//! Lambda Telemetry API state: platform lifecycle events and a small tail of function log lines.
//! Pure data handling; the span store decides when to turn it into spans. See
//! docs/implementation/platform-failures.md.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

pub const SCHEMA_VERSION: &str = "2025-01-29";
pub const MAX_LOG_LINES: usize = 50;
pub const MAX_LOG_BYTES: usize = 8 * 1024;
const MAX_LINE_BYTES: usize = 2 * 1024;
const MAX_MESSAGE_BYTES: usize = 300;
const MAX_TRACKED: usize = 64;

/// Body of the Telemetry API subscription: platform events plus function logs, with the smallest
/// buffering Lambda accepts so events arrive within ~25 ms.
pub fn subscription_body(port: u16) -> Value {
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "types": ["platform", "function"],
        "buffering": { "maxItems": 1000, "maxBytes": 262144, "timeoutMs": 25 },
        "destination": { "protocol": "HTTP", "URI": format!("http://sandbox.localdomain:{port}/") },
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogLine {
    pub time_ms: i64,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub status: String,
    pub error_type: Option<String>,
    pub time_ms: i64,
    pub duration_ms: Option<f64>,
    pub logs: Vec<LogLine>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InitFailure {
    pub failure: Failure,
    pub start_ms: Option<i64>,
    pub phase: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Report {
    pub request_id: String,
    pub billed_duration_ms: Option<i64>,
    pub max_memory_used_mb: Option<i64>,
    pub memory_size_mb: Option<i64>,
    pub init_duration_ms: Option<f64>,
    pub restore_duration_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Done {
    Success,
    Failed(Failure),
}

#[derive(Default)]
pub struct PlatformState {
    logs: VecDeque<LogLine>,
    log_bytes: usize,
    init_start_ms: Option<i64>,
    pub init_done: bool,
    pub init_failure: Option<InitFailure>,
    pub init_duration_ms: Option<f64>,
    pub restore_duration_ms: Option<f64>,
    starts: HashMap<String, i64>,
    done: HashMap<String, Done>,
    pub reports: Vec<Report>,
    pub received: u64,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from)
}

impl PlatformState {
    pub fn handle(&mut self, events: Vec<Value>) {
        for event in events {
            self.received += 1;
            let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
            let time_ms = event.get("time").and_then(Value::as_str).and_then(parse_time_ms).unwrap_or(0);
            let record = event.get("record").cloned().unwrap_or(Value::Null);
            self.handle_one(kind, time_ms, record);
        }
    }

    fn handle_one(&mut self, kind: &str, time_ms: i64, record: Value) {
        let status = text(&record, "status").unwrap_or_else(|| "success".into());
        let error_type = text(&record, "errorType");
        let metric = |name: &str| record.get("metrics").and_then(|m| m.get(name)).and_then(Value::as_f64);
        match kind {
            "function" => self.push_log(time_ms, &record),
            "platform.initStart" => {
                self.init_start_ms = Some(time_ms);
                self.init_done = false;
            }
            "platform.initRuntimeDone" => {
                self.init_done = true;
                if status == "success" {
                    self.clear_logs();
                } else {
                    let phase = text(&record, "phase").unwrap_or_else(|| "init".into());
                    let failure = Failure { status, error_type, time_ms, duration_ms: None, logs: self.take_logs() };
                    self.init_failure = Some(InitFailure { failure, start_ms: self.init_start_ms, phase });
                }
            }
            "platform.initReport" => {
                self.init_duration_ms = metric("durationMs").or(self.init_duration_ms);
                if let Some(f) = self.init_failure.as_mut() {
                    f.failure.duration_ms = metric("durationMs");
                    if f.failure.error_type.is_none() {
                        f.failure.error_type = error_type;
                    }
                }
            }
            "platform.restoreReport" => self.restore_duration_ms = metric("durationMs"),
            "platform.start" => {
                if let Some(id) = text(&record, "requestId") {
                    self.bounded_insert_start(id, time_ms);
                }
            }
            "platform.runtimeDone" => {
                let Some(id) = text(&record, "requestId") else { return };
                let done = if status == "success" {
                    self.clear_logs();
                    Done::Success
                } else {
                    Done::Failed(Failure { status, error_type, time_ms, duration_ms: metric("durationMs"), logs: self.take_logs() })
                };
                if self.done.len() >= MAX_TRACKED {
                    self.done.clear();
                }
                self.done.insert(id, done);
            }
            "platform.report" => {
                let Some(request_id) = text(&record, "requestId") else { return };
                let int = |name: &str| metric(name).map(|v| v.round() as i64);
                if self.reports.len() >= MAX_TRACKED {
                    self.reports.remove(0);
                }
                self.reports.push(Report {
                    request_id,
                    billed_duration_ms: int("billedDurationMs"),
                    max_memory_used_mb: int("maxMemoryUsedMB"),
                    memory_size_mb: int("memorySizeMB"),
                    init_duration_ms: metric("initDurationMs"),
                    restore_duration_ms: metric("restoreDurationMs"),
                });
            }
            _ => {}
        }
    }

    fn bounded_insert_start(&mut self, id: String, time_ms: i64) {
        if self.starts.len() >= MAX_TRACKED {
            self.starts.clear();
        }
        self.starts.insert(id, time_ms);
    }

    pub fn start_of(&self, request_id: &str) -> Option<i64> {
        self.starts.get(request_id).copied()
    }

    pub fn done(&self, request_id: &str) -> Option<&Done> {
        self.done.get(request_id)
    }

    /// Removes the outcome of a request once it has been turned into span data.
    pub fn forget(&mut self, request_id: &str) {
        self.done.remove(request_id);
        self.starts.remove(request_id);
    }

    /// Requests that failed and have not been handled yet.
    pub fn failed_requests(&self) -> Vec<String> {
        self.done.iter().filter(|(_, d)| matches!(d, Done::Failed(_))).map(|(id, _)| id.clone()).collect()
    }

    fn push_log(&mut self, time_ms: i64, record: &Value) {
        let line = parse_log(time_ms, record);
        self.log_bytes += line.message.len();
        self.logs.push_back(line);
        while self.logs.len() > MAX_LOG_LINES || (self.log_bytes > MAX_LOG_BYTES && self.logs.len() > 1) {
            if let Some(old) = self.logs.pop_front() {
                self.log_bytes -= old.message.len();
            }
        }
    }

    pub fn clear_logs(&mut self) {
        self.logs.clear();
        self.log_bytes = 0;
    }

    fn take_logs(&mut self) -> Vec<LogLine> {
        self.log_bytes = 0;
        std::mem::take(&mut self.logs).into()
    }

    #[cfg(test)]
    pub fn log_count(&self) -> usize {
        self.logs.len()
    }
}

/// Function log record: a string in text format, an object in JSON format.
fn parse_log(time_ms: i64, record: &Value) -> LogLine {
    let (severity, message) = match record {
        Value::String(s) => split_text_log(s),
        Value::Object(o) => {
            let level = o.get("level").and_then(Value::as_str).unwrap_or("INFO");
            let message = match o.get("message") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => record.to_string(),
            };
            (severity_of(level).unwrap_or("info"), message)
        }
        other => ("info", other.to_string()),
    };
    LogLine { time_ms, severity: severity.into(), message: cap(message.trim_end(), MAX_LINE_BYTES) }
}

fn severity_of(level: &str) -> Option<&'static str> {
    match level.to_ascii_uppercase().as_str() {
        "TRACE" | "DEBUG" => Some("debug"),
        "INFO" => Some("info"),
        "WARN" | "WARNING" => Some("warn"),
        "ERROR" | "FATAL" | "CRITICAL" => Some("error"),
        _ => None,
    }
}

/// Node's text format is `<time>\t<request id>\t<LEVEL>\t<message>`; anything else (stderr from a
/// crashing process, other runtimes) is kept whole.
fn split_text_log(line: &str) -> (&'static str, String) {
    let parts: Vec<&str> = line.splitn(4, '\t').collect();
    if parts.len() == 4 && parts[0].len() >= 20 && parts[0].as_bytes().get(4) == Some(&b'-') {
        if let Some(sev) = severity_of(parts[2]) {
            return (sev, parts[3].to_string());
        }
    }
    let upper = line.trim_start().to_ascii_uppercase();
    let sev = if upper.starts_with("FATAL") || upper.starts_with("ERROR") || upper.contains("ERROR:") { "error" } else { "info" };
    (sev, line.to_string())
}

pub fn cap(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated {} bytes]", &s[..end], s.len() - end)
}

