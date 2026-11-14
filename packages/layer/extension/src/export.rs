use crate::queue::{Exporter, SendResult};
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

const ATTEMPTS: u32 = 3;
const GZIP_THRESHOLD: usize = 1024;

pub fn is_retryable(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

/// `Retry-After` in milliseconds: delay-seconds or an IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`).
pub fn parse_retry_after(value: &str, now_unix_ms: u64) -> Option<u64> {
    let v = value.trim();
    if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) {
        return v.parse::<u64>().ok().map(|s| s.saturating_mul(1000));
    }
    let parts: Vec<&str> = v.split([' ', ':']).filter(|p| !p.is_empty()).collect();
    if parts.len() != 8 || parts[7] != "GMT" {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|m| *m == parts[2])? as i64 + 1;
    let year: i64 = parts[3].parse().ok()?;
    let (h, m, s): (i64, i64, i64) = (parts[4].parse().ok()?, parts[5].parse().ok()?, parts[6].parse().ok()?);
    // Days from civil (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let at_ms = ((days * 86_400 + h * 3600 + m * 60 + s) * 1000).max(0) as u64;
    Some(at_ms.saturating_sub(now_unix_ms))
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn gzip(body: &[u8]) -> Option<Vec<u8>> {
    let mut enc = GzEncoder::new(Vec::with_capacity(body.len() / 4), Compression::default());
    enc.write_all(body).ok()?;
    enc.finish().ok()
}

/// OTLP/HTTP JSON exporter over a keep-alive ureq agent (rustls + webpki roots for https).
pub struct HttpExporter {
    url: String,
    authorization: Option<String>,
    timeout: Duration,
    agent: Option<ureq::Agent>,
    log: Box<dyn Fn(&str)>,
}

enum Outcome {
    Ok,
    Retry(String),
    Fail(String),
    /// 429/503 with Retry-After: stop now and wait that long.
    Pause(String, u64),
}

impl HttpExporter {
    pub fn new(url: String, api_key: Option<String>, timeout: Duration, log: Box<dyn Fn(&str)>) -> Self {
        HttpExporter { url, authorization: api_key.map(|k| format!("Bearer {k}")), timeout, agent: None, log }
    }

    fn post(&mut self, body: &[u8], gzipped: bool, timeout: Duration) -> Outcome {
        // Built on first use so that nothing TLS-related runs during init.
        let agent = self.agent.get_or_insert_with(|| ureq::AgentBuilder::new().max_idle_connections_per_host(2).build());
        let mut req = agent.post(&self.url).timeout(timeout).set("content-type", "application/json");
        if gzipped {
            req = req.set("content-encoding", "gzip");
        }
        if let Some(auth) = &self.authorization {
            req = req.set("authorization", auth);
        }
        match req.send_bytes(body) {
            Ok(_) => Outcome::Ok,
            Err(ureq::Error::Status(status, resp)) => {
                let retry_after = resp.header("retry-after").and_then(|v| parse_retry_after(v, unix_ms()));
                let mut text = String::new();
                resp.into_reader().take(200).read_to_string(&mut text).ok();
                (self.log)(&format!("export failed with HTTP {status}: {text}"));
                let error = format!("HTTP {status}");
                match retry_after {
                    Some(ms) if status == 429 || status == 503 => Outcome::Pause(error, ms),
                    _ if is_retryable(status) => Outcome::Retry(error),
                    _ => Outcome::Fail(error),
                }
            }
            Err(e) => {
                (self.log)(&format!("export failed: {e}"));
                let kind = match &e {
                    ureq::Error::Transport(t) => format!("{:?}", t.kind()),
                    _ => "error".into(),
                };
                Outcome::Retry(kind.to_lowercase())
            }
        }
    }
}

impl Exporter for HttpExporter {
    /// Up to 3 attempts (backoff 100/300 ms) on network errors and retryable statuses, within `budget`.
    /// A 429 or 503 with Retry-After ends the attempts at once and passes the delay on.
    fn send(&mut self, body: Vec<u8>, budget: Duration) -> SendResult {
        let deadline = Instant::now() + budget;
        let (payload, gzipped) = match body.len() > GZIP_THRESHOLD {
            true => match gzip(&body) {
                Some(z) => (z, true),
                None => (body, false),
            },
            false => (body, false),
        };
        let mut error = "out of time".to_string();
        for i in 0..ATTEMPTS {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining < Duration::from_millis(50) {
                break;
            }
            match self.post(&payload, gzipped, self.timeout.min(remaining)) {
                Outcome::Ok => return SendResult::ok(),
                Outcome::Fail(e) => return SendResult::failed(e, None),
                Outcome::Pause(e, ms) => return SendResult::failed(e, Some(ms)),
                Outcome::Retry(e) => error = e,
            }
            let backoff = Duration::from_millis(100 * 3u64.pow(i));
            if Instant::now() + backoff >= deadline {
                break;
            }
            std::thread::sleep(backoff);
        }
        SendResult::failed(error, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn parses_retry_after() {
        assert_eq!(parse_retry_after("120", 0), Some(120_000));
        assert_eq!(parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", 784_111_777_000 - 5_000), Some(5_000));
        assert_eq!(parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", 784_111_777_000 + 1), Some(0));
        assert_eq!(parse_retry_after("soon", 0), None);
    }

    #[test]
    fn a_429_with_retry_after_stops_at_once_and_passes_the_delay_on() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/traces", listener.local_addr().unwrap());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h = hits.clone();
        thread::spawn(move || {
            for conn in listener.incoming() {
                let mut s = conn.unwrap();
                let _ = crate::http::read_message(&mut BufReader::new(s.try_clone().unwrap()), false, 1 << 20);
                h.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let resp = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
                std::io::Write::write_all(&mut s, resp.as_bytes()).unwrap();
            }
        });
        let mut e = HttpExporter::new(url, None, Duration::from_secs(1), Box::new(|_| {}));
        let r = e.send(b"{}".to_vec(), Duration::from_secs(2));
        assert!(!r.ok);
        assert_eq!(r.retry_after_ms, Some(30_000));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn retryable_statuses() {
        assert!(is_retryable(429) && is_retryable(503) && is_retryable(408));
        assert!(!is_retryable(400) && !is_retryable(401) && !is_retryable(404));
    }

    /// Serves the given statuses in order and reports each request's head and decoded body.
    fn server(statuses: Vec<u16>) -> (String, mpsc::Receiver<(String, String)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/traces", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for status in statuses {
                let (stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let msg = crate::http::read_message(&mut reader, false, 1 << 20).unwrap();
                let body = if msg.header("content-encoding") == Some("gzip") {
                    let mut s = String::new();
                    GzDecoder::new(&msg.body[..]).read_to_string(&mut s).unwrap();
                    s
                } else {
                    String::from_utf8(msg.body.clone()).unwrap()
                };
                let head = format!("{}\n{}", msg.start, msg.headers.iter().map(|(k, v)| format!("{}: {v}", k.to_lowercase())).collect::<Vec<_>>().join("\n"));
                tx.send((head, body)).unwrap();
                let mut s = stream;
                crate::http::write_response(&mut s, status, "{}").unwrap();
                let _ = reader.fill_buf();
            }
        });
        (url, rx)
    }

    #[test]
    fn posts_gzipped_json_with_bearer_auth_and_retries_5xx() {
        let (url, rx) = server(vec![503, 200]);
        let mut e = HttpExporter::new(url, Some("k1".into()), Duration::from_secs(1), Box::new(|_| {}));
        let body = format!("{{\"x\":\"{}\"}}", "a".repeat(2000));
        assert!(e.send(body.clone().into_bytes(), Duration::from_secs(2)).ok);
        for _ in 0..2 {
            let (head, got) = rx.recv().unwrap();
            assert!(head.starts_with("POST /v1/traces"));
            assert!(head.contains("authorization: Bearer k1"));
            assert!(head.contains("content-encoding: gzip"));
            assert!(head.contains("content-type: application/json"));
            assert_eq!(got, body);
        }
    }

    #[test]
    fn small_bodies_are_not_gzipped_and_4xx_is_not_retried() {
        let (url, rx) = server(vec![400, 200]);
        let mut e = HttpExporter::new(url, None, Duration::from_secs(1), Box::new(|_| {}));
        assert!(!e.send(b"{}".to_vec(), Duration::from_secs(2)).ok);
        let (head, body) = rx.recv().unwrap();
        assert!(!head.contains("content-encoding") && !head.contains("authorization"));
        assert_eq!(body, "{}");
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn unreachable_endpoint_gives_up_within_the_budget() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut e = HttpExporter::new(format!("http://127.0.0.1:{port}/v1/traces"), None, Duration::from_secs(1), Box::new(|_| {}));
        let started = Instant::now();
        assert!(!e.send(b"{}".to_vec(), Duration::from_millis(600)).ok);
        assert!(started.elapsed() < Duration::from_millis(700));
    }
}
