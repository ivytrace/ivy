//! Ivy Lambda extension: receives span batches from the in-process tracer on 127.0.0.1 and exports
//! them after each invocation. See docs/implementation/layer.md.

mod config;
mod export;
mod http;
mod platform;
mod queue;
mod spans;
mod store;

use config::Config;
use export::HttpExporter;
use queue::ExportQueue;
use serde_json::Value;
use std::io::{BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use spans::InvocationContext;
use store::{FinishOptions, SpanStore};

const WAIT_GRACE_MS: i64 = 200;
const HELLO_WAIT_MS: i64 = 500;
const SHUTDOWN_BUDGET_MS: i64 = 1500;
const SHUTDOWN_TELEMETRY_WAIT_MS: i64 = 150;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[ivy-extension] {msg}");
}

fn epoch_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

struct Event {
    event_type: String,
    deadline_ms: i64,
    request_id: Option<String>,
    function_arn: Option<String>,
    shutdown_reason: Option<String>,
}

/// Registers and returns the extension ID and, when Lambda includes it, the account ID.
fn register(api: &str, name: &str, events: &[&str]) -> Result<(String, Option<String>), String> {
    let body = serde_json::json!({ "events": events }).to_string();
    let headers = [("Lambda-Extension-Name", name), ("Content-Type", "application/json"), ("Lambda-Extension-Accept-Feature", "accountId")];
    let res = http::request(api, "POST", "/2020-01-01/extension/register", &headers, body.as_bytes()).map_err(|e| e.to_string())?;
    match (res.status(), res.header("lambda-extension-identifier")) {
        (200, Some(id)) => {
            let account = serde_json::from_slice::<Value>(&res.body).ok().and_then(|v| v.get("accountId").and_then(Value::as_str).map(String::from));
            Ok((id.to_string(), account))
        }
        (status, _) => Err(format!("HTTP {status} {}", String::from_utf8_lossy(&res.body))),
    }
}

fn next_event(api: &str, id: &str) -> Result<Event, String> {
    let res = http::request(api, "GET", "/2020-01-01/extension/event/next", &[("Lambda-Extension-Identifier", id)], b"").map_err(|e| e.to_string())?;
    if res.status() != 200 {
        return Err(format!("HTTP {} {}", res.status(), String::from_utf8_lossy(&res.body)));
    }
    let v: Value = serde_json::from_slice(&res.body).map_err(|e| e.to_string())?;
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
    Ok(Event {
        event_type: text("eventType").unwrap_or_default(),
        deadline_ms: v.get("deadlineMs").and_then(Value::as_i64).unwrap_or(0),
        request_id: text("requestId"),
        function_arn: text("invokedFunctionArn"),
        shutdown_reason: text("shutdownReason"),
    })
}

/// Same truthiness and `String(x)` coercion the TypeScript extension applied to the batch fields.
fn request_id_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        None => "undefined".into(),
        Some(other) => other.to_string(),
    }
}

fn is_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn handle_connection(mut stream: TcpStream, store: &SpanStore) {
    stream.set_read_timeout(Some(READ_TIMEOUT)).ok();
    let msg = match stream.try_clone().and_then(|s| http::read_message(&mut BufReader::new(s), false, http::MAX_BODY_BYTES)) {
        Ok(m) => m,
        Err(e) => {
            let _ = http::write_response(&mut stream, 400, &e.to_string());
            return;
        }
    };
    let (status, body) = match msg.route() {
        ("POST", "/hello") => {
            store.attach();
            (200, "{}".to_string())
        }
        ("POST", "/spans") => match serde_json::from_slice::<Value>(&msg.body) {
            Ok(mut batch) => {
                let request_id = request_id_of(batch.get("requestId"));
                let is_final = is_truthy(batch.get("final"));
                let resource = match batch.get_mut("resource").map(Value::take) {
                    Some(Value::Null) | None => Value::Array(vec![]),
                    Some(r) => r,
                };
                let spans = match batch.get_mut("spans").map(Value::take) {
                    Some(Value::Array(list)) => list,
                    _ => vec![],
                };
                store.add(&request_id, is_final, resource, spans);
                (200, "{}".to_string())
            }
            Err(e) => (400, e.to_string()),
        },
        _ => (404, String::new()),
    };
    let _ = http::write_response(&mut stream, status, &body);
}

/// Binds the span intake on 127.0.0.1. Called before `register`: Lambda starts the runtime's init as
/// soon as every extension has registered, and the tracer's hello must find the port open.
fn bind_intake(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", port))
}

/// Binds the intake (when `intake_port` is set), then registers with up to 3 tries.
#[allow(clippy::type_complexity)]
fn bind_and_register(api: &str, name: &str, events: &[&str], intake_port: Option<u16>) -> (Option<std::io::Result<TcpListener>>, Result<(String, Option<String>), String>) {
    let intake = intake_port.map(bind_intake);
    let mut registered = register(api, name, events);
    for _ in 0..2 {
        if registered.is_ok() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
        registered = register(api, name, events);
    }
    (intake, registered)
}

