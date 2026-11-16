//! API key → tenant and project (cached), monthly trace quotas, per-IP invalid-key limiting and usage counters.
//! Same rules as the Node router these replace (docs/implementation/tenancy.md, limits.md); the SQL mirrors
//! packages/api's tenancy and limits stores.

use crate::clickhouse::Client;
use serde::Deserialize;
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

pub fn hash_key(key: &str) -> String {
    Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// ClickHouse's JSON quotes 64-bit integers.
fn json_u64(v: &Json) -> Option<u64> {
    match v {
        Json::Number(n) => n.as_u64(),
        Json::String(s) => s.parse().ok(),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    pub tenant_id: String,
    pub project_id: String,
    pub shard_id: String,
}

struct CacheEntry {
    value: Option<Resolved>,
    expires: i64,
}

pub struct KeyCache {
    control: Client,
    database: String,
    entries: Mutex<HashMap<String, CacheEntry>>,
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

const KEY_TTL_MS: i64 = 60_000;
const NEGATIVE_TTL_MS: i64 = 30_000;
const MAX_KEYS: usize = 50_000;

#[derive(Deserialize)]
struct KeyRow {
    tenant_id: String,
    project_id: String,
}

#[derive(Deserialize)]
struct TenantRow {
    shard_id: String,
    slug: String,
}

impl KeyCache {
    pub fn new(control: Client, database: String) -> KeyCache {
        KeyCache { control, database, entries: Mutex::new(HashMap::new()), inflight: Mutex::new(HashMap::new()) }
    }

    fn cached(&self, hash: &str) -> Option<Option<Resolved>> {
        let entries = self.entries.lock().unwrap();
        entries.get(hash).filter(|e| e.expires > now_ms()).map(|e| e.value.clone())
    }

    /// A cached valid key, without a lookup.
    pub fn peek(&self, key: &str) -> bool {
        matches!(self.cached(&hash_key(key)), Some(Some(_)))
    }

    pub async fn resolve(&self, key: &str) -> Result<Option<Resolved>, String> {
        let hash = hash_key(key);
        if let Some(hit) = self.cached(&hash) {
            return Ok(hit);
        }
        // Concurrent lookups of one key share a query.
        let lock = self.inflight.lock().unwrap().entry(hash.clone()).or_default().clone();
        let _guard = lock.lock().await;
        if let Some(hit) = self.cached(&hash) {
            return Ok(hit);
        }
        let result = self.lookup(&hash).await;
        self.inflight.lock().unwrap().remove(&hash);
        let value = result?;
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= MAX_KEYS {
            let now = now_ms();
            entries.retain(|_, e| e.expires > now);
            if entries.len() >= MAX_KEYS {
                entries.clear();
            }
        }
        let ttl = if value.is_some() { KEY_TTL_MS } else { NEGATIVE_TTL_MS };
        entries.insert(hash, CacheEntry { value: value.clone(), expires: now_ms() + ttl });
        Ok(value)
    }

    /// A key without a project, or whose project is archived or missing, is rejected like a revoked one.
    async fn lookup(&self, hash: &str) -> Result<Option<Resolved>, String> {
        let db = &self.database;
        let keys: Vec<KeyRow> = self
            .control
            .query(db, "SELECT tenant_id, project_id FROM api_keys FINAL WHERE key_hash = {hash:String} AND revoked_at IS NULL LIMIT 1", &[("hash", hash.into())])
            .await?;
        let Some(key) = keys.into_iter().next() else { return Ok(None) };
        let Some(tenant) = tenant(&self.control, db, &key.tenant_id).await? else { return Ok(None) };
        if key.project_id.is_empty() {
            return Ok(None);
        }
        let projects: Vec<HashMap<String, Json>> = self
            .control
            .query(
                db,
                "SELECT archived = 1 AS archived FROM projects FINAL WHERE tenant_id = {tenant_id:String} AND id = {id:String}",
                &[("tenant_id", key.tenant_id.clone()), ("id", key.project_id.clone())],
            )
            .await?;
        let archived = match projects.first() {
            None => return Ok(None),
            Some(p) => p.get("archived").is_some_and(|a| a == &Json::Bool(true) || json_u64(a) == Some(1)),
        };
        Ok((!archived).then_some(Resolved { tenant_id: key.tenant_id, project_id: key.project_id, shard_id: tenant.shard_id }))
    }
}

async fn tenant(control: &Client, db: &str, id: &str) -> Result<Option<TenantRow>, String> {
    let rows: Vec<TenantRow> = control
        .query(db, "SELECT shard_id, slug FROM tenants FINAL WHERE id = {id:String} AND NOT deleted", &[("id", id.into())])
        .await?;
    Ok(rows.into_iter().next())
}

// ---------- monthly quotas (limits.md) ----------

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub plan: String,
    /// Some(quota) only when the workspace's limits can block (`over_quota = block` with a quota).
    pub blocking_quota: Option<u64>,
    pub used: u64,
    pub upgrade_url: Option<String>,
}

struct QuotaEntry {
    month: (i64, u32),
    snapshot: Snapshot,
    local: u64,
    refreshed_at: i64,
}

pub struct QuotaGate {
    control: Client,
    control_db: String,
    shards: HashMap<String, Client>,
    data_db: String,
    refresh_ms: i64,
    recheck_seconds: i64,
    public_url: Option<String>,
    upgrade_url: Option<String>,
    entries: Mutex<HashMap<String, QuotaEntry>>,
    refreshing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

pub struct Block {
    pub retry_after: i64,
    pub message: String,
}

const FAILURE_RETRY_MS: i64 = 10_000;
const HOUR_MS: i64 = 3_600_000;

impl QuotaGate {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        control: Client,
        control_db: String,
        shards: HashMap<String, Client>,
        data_db: String,
        refresh_seconds: i64,
        recheck_seconds: i64,
        public_url: Option<String>,
        upgrade_url: Option<String>,
    ) -> QuotaGate {
        QuotaGate {
            control,
            control_db,
            shards,
            data_db,
            refresh_ms: refresh_seconds * 1000,
            recheck_seconds,
            public_url,
            upgrade_url,
            entries: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(HashMap::new()),
        }
    }

    /// None when the tenant may ingest. Fails open when the lookup fails.
    pub async fn check(self: &Arc<Self>, tenant: &str, shard: &str) -> Option<Block> {
        let now = now_ms();
        let month = month_of(now);
        let state = self.entries.lock().unwrap().get(tenant).map(|e| (e.month == month, now - e.refreshed_at >= self.refresh_ms));
        match state {
            Some((true, stale)) => {
                if stale {
                    let (gate, tenant, shard) = (self.clone(), tenant.to_string(), shard.to_string());
                    tokio::spawn(async move { gate.refresh(&tenant, &shard, month, false).await });
                }
            }
            _ => self.refresh(tenant, shard, month, true).await,
        }
        let entries = self.entries.lock().unwrap();
        let e = entries.get(tenant)?;
        let quota = e.snapshot.blocking_quota?;
        if e.snapshot.used + e.local < quota {
            return None;
        }
        let until_next_month = (month_bounds(month).1 - now + 999) / 1000;
        Some(Block {
            retry_after: until_next_month.min(self.recheck_seconds).max(1),
            message: quota_message(quota, &e.snapshot.plan, e.snapshot.upgrade_url.as_deref()),
        })
    }

    /// Counts traces accepted for a tenant since its snapshot.
    pub fn add(&self, tenant: &str, traces: u64) {
        if let Some(e) = self.entries.lock().unwrap().get_mut(tenant) {
            e.local += traces;
        }
    }

    async fn refresh(&self, tenant: &str, shard: &str, month: (i64, u32), wait: bool) {
        let lock = self.refreshing.lock().unwrap().entry(tenant.to_string()).or_default().clone();
        let _guard = if wait {
            let guard = lock.lock().await;
            // Someone else loaded it while we waited.
            if self.entries.lock().unwrap().get(tenant).is_some_and(|e| e.month == month) {
                return;
            }
            guard
        } else {
            match lock.try_lock() {
                Ok(guard) => guard,
                Err(_) => return,
            }
        };
        let started = now_ms();
        let local_before = self.entries.lock().unwrap().get(tenant).filter(|e| e.month == month).map_or(0, |e| e.local);
        let result = self.load(tenant, shard, month, started).await;
        let mut entries = self.entries.lock().unwrap();
        match result {
            Ok(snapshot) => {
                // Traces accepted while the query ran may or may not be in its result; keep counting them.
                let local = entries.get(tenant).filter(|e| e.month == month).map_or(0, |e| e.local.saturating_sub(local_before));
                entries.insert(tenant.to_string(), QuotaEntry { month, snapshot, local, refreshed_at: started });
            }
            Err(err) => {
                eprintln!("[ingest] quota lookup for {tenant} failed (allowing ingest): {err}");
                let retry_at = started - self.refresh_ms + FAILURE_RETRY_MS;
                match entries.get_mut(tenant).filter(|e| e.month == month) {
                    Some(e) => e.refreshed_at = retry_at,
                    None => {
                        entries.insert(tenant.to_string(), QuotaEntry { month, snapshot: Snapshot::default(), local: 0, refreshed_at: retry_at });
                    }
                }
            }
        }
    }

    async fn load(&self, tenant: &str, shard: &str, month: (i64, u32), now: i64) -> Result<Snapshot, String> {
        let rows: Vec<HashMap<String, Json>> = self
            .control
            .query(
                &self.control_db,
                "SELECT plan, monthly_trace_quota, over_quota FROM workspace_limits FINAL WHERE tenant_id = {tenant:String} AND NOT deleted",
                &[("tenant", tenant.into())],
            )
            .await?;
        let Some(row) = rows.first() else { return Ok(Snapshot::default()) };
        let plan = row.get("plan").and_then(|p| p.as_str()).unwrap_or_default().to_string();
        let quota = row.get("monthly_trace_quota").and_then(json_u64);
        let blocks = row.get("over_quota").and_then(|o| o.as_str()) == Some("block");
        let Some(quota) = quota.filter(|_| blocks) else { return Ok(Snapshot { plan, ..Default::default() }) };
        let client = self.shards.get(shard).ok_or_else(|| format!("unknown shard {shard}"))?;
        let used = count_monthly_traces(client, &self.data_db, tenant, month, now).await?;
        let slug = tenant_slug(&self.control, &self.control_db, tenant).await?.unwrap_or_else(|| tenant.to_string());
        Ok(Snapshot { plan, blocking_quota: Some(quota), used, upgrade_url: self.upgrade_link(&slug) })
    }

    fn upgrade_link(&self, workspace: &str) -> Option<String> {
        let ws = encode_uri_component(workspace);
        if let Some(explicit) = &self.upgrade_url {
            return Some(explicit.replace("{workspace}", &ws));
        }
        self.public_url.as_ref().map(|p| format!("{}/w/{ws}/settings/usage", p.trim_end_matches('/')))
    }
}

async fn tenant_slug(control: &Client, db: &str, id: &str) -> Result<Option<String>, String> {
    Ok(tenant(control, db, id).await?.map(|t| t.slug).filter(|s| !s.is_empty()))
}

/// Rows of `invocations` this month up to now: whole hours from `invocations_hourly`, the partial hours at the
/// edges from `invocations` (packages/api/src/lib/limits/usage.ts).
async fn count_monthly_traces(client: &Client, db: &str, tenant: &str, month: (i64, u32), now: i64) -> Result<u64, String> {
    let (start, end) = month_bounds(month);
    let (from, to) = (start, start.max(end.min(now)));
    if from >= to {
        return Ok(0);
    }
    let (mut h1, mut h2) = (((from + HOUR_MS - 1) / HOUR_MS) * HOUR_MS, (to / HOUR_MS) * HOUR_MS);
    if h1 >= h2 {
        (h1, h2) = (to, to);
    }
    let sql = "SELECT sum(n) AS traces FROM (
        SELECT sum(invocations) AS n FROM invocations_hourly
        WHERE tenant_id = {tenant:String}
          AND hour >= fromUnixTimestamp64Milli({h1:Int64}) AND hour < fromUnixTimestamp64Milli({h2:Int64})
        UNION ALL
        SELECT count() AS n FROM invocations
        WHERE tenant_id = {tenant:String}
          AND ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})
          AND (ts < fromUnixTimestamp64Milli({h1:Int64}) OR ts >= fromUnixTimestamp64Milli({h2:Int64}))
      )";
    let params = [("tenant", tenant.to_string()), ("h1", h1.to_string()), ("h2", h2.to_string()), ("from", from.to_string()), ("to", to.to_string())];
    let rows: Vec<HashMap<String, Json>> = client.query(db, sql, &params).await?;
    Ok(rows.first().and_then(|r| r.get("traces")).and_then(json_u64).unwrap_or(0))
}

