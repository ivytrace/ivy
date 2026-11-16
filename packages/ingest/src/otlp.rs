//! OTLP ExportTraceServiceRequest decoding (JSON and protobuf) into one model.

use base64::Engine;
use serde::de::{self, Deserializer};
use serde::Deserialize;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Empty,
    Str(String),
    Bool(bool),
    Int(i64),
    Double(f64),
    Bytes(Vec<u8>),
    Array(Vec<Value>),
    Map(Vec<(String, Value)>),
}

pub type Attributes = Vec<(String, Value)>;

#[derive(Debug, Default)]
pub struct Request {
    pub resource_spans: Vec<ResourceSpans>,
}

#[derive(Debug, Default)]
pub struct ResourceSpans {
    pub attributes: Attributes,
    pub scope_spans: Vec<ScopeSpans>,
}

#[derive(Debug, Default)]
pub struct ScopeSpans {
    pub name: String,
    pub version: String,
    pub spans: Vec<Span>,
}

#[derive(Debug, Default)]
pub struct Span {
    pub trace_id: Vec<u8>,
    pub span_id: Vec<u8>,
    pub parent_span_id: Vec<u8>,
    pub trace_state: String,
    pub name: String,
    pub kind: i32,
    pub start: u64,
    pub end: u64,
    pub attributes: Attributes,
    pub events: Vec<Event>,
    pub links: Vec<Link>,
    pub status_code: i32,
    pub status_message: String,
}

#[derive(Debug, Default)]
pub struct Event {
    pub time: u64,
    pub name: String,
    pub attributes: Attributes,
}

