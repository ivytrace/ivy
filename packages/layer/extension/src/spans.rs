//! OTLP JSON span helpers for the spans the extension writes itself: synthetic invocation roots
//! for failures the tracer could not report, and report updates. See docs/implementation/platform-failures.md.

use crate::platform::{LogLine, Report};
use serde_json::{json, Value};
use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

pub const KIND_INTERNAL: u64 = 1;
pub const STATUS_ERROR: u64 = 2;

/// What is known about the invocation a failure belongs to.
#[derive(Debug, Clone, Default)]
pub struct InvocationContext {
    pub request_id: Option<String>,
    pub function_arn: Option<String>,
    pub start_ms: i64,
    pub cold_start: bool,
}

/// Invocation span IDs derived from the request ID, the same way the tracer derives them
/// (`src/lib/utils/ids.ts`): FNV-1a 32 of `"<i>:<request id>"` for i = 0..5, as 40 hex chars. The span ID is the
/// first 16; the trace ID is the start second (8 hex chars) plus the other 24. So the extension knows at `INVOKE`
/// which IDs the tracer's invocation span will have.
pub fn derived_ids(request_id: &str, start_ms: i64) -> (String, String) {
    let hex: String = (0..5)
        .map(|i| {
            let mut h: u32 = 0x811c_9dc5;
            for b in format!("{i}:{request_id}").bytes() {
                h ^= b as u32;
                h = h.wrapping_mul(0x0100_0193);
            }
            format!("{h:08x}")
        })
        .collect();
    let mut span_id = hex[..16].to_string();
    if span_id == "0000000000000000" {
        span_id = "0000000000000001".into();
    }
    (format!("{:08x}{}", (start_ms / 1000) as u32, &hex[16..]), span_id)
}

/// Provisional invocation span for an invocation that is still running (`ivy.in_progress`). The final span has
/// the same IDs and supersedes it.
pub fn in_progress_root(ctx: &InvocationContext, function_name: &str, trace_id: &str, span_id: &str, deadline_ms: i64, now_ms: i64) -> Value {
    let mut attrs = vec![
        kv("ivy.invocation", Attr::Bool(true)),
        kv("ivy.in_progress", Attr::Bool(true)),
        kv("faas.coldstart", Attr::Bool(ctx.cold_start)),
        kv("ivy.deadline_ms", Attr::Int(deadline_ms)),
        kv("ivy.last_seen_ms", Attr::Int(now_ms)),
    ];
    if let Some(id) = &ctx.request_id {
        attrs.push(kv("faas.invocation_id", Attr::Str(id.clone())));
    }
    if let Some(arn) = &ctx.function_arn {
        attrs.push(kv("cloud.resource_id", Attr::Str(arn.clone())));
    }
    json!({
        "traceId": trace_id,
        "spanId": span_id,
        "name": function_name,
        "kind": KIND_INTERNAL,
        "startTimeUnixNano": nanos(ctx.start_ms),
        "endTimeUnixNano": nanos(now_ms.max(ctx.start_ms)),
        "attributes": attrs,
        "events": [],
        "status": { "code": 0 },
    })
}

/// Enough of an exported root to address a later update to it.
#[derive(Debug, Clone, PartialEq)]
pub struct RootRef {
    pub request_id: String,
    pub trace_id: String,
    pub span_id: String,
    pub name: String,
    pub kind: Value,
    pub start: Value,
    pub end: Value,
    pub resource: Value,
}

pub enum Attr {
    Str(String),
    Int(i64),
    Double(f64),
    Bool(bool),
}

fn any_value(v: &Attr) -> Value {
    match v {
        Attr::Str(s) => json!({ "stringValue": s }),
        Attr::Int(i) => json!({ "intValue": i.to_string() }),
        Attr::Double(d) => json!({ "doubleValue": d }),
        Attr::Bool(b) => json!({ "boolValue": b }),
    }
}

pub fn kv(key: &str, v: Attr) -> Value {
    json!({ "key": key, "value": any_value(&v) })
}

/// Sets (or replaces) an attribute on an OTLP span.
pub fn set_attr(span: &mut Value, key: &str, v: Attr) {
    let Some(obj) = span.as_object_mut() else { return };
    let attrs = obj.entry("attributes").or_insert_with(|| json!([]));
    if !attrs.is_array() {
        *attrs = json!([]);
    }
    if let Some(list) = attrs.as_array_mut() {
        list.retain(|a| a.get("key").and_then(Value::as_str) != Some(key));
        list.push(kv(key, v));
    }
}

pub fn attr<'a>(span: &'a Value, key: &str) -> Option<&'a Value> {
    span.get("attributes")?.as_array()?.iter().find(|a| a.get("key").and_then(Value::as_str) == Some(key)).and_then(|a| a.get("value"))
}

pub fn is_root(span: &Value) -> bool {
    attr(span, "ivy.invocation").and_then(|v| v.get("boolValue")).and_then(Value::as_bool) == Some(true)
}