pub fn quota_message(quota: u64, plan: &str, upgrade_url: Option<&str>) -> String {
    let plan = if plan.is_empty() { String::new() } else { format!(" on the {plan} plan") };
    let upgrade = match upgrade_url {
        Some(u) => format!("Upgrade at {u}"),
        None => "Upgrade the workspace's plan or ask the Ivy operator to raise the quota".into(),
    };
    format!(
        "Monthly trace quota reached ({} traces{plan}). Traces are rejected until the next month (UTC). {upgrade}.",
        thousands(quota)
    )
}

fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The UTC calendar month containing `ms`.
pub fn month_of(ms: i64) -> (i64, u32) {
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m)
}

/// [first ms of the month, first ms of the next month).
pub fn month_bounds((y, m): (i64, u32)) -> (i64, i64) {
    let next = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    (days_from_civil(y, m, 1) * 86_400_000, days_from_civil(next.0, next.1, 1) * 86_400_000)
}

// ---------- invalid keys per IP ----------

/// Invalid-key attempts per client IP in fixed one-minute windows; past `max` an IP is blocked until its window
/// ends (except for keys already cached as valid).
pub struct FailureLimiter {
    max: u32,
    windows: Mutex<HashMap<String, (i64, u32)>>,
}

const WINDOW_MS: i64 = 60_000;

