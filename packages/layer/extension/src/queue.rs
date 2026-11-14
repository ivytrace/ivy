use crate::spans::{self, Attr, RootRef};
use crate::store::Batch;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::time::Duration;

const MIN_BACKOFF_MS: u64 = 5_000;
const MAX_BACKOFF_MS: u64 = 5 * 60_000;
/// Longest server-requested pause honoured (an environment rarely lives longer).
const MAX_RETRY_AFTER_MS: u64 = 60 * 60_000;
const SCOPE_NAME: &str = "ivy-layer";
const SCOPE_VERSION: &str = "0.1.0";

/// Same rule as the tracer's `PAYLOAD_KEY`: attributes that carry payloads and may be trimmed.
fn is_payload_key(key: &str) -> bool {
    const EXACT: [&str; 12] = [
        "ivy.http.request.headers",
        "ivy.http.response.headers",
        "ai.toolCall.args",
        "ai.toolCall.result",
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.system_instructions",
        "gen_ai.tool.definitions",
        "gen_ai.tool.call.arguments",
        "gen_ai.tool.call.result",
        "ai.response.toolCalls",
        "ai.response.reasoning",
    ];
    key.starts_with("ivy.payload.") || key.starts_with("ai.prompt") || key == "ai.response.text" || key == "ai.response.object" || EXACT.contains(&key)
}

/// Outcome of one export request.
#[derive(Debug, Clone, PartialEq)]
pub struct SendResult {
    pub ok: bool,
    /// The server asked us to wait (429/503 with Retry-After).
    pub retry_after_ms: Option<u64>,
    pub error: Option<String>,
}

impl SendResult {
    pub fn ok() -> Self {
        SendResult { ok: true, retry_after_ms: None, error: None }
    }
    pub fn failed(error: String, retry_after_ms: Option<u64>) -> Self {
        SendResult { ok: false, retry_after_ms, error: Some(error) }
    }
}

/// Sends one OTLP/HTTP JSON body within `budget`.
pub trait Exporter {
    fn send(&mut self, body: Vec<u8>, budget: Duration) -> SendResult;
}

/// Request sizes and the post-response time budget (see docs/implementation/layer.md, "Delivery").
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_queue_spans: usize,
    pub chunk_spans: usize,
    pub chunk_bytes: usize,
    pub budget_base_ms: u64,
    pub budget_per_chunk_ms: u64,
    pub budget_max_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_queue_spans: 2000, chunk_spans: 500, chunk_bytes: 1 << 20, budget_base_ms: 2000, budget_per_chunk_ms: 500, budget_max_ms: 5000 }
    }
}

/// Child spans of one invocation, sent in one request (or merged with other small chunks).
struct Chunk {
    resource: Value,
    spans: Vec<Value>,
    bytes: usize,
    /// Span ID of the invocation span the chunk belongs to.
    owner: Option<String>,
}

/// An invocation whose children are still queued: where to report spans that get lost.
struct Owner {
    root: RootRef,
    dropped: i64,
    reasons: Vec<String>,
    exported: bool,
    chunks: usize,
}

/// What one invocation's export did; logged as one line when something is worth knowing.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Report {
    pub invocations: usize,
    pub chunks: usize,
    pub collapsed: i64,
    pub dropped: i64,
    pub failure: Option<String>,
    pub paused_ms: Option<u64>,
}

impl Report {
    pub fn notable(&self) -> bool {
        self.collapsed > 0 || self.dropped > 0 || self.failure.is_some()
    }

    pub fn line(&self, elapsed_ms: u64) -> String {
        let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
        let mut line = match &self.failure {
            Some(e) => format!("[ivy] export failed ({e}); exported {}", plural(self.invocations, "invocation")),
            None => format!("[ivy] exported {}", plural(self.invocations, "invocation")),
        };
        line.push_str(&format!(", {}, collapsed {} calls, dropped {} spans ({elapsed_ms} ms)", plural(self.chunks, "chunk"), thousands(self.collapsed), thousands(self.dropped)));
        if let Some(ms) = self.paused_ms {
            line.push_str(&format!("; next attempt in {} s", ms.div_ceil(1000)));
        }
        line
    }
}

