use crate::platform::{describe, Done, PlatformState};
use crate::spans::{self, Attr, InvocationContext, RootRef};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Roots kept after export so a late `platform.report` can be sent as an update.
const MAX_ROOT_REFS: usize = 8;
/// After the platform says the runtime finished, how long to still wait for the tracer's final batch.
const GRACE_AFTER_SUCCESS: Duration = Duration::from_millis(100);
const GRACE_AFTER_ERROR: Duration = Duration::from_millis(50);
/// The grace restarts while batches for the request keep arriving (a large invocation is handed over in
/// chunks after the invocation span), up to this long after the platform said the runtime was done.
const MAX_GRACE: Duration = Duration::from_millis(1000);
/// Requests reported as in progress whose IDs are remembered (late chunks still get the right trace ID).
const MAX_IN_PROGRESS: usize = 16;

/// Spans that share one OTLP resource.
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub resource: Value,
    pub spans: Vec<Value>,
}

#[derive(Default)]
struct Entry {
    resource: Value,
    spans: Vec<Value>,
    index: HashMap<String, usize>,
    is_final: bool,
    last_add: Option<Instant>,
}

impl Entry {
    fn push(&mut self, span: Value) {
        let id = span_id(&span);
        match self.index.get(&id) {
            Some(&i) => self.spans[i] = span,
            None => {
                self.index.insert(id, self.spans.len());
                self.spans.push(span);
            }
        }
    }

    fn root_mut(&mut self) -> Option<&mut Value> {
        self.spans.iter_mut().find(|s| spans::is_root(s))
    }
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    order: Vec<String>,
    attached: bool,
    platform: PlatformState,
    last_resource: Option<Value>,
    roots: VecDeque<RootRef>,
    /// Requests already covered by an init failure span, so a `runtimeDone` for them adds nothing.
    init_failed_requests: HashSet<String>,
    init_failed: bool,
    /// Requests reported as in progress: (request ID, trace ID, span ID) of their provisional invocation span.
    in_progress: VecDeque<(String, String, String)>,
}

impl Inner {
    fn in_progress_ids(&self, request_id: &str) -> Option<(String, String)> {
        self.in_progress.iter().find(|p| p.0 == request_id).map(|p| (p.1.clone(), p.2.clone()))
    }

    fn entry(&mut self, request_id: &str) -> &mut Entry {
        if !self.entries.contains_key(request_id) {
            self.order.push(request_id.to_string());
        }
        self.entries.entry(request_id.to_string()).or_default()
    }
}

/// How the extension finishes an invocation; fixed for the life of the process.
pub struct FinishOptions {
    pub redact_keys: Vec<String>,
    /// Send late `platform.report` metrics as update spans.
    pub report_updates: bool,
    /// Resource for synthetic spans when the tracer never sent one.
    pub fallback_resource: Value,
}

/// Collects span batches from the in-process tracer per request ID, plus platform telemetry. A later
/// batch for the same request replaces spans with the same ID (a provisional timeout snapshot is
/// superseded by the final one).
#[derive(Default)]
pub struct SpanStore {
    inner: Mutex<Inner>,
    changed: Condvar,
}

