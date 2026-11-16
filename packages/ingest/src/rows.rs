//! `ivy.otel_traces` rows in ClickHouse RowBinary, mapped exactly like the OpenTelemetry Collector's ClickHouse
//! exporter (the materialized views depend on its strings: `Server`, `Error`, attribute values via `AsString`).

use crate::otlp::{Attributes, Request, Span, Value};
use base64::Engine;

pub const COLUMNS: &str = "Timestamp, TraceId, SpanId, ParentSpanId, TraceState, SpanName, SpanKind, ServiceName, \
ResourceAttributes, ScopeName, ScopeVersion, SpanAttributes, Duration, StatusCode, StatusMessage, \
`Events.Timestamp`, `Events.Name`, `Events.Attributes`, `Links.TraceId`, `Links.SpanId`, `Links.TraceState`, `Links.Attributes`";

pub struct Encoded {
    pub rows: Vec<u8>,
    pub spans: u64,
    pub invocations: u64,
}

/// Encodes every span; the resource attributes get `ivy.tenant_id` / `ivy.project_id` (client values replaced).
pub fn encode(req: &Request, tenant: &str, project: &str) -> Encoded {
    let mut out = Encoded { rows: Vec::with_capacity(4096), spans: 0, invocations: 0 };
    for rs in &req.resource_spans {
        let mut resource: Attributes = rs
            .attributes
            .iter()
            .filter(|(k, _)| k != "ivy.tenant_id" && k != "ivy.project_id")
            .cloned()
            .collect();
        resource.push(("ivy.tenant_id".into(), Value::Str(tenant.into())));
        resource.push(("ivy.project_id".into(), Value::Str(project.into())));
        let service = resource.iter().find(|(k, _)| k == "service.name").map(|(_, v)| as_string(v)).unwrap_or_default();
        let mut resource_bytes = Vec::new();
        write_map(&mut resource_bytes, &resource);
        for ss in &rs.scope_spans {
            for span in &ss.spans {
                write_span(&mut out.rows, span, &service, &resource_bytes, &ss.name, &ss.version);
                out.spans += 1;
                if crate::otlp::is_invocation(span) {
                    out.invocations += 1;
                }
            }
        }
    }
    out
}

fn write_span(b: &mut Vec<u8>, s: &Span, service: &str, resource: &[u8], scope: &str, version: &str) {
    write_i64(b, s.start as i64);
    write_str(b, &hex_id(&s.trace_id));
    write_str(b, &hex_id(&s.span_id));
    write_str(b, &hex_id(&s.parent_span_id));
    write_str(b, &s.trace_state);
    write_str(b, &s.name);
    write_str(b, span_kind(s.kind));
    write_str(b, service);
    b.extend_from_slice(resource);
    write_str(b, scope);
    write_str(b, version);
    write_map(b, &s.attributes);
    b.extend_from_slice(&s.end.wrapping_sub(s.start).to_le_bytes());
    write_str(b, status_code(s.status_code));
    write_str(b, &s.status_message);
    write_len(b, s.events.len());
    for e in &s.events {
        write_i64(b, e.time as i64);
    }
    write_len(b, s.events.len());
    for e in &s.events {
        write_str(b, &e.name);
    }
    write_len(b, s.events.len());
    for e in &s.events {
        write_map(b, &e.attributes);
    }
    write_len(b, s.links.len());
    for l in &s.links {
        write_str(b, &hex_id(&l.trace_id));
    }
    write_len(b, s.links.len());
    for l in &s.links {
        write_str(b, &hex_id(&l.span_id));
    }
    write_len(b, s.links.len());
    for l in &s.links {
        write_str(b, &l.trace_state);
    }
    write_len(b, s.links.len());
    for l in &s.links {
        write_map(b, &l.attributes);
    }
}

fn write_len(b: &mut Vec<u8>, mut n: usize) {
    while n > 0x7f {
        b.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    b.push(n as u8);
}

fn write_str(b: &mut Vec<u8>, s: &str) {
    write_len(b, s.len());
    b.extend_from_slice(s.as_bytes());
}

fn write_i64(b: &mut Vec<u8>, n: i64) {
    b.extend_from_slice(&n.to_le_bytes());
}

/// Map columns sorted by key, as the exporter's driver writes them.
fn write_map(b: &mut Vec<u8>, attrs: &Attributes) {
    let mut sorted: Vec<&(String, Value)> = attrs.iter().collect();
    sorted.sort_by(|x, y| x.0.cmp(&y.0));
    write_len(b, sorted.len());
    for (k, v) in sorted {
        write_str(b, k);
        write_str(b, &as_string(v));
    }
}

/// Lowercase hex; an all-zero (or missing) ID is "" (`TraceIDToHexOrEmptyString`).
fn hex_id(id: &[u8]) -> String {
    if id.iter().all(|&x| x == 0) {
        return String::new();
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(id.len() * 2);
    for &x in id {
        s.push(HEX[(x >> 4) as usize] as char);
        s.push(HEX[(x & 15) as usize] as char);
    }
    s
}

fn span_kind(kind: i32) -> &'static str {
    match kind {
        0 => "Unspecified",
        1 => "Internal",
        2 => "Server",
        3 => "Client",
        4 => "Producer",
        5 => "Consumer",
        _ => "",
    }
}

fn status_code(code: i32) -> &'static str {
    match code {
        0 => "Unset",
        1 => "Ok",
        2 => "Error",
        _ => "",
    }
}