pub fn thousands(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        format!("-{out}")
    } else {
        out
    }
}

/// Bounded export queue. Invocation, synthetic and update spans go first in requests of their own;
/// children follow in chunks. When the queue is full the oldest child chunks go first; invocation
/// spans are only dropped when nothing else is left (a long outage). Lost children are reported on
/// their invocation span (`ivy.dropped_spans`), as an update span once that was already exported.
pub struct ExportQueue<E: Exporter> {
    exporter: E,
    limits: Limits,
    priority: VecDeque<Batch>,
    chunks: VecDeque<Chunk>,
    owners: HashMap<String, Owner>,
    queued: usize,
    next_attempt_at: u64,
    backoff_ms: u64,
    pause_until: u64,
    report: Report,
    now: Box<dyn Fn() -> u64>,
    log: Box<dyn Fn(&str)>,
}

pub fn build_export_request(batches: &[Batch]) -> Value {
    let mut groups: Vec<(String, Value, Vec<Value>)> = Vec::new();
    for batch in batches {
        let key = batch.resource.to_string();
        match groups.iter_mut().find(|g| g.0 == key) {
            Some(g) => g.2.extend(batch.spans.iter().cloned()),
            None => groups.push((key, batch.resource.clone(), batch.spans.clone())),
        }
    }
    let resource_spans: Vec<Value> = groups
        .into_iter()
        .map(|(_, resource, spans)| {
            json!({
                "resource": { "attributes": resource },
                "scopeSpans": [{ "scope": { "name": SCOPE_NAME, "version": SCOPE_VERSION }, "spans": spans }],
            })
        })
        .collect();
    json!({ "resourceSpans": resource_spans })
}

fn is_marked(span: &Value, key: &str) -> bool {
    spans::attr(span, key).and_then(|v| v.get("boolValue")).and_then(Value::as_bool) == Some(true)
}

fn is_priority(span: &Value) -> bool {
    spans::is_root(span) || is_marked(span, "ivy.update") || is_marked(span, "ivy.synthetic")
}

