//! Ivy's OTLP/HTTP ingest: authenticates the API key, resolves tenant, project and shard, and writes the spans to
//! that shard's ClickHouse through a write-ahead log. See docs/implementation/ingest.md.

mod clickhouse;
mod otlp;
mod rows;
mod tenancy;
mod wal;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use otlp::Format;
use std::collections::HashMap;
use std::io::Read;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tenancy::{FailureLimiter, KeyCache, QuotaGate, UsageCounters};
use tokio::net::TcpListener;

// musl's allocator is slow under concurrency; the binary is a static musl build.
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

const RETRY_AFTER_S: i64 = 5;
const MAX_DECODED_BYTES: u64 = 64 * 1024 * 1024;

/// gRPC status codes used in OTLP error bodies.
mod grpc {
    pub const INVALID_ARGUMENT: u32 = 3;
    pub const NOT_FOUND: u32 = 5;
    pub const RESOURCE_EXHAUSTED: u32 = 8;
    pub const UNIMPLEMENTED: u32 = 12;
    pub const UNAVAILABLE: u32 = 14;
    pub const UNAUTHENTICATED: u32 = 16;
}

struct HttpError {
    status: StatusCode,
    code: u32,
    message: String,
    retry_after: Option<i64>,
}

fn err(status: u16, code: u32, message: impl Into<String>) -> HttpError {
    HttpError { status: StatusCode::from_u16(status).unwrap(), code, message: message.into(), retry_after: None }
}

fn retry(mut e: HttpError, seconds: i64) -> HttpError {
    e.retry_after = Some(seconds);
    e
}

struct Shard {
    wal: Arc<wal::Wal>,
}