fn serve_intake(listener: TcpListener, store: Arc<SpanStore>) -> std::io::Result<()> {
    thread::Builder::new().name("intake".into()).spawn(move || {
        for conn in listener.incoming() {
            let Ok(stream) = conn else { continue };
            let s = store.clone();
            let spawned = thread::Builder::new().spawn(move || handle_connection(stream, &s));
            if let Err(e) = spawned {
                log(&format!("could not handle a connection: {e}"));
            }
        }
    })?;
    Ok(())
}

/// Subscribes to platform events and function logs (Telemetry API). Function logs are only kept in a
/// small in-memory tail for failures, never exported on their own.
fn subscribe_telemetry(api: &str, id: &str, port: u16) -> Result<(), String> {
    let body = platform::subscription_body(port).to_string();
    let headers = [("Lambda-Extension-Identifier", id), ("Content-Type", "application/json")];
    let res = http::request(api, "PUT", "/2022-07-01/telemetry", &headers, body.as_bytes()).map_err(|e| e.to_string())?;
    match res.status() {
        200 => Ok(()),
        status => Err(format!("HTTP {status} {}", String::from_utf8_lossy(&res.body))),
    }
}

fn handle_telemetry(mut stream: TcpStream, store: &SpanStore) {
    stream.set_read_timeout(Some(READ_TIMEOUT)).ok();
    let msg = match stream.try_clone().and_then(|s| http::read_message(&mut BufReader::new(s), false, http::MAX_BODY_BYTES)) {
        Ok(m) => m,
        Err(e) => {
            let _ = http::write_response(&mut stream, 400, &e.to_string());
            return;
        }
    };
    match serde_json::from_slice::<Value>(&msg.body) {
        Ok(Value::Array(events)) => {
            store.add_telemetry(events);
            let _ = http::write_response(&mut stream, 200, "{}");
        }
        _ => {
            let _ = http::write_response(&mut stream, 400, "expected a JSON array");
        }
    }
}

fn start_telemetry_server(port: u16, store: Arc<SpanStore>) -> std::io::Result<()> {
    // Lambda delivers to sandbox.localdomain, which is not loopback.
    let listener = TcpListener::bind(("0.0.0.0", port))?;
    thread::Builder::new().name("telemetry".into()).spawn(move || {
        for conn in listener.incoming() {
            let Ok(stream) = conn else { continue };
            let s = store.clone();
            if let Err(e) = thread::Builder::new().spawn(move || handle_telemetry(stream, &s)) {
                log(&format!("could not handle a telemetry connection: {e}"));
            }
        }
    })?;
    Ok(())
}