impl FailureLimiter {
    pub fn new(max: u32) -> FailureLimiter {
        FailureLimiter { max, windows: Mutex::new(HashMap::new()) }
    }

    /// Seconds until the IP may try again, or 0.
    pub fn blocked_for(&self, ip: &str) -> i64 {
        let windows = self.windows.lock().unwrap();
        match windows.get(ip) {
            Some(&(start, failures)) if failures >= self.max => {
                let left = start + WINDOW_MS - now_ms();
                if left > 0 { (left + 999) / 1000 } else { 0 }
            }
            _ => 0,
        }
    }

    pub fn fail(&self, ip: &str) {
        let now = now_ms();
        let mut windows = self.windows.lock().unwrap();
        let w = windows.entry(ip.to_string()).or_insert((now, 0));
        if now - w.0 >= WINDOW_MS {
            *w = (now, 0);
        }
        w.1 += 1;
        if windows.len() > 100_000 {
            windows.retain(|_, w| now - w.0 < WINDOW_MS);
        }
    }
}

// ---------- usage ----------

#[derive(Clone, Copy, Debug, Default, serde::Serialize, PartialEq)]
pub struct Usage {
    pub requests: u64,
    pub spans: u64,
    pub bytes: u64,
}

/// Accepted traffic per tenant since start (logged once a minute, served on the admin port).
#[derive(Default)]
pub struct UsageCounters {
    totals: Mutex<HashMap<String, Usage>>,
    logged: Mutex<HashMap<String, Usage>>,
}