fn int_attr(span: &Value, key: &str) -> i64 {
    spans::attr(span, key).and_then(|v| v.get("intValue")).and_then(|v| v.as_str().map(String::from).or_else(|| v.as_i64().map(|i| i.to_string()))).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn str_attr(span: &Value, key: &str) -> Option<String> {
    spans::attr(span, key).and_then(|v| v.get("stringValue")).and_then(Value::as_str).map(String::from)
}

fn size_of(span: &Value) -> usize {
    serde_json::to_vec(span).map(|v| v.len()).unwrap_or(0)
}

/// Removes payload attributes, largest first, until the span fits in `max_bytes`; marks it trimmed.
pub fn trim_payloads(span: &mut Value, max_bytes: usize) -> usize {
    let size = size_of(span);
    if size <= max_bytes {
        return 0;
    }
    let Some(list) = span.get_mut("attributes").and_then(Value::as_array_mut) else { return 0 };
    let mut payloads: Vec<(String, usize)> = list
        .iter()
        .filter_map(|a| {
            let key = a.get("key")?.as_str()?;
            let text = a.pointer("/value/stringValue")?.as_str()?;
            is_payload_key(key).then(|| (key.to_string(), text.len()))
        })
        .collect();
    payloads.sort_by(|a, b| b.1.cmp(&a.1));
    let mut removed = 0;
    let mut drop = Vec::new();
    for (key, bytes) in payloads {
        if size - removed <= max_bytes {
            break;
        }
        removed += bytes;
        drop.push(key);
    }
    if drop.is_empty() {
        return 0;
    }
    list.retain(|a| a.get("key").and_then(Value::as_str).is_none_or(|k| !drop.iter().any(|d| d == k)));
    spans::set_attr(span, "ivy.payload.trimmed", Attr::Bool(true));
    removed
}

impl<E: Exporter> ExportQueue<E> {
    pub fn new(exporter: E, limits: Limits, now: Box<dyn Fn() -> u64>, log: Box<dyn Fn(&str)>) -> Self {
        ExportQueue {
            exporter,
            limits,
            priority: VecDeque::new(),
            chunks: VecDeque::new(),
            owners: HashMap::new(),
            queued: 0,
            next_attempt_at: 0,
            backoff_ms: 0,
            pause_until: 0,
            report: Report::default(),
            now,
            log,
        }
    }

    pub fn size(&self) -> usize {
        self.queued
    }

    /// Post-response time for the next flush: the base, plus a share per child chunk, capped.
    pub fn budget_ms(&self) -> u64 {
        let l = &self.limits;
        (l.budget_base_ms + l.budget_per_chunk_ms * self.chunks.len() as u64).min(l.budget_max_ms.max(l.budget_base_ms))
    }

    /// Takes the report of everything since the last call.
    pub fn take_report(&mut self) -> Report {
        std::mem::take(&mut self.report)
    }

    pub fn add(&mut self, batch: Batch) {
        let (mut first, mut children): (Vec<Value>, Vec<Value>) = batch.spans.into_iter().partition(is_priority);
        let mut owner = None;
        for span in first.iter_mut() {
            trim_payloads(span, self.limits.chunk_bytes);
            if spans::is_root(span) {
                if let Some(r) = spans::root_ref(&str_attr(span, "faas.invocation_id").unwrap_or_default(), span, &batch.resource) {
                    let reasons = str_attr(span, "ivy.dropped_spans.reason").map(|r| r.split(", ").map(String::from).collect()).unwrap_or_default();
                    owner = Some(r.span_id.clone());
                    self.owners.insert(r.span_id.clone(), Owner { root: r, dropped: int_attr(span, "ivy.dropped_spans"), reasons, exported: false, chunks: 0 });
                }
            }
        }
        if !first.is_empty() {
            self.queued += first.len();
            self.priority.push_back(Batch { resource: batch.resource.clone(), spans: first });
        }

        let mut current = Chunk { resource: batch.resource.clone(), spans: Vec::new(), bytes: 0, owner: owner.clone() };
        for mut span in children.drain(..) {
            let mut size = size_of(&span);
            if size > self.limits.chunk_bytes {
                trim_payloads(&mut span, self.limits.chunk_bytes);
                size = size_of(&span);
            }
            if !current.spans.is_empty() && (current.spans.len() >= self.limits.chunk_spans || current.bytes + size > self.limits.chunk_bytes) {
                let next = Chunk { resource: batch.resource.clone(), spans: Vec::new(), bytes: 0, owner: owner.clone() };
                self.push_chunk(std::mem::replace(&mut current, next));
            }
            current.bytes += size + 1;
            current.spans.push(span);
        }
        if !current.spans.is_empty() {
            self.push_chunk(current);
        }
        self.enforce_cap();
    }

    fn push_chunk(&mut self, chunk: Chunk) {
        if let Some(o) = chunk.owner.as_ref().and_then(|id| self.owners.get_mut(id)) {
            o.chunks += 1;
        }
        self.queued += chunk.spans.len();
        self.chunks.push_back(chunk);
    }

    fn enforce_cap(&mut self) {
        while self.queued > self.limits.max_queue_spans {
            if let Some(chunk) = self.chunks.pop_front() {
                self.queued -= chunk.spans.len();
                self.lose_chunk(chunk, "queue full");
            } else if let Some(batch) = self.priority.pop_front() {
                self.queued -= batch.spans.len();
                self.report.dropped += batch.spans.len() as i64;
                (self.log)(&format!("dropped {} invocation spans (queue full)", batch.spans.len()));
            } else {
                break;
            }
        }
    }

    /// Counts a chunk that will not be exported and records it on its invocation span.
    fn lose_chunk(&mut self, chunk: Chunk, reason: &str) {
        let n = chunk.spans.len() as i64;
        (self.log)(&format!("dropped {n} spans ({reason})"));
        let owner = chunk.owner.and_then(|id| self.owners.get_mut(&id).map(|o| (id, o)));
        // Counted in the report here, unless the invocation span still goes out carrying the count.
        if owner.as_ref().is_none_or(|(_, o)| o.exported) {
            self.report.dropped += n;
        }
        let Some((id, o)) = owner else { return };
        o.dropped += n;
        if !o.reasons.iter().any(|r| r == reason) {
            o.reasons.push(reason.to_string());
        }
        o.chunks = o.chunks.saturating_sub(1);
        let (dropped, reasons) = (o.dropped, o.reasons.join(", "));
        if o.exported {
            let update = self.priority.iter_mut().flat_map(|b| b.spans.iter_mut()).find(|s| is_marked(s, "ivy.update") && s["spanId"] == id.as_str() && spans::attr(s, "ivy.dropped_spans").is_some());
            match update {
                Some(span) => {
                    spans::set_attr(span, "ivy.dropped_spans", Attr::Int(dropped));
                    spans::set_attr(span, "ivy.dropped_spans.reason", Attr::Str(reasons));
                }
                None => {
                    let root = &o.root;
                    let span = json!({
                        "traceId": root.trace_id,
                        "spanId": root.span_id,
                        "name": root.name,
                        "kind": root.kind,
                        "startTimeUnixNano": root.start,
                        "endTimeUnixNano": root.end,
                        "attributes": [
                            spans::kv("ivy.update", Attr::Bool(true)),
                            spans::kv("faas.invocation_id", Attr::Str(root.request_id.clone())),
                            spans::kv("ivy.dropped_spans", Attr::Int(dropped)),
                            spans::kv("ivy.dropped_spans.reason", Attr::Str(reasons)),
                        ],
                        "events": [],
                        "status": { "code": 0 },
                    });
                    let resource = root.resource.clone();
                    self.queued += 1;
                    self.priority.push_back(Batch { resource, spans: vec![span] });
                }
            }
        } else if let Some(root) = self.priority.iter_mut().flat_map(|b| b.spans.iter_mut()).find(|s| spans::is_root(s) && s["spanId"] == id.as_str()) {
            spans::set_attr(root, "ivy.dropped_spans", Attr::Int(dropped));
            spans::set_attr(root, "ivy.dropped_spans.reason", Attr::Str(reasons));
        }
        self.forget_owner_if_done(&id);
    }

    fn forget_owner_if_done(&mut self, id: &str) {
        if self.owners.get(id).is_some_and(|o| o.exported && o.chunks == 0) {
            self.owners.remove(id);
        }
    }

    fn fail(&mut self, result: &SendResult) {
        self.report.failure = result.error.clone().or(Some("error".into()));
        self.backoff_ms = if self.backoff_ms == 0 { MIN_BACKOFF_MS } else { (self.backoff_ms * 2).min(MAX_BACKOFF_MS) };
        let now = (self.now)();
        self.next_attempt_at = now + self.backoff_ms;
        if let Some(ms) = result.retry_after_ms {
            self.pause_until = now + ms.min(MAX_RETRY_AFTER_MS);
            self.next_attempt_at = self.next_attempt_at.max(self.pause_until);
        }
        self.report.paused_ms = Some(self.next_attempt_at - now);
    }

    fn succeed(&mut self) {
        self.backoff_ms = 0;
        self.next_attempt_at = 0;
    }

    /// Exports within `budget_ms`: priority spans first, then child chunks one request at a time.
    /// `force` ignores the failure backoff (shutdown) but not a server's Retry-After.
    pub fn flush(&mut self, budget_ms: u64, force: bool) {
        let now = (self.now)();
        if now < self.pause_until || (!force && now < self.next_attempt_at) {
            return;
        }
        let deadline = now + budget_ms;
        let remaining = |q: &Self| deadline.saturating_sub((q.now)());

        while !self.priority.is_empty() && remaining(self) > 50 {
            let mut taken = Vec::new();
            let (mut count, mut bytes) = (0, 0);
            while let Some(next) = self.priority.front() {
                let size: usize = next.spans.iter().map(size_of).sum();
                if !taken.is_empty() && (count + next.spans.len() > self.limits.chunk_spans || bytes + size > self.limits.chunk_bytes) {
                    break;
                }
                count += next.spans.len();
                bytes += size;
                taken.extend(self.priority.pop_front());
            }
            self.queued -= count;
            let body = build_export_request(&taken).to_string().into_bytes();
            let result = self.exporter.send(body, Duration::from_millis(remaining(self)));
            let roots: Vec<&Value> = taken.iter().flat_map(|b| b.spans.iter()).filter(|s| spans::is_root(s)).collect();
            if result.ok {
                self.succeed();
                self.report.invocations += roots.len();
                for root in roots {
                    self.report.collapsed += int_attr(root, "ivy.collapsed_calls");
                    self.report.dropped += int_attr(root, "ivy.dropped_spans");
                    if let Some(id) = root.get("spanId").and_then(Value::as_str).map(String::from) {
                        if let Some(o) = self.owners.get_mut(&id) {
                            o.exported = true;
                        }
                        self.forget_owner_if_done(&id);
                    }
                }
            } else {
                for root in roots {
                    if let Some(id) = root.get("spanId").and_then(Value::as_str) {
                        self.owners.remove(id);
                    }
                }
                self.report.dropped += count as i64;
                (self.log)(&format!("dropped {count} invocation and update spans (export failed)"));
                self.fail(&result);
                return;
            }
        }

        while !self.chunks.is_empty() && remaining(self) > 50 {
            let mut taken: Vec<Chunk> = Vec::new();
            let (mut count, mut bytes) = (0, 0);
            while let Some(next) = self.chunks.front() {
                if !taken.is_empty() && (count + next.spans.len() > self.limits.chunk_spans || bytes + next.bytes > self.limits.chunk_bytes) {
                    break;
                }
                count += next.spans.len();
                bytes += next.bytes;
                taken.extend(self.chunks.pop_front());
            }
            self.queued -= count;
            let batches: Vec<Batch> = taken.iter().map(|c| Batch { resource: c.resource.clone(), spans: c.spans.clone() }).collect();
            let body = build_export_request(&batches).to_string().into_bytes();
            let result = self.exporter.send(body, Duration::from_millis(remaining(self)));
            if result.ok {
                self.succeed();
                self.report.chunks += 1;
                for c in taken {
                    if let Some(id) = c.owner {
                        if let Some(o) = self.owners.get_mut(&id) {
                            o.chunks = o.chunks.saturating_sub(1);
                        }
                        self.forget_owner_if_done(&id);
                    }
                }
            } else {
                for c in taken {
                    self.lose_chunk(c, "export failed");
                }
                self.fail(&result);
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    type Script = Rc<RefCell<VecDeque<SendResult>>>;

    struct Fake {
        results: Script,
        sent: Rc<RefCell<Vec<Value>>>,
        time: Rc<Cell<u64>>,
        /// Simulated time each request takes.
        cost_ms: u64,
    }

    impl Exporter for Fake {
        fn send(&mut self, body: Vec<u8>, _budget: Duration) -> SendResult {
            self.sent.borrow_mut().push(serde_json::from_slice(&body).unwrap());
            self.time.set(self.time.get() + self.cost_ms);
            self.results.borrow_mut().pop_front().unwrap_or_else(SendResult::ok)
        }
    }

    struct Setup {
        q: ExportQueue<Fake>,
        sent: Rc<RefCell<Vec<Value>>>,
        time: Rc<Cell<u64>>,
    }

    fn fail() -> SendResult {
        SendResult::failed("HTTP 503".into(), None)
    }

    fn setup_with(results: Vec<SendResult>, limits: Limits, cost_ms: u64) -> Setup {
        let sent = Rc::new(RefCell::new(Vec::new()));
        let time = Rc::new(Cell::new(1_000_000));
        let t = time.clone();
        let fake = Fake { results: Rc::new(RefCell::new(results.into())), sent: sent.clone(), time: time.clone(), cost_ms };
        let q = ExportQueue::new(fake, limits, Box::new(move || t.get()), Box::new(|_| {}));
        Setup { q, sent, time }
    }

    fn setup(results: Vec<SendResult>, max_queue_spans: usize) -> Setup {
        setup_with(results, Limits { max_queue_spans, ..Limits::default() }, 0)
    }

    fn span(id: &str) -> Value {
        json!({ "traceId": "t".repeat(32), "spanId": id, "name": "x", "kind": 1, "attributes": [], "events": [], "status": { "code": 0 } })
    }

    fn root(id: &str) -> Value {
        let mut s = span(id);
        spans::set_attr(&mut s, "ivy.invocation", Attr::Bool(true));
        spans::set_attr(&mut s, "faas.invocation_id", Attr::Str(format!("req-{id}")));
        s
    }

    fn batch(ids: &[&str]) -> Batch {
        Batch { resource: json!([]), spans: ids.iter().map(|id| span(id)).collect() }
    }

    /// An invocation: its root plus `n` children.
    fn invocation(id: &str, n: usize) -> Batch {
        let mut spans = vec![root(id)];
        spans.extend((0..n).map(|i| span(&format!("{id}-{i}"))));
        Batch { resource: json!([]), spans }
    }

    fn request_spans(req: &Value) -> Vec<Value> {
        req["resourceSpans"].as_array().unwrap().iter().flat_map(|rs| rs["scopeSpans"][0]["spans"].as_array().unwrap().clone()).collect()
    }

    fn ids(req: &Value) -> Vec<String> {
        request_spans(req).iter().map(|s| s["spanId"].as_str().unwrap().to_string()).collect()
    }

    fn int(span: &Value, key: &str) -> i64 {
        int_attr(span, key)
    }

    #[test]
    fn exports_queued_batches() {
        let mut s = setup(vec![], 10);
        s.q.add(batch(&["a", "b"]));
        s.q.flush(1000, false);
        assert_eq!(s.sent.borrow().len(), 1);
        assert_eq!(s.q.size(), 0);
        let req = &s.sent.borrow()[0];
        assert_eq!(req["resourceSpans"][0]["scopeSpans"][0]["scope"]["name"], "ivy-layer");
        assert_eq!(ids(req), ["a", "b"]);
    }

    #[test]
    fn sends_the_invocation_span_first_in_its_own_request_then_the_children_in_chunks() {
        let mut s = setup(vec![], 10_000);
        let mut inv = invocation("r", 1200);
        inv.spans.rotate_left(1); // the root arrives last
        s.q.add(inv);
        s.q.flush(5000, false);
        let sent = s.sent.borrow();
        assert_eq!(ids(&sent[0]), ["r"]);
        let counts: Vec<usize> = sent[1..].iter().map(|r| request_spans(r).len()).collect();
        assert_eq!(counts, [500, 500, 200]);
        assert_eq!(s.q.take_report(), Report { invocations: 1, chunks: 3, ..Report::default() });
    }

    #[test]
    fn chunks_respect_the_byte_limit_and_trim_a_span_larger_than_a_chunk() {
        let limits = Limits { chunk_bytes: 4096, ..Limits::default() };
        let mut s = setup_with(vec![], limits, 0);
        let mut inv = invocation("r", 20);
        for (i, child) in inv.spans.iter_mut().skip(1).enumerate() {
            spans::set_attr(child, "ivy.payload.request", Attr::Str("p".repeat(if i == 0 { 10_000 } else { 1000 })));
        }
        s.q.add(inv);
        s.q.flush(5000, false);
        let sent = s.sent.borrow();
        let children: Vec<Value> = sent[1..].iter().flat_map(request_spans).collect();
        assert_eq!(children.len(), 20, "no child is dropped");
        for req in &sent[1..] {
            assert!(request_spans(req).iter().map(size_of).sum::<usize>() <= 4096);
        }
        let big = children.iter().find(|c| c["spanId"] == "r-0").unwrap();
        assert!(spans::attr(big, "ivy.payload.request").is_none());
        assert!(is_marked(big, "ivy.payload.trimmed"));
    }

    #[test]
    fn the_budget_grows_with_the_chunks_and_is_capped() {
        let mut s = setup(vec![], 100_000);
        assert_eq!(s.q.budget_ms(), 2000);
        s.q.add(invocation("a", 1200));
        assert_eq!(s.q.budget_ms(), 3500);
        s.q.add(invocation("b", 5000));
        assert_eq!(s.q.budget_ms(), 5000);
    }

    #[test]
    fn stops_sending_chunks_when_the_budget_runs_out_and_keeps_the_rest_for_later() {
        let mut s = setup_with(vec![], Limits { max_queue_spans: 100_000, ..Limits::default() }, 1000);
        s.q.add(invocation("r", 3000));
        let started = s.time.get();
        let budget = s.q.budget_ms();
        s.q.flush(budget, false);
        assert!(s.time.get() - started <= budget + 1000, "one request may still be in flight at the deadline");
        assert_eq!(ids(&s.sent.borrow()[0]), ["r"]);
        assert!(s.q.size() > 0);
        s.q.flush(s.q.budget_ms(), false);
        assert_eq!(s.q.size(), 0);
    }

    #[test]
    fn a_failed_chunk_is_reported_on_the_already_exported_invocation_span_as_an_update() {
        let mut s = setup(vec![SendResult::ok(), fail()], 10_000);
        s.q.add(invocation("r", 600));
        s.q.flush(5000, false);
        assert_eq!(s.sent.borrow().len(), 2);
        let report = s.q.take_report();
        assert_eq!((report.invocations, report.chunks, report.dropped), (1, 0, 500));
        assert_eq!(report.failure.as_deref(), Some("HTTP 503"));
        // After the backoff: the update first, then the remaining chunk.
        s.time.set(s.time.get() + 10_000);
        s.q.flush(5000, false);
        let sent = s.sent.borrow();
        let update = &request_spans(&sent[2])[0];
        assert!(is_marked(update, "ivy.update") && update["spanId"] == "r");
        assert_eq!(int(update, "ivy.dropped_spans"), 500);
        assert_eq!(str_attr(update, "ivy.dropped_spans.reason").as_deref(), Some("export failed"));
        assert_eq!(request_spans(&sent[3]).len(), 100);
    }

    #[test]
    fn the_queue_cap_drops_the_oldest_child_chunks_and_never_the_invocation_spans() {
        let mut s = setup(vec![], 1000);
        s.q.add(invocation("a", 600));
        s.q.add(invocation("b", 600));
        s.q.flush(5000, false);
        let sent = s.sent.borrow();
        let all: Vec<String> = sent.iter().flat_map(ids).collect();
        assert!(all.contains(&"a".to_string()) && all.contains(&"b".to_string()));
        assert!(!all.contains(&"a-0".to_string()), "a's first chunk was the oldest");
        assert_eq!(all.len(), 702);
        let root_a = sent.iter().flat_map(request_spans).find(|s| s["spanId"] == "a").unwrap();
        assert_eq!(int(&root_a, "ivy.dropped_spans"), 500);
        assert_eq!(str_attr(&root_a, "ivy.dropped_spans.reason").as_deref(), Some("queue full"));
    }

    #[test]
    fn keeps_the_tracers_own_dropped_count_and_adds_to_it() {
        let mut s = setup(vec![], 1000);
        let mut a = invocation("a", 600);
        spans::set_attr(&mut a.spans[0], "ivy.dropped_spans", Attr::Int(37));
        spans::set_attr(&mut a.spans[0], "ivy.dropped_spans.reason", Attr::Str("span limit".into()));
        spans::set_attr(&mut a.spans[0], "ivy.collapsed_calls", Attr::Int(1184));
        s.q.add(a);
        s.q.add(invocation("b", 600));
        s.q.flush(5000, false);
        let root_a = s.sent.borrow().iter().flat_map(request_spans).find(|s| s["spanId"] == "a").unwrap();
        assert_eq!(int(&root_a, "ivy.dropped_spans"), 537);
        assert_eq!(str_attr(&root_a, "ivy.dropped_spans.reason").as_deref(), Some("span limit, queue full"));
        let report = s.q.take_report();
        assert_eq!(report.collapsed, 1184);
        assert_eq!(report.dropped, 537, "counted once, through the invocation span");
        assert_eq!(report.line(42), "[ivy] exported 2 invocations, 3 chunks, collapsed 1,184 calls, dropped 537 spans (42 ms)");
    }

    #[test]
    fn invocation_spans_go_only_when_nothing_else_is_left() {
        let mut s = setup(vec![], 3);
        for id in ["a", "b", "c", "d"] {
            s.q.add(invocation(id, 0));
        }
        s.q.flush(5000, false);
        assert_eq!(s.sent.borrow().iter().flat_map(ids).collect::<Vec<_>>(), ["b", "c", "d"]);
    }

    #[test]
    fn retry_after_pauses_even_forced_flushes() {
        let mut s = setup(vec![SendResult::failed("HTTP 429".into(), Some(30_000))], 100);
        s.q.add(invocation("a", 1));
        s.q.flush(1000, false);
        assert_eq!(s.q.take_report().paused_ms, Some(30_000));
        s.q.add(invocation("b", 1));
        s.time.set(s.time.get() + 10_000);
        s.q.flush(1000, true);
        assert_eq!(s.sent.borrow().len(), 1);
        s.time.set(s.time.get() + 25_000);
        s.q.flush(1000, false);
        assert_eq!(s.sent.borrow().len(), 3);
    }

    #[test]
    fn backoff_doubles_up_to_five_minutes_and_resets_on_success() {
        let mut s = setup(vec![fail(); 12], 10_000);
        let mut gaps = Vec::new();
        for _ in 0..8 {
            s.q.add(batch(&["a"]));
            s.q.flush(1000, false);
            gaps.push(s.q.next_attempt_at - s.time.get());
            s.time.set(s.q.next_attempt_at);
        }
        assert_eq!(gaps, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);

        let mut ok = setup(vec![fail(), SendResult::ok()], 10);
        ok.q.add(batch(&["a"]));
        ok.q.flush(1000, false);
        ok.time.set(ok.time.get() + 5_000);
        ok.q.add(batch(&["b"]));
        ok.q.flush(1000, false);
        assert_eq!(ok.q.backoff_ms, 0);
        assert_eq!(ok.q.next_attempt_at, 0);
    }

    #[test]
    fn force_flush_ignores_the_backoff() {
        let mut s = setup(vec![fail()], 10);
        s.q.add(batch(&["a"]));
        s.q.flush(1000, false);
        s.q.add(batch(&["b"]));
        s.q.flush(1000, true);
        assert_eq!(s.sent.borrow().len(), 2);
    }

    #[test]
    fn groups_spans_by_resource() {
        let a = Batch { resource: json!([{"key": "service.name", "value": {"stringValue": "a"}}]), spans: vec![span("1")] };
        let b = Batch { resource: json!([{"key": "service.name", "value": {"stringValue": "b"}}]), spans: vec![span("2")] };
        let req = build_export_request(&[a.clone(), b, a]);
        let rs = req["resourceSpans"].as_array().unwrap();
        assert_eq!(rs.len(), 2);
        assert_eq!(rs[0]["scopeSpans"][0]["spans"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn formats_failure_lines() {
        let r = Report { invocations: 0, chunks: 0, collapsed: 0, dropped: 2345, failure: Some("HTTP 503".into()), paused_ms: Some(5000) };
        assert!(r.notable());
        assert_eq!(r.line(1520), "[ivy] export failed (HTTP 503); exported 0 invocations, 0 chunks, collapsed 0 calls, dropped 2,345 spans (1520 ms); next attempt in 5 s");
        assert!(!Report { invocations: 1, chunks: 1, ..Report::default() }.notable());
    }
}