fn main() {
    let name = std::env::args()
        .nth(1)
        .or_else(|| std::env::args().next().and_then(|p| p.rsplit('/').next().map(String::from)))
        .unwrap_or_else(|| "ivy-extension".into());
    let api = std::env::var("AWS_LAMBDA_RUNTIME_API").unwrap_or_default();
    let config = Config::from_env();
    let debug = |msg: &str| {
        if config.debug {
            log(msg)
        }
    };

    let events: &[&str] = if config.enabled { &["INVOKE", "SHUTDOWN"] } else { &[] };
    let store = Arc::new(SpanStore::default());
    // Test-only: simulates a listener that opens late (the old register-then-bind order).
    let intake_delay = std::env::var("IVY_TEST_INTAKE_DELAY_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|ms| *ms > 0);
    let intake_port = (config.enabled && intake_delay.is_none()).then_some(config.extension_port);
    let (intake, registered) = bind_and_register(&api, &name, events, intake_port);
    let (id, account_id) = match registered {
        Ok(r) => r,
        Err(e) => {
            log(&format!("register failed: {e}"));
            std::process::exit(1);
        }
    };

    if !config.enabled {
        debug("IVY_ENDPOINT not set; idle");
        loop {
            if next_event(&api, &id).is_err() {
                thread::sleep(Duration::from_millis(100));
            }
        }
    }

    let served = match (intake, intake_delay) {
        (Some(bound), _) => bound.and_then(|l| serve_intake(l, store.clone())),
        (None, Some(ms)) => {
            let (port, s) = (config.extension_port, store.clone());
            thread::Builder::new().spawn(move || {
                thread::sleep(Duration::from_millis(ms));
                if let Err(e) = bind_intake(port).and_then(|l| serve_intake(l, s)) {
                    log(&format!("could not listen on 127.0.0.1:{port}: {e}"));
                }
            }).map(|_| ())
        }
        (None, None) => Ok(()),
    };
    if let Err(e) = served {
        log(&format!("could not listen on 127.0.0.1:{}: {e}", config.extension_port));
    }
    let mut telemetry_on = false;
    if config.telemetry {
        let started = Instant::now();
        let subscribed = start_telemetry_server(config.telemetry_port, store.clone())
            .map_err(|e| format!("could not listen on port {}: {e}", config.telemetry_port))
            .and_then(|_| subscribe_telemetry(&api, &id, config.telemetry_port));
        match subscribed {
            Ok(()) => {
                telemetry_on = true;
                debug(&format!("subscribed to telemetry in {} µs", started.elapsed().as_micros()))
            }
            Err(e) => debug(&format!("telemetry unavailable ({} µs): {e}", started.elapsed().as_micros())),
        }
    }
    debug("registered");
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let finish_options = FinishOptions {
        redact_keys: config.redact_keys.clone(),
        report_updates: config.report_updates,
        fallback_resource: spans::env_resource(&env, account_id.as_deref()),
    };
    let mut first_invoke = true;
    let mut last_request: Option<String> = None;

    let started = Instant::now();
    let exporter = HttpExporter::new(
        config.traces_url.clone().unwrap_or_default(),
        config.api_key.clone(),
        Duration::from_millis(config.export_timeout_ms),
        Box::new(log),
    );
    // The tracer announces itself without blocking init, so its hello can land just after the first
    // INVOKE. With the exec wrapper configured a tracer is expected: give it a moment to say hello.
    let tracer_expected = std::env::var("AWS_LAMBDA_EXEC_WRAPPER").is_ok_and(|w| w.ends_with("/ivy-wrapper"));
    let mut expect_hello = tracer_expected;
    let mut queue = ExportQueue::new(exporter, config.max_queue_spans, Box::new(move || started.elapsed().as_millis() as u64), Box::new(log));

    loop {
        let event = match next_event(&api, &id) {
            Ok(e) => e,
            Err(e) => {
                log(&format!("next failed: {e}"));
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        if event.event_type == "SHUTDOWN" {
            let wait_ms = SHUTDOWN_TELEMETRY_WAIT_MS.min(event.deadline_ms - epoch_ms() - 300).max(0) as u64;
            store.wait_for_telemetry(last_request.as_deref(), Duration::from_millis(wait_ms));
            for b in store.finish(None, &finish_options) {
                queue.add(b);
            }
            let budget = SHUTDOWN_BUDGET_MS.min(event.deadline_ms - epoch_ms() - 100);
            if queue.size() > 0 && budget > 50 {
                queue.flush(budget as u64, true);
            }
            debug(&format!("shutdown ({})", event.shutdown_reason.as_deref().unwrap_or("unknown")));
            std::process::exit(0);
        }
        let invoked_at = epoch_ms();
        if expect_hello && !store.is_attached() {
            let wait_ms = HELLO_WAIT_MS.min(event.deadline_ms - epoch_ms()).max(0) as u64;
            if !store.wait_attached(Duration::from_millis(wait_ms)) {
                debug("no hello from the tracer");
            }
        }
        expect_hello = false;
        // With the wrapper a tracer is expected even if its hello is late or was lost: its spans count as a
        // hello. With telemetry the wait ends when the runtime is done, so a missing tracer costs little.
        let wait_for_spans = store.is_attached() || (tracer_expected && telemetry_on);
        if let Some(request_id) = event.request_id.as_deref().filter(|_| wait_for_spans) {
            let wait_ms = (event.deadline_ms - epoch_ms() + WAIT_GRACE_MS).max(0) as u64;
            if !store.wait_for(request_id, Duration::from_millis(wait_ms)) {
                debug(&format!("no final spans for {request_id}"));
            }
        }
        let ctx = InvocationContext { request_id: event.request_id.clone(), function_arn: event.function_arn.clone(), start_ms: invoked_at, cold_start: first_invoke };
        first_invoke = false;
        last_request = event.request_id.clone();
        for b in store.finish(Some(&ctx), &finish_options) {
            queue.add(b);
        }
        if queue.size() > 0 {
            queue.flush(config.flush_budget_ms, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_intake_listens_before_register_is_sent() {
        let api = TcpListener::bind("127.0.0.1:0").unwrap();
        let api_addr = api.local_addr().unwrap().to_string();
        let intake_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let fake_api = thread::spawn(move || {
            let (mut stream, _) = api.accept().unwrap();
            let msg = http::read_message(&mut BufReader::new(stream.try_clone().unwrap()), false, 1 << 20).unwrap();
            assert_eq!(msg.route(), ("POST", "/2020-01-01/extension/register"));
            // What the runtime's init would do as soon as registration completes: say hello.
            let reachable = TcpStream::connect(("127.0.0.1", intake_port)).is_ok();
            let resp = "HTTP/1.1 200 OK\r\nLambda-Extension-Identifier: ext-1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
            stream.write_all(resp.as_bytes()).unwrap();
            reachable
        });
        let (intake, registered) = bind_and_register(&api_addr, "ivy-extension", &["INVOKE"], Some(intake_port));
        assert_eq!(registered.unwrap().0, "ext-1");
        assert!(intake.unwrap().is_ok());
        assert!(fake_api.join().unwrap(), "intake port was not open when register was sent");
    }
}