fn span_id(span: &Value) -> String {
    match span.get("spanId") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

impl SpanStore {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Waits until `done` holds or the deadline passes; returns whether it held.
    fn wait_while<'a>(&'a self, mut inner: MutexGuard<'a, Inner>, deadline: Instant, done: impl Fn(&mut Inner) -> bool) -> (MutexGuard<'a, Inner>, bool) {
        loop {
            if done(&mut inner) {
                return (inner, true);
            }
            let now = Instant::now();
            if now >= deadline {
                return (inner, false);
            }
            inner = match self.changed.wait_timeout(inner, deadline - now) {
                Ok((guard, _)) => guard,
                Err(e) => e.into_inner().0,
            };
        }
    }

    /// Records that the in-process tracer said hello (or sent spans).
    pub fn attach(&self) {
        self.lock().attached = true;
        self.changed.notify_all();
    }

    /// Attached, and its process did not fail to initialize.
    pub fn is_attached(&self) -> bool {
        let inner = self.lock();
        inner.attached && !inner.init_failed
    }

    /// True once the tracer is attached, false after `timeout`.
    pub fn wait_attached(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        self.wait_while(self.lock(), deadline, |i| i.attached).1
    }

    pub fn add(&self, request_id: &str, is_final: bool, resource: Value, spans: Vec<Value>) {
        let mut inner = self.lock();
        inner.attached = true;
        if resource.as_array().is_some_and(|a| !a.is_empty()) {
            inner.last_resource = Some(resource.clone());
        }
        // The tracer derives the same IDs, but its trace ID's time prefix can be a second off the one the
        // extension already exported for an in-progress invocation.
        let trace_id = inner.in_progress_ids(request_id).map(|(t, _)| Value::String(t));
        let entry = inner.entry(request_id);
        entry.resource = resource;
        entry.last_add = Some(Instant::now());
        for mut span in spans {
            if let (Some(t), Some(obj)) = (&trace_id, span.as_object_mut()) {
                obj.insert("traceId".into(), t.clone());
            }
            entry.push(span);
        }
        if is_final {
            entry.is_final = true;
        }
        self.changed.notify_all();
    }

    /// Feeds a batch of Telemetry API events.
    pub fn add_telemetry(&self, events: Vec<Value>) {
        let mut inner = self.lock();
        inner.platform.handle(events);
        if inner.platform.init_failure.is_some() {
            inner.init_failed = true;
        }
        self.changed.notify_all();
    }

    /// Waits for the tracer's final batch for `request_id`. Returns early when the platform reports the
    /// runtime as done: after a short grace for success or a handler error, at once for a crash or
    /// timeout. True when the final batch arrived.
    pub fn wait_for(&self, request_id: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let (inner, _) = self.wait_while(self.lock(), deadline, |i| i.entry(request_id).is_final || i.platform.done(request_id).is_some());
        if inner.entries.get(request_id).is_some_and(|e| e.is_final) {
            return true;
        }
        let grace = match inner.platform.done(request_id) {
            Some(Done::Success) => GRACE_AFTER_SUCCESS,
            Some(Done::Failed(f)) if f.status == "error" => GRACE_AFTER_ERROR,
            _ => return false,
        };
        let hard_deadline = deadline.min(Instant::now() + MAX_GRACE);
        let mut inner = inner;
        loop {
            let last = inner.entries.get(request_id).and_then(|e| e.last_add).unwrap_or_else(Instant::now);
            let until = hard_deadline.min(last.max(Instant::now()) + grace);
            let (guard, done) = self.wait_while(inner, until, |i| i.entry(request_id).is_final);
            if done {
                return true;
            }
            inner = guard;
            let moved = inner.entries.get(request_id).and_then(|e| e.last_add).is_some_and(|l| l > last);
            if !moved || Instant::now() >= hard_deadline {
                return false;
            }
        }
    }

    /// Waits until the invocation is over: the tracer's final batch arrived or the platform reported the
    /// runtime done. No grace; true when it is over.
    pub fn wait_settled(&self, request_id: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        self.wait_while(self.lock(), deadline, |i| i.entries.get(request_id).is_some_and(|e| e.is_final) || i.platform.done(request_id).is_some()).1
    }

    /// A provisional invocation span (`ivy.in_progress`) for a request that is still running, with the IDs its
    /// final span will have. `None` once the invocation is over. Spans the tracer already handed over (a timeout
    /// snapshot) get its trace ID.
    pub fn in_progress(&self, ctx: &InvocationContext, deadline_ms: i64, now_ms: i64, opts: &FinishOptions) -> Option<Batch> {
        let request_id = ctx.request_id.as_deref()?;
        let mut inner = self.lock();
        if inner.entries.get(request_id).is_some_and(|e| e.is_final) || inner.platform.done(request_id).is_some() {
            return None;
        }
        let start_ms = inner.platform.start_of(request_id).unwrap_or(ctx.start_ms);
        let (trace_id, span_id) = match inner.in_progress_ids(request_id) {
            Some(ids) => ids,
            None => {
                let ids = spans::derived_ids(request_id, start_ms);
                if inner.in_progress.len() >= MAX_IN_PROGRESS {
                    inner.in_progress.pop_front();
                }
                inner.in_progress.push_back((request_id.to_string(), ids.0.clone(), ids.1.clone()));
                ids
            }
        };
        if let Some(e) = inner.entries.get_mut(request_id) {
            for s in e.spans.iter_mut().filter_map(Value::as_object_mut) {
                s.insert("traceId".into(), Value::String(trace_id.clone()));
            }
        }
        let resource = inner.last_resource.clone().unwrap_or_else(|| opts.fallback_resource.clone());
        let name = spans::function_name(&resource).unwrap_or_else(|| "unknown".into());
        let root_ctx = InvocationContext { start_ms, ..ctx.clone() };
        let root = spans::in_progress_root(&root_ctx, &name, &trace_id, &span_id, deadline_ms, now_ms);
        Some(Batch { resource, spans: vec![root] })
    }

    /// At shutdown: waits for telemetry that may still be in Lambda's buffer (the init outcome, the
    /// last invocation's outcome, reports for exported roots). Only when telemetry arrives at all.
    pub fn wait_for_telemetry(&self, last_request: Option<&str>, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        let inner = self.lock();
        if inner.platform.received == 0 {
            return;
        }
        let _ = self.wait_while(inner, deadline, |i| {
            let reported = i.roots.iter().all(|r| i.platform.reports.iter().any(|p| p.request_id == r.request_id));
            i.platform.init_done && last_request.is_none_or(|r| i.platform.done(r).is_some()) && reported
        });
    }

    /// Turns pending platform data into span data (failures, cold-start init duration, report updates)
    /// and removes and returns everything collected so far. `ctx` is the invocation just handled.
    pub fn finish(&self, ctx: Option<&InvocationContext>, opts: &FinishOptions) -> Vec<Batch> {
        let mut inner = self.lock();
        let redact = |m: &str| crate::platform::redact(m, &opts.redact_keys);
        let resource = inner.last_resource.clone().unwrap_or_else(|| opts.fallback_resource.clone());
        let name = spans::function_name(&resource).unwrap_or_else(|| "unknown".into());
        let mut updates: Vec<Batch> = Vec::new();

        if let Some(init) = inner.platform.init_failure.take() {
            let f = &init.failure;
            let request_id = ctx.and_then(|c| c.request_id.clone());
            let start_ms = init.start_ms.unwrap_or(f.time_ms - f.duration_ms.unwrap_or(0.0) as i64);
            let root_ctx = InvocationContext { request_id: request_id.clone(), function_arn: ctx.and_then(|c| c.function_arn.clone()), start_ms, cold_start: true };
            let ids = request_id.as_deref().and_then(|id| inner.in_progress_ids(id));
            let mut root = spans::synthetic_root(&root_ctx, &name, ids);
            let (error_type, message) = describe(f, "init");
            spans::apply_failure(&mut root, &error_type, &message, "init", &f.status, f.time_ms, &f.logs, &redact);
            if let Some(d) = f.duration_ms {
                spans::set_attr(&mut root, "ivy.init_duration_ms", Attr::Double(d));
            }
            let key = request_id.clone().unwrap_or_else(|| format!("init-{}", spans::random_hex(4)));
            if let Some(id) = request_id {
                inner.init_failed_requests.insert(id.clone());
                inner.platform.forget(&id);
                // Anything the dead tracer left for this request is superseded by the init failure.
                inner.entries.remove(&id);
            }
            let entry = inner.entry(&key);
            entry.resource = resource.clone();
            entry.push(root);
            entry.is_final = true;
        }

        for request_id in inner.platform.failed_requests() {
            let Some(Done::Failed(f)) = inner.platform.done(&request_id).cloned() else { continue };
            let start = inner.platform.start_of(&request_id);
            inner.platform.forget(&request_id);
            if inner.init_failed_requests.contains(&request_id) {
                continue;
            }
            let (error_type, message) = describe(&f, "invoke");
            let ctx_for = ctx.filter(|c| c.request_id.as_deref() == Some(request_id.as_str()));
            let start_ms = start.or(ctx_for.map(|c| c.start_ms)).unwrap_or(f.time_ms - f.duration_ms.unwrap_or(0.0) as i64);
            let ids = inner.in_progress_ids(&request_id);
            let entry = inner.entry(&request_id);
            if entry.resource.as_array().is_none_or(|a| a.is_empty()) {
                entry.resource = resource.clone();
            }
            let tracer_reported = entry.is_final;
            match entry.root_mut() {
                // The handler finished and reported its own error: keep it.
                Some(root) if tracer_reported && spans::has_error_status(root) => {}
                Some(root) => spans::apply_failure(root, &error_type, &message, "invoke", &f.status, f.time_ms, &f.logs, &redact),
                None => {
                    let root_ctx = InvocationContext {
                        request_id: Some(request_id.clone()),
                        function_arn: ctx_for.and_then(|c| c.function_arn.clone()),
                        start_ms,
                        cold_start: ctx_for.is_some_and(|c| c.cold_start),
                    };
                    let mut root = spans::synthetic_root(&root_ctx, &name, ids);
                    spans::apply_failure(&mut root, &error_type, &message, "invoke", &f.status, f.time_ms, &f.logs, &redact);
                    entry.push(root);
                }
            }
            entry.is_final = true;
        }

        if let Some(c) = ctx.filter(|c| c.cold_start) {
            let (init_ms, restore_ms) = (inner.platform.init_duration_ms, inner.platform.restore_duration_ms);
            if let Some(root) = c.request_id.as_deref().and_then(|id| inner.entries.get_mut(id)).and_then(Entry::root_mut) {
                if let Some(d) = init_ms {
                    spans::set_attr(root, "ivy.init_duration_ms", Attr::Double(d));
                }
                if let Some(d) = restore_ms {
                    spans::set_attr(root, "ivy.restore_duration_ms", Attr::Double(d));
                }
            }
        }
        // Reported as in progress, but the tracer's spans never came: a closing root replaces the provisional one,
        // so the invocation does not show as running until its deadline.
        if let Some(c) = ctx {
            let id = c.request_id.as_deref().unwrap_or_default();
            let ids = inner.in_progress_ids(id);
            let has_root = inner.entries.get(id).is_some_and(|e| e.spans.iter().any(spans::is_root));
            if let (Some(ids), false) = (ids, has_root) {
                let start_ms = inner.platform.start_of(id).unwrap_or(c.start_ms);
                let mut root = spans::synthetic_root(&InvocationContext { start_ms, ..c.clone() }, &name, Some(ids));
                if let Some(obj) = root.as_object_mut() {
                    obj.insert("endTimeUnixNano".into(), spans::nanos(spans::epoch_ms().max(start_ms)));
                }
                let entry = inner.entry(id);
                if entry.resource.as_array().is_none_or(|a| a.is_empty()) {
                    entry.resource = resource.clone();
                }
                entry.push(root);
            }
        }
        if let Some(id) = ctx.and_then(|c| c.request_id.as_deref()) {
            if matches!(inner.platform.done(id), Some(Done::Success)) {
                inner.platform.forget(id);
            }
        }

        let mut unmatched = Vec::new();
        for report in std::mem::take(&mut inner.platform.reports) {
            if let Some(root) = inner.entries.get_mut(&report.request_id).and_then(Entry::root_mut) {
                for (k, v) in spans::report_attrs(&report) {
                    spans::set_attr(root, k, v);
                }
            } else if let Some(pos) = inner.roots.iter().position(|r| r.request_id == report.request_id) {
                if let Some(r) = inner.roots.remove(pos) {
                    if opts.report_updates {
                        updates.push(Batch { resource: r.resource.clone(), spans: vec![spans::update_span(&r, &report)] });
                    }
                }
            } else if inner.order.contains(&report.request_id) {
                unmatched.push(report);
            }
        }
        inner.platform.reports = unmatched;

        let order = std::mem::take(&mut inner.order);
        let mut entries = std::mem::take(&mut inner.entries);
        let mut out = Vec::new();
        for id in order {
            let Some(e) = entries.remove(&id) else { continue };
            if e.spans.is_empty() {
                continue;
            }
            for root in e.spans.iter().filter(|s| spans::is_root(s) && !id.starts_with("init-")) {
                if let Some(r) = spans::root_ref(&id, root, &e.resource) {
                    if inner.roots.len() >= MAX_ROOT_REFS {
                        inner.roots.pop_front();
                    }
                    inner.roots.push_back(r);
                }
            }
            out.push(Batch { resource: e.resource, spans: e.spans });
        }
        out.extend(updates);
        out
    }

    /// Removes and returns everything collected so far, without platform data.
    #[cfg(test)]
    pub fn drain(&self) -> Vec<Batch> {
        self.finish(None, &FinishOptions { redact_keys: vec![], report_updates: false, fallback_resource: Value::Array(vec![]) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::thread;

    fn span(id: &str, name: &str) -> Value {
        json!({ "spanId": id, "name": name })
    }

    #[test]
    fn resolves_when_the_final_batch_arrives_before_or_after_waiting() {
        let s = Arc::new(SpanStore::default());
        s.add("r1", true, json!([]), vec![span("a", "x")]);
        assert!(s.wait_for("r1", Duration::from_secs(1)));

        let s2 = s.clone();
        let t = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            s2.add("r2", true, json!([]), vec![span("b", "x")]);
        });
        assert!(s.wait_for("r2", Duration::from_secs(1)));
        t.join().unwrap();
    }

    #[test]
    fn times_out_without_a_final_batch() {
        let s = SpanStore::default();
        s.add("r1", false, json!([]), vec![span("a", "x")]);
        let started = Instant::now();
        assert!(!s.wait_for("r1", Duration::from_millis(30)));
        assert!(started.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn final_batch_supersedes_provisional_spans_with_the_same_id() {
        let s = SpanStore::default();
        s.add("r1", false, json!([]), vec![span("root", "timeout")]);
        s.add("r1", true, json!([{"key": "service.name"}]), vec![span("root", "final"), span("child", "x")]);
        let batches = s.drain();
        assert_eq!(batches.len(), 1);
        let names: Vec<_> = batches[0].spans.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["final", "x"]);
        assert_eq!(batches[0].resource, json!([{"key": "service.name"}]));
        assert!(s.drain().is_empty());
    }

    #[test]
    fn attaches_on_hello_or_on_the_first_spans() {
        let s = Arc::new(SpanStore::default());
        assert!(!s.wait_attached(Duration::from_millis(10)));
        let s2 = s.clone();
        let t = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            s2.attach();
        });
        assert!(s.wait_attached(Duration::from_secs(1)));
        t.join().unwrap();

        let s = SpanStore::default();
        s.add("r1", false, json!([]), vec![span("a", "x")]);
        assert!(s.is_attached());
    }

    #[test]
    fn drain_keeps_arrival_order_and_skips_empty_entries() {
        let s = SpanStore::default();
        s.add("b", true, json!([]), vec![span("1", "b")]);
        assert!(!s.wait_for("empty", Duration::ZERO));
        s.add("a", true, json!([]), vec![span("2", "a")]);
        let names: Vec<_> = s.drain().iter().map(|b| b.spans[0]["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["b", "a"]);
    }

    // Platform telemetry scenarios.

    const T0: &str = "2024-06-01T10:00:00.000Z";

    fn ev(kind: &str, time: &str, record: Value) -> Value {
        json!({ "time": time, "type": kind, "record": record })
    }

    fn opts() -> FinishOptions {
        let env = |k: &str| match k {
            "AWS_LAMBDA_FUNCTION_NAME" => Some("checkout".to_string()),
            "AWS_REGION" => Some("eu-west-1".to_string()),
            _ => None,
        };
        FinishOptions { redact_keys: vec!["password".into()], report_updates: true, fallback_resource: spans::env_resource(&env, Some("123456789012")) }
    }

    fn ctx(id: &str, cold: bool) -> InvocationContext {
        InvocationContext { request_id: Some(id.into()), function_arn: Some("arn:aws:lambda:eu-west-1:123456789012:function:checkout".into()), start_ms: 1_717_236_000_000, cold_start: cold }
    }

    fn root(id: &str) -> Value {
        json!({
            "traceId": "665af0a0aaaaaaaaaaaaaaaaaaaaaaaa", "spanId": id, "name": "checkout", "kind": 2,
            "startTimeUnixNano": "1717236000000000000", "endTimeUnixNano": "1717236000050000000",
            "attributes": [{ "key": "ivy.invocation", "value": { "boolValue": true } }, { "key": "faas.coldstart", "value": { "boolValue": false } }],
            "events": [], "status": { "code": 0 },
        })
    }

    fn child(id: &str) -> Value {
        json!({ "traceId": "665af0a0aaaaaaaaaaaaaaaaaaaaaaaa", "spanId": id, "parentSpanId": "root", "name": "DynamoDB.GetItem", "kind": 3, "attributes": [], "events": [], "status": { "code": 0 } })
    }

    fn a<'v>(span: &'v Value, key: &str) -> Option<&'v Value> {
        spans::attr(span, key)
    }

    fn roots(batches: &[Batch]) -> Vec<Value> {
        batches.iter().flat_map(|b| b.spans.iter()).filter(|s| spans::is_root(s)).cloned().collect()
    }

    #[test]
    fn init_failure_becomes_a_synthetic_root_with_the_log_tail() {
        let s = SpanStore::default();
        s.attach();
        let log = "2024-06-01T10:00:00.050Z\tundefined\tERROR\tUncaught Exception \t{\"errorType\":\"Runtime.ImportModuleError\",\"errorMessage\":\"Error: Cannot find module 'left-pad'\\nRequire stack:\\n- /var/task/index.js\",\"stack\":[]}";
        s.add_telemetry(vec![
            ev("platform.initStart", T0, json!({ "phase": "init", "initializationType": "on-demand" })),
            ev("function", "2024-06-01T10:00:00.040Z", json!("2024-06-01T10:00:00.040Z\tundefined\tINFO\tconnecting with password=hunter2")),
            ev("function", "2024-06-01T10:00:00.050Z", json!(log)),
            ev("platform.initRuntimeDone", "2024-06-01T10:00:00.060Z", json!({ "phase": "init", "status": "error", "errorType": "Runtime.ImportModuleError" })),
            ev("platform.initReport", "2024-06-01T10:00:00.061Z", json!({ "phase": "init", "status": "error", "metrics": { "durationMs": 61.5 } })),
        ]);
        assert!(!s.is_attached(), "a tracer whose process failed to init is not waited for");

        let out = s.finish(None, &opts());
        let r = roots(&out);
        assert_eq!(r.len(), 1);
        let root = &r[0];
        assert_eq!(a(root, "ivy.synthetic").unwrap()["boolValue"], true);
        assert_eq!(a(root, "error.type").unwrap()["stringValue"], "Runtime.ImportModuleError");
        assert_eq!(a(root, "ivy.failure.phase").unwrap()["stringValue"], "init");
        assert_eq!(a(root, "ivy.init_duration_ms").unwrap()["doubleValue"], 61.5);
        assert!(a(root, "faas.invocation_id").is_none());
        assert_eq!(root["status"], json!({ "code": 2, "message": "Error: Cannot find module 'left-pad'" }));
        assert_eq!(root["startTimeUnixNano"], "1717236000000000000");
        assert_eq!(root["endTimeUnixNano"], "1717236000060000000");
        assert_eq!(root["traceId"].as_str().unwrap().len(), 32);
        let events = root["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["attributes"][1]["value"]["stringValue"], "connecting with password=[redacted]");
        assert_eq!(events[1]["attributes"][0]["value"]["stringValue"], "error");
        assert_eq!(out[0].resource, opts().fallback_resource);
        assert!(s.finish(None, &opts()).is_empty(), "exported once");
    }

    #[test]
    fn init_failure_followed_by_an_invoke_carries_its_request_id_once() {
        let s = SpanStore::default();
        s.add_telemetry(vec![
            ev("platform.initStart", T0, json!({ "phase": "invoke" })),
            ev("platform.initRuntimeDone", "2024-06-01T10:00:00.060Z", json!({ "phase": "invoke", "status": "error", "errorType": "Runtime.HandlerNotFound" })),
        ]);
        let out = s.finish(Some(&ctx("req-1", true)), &opts());
        s.add_telemetry(vec![ev("platform.runtimeDone", "2024-06-01T10:00:00.070Z", json!({ "requestId": "req-1", "status": "error", "errorType": "Runtime.HandlerNotFound" }))]);
        let later = s.finish(None, &opts());
        let r = roots(&out);
        assert_eq!(r.len(), 1);
        assert_eq!(a(&r[0], "faas.invocation_id").unwrap()["stringValue"], "req-1");
        assert_eq!(a(&r[0], "ivy.failure.phase").unwrap()["stringValue"], "init");
        assert!(roots(&later).is_empty(), "no second invocation for the same request");
    }

    #[test]
    fn out_of_memory_after_partial_spans_completes_the_tracers_root() {
        let s = SpanStore::default();
        s.add("req-2", false, json!([{ "key": "faas.name", "value": { "stringValue": "checkout" } }]), vec![root("root"), child("c1")]);
        s.add_telemetry(vec![
            ev("platform.start", T0, json!({ "requestId": "req-2" })),
            ev("function", "2024-06-01T10:00:01.000Z", json!("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory")),
            ev("platform.runtimeDone", "2024-06-01T10:00:02.000Z", json!({ "requestId": "req-2", "status": "failure", "errorType": "Runtime.OutOfMemory", "metrics": { "durationMs": 2000.0 } })),
        ]);
        let started = Instant::now();
        assert!(!s.wait_for("req-2", Duration::from_secs(5)), "no final batch, but the wait ends with the crash");
        assert!(started.elapsed() < Duration::from_millis(500));
        let out = s.finish(Some(&ctx("req-2", false)), &opts());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].spans.len(), 2, "the child span is kept, no extra root");
        let r = &roots(&out)[0];
        assert_eq!(r["spanId"], "root");
        assert!(a(r, "ivy.synthetic").is_none());
        assert_eq!(a(r, "error.type").unwrap()["stringValue"], "Runtime.OutOfMemory");
        assert_eq!(a(r, "ivy.failure.phase").unwrap()["stringValue"], "invoke");
        assert_eq!(r["status"]["message"], "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
        assert_eq!(r["endTimeUnixNano"], "1717236002000000000");
        assert_eq!(r["events"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn crash_without_any_tracer_spans_gets_a_synthetic_root() {
        let s = SpanStore::default();
        s.add_telemetry(vec![
            ev("platform.start", T0, json!({ "requestId": "req-3" })),
            ev("platform.runtimeDone", "2024-06-01T10:00:00.300Z", json!({ "requestId": "req-3", "status": "failure", "errorType": "Runtime.ExitError" })),
        ]);
        let r = roots(&s.finish(None, &opts()));
        assert_eq!(r.len(), 1);
        assert_eq!(a(&r[0], "faas.invocation_id").unwrap()["stringValue"], "req-3");
        assert_eq!(a(&r[0], "error.type").unwrap()["stringValue"], "Runtime.ExitError");
        assert_eq!(r[0]["startTimeUnixNano"], "1717236000000000000");
        assert_eq!(r[0]["status"]["message"], "Runtime exited before the invocation completed");
    }

    #[test]
    fn timeout_replaces_the_provisional_snapshot_error() {
        let s = SpanStore::default();
        let mut snapshot = root("root");
        spans::set_attr(&mut snapshot, "error.type", Attr::Str("Timeout".into()));
        s.add("req-4", false, json!([]), vec![snapshot, child("c1")]);
        s.add_telemetry(vec![ev("platform.runtimeDone", "2024-06-01T10:00:03.000Z", json!({ "requestId": "req-4", "status": "timeout" }))]);
        assert!(!s.wait_for("req-4", Duration::from_secs(5)));
        let out = s.finish(Some(&ctx("req-4", false)), &opts());
        let r = roots(&out);
        assert_eq!(r.len(), 1);
        assert_eq!(a(&r[0], "error.type").unwrap()["stringValue"], "Sandbox.Timedout");
        assert_eq!(r[0]["status"]["message"], "Task timed out");
        assert_eq!(out[0].spans.len(), 2);
    }

    #[test]
    fn handler_errors_reported_by_the_tracer_are_kept() {
        let s = SpanStore::default();
        let mut r = root("root");
        r["status"] = json!({ "code": 2, "message": "Intentional failure" });
        spans::set_attr(&mut r, "error.type", Attr::Str("Error".into()));
        s.add("req-5", true, json!([]), vec![r]);
        s.add_telemetry(vec![ev("platform.runtimeDone", "2024-06-01T10:00:00.100Z", json!({ "requestId": "req-5", "status": "error", "errorType": "Error" }))]);
        let out = roots(&s.finish(Some(&ctx("req-5", false)), &opts()));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["status"]["message"], "Intentional failure");
        assert!(a(&out[0], "ivy.failure.phase").is_none());
    }

    #[test]
    fn normal_invocation_gets_init_duration_now_and_report_metrics_as_a_later_update() {
        let s = SpanStore::default();
        s.add_telemetry(vec![
            ev("platform.initStart", T0, json!({ "phase": "init" })),
            ev("function", T0, json!("2024-06-01T10:00:00.000Z\tundefined\tINFO\tbooting")),
            ev("platform.initRuntimeDone", T0, json!({ "phase": "init", "status": "success" })),
            ev("platform.initReport", T0, json!({ "phase": "init", "status": "success", "metrics": { "durationMs": 180.25 } })),
        ]);
        s.add("req-6", true, json!([{ "key": "faas.name", "value": { "stringValue": "checkout" } }]), vec![root("root"), child("c1")]);
        assert!(s.wait_for("req-6", Duration::from_millis(10)));
        let first = s.finish(Some(&ctx("req-6", true)), &opts());
        let r = roots(&first);
        assert_eq!(r.len(), 1);
        assert_eq!(a(&r[0], "ivy.init_duration_ms").unwrap()["doubleValue"], 180.25);
        assert!(a(&r[0], "error.type").is_none() && r[0]["status"]["code"] == 0);
        assert_eq!(r[0]["events"].as_array().unwrap().len(), 0, "logs of a healthy invocation are not exported");

        // The report is emitted after the invoke phase ends, so it arrives with the next invocation.
        s.add_telemetry(vec![
            ev("platform.runtimeDone", T0, json!({ "requestId": "req-6", "status": "success" })),
            ev("function", T0, json!("2024-06-01T10:00:05.000Z\treq-7\tINFO\tnext")),
            ev("platform.report", T0, json!({ "requestId": "req-6", "status": "success", "metrics": { "billedDurationMs": 52, "durationMs": 51.3, "maxMemoryUsedMB": 88, "memorySizeMB": 256, "initDurationMs": 180.25 } })),
        ]);
        s.add("req-7", true, json!([]), vec![root("root-7")]);
        let next = s.finish(Some(&ctx("req-7", false)), &opts());
        let all: Vec<&Value> = next.iter().flat_map(|b| b.spans.iter()).collect();
        assert_eq!(all.len(), 2);
        assert_eq!(roots(&next).len(), 1, "the update is not another invocation");
        let update = all.iter().find(|s| s["spanId"] == "root").unwrap();
        assert_eq!(a(update, "ivy.update").unwrap()["boolValue"], true);
        assert!(a(update, "ivy.invocation").is_none());
        assert_eq!(a(update, "ivy.billed_duration_ms").unwrap()["intValue"], "52");
        assert_eq!(a(update, "ivy.memory_max_used_mb").unwrap()["intValue"], "88");
        assert_eq!(a(update, "ivy.memory_size_mb").unwrap()["intValue"], "256");
        assert_eq!(update["startTimeUnixNano"], "1717236000000000000");
        assert!(roots(&next)[0]["events"].as_array().unwrap().is_empty());
        assert!(s.finish(None, &opts()).is_empty(), "each report is used once");
    }

    #[test]
    fn report_for_a_root_still_in_the_store_is_applied_in_place() {
        let s = SpanStore::default();
        s.add("req-8", true, json!([]), vec![root("root")]);
        s.add_telemetry(vec![ev("platform.report", T0, json!({ "requestId": "req-8", "metrics": { "billedDurationMs": 3, "maxMemoryUsedMB": 70, "memorySizeMB": 128 } }))]);
        let out = s.finish(None, &opts());
        assert_eq!(out.iter().map(|b| b.spans.len()).sum::<usize>(), 1);
        assert_eq!(a(&out[0].spans[0], "ivy.billed_duration_ms").unwrap()["intValue"], "3");
    }

    #[test]
    fn success_without_a_final_batch_stops_waiting_after_a_short_grace() {
        let s = SpanStore::default();
        s.attach();
        s.add_telemetry(vec![ev("platform.runtimeDone", T0, json!({ "requestId": "req-9", "status": "success" }))]);
        let started = Instant::now();
        assert!(!s.wait_for("req-9", Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_millis(400));
        assert!(s.finish(Some(&ctx("req-9", false)), &opts()).is_empty());
    }

    #[test]
    fn the_grace_restarts_while_chunks_keep_arriving() {
        let s = Arc::new(SpanStore::default());
        s.attach();
        s.add_telemetry(vec![ev("platform.runtimeDone", T0, json!({ "requestId": "req-c", "status": "success" }))]);
        s.add("req-c", false, json!([]), vec![root("root")]);
        let s2 = s.clone();
        let t = thread::spawn(move || {
            for i in 0..4 {
                thread::sleep(Duration::from_millis(60));
                s2.add("req-c", i == 3, json!([]), vec![span(&format!("c{i}"), "x")]);
            }
        });
        assert!(s.wait_for("req-c", Duration::from_secs(5)), "four chunks 60 ms apart, each within the 100 ms grace");
        t.join().unwrap();
        assert_eq!(s.drain()[0].spans.len(), 5);
    }

    #[test]
    fn shutdown_wait_returns_once_the_last_outcome_and_reports_are_in() {
        let s = Arc::new(SpanStore::default());
        s.add_telemetry(vec![ev("platform.initRuntimeDone", T0, json!({ "status": "success" }))]);
        s.add("req-10", true, json!([]), vec![root("root")]);
        s.finish(Some(&ctx("req-10", false)), &opts());
        let s2 = s.clone();
        let t = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            s2.add_telemetry(vec![
                ev("platform.runtimeDone", T0, json!({ "requestId": "req-10", "status": "success" })),
                ev("platform.report", T0, json!({ "requestId": "req-10", "metrics": { "billedDurationMs": 9 } })),
            ]);
        });
        let started = Instant::now();
        s.wait_for_telemetry(Some("req-10"), Duration::from_secs(2));
        assert!(started.elapsed() < Duration::from_millis(500));
        t.join().unwrap();
        let out = s.finish(None, &opts());
        assert_eq!(a(&out[0].spans[0], "ivy.update").unwrap()["boolValue"], true);
    }

    fn long_ctx() -> InvocationContext {
        InvocationContext { start_ms: 1_717_236_000_999, ..ctx("req-long", false) }
    }

    #[test]
    fn in_progress_span_has_the_derived_ids_and_the_tracers_spans_get_its_trace_id() {
        let s = SpanStore::default();
        let batch = s.in_progress(&long_ctx(), 1_717_236_900_000, 1_717_236_006_000, &opts()).unwrap();
        let p = &batch.spans[0];
        let (trace, span) = spans::derived_ids("req-long", 1_717_236_000_999);
        assert_eq!((p["traceId"].as_str().unwrap(), p["spanId"].as_str().unwrap()), (trace.as_str(), span.as_str()));
        assert_eq!(p["endTimeUnixNano"], "1717236006000000000");
        assert_eq!(a(p, "ivy.last_seen_ms").unwrap()["intValue"], "1717236006000");
        assert_eq!(p["name"], "checkout");

        // The tracer started a moment later, in the next second: same suffix and span ID, other prefix.
        let tracer_trace = format!("{:08x}{}", 1_717_236_001u32, &trace[8..]);
        let mut final_root = root(&span);
        final_root["traceId"] = json!(tracer_trace);
        let mut c = child("c1");
        c["traceId"] = json!(tracer_trace);
        c["parentSpanId"] = json!(span);
        s.add("req-long", true, json!([]), vec![final_root]);
        let late_chunk = c.clone();
        let out = s.finish(Some(&long_ctx()), &opts());
        s.add("req-long", true, json!([]), vec![late_chunk]);
        let late = s.drain();
        assert_eq!(roots(&out).len(), 1);
        assert_eq!(roots(&out)[0]["traceId"], trace.as_str());
        assert!(a(&roots(&out)[0], "ivy.in_progress").is_none());
        assert_eq!(late[0].spans[0]["traceId"], trace.as_str(), "a chunk arriving after the export gets it too");
    }

    #[test]
    fn no_in_progress_span_once_the_invocation_is_over() {
        let s = SpanStore::default();
        s.add("req-long", true, json!([]), vec![root("x")]);
        assert!(s.in_progress(&long_ctx(), 1_717_236_900_000, 1_717_236_006_000, &opts()).is_none());
        let s = SpanStore::default();
        s.add_telemetry(vec![ev("platform.runtimeDone", T0, json!({ "requestId": "req-long", "status": "success" }))]);
        assert!(s.in_progress(&long_ctx(), 1_717_236_900_000, 1_717_236_006_000, &opts()).is_none());
    }

    #[test]
    fn a_crash_after_the_in_progress_span_keeps_its_ids() {
        let s = SpanStore::default();
        let p = s.in_progress(&long_ctx(), 1_717_236_900_000, 1_717_236_006_000, &opts()).unwrap().spans.remove(0);
        s.add_telemetry(vec![ev("platform.runtimeDone", "2024-06-01T10:01:00.000Z", json!({ "requestId": "req-long", "status": "failure", "errorType": "Runtime.ExitError" }))]);
        let r = roots(&s.finish(Some(&long_ctx()), &opts()));
        assert_eq!(r.len(), 1);
        assert_eq!((&r[0]["traceId"], &r[0]["spanId"]), (&p["traceId"], &p["spanId"]));
        assert_eq!(a(&r[0], "error.type").unwrap()["stringValue"], "Runtime.ExitError");
        assert!(a(&r[0], "ivy.in_progress").is_none());
    }

    #[test]
    fn an_in_progress_invocation_whose_tracer_sent_nothing_is_closed() {
        let s = SpanStore::default();
        let p = s.in_progress(&long_ctx(), 1_717_236_900_000, 1_717_236_006_000, &opts()).unwrap().spans.remove(0);
        s.add_telemetry(vec![ev("platform.runtimeDone", T0, json!({ "requestId": "req-long", "status": "success" }))]);
        let r = roots(&s.finish(Some(&long_ctx()), &opts()));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["spanId"], p["spanId"]);
        assert_eq!(r[0]["status"]["code"], 0);
        assert_eq!(a(&r[0], "ivy.synthetic").unwrap()["boolValue"], true);
        assert!(s.finish(Some(&ctx("req-next", false)), &opts()).is_empty(), "only for the invocation that was reported");
    }

    /// Cost of the telemetry path for a healthy warm invocation (`cargo test --release -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn bench_warm_invocation_overhead() {
        let s = SpanStore::default();
        let o = opts();
        let n = 20_000;
        let mut parse_and_finish = Duration::ZERO;
        for i in 0..n {
            let id = format!("8f1c2a7e-3b9d-4c55-9a51-{i:012}");
            let body = serde_json::to_vec(&json!([
                ev("platform.start", T0, json!({ "requestId": id, "version": "$LATEST" })),
                ev("function", T0, json!(format!("2024-06-01T10:00:00.000Z\t{id}\tINFO\tprocessing order 42"))),
                ev("platform.runtimeDone", T0, json!({ "requestId": id, "status": "success", "metrics": { "durationMs": 3.1, "producedBytes": 52 } })),
                ev("platform.report", T0, json!({ "requestId": format!("8f1c2a7e-3b9d-4c55-9a51-{:012}", i.max(1) - 1), "metrics": { "billedDurationMs": 4, "durationMs": 3.1, "maxMemoryUsedMB": 80, "memorySizeMB": 256 } })),
            ]))
            .unwrap();
            s.add(&id, true, json!([]), vec![root(&format!("{i:016x}"))]);
            let started = Instant::now();
            let events: Vec<Value> = serde_json::from_slice(&body).unwrap();
            s.add_telemetry(events);
            s.finish(Some(&ctx(&id, false)), &o);
            parse_and_finish += started.elapsed();
        }
        let update = spans::update_span(
            &spans::root_ref("8f1c2a7e-3b9d-4c55-9a51-0f6f1e2b7c3d", &root("4bf92f3577b34da6"), &json!([])).unwrap(),
            &crate::platform::Report { request_id: "8f1c2a7e-3b9d-4c55-9a51-0f6f1e2b7c3d".into(), billed_duration_ms: Some(52), max_memory_used_mb: Some(88), memory_size_mb: Some(256), ..Default::default() },
        );
        println!("telemetry parse + finish per warm invocation: {:?}; update span: {} bytes", parse_and_finish / n, update.to_string().len());
    }
}
