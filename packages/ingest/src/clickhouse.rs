//! Minimal ClickHouse HTTP client: parameterised SELECTs (JSONEachRow) and RowBinary inserts.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::client::legacy::{connect::HttpConnector, Client as HyperClient};
use hyper_util::rt::TokioExecutor;
use serde::de::DeserializeOwned;
use std::time::Duration;

#[derive(Clone)]
pub struct Client {
    http: HyperClient<HttpConnector, Full<Bytes>>,
    url: String,
    user: String,
    password: String,
}

fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl Client {
    pub fn new(url: &str, user: &str, password: &str) -> Result<Client, String> {
        let url = url.trim_end_matches('/').to_string();
        if !url.starts_with("http://") {
            return Err(format!("ClickHouse URL {url}: only http:// is supported"));
        }
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        connector.set_connect_timeout(Some(Duration::from_secs(5)));
        let http = HyperClient::builder(TokioExecutor::new()).pool_idle_timeout(Duration::from_secs(30)).build(connector);
        Ok(Client { http, url, user: user.into(), password: password.into() })
    }

    async fn post(&self, query: &[(&str, &str)], body: Bytes, timeout: Duration) -> Result<Bytes, String> {
        let qs: Vec<String> = query.iter().map(|(k, v)| format!("{}={}", encode_component(k), encode_component(v))).collect();
        let req = Request::post(format!("{}/?{}", self.url, qs.join("&")))
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .body(Full::new(body))
            .map_err(|e| e.to_string())?;
        let res = tokio::time::timeout(timeout, async {
            let res = self.http.request(req).await.map_err(|e| e.to_string())?;
            let status = res.status();
            let body = res.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
            Ok::<_, String>((status, body))
        })
        .await
        .map_err(|_| format!("ClickHouse timed out after {timeout:?}"))??;
        if !res.0.is_success() {
            return Err(format!("ClickHouse {}: {}", res.0, String::from_utf8_lossy(&res.1).trim()));
        }
        Ok(res.1)
    }

    /// SELECT with `{name:Type}` parameters, rows as JSONEachRow.
    pub async fn query<T: DeserializeOwned>(&self, database: &str, sql: &str, params: &[(&str, String)]) -> Result<Vec<T>, String> {
        let names: Vec<String> = params.iter().map(|(k, _)| format!("param_{k}")).collect();
        let mut q: Vec<(&str, &str)> = vec![("database", database), ("default_format", "JSONEachRow")];
        for (i, (_, v)) in params.iter().enumerate() {
            q.push((&names[i], v));
        }
        let body = self.post(&q, Bytes::from(sql.to_string()), Duration::from_secs(10)).await?;
        body.split(|&b| b == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_slice(l).map_err(|e| e.to_string()))
            .collect()
    }

    pub async fn insert_row_binary(&self, database: &str, table: &str, columns: &str, rows: Bytes) -> Result<(), String> {
        let sql = format!("INSERT INTO {database}.{table} ({columns}) FORMAT RowBinary");
        self.post(&[("query", &sql)], rows, Duration::from_secs(60)).await.map(|_| ())
    }
}