/// pcommon `Value.AsString`: maps and slices as JSON (keys sorted, no HTML escaping), doubles like ES6.
pub fn as_string(v: &Value) -> String {
    match v {
        Value::Empty => String::new(),
        Value::Str(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Int(i) => i.to_string(),
        Value::Double(f) => es6_number(*f),
        Value::Bytes(b) => base64::engine::general_purpose::STANDARD.encode(b),
        Value::Array(_) | Value::Map(_) => json(v),
    }
}

fn json(v: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, v);
    out
}

fn write_json(out: &mut String, v: &Value) {
    match v {
        Value::Empty => out.push_str("null"),
        Value::Str(s) => out.push_str(&serde_json::to_string(s).unwrap()),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Int(i) => out.push_str(&i.to_string()),
        Value::Double(f) if f.is_finite() => out.push_str(&es6_number(*f)),
        // encoding/json can't encode NaN/Inf; AsRaw maps hold them only in odd payloads.
        Value::Double(_) => out.push_str("null"),
        Value::Bytes(b) => out.push_str(&serde_json::to_string(&base64::engine::general_purpose::STANDARD.encode(b)).unwrap()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Value::Map(kvs) => {
            // A Go map: sorted keys, the last duplicate wins.
            let mut sorted: std::collections::BTreeMap<&str, &Value> = std::collections::BTreeMap::new();
            for (k, v) in kvs {
                sorted.insert(k, v);
            }
            out.push('{');
            for (i, (k, v)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap());
                out.push(':');
                write_json(out, v);
            }
            out.push('}');
        }
    }
}

/// ES6 Number-to-String (shortest round-trip digits; exponent form below 1e-6 and from 1e21), as Go's
/// `float64AsString` and encoding/json do.
pub fn es6_number(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let abs = f.abs();
    if abs != 0.0 && !(1e-6..1e21).contains(&abs) {
        // Rust: 1e21, 1.5e-7 → Go/ES6: 1e+21, 1.5e-7
        let s = format!("{f:e}");
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        };
    }
    let s = format!("{f}");
    if s == "-0" {
        "0".into()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_values_like_pcommon() {
        assert_eq!(as_string(&Value::Double(1.5)), "1.5");
        assert_eq!(as_string(&Value::Double(100.0)), "100");
        assert_eq!(as_string(&Value::Double(1e21)), "1e+21");
        assert_eq!(as_string(&Value::Double(1.5e-7)), "1.5e-7");
        assert_eq!(as_string(&Value::Double(0.1)), "0.1");
        assert_eq!(as_string(&Value::Int(-3)), "-3");
        assert_eq!(as_string(&Value::Bool(false)), "false");
        assert_eq!(as_string(&Value::Array(vec![Value::Str("a<b".into()), Value::Int(1)])), r#"["a<b",1]"#);
        assert_eq!(
            as_string(&Value::Map(vec![("b".into(), Value::Bool(true)), ("a".into(), Value::Str("x".into()))])),
            r#"{"a":"x","b":true}"#
        );
        assert_eq!(as_string(&Value::Bytes(vec![1, 2, 3])), "AQID");
    }

    #[test]
    fn hex_ids() {
        assert_eq!(hex_id(&[0; 16]), "");
        assert_eq!(hex_id(&[]), "");
        assert_eq!(hex_id(&[0xab, 0x01]), "ab01");
    }

    #[test]
    fn replaces_tenant_attributes() {
        let req = Request {
            resource_spans: vec![crate::otlp::ResourceSpans {
                attributes: vec![
                    ("ivy.tenant_id".into(), Value::Str("spoofed".into())),
                    ("service.name".into(), Value::Str("svc".into())),
                ],
                scope_spans: vec![crate::otlp::ScopeSpans { spans: vec![Span::default()], ..Default::default() }],
            }],
        };
        let e = encode(&req, "ten_a", "prj_1");
        assert_eq!(e.spans, 1);
        let rows = String::from_utf8_lossy(&e.rows);
        assert!(!rows.contains("spoofed"));
        assert!(rows.contains("ten_a") && rows.contains("prj_1") && rows.contains("svc"));
    }
}