pub fn has_error_status(span: &Value) -> bool {
    span.pointer("/status/code").and_then(Value::as_u64) == Some(STATUS_ERROR)
}

pub fn epoch_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn nanos(ms: i64) -> Value {
    Value::String(format!("{}", ms.max(0) as u128 * 1_000_000))
}

fn nanos_of(v: Option<&Value>) -> u128 {
    v.and_then(Value::as_str).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn log_event(line: &LogLine, redact: &dyn Fn(&str) -> String) -> Value {
    json!({
        "timeUnixNano": nanos(line.time_ms),
        "name": "log",
        "attributes": [kv("log.severity", Attr::Str(line.severity.clone())), kv("log.message", Attr::Str(redact(&line.message)))],
    })
}

/// Marks a root span as failed by the platform: error status and type, phase, end time, log tail.
#[allow(clippy::too_many_arguments)]
pub fn apply_failure(span: &mut Value, error_type: &str, message: &str, phase: &str, status: &str, end_ms: i64, logs: &[LogLine], redact: &dyn Fn(&str) -> String) {
    set_attr(span, "error.type", Attr::Str(error_type.into()));
    set_attr(span, "ivy.failure.phase", Attr::Str(phase.into()));
    set_attr(span, "ivy.platform.status", Attr::Str(status.into()));
    let Some(obj) = span.as_object_mut() else { return };
    obj.insert("status".into(), json!({ "code": STATUS_ERROR, "message": message }));
    let start = nanos_of(obj.get("startTimeUnixNano"));
    let end = nanos_of(obj.get("endTimeUnixNano"));
    let platform_end = end_ms.max(0) as u128 * 1_000_000;
    if end <= start || platform_end > end {
        obj.insert("endTimeUnixNano".into(), Value::String(platform_end.max(start).to_string()));
    }
    let events = obj.entry("events").or_insert_with(|| json!([]));
    if let Some(list) = events.as_array_mut() {
        list.extend(logs.iter().map(|l| log_event(l, redact)));
    }
}

/// An invocation root for a failure where the tracer produced nothing (init errors, crashes).
pub fn synthetic_root(ctx: &InvocationContext, function_name: &str, ids: Option<(String, String)>) -> Value {
    let mut attrs = vec![
        kv("ivy.invocation", Attr::Bool(true)),
        kv("ivy.synthetic", Attr::Bool(true)),
        kv("faas.coldstart", Attr::Bool(ctx.cold_start)),
        kv("faas.trigger", Attr::Str("other".into())),
        kv("ivy.trigger.source", Attr::Str("unknown".into())),
    ];
    if let Some(id) = &ctx.request_id {
        attrs.push(kv("faas.invocation_id", Attr::Str(id.clone())));
    }
    if let Some(arn) = &ctx.function_arn {
        attrs.push(kv("cloud.resource_id", Attr::Str(arn.clone())));
    }
    let (trace, span) = ids.unwrap_or_else(|| (trace_id(ctx.start_ms), random_hex(8)));
    json!({
        "traceId": trace,
        "spanId": span,
        "name": function_name,
        "kind": KIND_INTERNAL,
        "startTimeUnixNano": nanos(ctx.start_ms),
        "endTimeUnixNano": nanos(ctx.start_ms),
        "attributes": attrs,
        "events": [],
        "status": { "code": 0 },
    })
}

pub fn root_ref(request_id: &str, span: &Value, resource: &Value) -> Option<RootRef> {
    let text = |k: &str| span.get(k).and_then(Value::as_str).map(String::from);
    Some(RootRef {
        request_id: request_id.to_string(),
        trace_id: text("traceId")?,
        span_id: text("spanId")?,
        name: text("name").unwrap_or_default(),
        kind: span.get("kind").cloned().unwrap_or(json!(KIND_INTERNAL)),
        start: span.get("startTimeUnixNano").cloned().unwrap_or(json!("0")),
        end: span.get("endTimeUnixNano").cloned().unwrap_or(json!("0")),
        resource: resource.clone(),
    })
}

/// Report metrics as attributes; applied to a root that is still in the store, or sent as an update.
pub fn report_attrs(report: &Report) -> Vec<(&'static str, Attr)> {
    let mut out = Vec::new();
    if let Some(v) = report.billed_duration_ms {
        out.push(("ivy.billed_duration_ms", Attr::Int(v)));
    }
    if let Some(v) = report.max_memory_used_mb {
        out.push(("ivy.memory_max_used_mb", Attr::Int(v)));
    }
    if let Some(v) = report.memory_size_mb {
        out.push(("ivy.memory_size_mb", Attr::Int(v)));
    }
    if let Some(v) = report.init_duration_ms {
        out.push(("ivy.init_duration_ms", Attr::Double(v)));
    }
    if let Some(v) = report.restore_duration_ms {
        out.push(("ivy.restore_duration_ms", Attr::Double(v)));
    }
    out
}

/// A span with the root's trace and span ID that only carries report attributes and
/// `ivy.update = true`; the backend merges it into the root (it is not an invocation).
pub fn update_span(root: &RootRef, report: &Report) -> Value {
    let mut attrs = vec![kv("ivy.update", Attr::Bool(true)), kv("faas.invocation_id", Attr::Str(root.request_id.clone()))];
    attrs.extend(report_attrs(report).into_iter().map(|(k, v)| kv(k, v)));
    json!({
        "traceId": root.trace_id,
        "spanId": root.span_id,
        "name": root.name,
        "kind": root.kind,
        "startTimeUnixNano": root.start,
        "endTimeUnixNano": root.end,
        "attributes": attrs,
        "events": [],
        "status": { "code": 0 },
    })
}

/// Resource attributes for a synthetic root when the tracer never sent any.
pub fn env_resource(env: &dyn Fn(&str) -> Option<String>, account_id: Option<&str>) -> Value {
    let name = env("AWS_LAMBDA_FUNCTION_NAME").unwrap_or_else(|| "unknown".into());
    let mut attrs = vec![
        kv("service.name", Attr::Str(name.clone())),
        kv("cloud.provider", Attr::Str("aws".into())),
        kv("cloud.platform", Attr::Str("aws_lambda".into())),
        kv("faas.name", Attr::Str(name)),
        kv("telemetry.sdk.name", Attr::Str("ivy-layer".into())),
    ];
    if let Some(region) = env("AWS_REGION").or_else(|| env("AWS_DEFAULT_REGION")) {
        attrs.push(kv("cloud.region", Attr::Str(region)));
    }
    if let Some(account) = account_id {
        attrs.push(kv("cloud.account.id", Attr::Str(account.into())));
    }
    if let Some(version) = env("AWS_LAMBDA_FUNCTION_VERSION") {
        attrs.push(kv("faas.version", Attr::Str(version)));
    }
    if let Some(mb) = env("AWS_LAMBDA_FUNCTION_MEMORY_SIZE").and_then(|m| m.parse::<i64>().ok()) {
        attrs.push(kv("faas.max_memory", Attr::Int(mb * 1024 * 1024)));
    }
    Value::Array(attrs)
}

pub fn function_name(resource: &Value) -> Option<String> {
    resource.as_array()?.iter().find(|a| a["key"] == "faas.name")?.pointer("/value/stringValue")?.as_str().map(String::from)
}

/// Same layout as the tracer's IDs: 8 hex chars of unix seconds + 24 random.
pub fn trace_id(now_ms: i64) -> String {
    format!("{:08x}{}", (now_ms / 1000) as u32, random_hex(12))
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    let ok = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).is_ok();
    if !ok {
        let mut x = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1) ^ (std::process::id() as u64) << 32;
        for b in buf.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = x as u8;
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_the_tracer_layout() {
        let t = trace_id(1_700_000_000_000);
        assert_eq!(t.len(), 32);
        assert!(t.starts_with("6553f100"));
        assert_eq!(random_hex(8).len(), 16);
        assert_ne!(random_hex(8), random_hex(8));
    }

    #[test]
    fn derived_ids_match_the_tracer() {
        // The same request ID and values as src/lib/utils/ids.test.ts.
        let (trace, span) = derived_ids("8f1c2a7e-3b9d-4c55-9a51-0f6f1e2b7c3d", 1_700_000_000_123);
        assert_eq!((trace.as_str(), span.as_str()), ("6553f100306e643c836b93bd7315f15e", "aa43ecc22bca145b"));
        assert_eq!((trace, span.clone()), derived_ids("8f1c2a7e-3b9d-4c55-9a51-0f6f1e2b7c3d", 1_700_000_000_999));
        assert_ne!(span, derived_ids("8f1c2a7e-3b9d-4c55-9a51-0f6f1e2b7c3e", 0).1);
    }

    #[test]
    fn apply_failure_extends_the_end_time_and_appends_logs() {
        let mut s = json!({ "startTimeUnixNano": nanos(1000), "endTimeUnixNano": nanos(1000), "attributes": [kv("error.type", Attr::Str("Timeout".into()))], "events": [] });
        let logs = vec![LogLine { time_ms: 1500, severity: "error".into(), message: "token=abc".into() }];
        apply_failure(&mut s, "Sandbox.Timedout", "Task timed out", "invoke", "timeout", 3000, &logs, &|m| m.replace("abc", "[redacted]"));
        assert_eq!(s["endTimeUnixNano"], nanos(3000));
        assert_eq!(attr(&s, "error.type").unwrap()["stringValue"], "Sandbox.Timedout");
        assert_eq!(s["attributes"].as_array().unwrap().iter().filter(|a| a["key"] == "error.type").count(), 1);
        assert_eq!(s["status"], json!({ "code": 2, "message": "Task timed out" }));
        assert_eq!(s["events"][0]["attributes"][1]["value"]["stringValue"], "token=[redacted]");
    }
}