impl UsageCounters {
    pub fn add(&self, tenant: &str, spans: u64, bytes: u64) {
        let mut totals = self.totals.lock().unwrap();
        let u = totals.entry(tenant.to_string()).or_default();
        u.requests += 1;
        u.spans += spans;
        u.bytes += bytes;
    }

    pub fn snapshot(&self) -> HashMap<String, Usage> {
        self.totals.lock().unwrap().clone()
    }

    pub fn deltas(&self) -> Vec<(String, Usage)> {
        let totals = self.snapshot();
        let mut logged = self.logged.lock().unwrap();
        let mut out = Vec::new();
        for (tenant, u) in totals {
            let prev = logged.get(&tenant).copied().unwrap_or_default();
            if u.requests == prev.requests {
                continue;
            }
            out.push((tenant.clone(), Usage { requests: u.requests - prev.requests, spans: u.spans - prev.spans, bytes: u.bytes - prev.bytes }));
            logged.insert(tenant, u);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months() {
        // 2026-11-16T11:00:00Z
        let ms = 1_794_826_800_000;
        assert_eq!(month_of(ms), (2026, 11));
        let (start, end) = month_bounds((2026, 11));
        assert_eq!(start, 1_793_491_200_000); // 2026-11-01
        assert_eq!(end, 1_796_083_200_000); // 2026-12-01
        assert_eq!(month_bounds((2026, 12)).1, 1_798_761_600_000); // 2027-01-01
        assert_eq!(month_of(start - 1), (2026, 10));
    }

    #[test]
    fn quota_messages() {
        assert_eq!(
            quota_message(100_000, "free", Some("https://example.com/w/acme/settings/usage")),
            "Monthly trace quota reached (100,000 traces on the free plan). Traces are rejected until the next month (UTC). Upgrade at https://example.com/w/acme/settings/usage."
        );
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000_000), "1,000,000");
    }

    #[test]
    fn limiter_blocks_after_max_failures() {
        let l = FailureLimiter::new(2);
        l.fail("1.2.3.4");
        assert_eq!(l.blocked_for("1.2.3.4"), 0);
        l.fail("1.2.3.4");
        assert!(l.blocked_for("1.2.3.4") > 0);
        assert_eq!(l.blocked_for("5.6.7.8"), 0);
    }

    #[test]
    fn usage_deltas() {
        let u = UsageCounters::default();
        u.add("t", 3, 100);
        u.add("t", 2, 50);
        assert_eq!(u.deltas()[0].1, Usage { requests: 2, spans: 5, bytes: 150 });
        assert!(u.deltas().is_empty());
    }

    #[test]
    fn hashes_like_the_api() {
        assert_eq!(hash_key("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