struct App {
    keys: KeyCache,
    limiter: FailureLimiter,
    quota: Arc<QuotaGate>,
    usage: UsageCounters,
    shards: HashMap<String, Shard>,
    max_body: usize,
    trust_proxy: bool,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn env_num<T: std::str::FromStr>(name: &str, fallback: T) -> T {
    env(name).and_then(|v| v.parse().ok()).unwrap_or(fallback)
}

/// `IVY_SHARDS` ({"shard-1": {"clickhouse": "http://…"}}) or one shard, `shard-1`, from `IVY_CLICKHOUSE_URL`.
fn shard_urls() -> Result<Vec<(String, String)>, String> {
    let Some(raw) = env("IVY_SHARDS") else {
        return Ok(vec![("shard-1".into(), env("IVY_CLICKHOUSE_URL").unwrap_or_else(|| "http://localhost:8123".into()))]);
    };
    let parsed: HashMap<String, serde_json::Value> = serde_json::from_str(&raw).map_err(|e| format!("IVY_SHARDS: {e}"))?;
    let mut shards: Vec<(String, String)> = parsed
        .into_iter()
        .map(|(id, cfg)| match cfg.get("clickhouse").and_then(|c| c.as_str()) {
            Some(url) => Ok((id, url.to_string())),
            None => Err(format!("IVY_SHARDS: shard {id} needs a \"clickhouse\" URL")),
        })
        .collect::<Result<_, _>>()?;
    if shards.is_empty() {
        return Err("IVY_SHARDS has no shards".into());
    }
    shards.sort();
    Ok(shards)
}

fn client_ip(req: &Request<Incoming>, remote: SocketAddr, trust_proxy: bool) -> String {
    if trust_proxy {
        if let Some(first) = req.headers().get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()) {
            let first = first.trim();
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    remote.ip().to_string()
}

fn api_key(headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers.get("authorization") {
        let auth = auth.to_str().ok()?.trim();
        let (scheme, rest) = auth.split_once(char::is_whitespace)?;
        let key = rest.trim();
        return (scheme.eq_ignore_ascii_case("bearer") && !key.is_empty()).then(|| key.to_string());
    }
    headers.get("x-api-key").and_then(|v| v.to_str().ok()).map(str::trim).filter(|k| !k.is_empty()).map(String::from)
}

fn decompress(body: Bytes, encoding: Option<&str>) -> Result<Bytes, HttpError> {
    let enc = encoding.map(|e| e.trim().to_ascii_lowercase()).filter(|e| !e.is_empty()).unwrap_or_else(|| "identity".into());
    let reader: Box<dyn Read> = match enc.as_str() {
        "identity" => return Ok(body),
        "gzip" => Box::new(flate2::read::GzDecoder::new(&body[..])),
        "deflate" => Box::new(flate2::read::ZlibDecoder::new(&body[..])),
        other => return Err(err(400, grpc::INVALID_ARGUMENT, format!("Malformed request: Unsupported content-encoding: {other}"))),
    };
    let mut out = Vec::with_capacity(body.len() * 4);
    reader
        .take(MAX_DECODED_BYTES + 1)
        .read_to_end(&mut out)
        .map_err(|e| err(400, grpc::INVALID_ARGUMENT, format!("Malformed request: {e}")))?;
    if out.len() as u64 > MAX_DECODED_BYTES {
        return Err(err(413, grpc::INVALID_ARGUMENT, "Decompressed body too large"));
    }
    Ok(Bytes::from(out))
}

fn varint(mut n: u64, out: &mut Vec<u8>) {
    while n > 0x7f {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

/// OTLP/HTTP error body: a google.rpc.Status, encoded like the request.
fn error_response(format: Option<Format>, e: HttpError, close: bool) -> Response<Full<Bytes>> {
    let (body, content_type) = if format == Some(Format::Protobuf) {
        let mut b = vec![0x08];
        varint(e.code as u64, &mut b);
        b.push(0x12);
        varint(e.message.len() as u64, &mut b);
        b.extend_from_slice(e.message.as_bytes());
        (b, "application/x-protobuf")
    } else {
        (serde_json::json!({ "code": e.code, "message": e.message }).to_string().into_bytes(), "application/json")
    };
    let mut res = Response::builder().status(e.status).header("content-type", content_type);
    if let Some(s) = e.retry_after {
        res = res.header("retry-after", s.to_string());
    }
    if close {
        res = res.header("connection", "close");
    }
    res.body(Full::new(Bytes::from(body))).unwrap()
}

async fn handle(app: Arc<App>, req: Request<Incoming>, remote: SocketAddr) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let format = otlp::format_of(req.headers().get("content-type").and_then(|v| v.to_str().ok()));
    let mut body_read = false;
    let result = ingest(&app, req, remote, format, &mut body_read).await;
    Ok(match result {
        Ok(res) => res,
        Err(e) => error_response(format, e, !body_read),
    })
}

async fn ingest(app: &App, req: Request<Incoming>, remote: SocketAddr, format: Option<Format>, body_read: &mut bool) -> Result<Response<Full<Bytes>>, HttpError> {
    let path = req.uri().path().to_string();
    if path == "/health" && req.method() == Method::GET {
        return Ok(Response::builder().header("content-type", "application/json").body(Full::new(Bytes::from_static(b"{\"ok\":true}"))).unwrap());
    }
    if path == "/v1/logs" || path == "/v1/metrics" {
        return Err(err(404, grpc::UNIMPLEMENTED, format!("{path} is not supported; Ivy ingests traces only")));
    }
    if path != "/v1/traces" {
        return Err(err(404, grpc::NOT_FOUND, "Not found"));
    }
    if req.method() != Method::POST {
        return Err(err(405, grpc::UNIMPLEMENTED, "Use POST"));
    }

    let ip = client_ip(&req, remote, app.trust_proxy);
    let key = api_key(req.headers()).ok_or_else(|| err(401, grpc::UNAUTHENTICATED, "Missing API key (Authorization: Bearer <key>)"))?;
    let blocked = app.limiter.blocked_for(&ip);
    if blocked > 0 && !app.keys.peek(&key) {
        return Err(retry(err(429, grpc::RESOURCE_EXHAUSTED, "Too many invalid API keys"), blocked));
    }
    let tenant = match app.keys.resolve(&key).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            app.limiter.fail(&ip);
            return Err(err(401, grpc::UNAUTHENTICATED, "Invalid API key"));
        }
        Err(e) => {
            eprintln!("[ingest] key lookup failed: {e}");
            return Err(retry(err(503, grpc::UNAVAILABLE, "Key lookup unavailable"), RETRY_AFTER_S));
        }
    };
    if let Some(block) = app.quota.check(&tenant.tenant_id, &tenant.shard_id).await {
        return Err(retry(err(429, grpc::RESOURCE_EXHAUSTED, block.message), block.retry_after));
    }

    let format = format.ok_or_else(|| err(415, grpc::INVALID_ARGUMENT, "Use application/x-protobuf or application/json"))?;
    let declared: u64 = req.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
    if declared > app.max_body as u64 {
        return Err(err(413, grpc::INVALID_ARGUMENT, format!("Body larger than {} bytes", app.max_body)));
    }
    let encoding = req.headers().get("content-encoding").and_then(|v| v.to_str().ok()).map(String::from);
    let body = match tokio::time::timeout(Duration::from_secs(30), Limited::new(req.into_body(), app.max_body).collect()).await {
        Err(_) => return Err(err(408, grpc::INVALID_ARGUMENT, "Request timed out")),
        Ok(Err(e)) if e.is::<http_body_util::LengthLimitError>() => {
            return Err(err(413, grpc::INVALID_ARGUMENT, format!("Body larger than {} bytes", app.max_body)))
        }
        Ok(Err(e)) => return Err(err(400, grpc::INVALID_ARGUMENT, format!("Malformed request: {e}"))),
        Ok(Ok(b)) => b.to_bytes(),
    };
    *body_read = true;
    let received = body.len() as u64;
    let decoded = decompress(body, encoding.as_deref())?;
    let request = otlp::decode(&decoded, format).map_err(|e| err(400, grpc::INVALID_ARGUMENT, format!("Malformed request: {e}")))?;
    let encoded = rows::encode(&request, &tenant.tenant_id, &tenant.project_id);

    let shard = app.shards.get(&tenant.shard_id).ok_or_else(|| {
        eprintln!("[ingest] tenant {} is on unknown shard {}", tenant.tenant_id, tenant.shard_id);
        err(500, grpc::UNAVAILABLE, "Internal error")
    })?;
    match shard.wal.append(&encoded.rows) {
        Ok(()) => {}
        Err(wal::AppendError::Full) => {
            return Err(retry(err(503, grpc::UNAVAILABLE, "Ingest temporarily unavailable"), RETRY_AFTER_S));
        }
        Err(wal::AppendError::Io(e)) => {
            eprintln!("[ingest] write-ahead log for shard {} failed: {e}", tenant.shard_id);
            return Err(retry(err(503, grpc::UNAVAILABLE, "Ingest temporarily unavailable"), RETRY_AFTER_S));
        }
    }
    app.usage.add(&tenant.tenant_id, encoded.spans, received);
    app.quota.add(&tenant.tenant_id, encoded.invocations);

    // An empty ExportTraceServiceResponse.
    let (body, content_type): (&'static [u8], _) = match format {
        Format::Json => (b"{}", "application/json"),
        Format::Protobuf => (b"", "application/x-protobuf"),
    };
    Ok(Response::builder().header("content-type", HeaderValue::from_static(content_type)).body(Full::new(Bytes::from_static(body))).unwrap())
}

async fn serve_admin(app: Arc<App>, addr: SocketAddr) {
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => return eprintln!("[ingest] admin listener on {addr}: {e}"),
    };
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let app = app.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req: Request<Incoming>| {
                let app = app.clone();
                async move {
                    let res = if req.uri().path() == "/stats" {
                        let body = serde_json::to_vec(&app.usage.snapshot()).unwrap();
                        Response::builder().header("content-type", "application/json").body(Full::new(Bytes::from(body)))
                    } else {
                        Response::builder().status(404).body(Full::new(Bytes::new()))
                    };
                    Ok::<_, std::convert::Infallible>(res.unwrap())
                }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
        });
    }
}

