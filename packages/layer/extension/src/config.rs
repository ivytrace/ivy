use std::collections::HashMap;

/// The subset of the layer's environment variables the extension uses (same parsing as `src/lib/config/config.ts`).
pub struct Config {
    pub traces_url: Option<String>,
    pub api_key: Option<String>,
    pub enabled: bool,
    pub debug: bool,
    pub extension_port: u16,
    pub export_timeout_ms: u64,
    pub flush_budget_ms: u64,
    pub max_queue_spans: usize,
}

/// Like JS `parseInt(value, 10)`: leading digits, anything else falls back.
fn int(value: Option<&String>, fallback: u64) -> u64 {
    let Some(v) = value else { return fallback };
    let digits: String = v.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(fallback)
}

fn bool(value: Option<&String>, fallback: bool) -> bool {
    match value {
        None => fallback,
        Some(v) if v.is_empty() => fallback,
        Some(v) => !matches!(v.to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"),
    }
}

pub fn traces_url(endpoint: &str) -> String {
    let base = endpoint.trim_end_matches('/');
    if base.ends_with("/v1/traces") {
        base.to_string()
    } else {
        format!("{base}/v1/traces")
    }
}

impl Config {
    pub fn from_env() -> Self {
        Self::from_map(&std::env::vars().collect())
    }

    pub fn from_map(env: &HashMap<String, String>) -> Self {
        let endpoint = env.get("IVY_ENDPOINT").filter(|v| !v.is_empty());
        let port = int(env.get("IVY_EXTENSION_PORT"), 9790);
        Config {
            traces_url: endpoint.map(|e| traces_url(e)),
            api_key: env.get("IVY_API_KEY").filter(|v| !v.is_empty()).cloned(),
            enabled: endpoint.is_some() && !bool(env.get("IVY_DISABLE"), false),
            debug: bool(env.get("IVY_DEBUG"), false),
            extension_port: u16::try_from(port).unwrap_or(9790),
            export_timeout_ms: int(env.get("IVY_EXPORT_TIMEOUT_MS"), 1000),
            flush_budget_ms: int(env.get("IVY_FLUSH_BUDGET_MS"), 2000),
            max_queue_spans: int(env.get("IVY_MAX_QUEUE_SPANS"), 2000) as usize,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn defaults_and_endpoint() {
        let c = Config::from_map(&env(&[("IVY_ENDPOINT", "https://ingest.example.com/")]));
        assert!(c.enabled);
        assert_eq!(c.traces_url.as_deref(), Some("https://ingest.example.com/v1/traces"));
        assert_eq!(c.extension_port, 9790);
        assert_eq!(c.max_queue_spans, 2000);
        assert_eq!(traces_url("http://x/v1/traces"), "http://x/v1/traces");
    }

    #[test]
    fn disabled_without_endpoint_or_with_ivy_disable() {
        assert!(!Config::from_map(&env(&[])).enabled);
        assert!(!Config::from_map(&env(&[("IVY_ENDPOINT", "http://x"), ("IVY_DISABLE", "true")])).enabled);
        assert!(Config::from_map(&env(&[("IVY_ENDPOINT", "http://x"), ("IVY_DISABLE", "0")])).enabled);
    }

    #[test]
    fn ints_parse_like_parse_int() {
        let c = Config::from_map(&env(&[("IVY_EXPORT_TIMEOUT_MS", "250ms"), ("IVY_FLUSH_BUDGET_MS", "x"), ("IVY_EXTENSION_PORT", "99999")]));
        assert_eq!(c.export_timeout_ms, 250);
        assert_eq!(c.flush_budget_ms, 2000);
        assert_eq!(c.extension_port, 9790);
    }
}
