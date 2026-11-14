use crate::queue::Exporter;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Read, Write};
use std::time::{Duration, Instant};

const ATTEMPTS: u32 = 3;
const GZIP_THRESHOLD: usize = 1024;

pub fn is_retryable(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
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
    Retry,
    Fail,
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
                let mut text = String::new();
                resp.into_reader().take(200).read_to_string(&mut text).ok();
                (self.log)(&format!("export failed with HTTP {status}: {text}"));
                if is_retryable(status) {
                    Outcome::Retry
                } else {
                    Outcome::Fail
                }
            }
            Err(e) => {
                (self.log)(&format!("export failed: {e}"));
                Outcome::Retry
            }
        }
    }
}

impl Exporter for HttpExporter {
    /// Up to 3 attempts (backoff 100/300 ms) on network errors and retryable statuses, within `budget`.
    fn send(&mut self, body: Vec<u8>, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        let (payload, gzipped) = match body.len() > GZIP_THRESHOLD {
            true => match gzip(&body) {
                Some(z) => (z, true),
                None => (body, false),
            },
            false => (body, false),
        };
        for i in 0..ATTEMPTS {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining < Duration::from_millis(50) {
                break;
            }
            match self.post(&payload, gzipped, self.timeout.min(remaining)) {
                Outcome::Ok => return true,
                Outcome::Fail => return false,
                Outcome::Retry => {}
            }
            let backoff = Duration::from_millis(100 * 3u64.pow(i));
            if Instant::now() + backoff >= deadline {
                break;
            }
            std::thread::sleep(backoff);
        }
        false
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
        assert!(e.send(body.clone().into_bytes(), Duration::from_secs(2)));
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
        assert!(!e.send(b"{}".to_vec(), Duration::from_secs(2)));
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
        assert!(!e.send(b"{}".to_vec(), Duration::from_millis(600)));
        assert!(started.elapsed() < Duration::from_millis(700));
    }
}