async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

/// `ivy-ingest health`: exits 0 when GET /health answers 200 (the image has no shell or wget for healthchecks).
fn health() -> i32 {
    use std::io::Write;
    let port: u16 = env_num("IVY_INGEST_PORT", 4318);
    let check = || -> std::io::Result<bool> {
        let mut s = std::net::TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(2))?;
        s.set_read_timeout(Some(Duration::from_secs(2)))?;
        s.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut head = [0u8; 12];
        s.read_exact(&mut head)?;
        Ok(&head[9..12] == b"200")
    };
    if check().unwrap_or(false) { 0 } else { 1 }
}

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("health") {
        std::process::exit(health());
    }
    if let Err(e) = run().await {
        eprintln!("[ingest] {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let user = env("IVY_CLICKHOUSE_USER").unwrap_or_else(|| "ivy".into());
    let password = env("IVY_CLICKHOUSE_PASSWORD").unwrap_or_else(|| "ivy".into());
    let data_db = env("IVY_CLICKHOUSE_DATABASE").unwrap_or_else(|| "ivy".into());
    let shard_urls = shard_urls()?;
    let control_url = env("IVY_CONTROL_CLICKHOUSE_URL")
        .or_else(|| shard_urls.iter().find(|(id, _)| id == "shard-1").map(|(_, url)| url.clone()))
        .ok_or("IVY_CONTROL_CLICKHOUSE_URL is required when IVY_SHARDS has no shard-1")?;
    let control_db = env("IVY_CONTROL_CLICKHOUSE_DATABASE").unwrap_or_else(|| "ivy_control".into());
    let control = clickhouse::Client::new(&control_url, &user, &password)?;
    let wal_dir = PathBuf::from(env("IVY_INGEST_WAL_DIR").unwrap_or_else(|| "/var/lib/ivy-ingest".into()));
    let wal_max: u64 = env_num("IVY_INGEST_WAL_MAX_BYTES", 2 * 1024 * 1024 * 1024);

    let flush_every = Duration::from_millis(env_num("IVY_INGEST_FLUSH_MS", 2000));
    let mut shards = HashMap::new();
    let mut shard_clients = HashMap::new();
    for (id, url) in &shard_urls {
        let client = clickhouse::Client::new(url, &user, &password)?;
        let wal = wal::Wal::open(wal_dir.join(id), wal_max).map_err(|e| format!("write-ahead log {}: {e}", wal_dir.join(id).display()))?;
        if wal.bytes() > 0 {
            eprintln!("[ingest] replaying {} bytes of write-ahead log for shard {id}", wal.bytes());
        }
        tokio::spawn(wal.clone().run_flusher(client.clone(), data_db.clone(), id.clone(), flush_every));
        shards.insert(id.clone(), Shard { wal });
        shard_clients.insert(id.clone(), client);
    }

    let app = Arc::new(App {
        keys: KeyCache::new(control.clone(), control_db.clone()),
        limiter: FailureLimiter::new(env_num("IVY_INGEST_MAX_KEY_FAILURES", 20)),
        quota: Arc::new(QuotaGate::new(
            control,
            control_db,
            shard_clients.clone(),
            data_db.clone(),
            env_num("IVY_QUOTA_REFRESH_SECONDS", 60),
            env_num("IVY_QUOTA_RETRY_AFTER_SECONDS", 300),
            env("IVY_PUBLIC_URL"),
            env("IVY_UPGRADE_URL"),
        )),
        usage: UsageCounters::default(),
        shards,
        max_body: env_num("IVY_INGEST_MAX_BODY_BYTES", 10 * 1024 * 1024),
        trust_proxy: matches!(env("IVY_INGEST_TRUST_PROXY").as_deref(), Some("1" | "true")),
    });

    let admin_host = env("IVY_INGEST_ADMIN_HOST").unwrap_or_else(|| "127.0.0.1".into());
    let admin_addr: SocketAddr = format!("{admin_host}:{}", env_num("IVY_INGEST_ADMIN_PORT", 4320)).parse().map_err(|e| format!("admin address: {e}"))?;
    tokio::spawn(serve_admin(app.clone(), admin_addr));

    let usage_app = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await;
        loop {
            tick.tick().await;
            for (tenant, u) in usage_app.usage.deltas() {
                println!("[ingest] usage tenant={tenant} requests={} spans={} bytes={}", u.requests, u.spans, u.bytes);
            }
        }
    });

    let port: u16 = env_num("IVY_INGEST_PORT", 4318);
    let listener = TcpListener::bind(("0.0.0.0", port)).await.map_err(|e| format!("listen on :{port}: {e}"))?;
    let names: Vec<String> = shard_urls.iter().map(|(id, url)| format!("{id} → {url}")).collect();
    println!("[ingest] listening on :{port} (OTLP/HTTP /v1/traces; {}; log in {})", names.join(", "), wal_dir.display());

    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((stream, remote)) = accepted else { continue };
                let _ = stream.set_nodelay(true);
                let app = app.clone();
                tokio::spawn(async move {
                    let svc = service_fn(move |req| handle(app.clone(), req, remote));
                    let _ = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(10))
                        .keep_alive(true)
                        .serve_connection(TokioIo::new(stream), svc)
                        .await;
                });
            }
            _ = &mut shutdown => break,
        }
    }

    // Spans already accepted are in the log either way; a last flush saves the next start a replay.
    for (id, shard) in &app.shards {
        let client = &shard_clients[id];
        match tokio::time::timeout(Duration::from_secs(5), shard.wal.flush(client, &data_db)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => eprintln!("[ingest] final flush of shard {id} failed (kept in the log): {e}"),
            Err(_) => eprintln!("[ingest] final flush of shard {id} timed out (kept in the log)"),
        }
    }
    Ok(())
}