/// Error type and message the runtime printed, from a JSON error object in the log tail
/// (Node prints `Uncaught Exception {"errorType":…,"errorMessage":…}` for init errors).
fn logged_error(logs: &[LogLine]) -> Option<(Option<String>, String)> {
    logs.iter().rev().find_map(|l| {
        let start = l.message.find("{\"errorType\"").or_else(|| l.message.find("{\"errorMessage\""))?;
        let v: Value = serde_json::from_str(&l.message[start..]).ok()?;
        let message = v.get("errorMessage").and_then(Value::as_str)?.lines().next()?.trim().to_string();
        Some((text(&v, "errorType"), message))
    })
}

/// The error type and the first meaningful line, used as the span's status message and so as the
/// error group fingerprint (error type + message).
pub fn describe(f: &Failure, phase: &str) -> (String, String) {
    let logged = logged_error(&f.logs);
    // V8 aborts on heap exhaustion before Lambda's memory limit is hit; Lambda then reports Runtime.ExitError.
    let heap_exhausted = f.logs.iter().any(|l| l.message.contains("JavaScript heap out of memory"));
    let error_type = Some("Runtime.OutOfMemory".to_string())
        .filter(|_| heap_exhausted && phase == "invoke" && f.error_type.as_deref().is_none_or(|t| t == "Runtime.ExitError"))
        .or_else(|| f.error_type.clone())
        .or_else(|| logged.as_ref().and_then(|l| l.0.clone()))
        .unwrap_or_else(|| match (phase, f.status.as_str()) {
            (_, "timeout") => "Sandbox.Timedout".into(),
            ("init", _) => "Runtime.InitError".into(),
            _ => "Runtime.ExitError".into(),
        });
    let fatal = || f.logs.iter().rev().find(|l| l.message.contains("FATAL ERROR")).map(|l| first_line(&l.message));
    let error_line = || f.logs.iter().rev().find(|l| l.severity == "error").map(|l| first_line(&l.message));
    let message = logged.map(|l| l.1).or_else(fatal).or_else(error_line).unwrap_or_else(|| fallback_message(&error_type, &f.status, phase));
    (error_type, cap(&message, MAX_MESSAGE_BYTES))
}

fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

fn fallback_message(error_type: &str, status: &str, phase: &str) -> String {
    match error_type {
        "Runtime.OutOfMemory" => "Runtime exited: out of memory".into(),
        "Sandbox.Timedout" => "Task timed out".into(),
        _ if status == "timeout" => "Task timed out".into(),
        _ if phase == "init" => "Function initialization failed".into(),
        _ => "Runtime exited before the invocation completed".into(),
    }
}

/// Parses RFC 3339 UTC timestamps as Lambda writes them (`2022-10-12T00:01:15.000Z`).
pub fn parse_time_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let mut millis = 0;
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(char::is_ascii_digit).collect();
        rest = &frac[digits.len()..];
        let padded = format!("{:0<3}", &digits[..digits.len().min(3)]);
        millis = padded.parse().ok()?;
    }
    let offset_min = match rest {
        "" | "Z" | "z" => 0,
        tz if tz.len() == 6 && (tz.starts_with('+') || tz.starts_with('-')) => {
            let sign = if tz.starts_with('-') { -1 } else { 1 };
            sign * (tz[1..3].parse::<i64>().ok()? * 60 + tz[4..6].parse::<i64>().ok()?)
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3_600 + mi * 60 + se - offset_min * 60) * 1_000) + millis)
}

const COUNT_SUFFIXES: [&str; 5] = ["tokens", "tokencount", "tokencounts", "tokensdetails", "tokenusage"];
const CREDENTIAL_PREFIXES: [&str; 18] = [
    "access", "refresh", "session", "id", "api", "auth", "bearer", "oauth", "csrf", "xsrf", "client", "device", "push", "secret",
    "security", "reset", "invite", "verification",
];

/// Token counts (`max_tokens`, `inputTokens`, `x-amzn-bedrock-input-token-count`) are not secrets
/// (same rule as the tracer's `isTokenCountKey`). `k` is normalized.
fn is_token_count_key(k: &str) -> bool {
    COUNT_SUFFIXES.iter().any(|s| k.ends_with(s) && !CREDENTIAL_PREFIXES.iter().any(|p| k[..k.len() - s.len()].ends_with(p)))
}