#[derive(Debug, Default)]
pub struct Link {
    pub trace_id: Vec<u8>,
    pub span_id: Vec<u8>,
    pub trace_state: String,
    pub attributes: Attributes,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Format {
    Json,
    Protobuf,
}

pub fn format_of(content_type: Option<&str>) -> Option<Format> {
    let t = content_type?.split(';').next()?.trim().to_ascii_lowercase();
    match t.as_str() {
        "application/x-protobuf" | "application/protobuf" => Some(Format::Protobuf),
        "application/json" => Some(Format::Json),
        _ => None,
    }
}

pub fn decode(body: &[u8], format: Format) -> Result<Request, String> {
    match format {
        Format::Json => decode_json(body),
        Format::Protobuf => decode_protobuf(body),
    }
}

/// Spans marked `ivy.invocation = true` that aren't in-progress records: one per Lambda invocation (a trace).
pub fn is_invocation(span: &Span) -> bool {
    let is_true = |key: &str| {
        span.attributes.iter().any(|(k, v)| {
            k == key && matches!(v, Value::Bool(true)) || k == key && matches!(v, Value::Str(s) if s == "true")
        })
    };
    is_true("ivy.invocation") && !is_true("ivy.in_progress")
}

// ---------- JSON (OTLP/HTTP JSON mapping: hex IDs, camelCase or snake_case fields) ----------

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct JRequest {
    #[serde(alias = "resource_spans")]
    resource_spans: Vec<JResourceSpans>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct JResourceSpans {
    resource: Option<JAttributesHolder>,
    #[serde(alias = "scope_spans")]
    scope_spans: Vec<JScopeSpans>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct JAttributesHolder {
    attributes: Vec<JKeyValue>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct JScopeSpans {
    scope: Option<JScope>,
    spans: Vec<JSpan>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct JScope {
    name: String,
    version: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct JSpan {
    #[serde(alias = "trace_id")]
    trace_id: String,
    #[serde(alias = "span_id")]
    span_id: String,
    #[serde(alias = "parent_span_id")]
    parent_span_id: String,
    #[serde(alias = "trace_state")]
    trace_state: String,
    name: String,
    #[serde(deserialize_with = "enum_value")]
    kind: i32,
    #[serde(alias = "start_time_unix_nano", deserialize_with = "uint64")]
    start_time_unix_nano: u64,
    #[serde(alias = "end_time_unix_nano", deserialize_with = "uint64")]
    end_time_unix_nano: u64,
    attributes: Vec<JKeyValue>,
    events: Vec<JEvent>,
    links: Vec<JLink>,
    status: Option<JStatus>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct JEvent {
    #[serde(alias = "time_unix_nano", deserialize_with = "uint64")]
    time_unix_nano: u64,
    name: String,
    attributes: Vec<JKeyValue>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct JLink {
    #[serde(alias = "trace_id")]
    trace_id: String,
    #[serde(alias = "span_id")]
    span_id: String,
    #[serde(alias = "trace_state")]
    trace_state: String,
    attributes: Vec<JKeyValue>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct JStatus {
    #[serde(deserialize_with = "enum_value")]
    code: i32,
    message: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct JKeyValue {
    key: String,
    value: Option<JAnyValue>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct JAnyValue {
    #[serde(alias = "string_value")]
    string_value: Option<String>,
    #[serde(alias = "bool_value")]
    bool_value: Option<bool>,
    #[serde(alias = "int_value", deserialize_with = "opt_int64")]
    int_value: Option<i64>,
    #[serde(alias = "double_value", deserialize_with = "opt_double")]
    double_value: Option<f64>,
    #[serde(alias = "bytes_value")]
    bytes_value: Option<String>,
    #[serde(alias = "array_value")]
    array_value: Option<JValues<JAnyValue>>,
    #[serde(alias = "kvlist_value")]
    kvlist_value: Option<JValues<JKeyValue>>,
}

#[derive(Deserialize)]
#[serde(bound = "T: Deserialize<'de>")]
struct JValues<T> {
    #[serde(default = "Vec::new")]
    values: Vec<T>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum NumOrStr {
    U(u64),
    I(i64),
    F(f64),
    S(String),
}

fn uint64<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    match Option::<NumOrStr>::deserialize(d)? {
        None => Ok(0),
        Some(NumOrStr::U(n)) => Ok(n),
        Some(NumOrStr::I(n)) => u64::try_from(n).map_err(de::Error::custom),
        Some(NumOrStr::F(_)) => Err(de::Error::custom("expected an integer")),
        Some(NumOrStr::S(s)) => s.parse().map_err(de::Error::custom),
    }
}

fn opt_int64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    match Option::<NumOrStr>::deserialize(d)? {
        None => Ok(None),
        Some(NumOrStr::U(n)) => i64::try_from(n).map(Some).map_err(de::Error::custom),
        Some(NumOrStr::I(n)) => Ok(Some(n)),
        Some(NumOrStr::F(_)) => Err(de::Error::custom("expected an integer")),
        Some(NumOrStr::S(s)) => s.parse().map(Some).map_err(de::Error::custom),
    }
}

fn opt_double<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    match Option::<NumOrStr>::deserialize(d)? {
        None => Ok(None),
        Some(NumOrStr::U(n)) => Ok(Some(n as f64)),
        Some(NumOrStr::I(n)) => Ok(Some(n as f64)),
        Some(NumOrStr::F(f)) => Ok(Some(f)),
        Some(NumOrStr::S(s)) => match s.as_str() {
            "NaN" => Ok(Some(f64::NAN)),
            "Infinity" => Ok(Some(f64::INFINITY)),
            "-Infinity" => Ok(Some(f64::NEG_INFINITY)),
            _ => s.parse().map(Some).map_err(de::Error::custom),
        },
    }
}

/// Enums as numbers or as their proto names (`SPAN_KIND_SERVER`, `STATUS_CODE_ERROR`).
fn enum_value<'de, D: Deserializer<'de>>(d: D) -> Result<i32, D::Error> {
    match Option::<NumOrStr>::deserialize(d)? {
        None => Ok(0),
        Some(NumOrStr::U(n)) => i32::try_from(n).map_err(de::Error::custom),
        Some(NumOrStr::I(n)) => i32::try_from(n).map_err(de::Error::custom),
        Some(NumOrStr::F(_)) => Err(de::Error::custom("expected an enum")),
        Some(NumOrStr::S(s)) => Ok(match s.as_str() {
            "SPAN_KIND_UNSPECIFIED" | "STATUS_CODE_UNSET" => 0,
            "SPAN_KIND_INTERNAL" | "STATUS_CODE_OK" => 1,
            "SPAN_KIND_SERVER" | "STATUS_CODE_ERROR" => 2,
            "SPAN_KIND_CLIENT" => 3,
            "SPAN_KIND_PRODUCER" => 4,
            "SPAN_KIND_CONSUMER" => 5,
            other => other.parse().map_err(|_| de::Error::custom(format!("unknown enum value {other}")))?,
        }),
    }
}

fn hex_id(s: &str, len: usize) -> Result<Vec<u8>, String> {
    if s.is_empty() {
        return Ok(Vec::new());
    }
    if s.len() != len * 2 {
        return Err(format!("invalid ID length: {s}"));
    }
    (0..len)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|_| format!("invalid hex ID: {s}")))
        .collect()
}

fn json_attributes(kvs: Vec<JKeyValue>) -> Result<Attributes, String> {
    kvs.into_iter().map(|kv| Ok((kv.key, json_value(kv.value)?))).collect()
}

fn json_value(v: Option<JAnyValue>) -> Result<Value, String> {
    let Some(v) = v else { return Ok(Value::Empty) };
    Ok(if let Some(s) = v.string_value {
        Value::Str(s)
    } else if let Some(b) = v.bool_value {
        Value::Bool(b)
    } else if let Some(i) = v.int_value {
        Value::Int(i)
    } else if let Some(f) = v.double_value {
        Value::Double(f)
    } else if let Some(b) = v.bytes_value {
        Value::Bytes(base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| e.to_string())?)
    } else if let Some(a) = v.array_value {
        Value::Array(a.values.into_iter().map(|x| json_value(Some(x))).collect::<Result<_, _>>()?)
    } else if let Some(m) = v.kvlist_value {
        Value::Map(json_attributes(m.values)?)
    } else {
        Value::Empty
    })
}

fn decode_json(body: &[u8]) -> Result<Request, String> {
    let req: JRequest = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let mut out = Request::default();
    for rs in req.resource_spans {
        let mut r = ResourceSpans {
            attributes: json_attributes(rs.resource.map(|r| r.attributes).unwrap_or_default())?,
            scope_spans: Vec::new(),
        };
        for ss in rs.scope_spans {
            let scope = ss.scope.unwrap_or_default();
            let mut spans = Vec::with_capacity(ss.spans.len());
            for s in ss.spans {
                let status = s.status.unwrap_or_default();
                spans.push(Span {
                    trace_id: hex_id(&s.trace_id, 16)?,
                    span_id: hex_id(&s.span_id, 8)?,
                    parent_span_id: hex_id(&s.parent_span_id, 8)?,
                    trace_state: s.trace_state,
                    name: s.name,
                    kind: s.kind,
                    start: s.start_time_unix_nano,
                    end: s.end_time_unix_nano,
                    attributes: json_attributes(s.attributes)?,
                    events: s
                        .events
                        .into_iter()
                        .map(|e| Ok(Event { time: e.time_unix_nano, name: e.name, attributes: json_attributes(e.attributes)? }))
                        .collect::<Result<_, String>>()?,
                    links: s
                        .links
                        .into_iter()
                        .map(|l| {
                            Ok(Link {
                                trace_id: hex_id(&l.trace_id, 16)?,
                                span_id: hex_id(&l.span_id, 8)?,
                                trace_state: l.trace_state,
                                attributes: json_attributes(l.attributes)?,
                            })
                        })
                        .collect::<Result<_, String>>()?,
                    status_code: status.code,
                    status_message: status.message,
                });
            }
            r.scope_spans.push(ScopeSpans { name: scope.name, version: scope.version, spans });
        }
        out.resource_spans.push(r);
    }
    Ok(out)
}

// ---------- protobuf (a field walker over the OTLP trace schema) ----------

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

enum Field<'a> {
    Varint(u64),
    Fixed64(u64),
    Fixed32,
    Bytes(&'a [u8]),
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn varint(&mut self) -> Result<u64, String> {
        let mut result: u64 = 0;
        for shift in (0..64).step_by(7) {
            let byte = *self.buf.get(self.pos).ok_or("truncated varint")?;
            self.pos += 1;
            result |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Ok(result);
            }
        }
        Err("varint too long".into())
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.buf.len()).ok_or("truncated field")?;
        let out = &self.buf[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn next(&mut self) -> Result<Option<(u64, Field<'a>)>, String> {
        if self.pos >= self.buf.len() {
            return Ok(None);
        }
        let tag = self.varint()?;
        let field = match tag & 7 {
            0 => Field::Varint(self.varint()?),
            1 => Field::Fixed64(u64::from_le_bytes(self.take(8)?.try_into().unwrap())),
            2 => {
                let len = self.varint()? as usize;
                Field::Bytes(self.take(len)?)
            }
            5 => {
                self.take(4)?;
                Field::Fixed32
            }
            w => return Err(format!("unsupported wire type {w}")),
        };
        Ok(Some((tag >> 3, field)))
    }
}

fn utf8(b: &[u8]) -> Result<String, String> {
    String::from_utf8(b.to_vec()).map_err(|_| "invalid UTF-8".to_string())
}

fn id(b: &[u8], len: usize) -> Result<Vec<u8>, String> {
    if !b.is_empty() && b.len() != len {
        return Err(format!("invalid ID length {}", b.len()));
    }
    Ok(b.to_vec())
}

fn pb_any_value(buf: &[u8]) -> Result<Value, String> {
    let mut r = Reader::new(buf);
    let mut v = Value::Empty;
    while let Some((num, f)) = r.next()? {
        v = match (num, f) {
            (1, Field::Bytes(b)) => Value::Str(utf8(b)?),
            (2, Field::Varint(n)) => Value::Bool(n != 0),
            (3, Field::Varint(n)) => Value::Int(n as i64),
            (4, Field::Fixed64(n)) => Value::Double(f64::from_bits(n)),
            (5, Field::Bytes(b)) => Value::Array(pb_repeated(b, pb_any_value)?),
            (6, Field::Bytes(b)) => Value::Map(pb_repeated(b, pb_key_value)?),
            (7, Field::Bytes(b)) => Value::Bytes(b.to_vec()),
            _ => v,
        };
    }
    Ok(v)
}

/// ArrayValue / KeyValueList: `repeated values = 1`.
fn pb_repeated<T>(buf: &[u8], item: fn(&[u8]) -> Result<T, String>) -> Result<Vec<T>, String> {
    let mut r = Reader::new(buf);
    let mut out = Vec::new();
    while let Some((num, f)) = r.next()? {
        if let (1, Field::Bytes(b)) = (num, f) {
            out.push(item(b)?);
        }
    }
    Ok(out)
}

fn pb_key_value(buf: &[u8]) -> Result<(String, Value), String> {
    let mut r = Reader::new(buf);
    let (mut key, mut value) = (String::new(), Value::Empty);
    while let Some((num, f)) = r.next()? {
        match (num, f) {
            (1, Field::Bytes(b)) => key = utf8(b)?,
            (2, Field::Bytes(b)) => value = pb_any_value(b)?,
            _ => {}
        }
    }
    Ok((key, value))
}

fn pb_event(buf: &[u8]) -> Result<Event, String> {
    let mut r = Reader::new(buf);
    let mut e = Event::default();
    while let Some((num, f)) = r.next()? {
        match (num, f) {
            (1, Field::Fixed64(n)) => e.time = n,
            (2, Field::Bytes(b)) => e.name = utf8(b)?,
            (3, Field::Bytes(b)) => e.attributes.push(pb_key_value(b)?),
            _ => {}
        }
    }
    Ok(e)
}

fn pb_link(buf: &[u8]) -> Result<Link, String> {
    let mut r = Reader::new(buf);
    let mut l = Link::default();
    while let Some((num, f)) = r.next()? {
        match (num, f) {
            (1, Field::Bytes(b)) => l.trace_id = id(b, 16)?,
            (2, Field::Bytes(b)) => l.span_id = id(b, 8)?,
            (3, Field::Bytes(b)) => l.trace_state = utf8(b)?,
            (4, Field::Bytes(b)) => l.attributes.push(pb_key_value(b)?),
            _ => {}
        }
    }
    Ok(l)
}

fn pb_span(buf: &[u8]) -> Result<Span, String> {
    let mut r = Reader::new(buf);
    let mut s = Span::default();
    while let Some((num, f)) = r.next()? {
        match (num, f) {
            (1, Field::Bytes(b)) => s.trace_id = id(b, 16)?,
            (2, Field::Bytes(b)) => s.span_id = id(b, 8)?,
            (3, Field::Bytes(b)) => s.trace_state = utf8(b)?,
            (4, Field::Bytes(b)) => s.parent_span_id = id(b, 8)?,
            (5, Field::Bytes(b)) => s.name = utf8(b)?,
            (6, Field::Varint(n)) => s.kind = n as i32,
            (7, Field::Fixed64(n)) => s.start = n,
            (8, Field::Fixed64(n)) => s.end = n,
            (9, Field::Bytes(b)) => s.attributes.push(pb_key_value(b)?),
            (11, Field::Bytes(b)) => s.events.push(pb_event(b)?),
            (13, Field::Bytes(b)) => s.links.push(pb_link(b)?),
            (15, Field::Bytes(b)) => {
                let mut st = Reader::new(b);
                while let Some((n, f)) = st.next()? {
                    match (n, f) {
                        (2, Field::Bytes(m)) => s.status_message = utf8(m)?,
                        (3, Field::Varint(c)) => s.status_code = c as i32,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(s)
}

fn pb_scope_spans(buf: &[u8]) -> Result<ScopeSpans, String> {
    let mut r = Reader::new(buf);
    let mut ss = ScopeSpans::default();
    while let Some((num, f)) = r.next()? {
        match (num, f) {
            (1, Field::Bytes(b)) => {
                let mut sc = Reader::new(b);
                while let Some((n, f)) = sc.next()? {
                    match (n, f) {
                        (1, Field::Bytes(v)) => ss.name = utf8(v)?,
                        (2, Field::Bytes(v)) => ss.version = utf8(v)?,
                        _ => {}
                    }
                }
            }
            (2, Field::Bytes(b)) => ss.spans.push(pb_span(b)?),
            _ => {}
        }
    }
    Ok(ss)
}

fn pb_resource_spans(buf: &[u8]) -> Result<ResourceSpans, String> {
    let mut r = Reader::new(buf);
    let mut rs = ResourceSpans::default();
    while let Some((num, f)) = r.next()? {
        match (num, f) {
            (1, Field::Bytes(b)) => {
                let mut res = Reader::new(b);
                while let Some((n, f)) = res.next()? {
                    if let (1, Field::Bytes(kv)) = (n, f) {
                        rs.attributes.push(pb_key_value(kv)?);
                    }
                }
            }
            (2, Field::Bytes(b)) => rs.scope_spans.push(pb_scope_spans(b)?),
            _ => {}
        }
    }
    Ok(rs)
}

fn decode_protobuf(body: &[u8]) -> Result<Request, String> {
    let mut r = Reader::new(body);
    let mut out = Request::default();
    while let Some((num, f)) = r.next()? {
        if let (1, Field::Bytes(b)) = (num, f) {
            out.resource_spans.push(pb_resource_spans(b)?);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r#"{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout"}}]},
      "scopeSpans":[{"scope":{"name":"@ivy/layer","version":"0.1.0"},"spans":[
        {"traceId":"5B8EFFF798038103D269B633813FC60C","spanId":"eee19b7ec3c1b174","name":"checkout","kind":2,
         "startTimeUnixNano":"1700000000000000000","endTimeUnixNano":1700000000500000000,
         "attributes":[{"key":"ivy.invocation","value":{"boolValue":true}},{"key":"n","value":{"intValue":"42"}}],
         "status":{"code":"STATUS_CODE_ERROR","message":"boom"}},
        {"traceId":"5b8efff798038103d269b633813fc60c","spanId":"eee19b7ec3c1b175","parentSpanId":"eee19b7ec3c1b174","kind":"SPAN_KIND_CLIENT",
         "attributes":[{"key":"ivy.invocation","value":{"stringValue":"true"}},{"key":"ivy.in_progress","value":{"boolValue":true}}]}
      ]}]}]}"#;

    #[test]
    fn decodes_json() {
        let req = decode(JSON.as_bytes(), Format::Json).unwrap();
        let spans = &req.resource_spans[0].scope_spans[0].spans;
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].trace_id[0], 0x5b);
        assert_eq!(spans[0].kind, 2);
        assert_eq!(spans[0].status_code, 2);
        assert_eq!(spans[0].start, 1_700_000_000_000_000_000);
        assert_eq!(spans[0].end, 1_700_000_000_500_000_000);
        assert_eq!(spans[0].attributes[1].1, Value::Int(42));
        assert_eq!(spans[1].kind, 3);
        assert!(is_invocation(&spans[0]));
        assert!(!is_invocation(&spans[1]));
    }

    #[test]
    fn rejects_bad_ids() {
        let bad = r#"{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"abc"}]}]}]}"#;
        assert!(decode(bad.as_bytes(), Format::Json).is_err());
    }

    #[test]
    fn accepts_snake_case() {
        let body = r#"{"resource_spans":[{"scope_spans":[{"spans":[{"span_id":"eee19b7ec3c1b174","start_time_unix_nano":5}]}]}]}"#;
        let req = decode(body.as_bytes(), Format::Json).unwrap();
        assert_eq!(req.resource_spans[0].scope_spans[0].spans[0].start, 5);
    }

    fn varint(mut n: u64, out: &mut Vec<u8>) {
        while n > 0x7f {
            out.push((n as u8 & 0x7f) | 0x80);
            n >>= 7;
        }
        out.push(n as u8);
    }

    fn bytes_field(num: u64, b: &[u8], out: &mut Vec<u8>) {
        varint(num << 3 | 2, out);
        varint(b.len() as u64, out);
        out.extend_from_slice(b);
    }

    #[test]
    fn decodes_protobuf() {
        let mut any = Vec::new();
        bytes_field(1, b"true", &mut any);
        let mut kv = Vec::new();
        bytes_field(1, b"ivy.invocation", &mut kv);
        bytes_field(2, &any, &mut kv);
        let mut span = Vec::new();
        bytes_field(1, &[1; 16], &mut span);
        bytes_field(2, &[2; 8], &mut span);
        bytes_field(5, b"handler", &mut span);
        varint(6 << 3, &mut span);
        varint(2, &mut span);
        varint(7 << 3 | 1, &mut span);
        span.extend_from_slice(&10u64.to_le_bytes());
        bytes_field(9, &kv, &mut span);
        let mut ss = Vec::new();
        bytes_field(2, &span, &mut ss);
        let mut rs = Vec::new();
        bytes_field(2, &ss, &mut rs);
        let mut req = Vec::new();
        bytes_field(1, &rs, &mut req);

        let decoded = decode(&req, Format::Protobuf).unwrap();
        let s = &decoded.resource_spans[0].scope_spans[0].spans[0];
        assert_eq!(s.name, "handler");
        assert_eq!(s.kind, 2);
        assert_eq!(s.start, 10);
        assert!(is_invocation(s));
        assert!(decode(&req[..req.len() - 3], Format::Protobuf).is_err());
    }
}
