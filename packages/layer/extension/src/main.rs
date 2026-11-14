//! Ivy Lambda extension: receives span batches from the in-process tracer on 127.0.0.1 and exports
//! them after each invocation. See docs/implementation/layer.md.

mod config;
mod export;
mod http;
mod queue;
mod store;

use config::Config;
use export::HttpExporter;
use queue::ExportQueue;
use serde_json::Value;
use std::io::{BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use store::SpanStore;

const WAIT_GRACE_MS: i64 = 200;
const SHUTDOWN_BUDGET_MS: i64 = 1500;
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
    shutdown_reason: Option<String>,
}

fn register(api: &str, name: &str, events: &[&str]) -> Result<String, String> {
    let body = serde_json::json!({ "events": events }).to_string();
    let headers = [("Lambda-Extension-Name", name), ("Content-Type", "application/json")];
    let res = http::request(api, "POST", "/2020-01-01/extension/register", &headers, body.as_bytes()).map_err(|e| e.to_string())?;
    match (res.status(), res.header("lambda-extension-identifier")) {
        (200, Some(id)) => Ok(id.to_string()),
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

fn handle_connection(mut stream: TcpStream, store: &SpanStore, attached: &AtomicBool) {
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
            attached.store(true, Ordering::SeqCst);
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

fn start_server(port: u16, store: Arc<SpanStore>, attached: Arc<AtomicBool>) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    thread::Builder::new().name("intake".into()).spawn(move || {
        for conn in listener.incoming() {
            let Ok(stream) = conn else { continue };
            let (s, a) = (store.clone(), attached.clone());
            let spawned = thread::Builder::new().spawn(move || handle_connection(stream, &s, &a));
            if let Err(e) = spawned {
                log(&format!("could not handle a connection: {e}"));
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
    let mut registered = register(&api, &name, events);
    for _ in 0..2 {
        if registered.is_ok() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
        registered = register(&api, &name, events);
    }
    let id = match registered {
        Ok(id) => id,
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

    let store = Arc::new(SpanStore::default());
    let attached = Arc::new(AtomicBool::new(false));
    if let Err(e) = start_server(config.extension_port, store.clone(), attached.clone()) {
        log(&format!("could not listen on 127.0.0.1:{}: {e}", config.extension_port));
    }
    debug("registered");

    let started = Instant::now();
    let exporter = HttpExporter::new(
        config.traces_url.clone().unwrap_or_default(),
        config.api_key.clone(),
        Duration::from_millis(config.export_timeout_ms),
        Box::new(log),
    );
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
            for b in store.drain() {
                queue.add(b);
            }
            let budget = SHUTDOWN_BUDGET_MS.min(event.deadline_ms - epoch_ms() - 100);
            if queue.size() > 0 && budget > 50 {
                queue.flush(budget as u64, true);
            }
            debug(&format!("shutdown ({})", event.shutdown_reason.as_deref().unwrap_or("unknown")));
            std::process::exit(0);
        }
        if let Some(request_id) = event.request_id.as_deref().filter(|_| attached.load(Ordering::SeqCst)) {
            let wait_ms = (event.deadline_ms - epoch_ms() + WAIT_GRACE_MS).max(0) as u64;
            if !store.wait_for(request_id, Duration::from_millis(wait_ms)) {
                debug(&format!("no final spans for {request_id}"));
            }
        }
        for b in store.drain() {
            queue.add(b);
        }
        if queue.size() > 0 {
            queue.flush(config.flush_budget_ms, false);
        }
    }
}