/// Whether a key must be redacted (same matching as the tracer: lowercased, `-`/`_` removed, substring,
/// token counts excluded). Numbers and booleans are kept when only `token` entries matched.
fn is_secret(key: &str, keys: &[String], scalar: bool) -> bool {
    let k: String = key.to_ascii_lowercase().chars().filter(|c| *c != '-' && *c != '_').collect();
    if k.is_empty() || is_token_count_key(&k) {
        return false;
    }
    let mut matched = keys.iter().filter(|e| k.contains(e.as_str())).peekable();
    if matched.peek().is_none() {
        return false;
    }
    !(scalar && matched.all(|e| e.contains("token")))
}

/// Best-effort redaction of `"key": value` and `key=value` pairs whose key matches a redact entry.
pub fn redact(text: &str, keys: &[String]) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i < b.len() {
        // "key" : value
        if b[i] == b'"' {
            if let Some(len) = b[i + 1..].iter().take(101).position(|c| *c == b'"') {
                let key = &text[i + 1..i + 1 + len];
                let mut j = i + len + 2;
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < b.len() && b[j] == b':' && !key.contains('\\') && is_secret(key, keys, false) {
                    j += 1;
                    while j < b.len() && b[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    let end = value_end(b, j);
                    let value = &text[j..end];
                    let scalar = value == "true" || value == "false" || (!value.is_empty() && value.parse::<f64>().is_ok());
                    if scalar && !is_secret(key, keys, true) {
                        i += 1;
                        continue;
                    }
                    out.push_str(&text[copied..j]);
                    out.push_str("\"[redacted]\"");
                    copied = end;
                    i = end;
                    continue;
                }
            }
        }
        // key=value
        if b[i] == b'=' && i > 0 {
            let start = text[..i].rfind(|c: char| c.is_whitespace() || "&?,;\"{}".contains(c)).map(|p| p + 1).unwrap_or(0);
            if start >= copied && start < i && is_secret(&text[start..i], keys, false) {
                let end = text[i + 1..].find(|c: char| c.is_whitespace() || "&,;\"}".contains(c)).map(|p| i + 1 + p).unwrap_or(b.len());
                out.push_str(&text[copied..=i]);
                out.push_str("[redacted]");
                copied = end;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[copied.min(text.len())..]);
    out
}

fn value_end(b: &[u8], start: usize) -> usize {
    if start < b.len() && b[start] == b'"' {
        let mut j = start + 1;
        while j < b.len() {
            match b[j] {
                b'\\' => j += 2,
                b'"' => return j + 1,
                _ => j += 1,
            }
        }
        return b.len();
    }
    let mut j = start;
    while j < b.len() && !matches!(b[j], b',' | b'}' | b']') && !b[j].is_ascii_whitespace() {
        j += 1;
    }
    j
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str, time: &str, record: Value) -> Value {
        json!({ "time": time, "type": kind, "record": record })
    }

    #[test]
    fn parses_lambda_timestamps() {
        assert_eq!(parse_time_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_time_ms("2022-10-12T00:01:15.123Z"), Some(1_665_532_875_123));
        assert_eq!(parse_time_ms("2022-10-12T00:01:15.5Z"), Some(1_665_532_875_500));
        assert_eq!(parse_time_ms("2022-10-12T02:01:15+02:00"), Some(1_665_532_875_000));
        assert_eq!(parse_time_ms("nope"), None);
    }

    #[test]
    fn subscribes_to_platform_and_function_with_minimum_buffering() {
        let b = subscription_body(9791);
        assert_eq!(b["schemaVersion"], "2025-01-29");
        assert_eq!(b["types"], json!(["platform", "function"]));
        assert_eq!(b["buffering"], json!({ "maxItems": 1000, "maxBytes": 262144, "timeoutMs": 25 }));
        assert_eq!(b["destination"]["URI"], "http://sandbox.localdomain:9791/");
    }

    #[test]
    fn keeps_a_bounded_log_tail_and_clears_it_after_a_successful_invocation() {
        let mut p = PlatformState::default();
        let lines: Vec<Value> = (0..80).map(|i| ev("function", "2024-01-01T00:00:00.000Z", json!(format!("line {i}")))).collect();
        p.handle(lines);
        assert_eq!(p.log_count(), MAX_LOG_LINES);
        p.handle(vec![ev("function", "2024-01-01T00:00:00.000Z", json!("x".repeat(5000)))]);
        assert!(p.log_bytes <= MAX_LOG_BYTES);
        p.handle(vec![ev("platform.runtimeDone", "2024-01-01T00:00:01.000Z", json!({ "requestId": "r1", "status": "success" }))]);
        assert_eq!(p.log_count(), 0);
        assert_eq!(p.done("r1"), Some(&Done::Success));
    }

    #[test]
    fn parses_text_and_json_log_records() {
        let l = parse_log(0, &json!("2024-01-01T00:00:00.000Z\tabc\tERROR\tboom\n"));
        assert_eq!((l.severity.as_str(), l.message.as_str()), ("error", "boom"));
        let l = parse_log(0, &json!({ "level": "WARN", "message": "careful" }));
        assert_eq!((l.severity.as_str(), l.message.as_str()), ("warn", "careful"));
        let l = parse_log(0, &json!("FATAL ERROR: Reached heap limit"));
        assert_eq!(l.severity, "error");
    }

    #[test]
    fn describes_an_import_module_error_from_the_logged_error() {
        let msg = "2024-01-01T00:00:00.000Z\tundefined\tERROR\tUncaught Exception \t{\"errorType\":\"Runtime.ImportModuleError\",\"errorMessage\":\"Error: Cannot find module 'left-pad'\\nRequire stack:\\n- /var/task/index.js\",\"stack\":[]}";
        let f = Failure { status: "error".into(), error_type: None, time_ms: 0, duration_ms: None, logs: vec![parse_log(0, &json!(msg))] };
        assert_eq!(describe(&f, "init"), ("Runtime.ImportModuleError".into(), "Error: Cannot find module 'left-pad'".into()));
    }

    #[test]
    fn describes_out_of_memory_and_falls_back_without_logs() {
        let logs = vec![parse_log(0, &json!("<--- Last few GCs --->")), parse_log(0, &json!("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"))];
        let f = Failure { status: "failure".into(), error_type: Some("Runtime.OutOfMemory".into()), time_ms: 0, duration_ms: None, logs };
        assert_eq!(describe(&f, "invoke").1, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
        let v8 = Failure { error_type: Some("Runtime.ExitError".into()), ..f.clone() };
        assert_eq!(describe(&v8, "invoke").0, "Runtime.OutOfMemory", "V8 heap exhaustion is reported as an out of memory");
        let f = Failure { status: "timeout".into(), error_type: None, time_ms: 0, duration_ms: None, logs: vec![] };
        assert_eq!(describe(&f, "invoke"), ("Sandbox.Timedout".into(), "Task timed out".into()));
    }

    #[test]
    fn redacts_secrets_in_log_lines() {
        let keys: Vec<String> = ["password", "token", "apikey"].iter().map(|s| s.to_string()).collect();
        assert_eq!(redact(r#"{"user":"a","password":"hunter2","n":1}"#, &keys), r#"{"user":"a","password":"[redacted]","n":1}"#);
        assert_eq!(redact(r#"{"x-api-key": 1234}"#, &keys), r#"{"x-api-key": "[redacted]"}"#);
        assert_eq!(redact("GET /cb?code=1&access_token=abc&x=2 ok", &keys), "GET /cb?code=1&access_token=[redacted]&x=2 ok");
        assert_eq!(redact("nothing secret here", &keys), "nothing secret here");
    }

    #[test]
    fn keeps_token_counts_in_log_lines() {
        let keys: Vec<String> = crate::config::DEFAULT_REDACT_KEYS.split(',').map(|k| k.replace('_', "")).collect();
        let counts = r#"{"max_tokens":1024,"usage":{"input_tokens":812,"outputTokens":24,"cache_read_input_tokens":0},"x-amzn-bedrock-input-token-count":"812"}"#;
        assert_eq!(redact(counts, &keys), counts);
        assert_eq!(redact(r#"{"tokenLimit":4096,"token":"abc"}"#, &keys), r#"{"tokenLimit":4096,"token":"[redacted]"}"#);
        assert_eq!(
            redact(r#"{"accessToken":"a","refresh_tokens":"b","sessionToken":"c","x-auth-token":"d","apiTokens":"e"}"#, &keys),
            r#"{"accessToken":"[redacted]","refresh_tokens":"[redacted]","sessionToken":"[redacted]","x-auth-token":"[redacted]","apiTokens":"[redacted]"}"#
        );
        assert_eq!(redact(r#"{"cardNumber":4111111111111111,"cvv":123}"#, &keys), r#"{"cardNumber":"[redacted]","cvv":"[redacted]"}"#);
    }
}
