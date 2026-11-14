use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Spans that share one OTLP resource.
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub resource: Value,
    pub spans: Vec<Value>,
}

#[derive(Default)]
struct Entry {
    resource: Value,
    spans: Vec<Value>,
    index: HashMap<String, usize>,
    is_final: bool,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    order: Vec<String>,
}

impl Inner {
    fn entry(&mut self, request_id: &str) -> &mut Entry {
        if !self.entries.contains_key(request_id) {
            self.order.push(request_id.to_string());
        }
        self.entries.entry(request_id.to_string()).or_default()
    }
}

/// Collects span batches from the in-process tracer per request ID. A later batch for the same
/// request replaces spans with the same ID (a provisional timeout snapshot is superseded by the final one).
#[derive(Default)]
pub struct SpanStore {
    inner: Mutex<Inner>,
    changed: Condvar,
}

fn span_id(span: &Value) -> String {
    match span.get("spanId") {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

impl SpanStore {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn add(&self, request_id: &str, is_final: bool, resource: Value, spans: Vec<Value>) {
        let mut inner = self.lock();
        let entry = inner.entry(request_id);
        entry.resource = resource;
        for span in spans {
            let id = span_id(&span);
            match entry.index.get(&id) {
                Some(&i) => entry.spans[i] = span,
                None => {
                    entry.index.insert(id, entry.spans.len());
                    entry.spans.push(span);
                }
            }
        }
        if is_final {
            entry.is_final = true;
            self.changed.notify_all();
        }
    }

    /// True once the final batch for `request_id` arrived, false after `timeout`.
    pub fn wait_for(&self, request_id: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut inner = self.lock();
        loop {
            if inner.entry(request_id).is_final {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            inner = match self.changed.wait_timeout(inner, deadline - now) {
                Ok((guard, _)) => guard,
                Err(e) => e.into_inner().0,
            };
        }
    }

    /// Removes and returns everything collected so far.
    pub fn drain(&self) -> Vec<Batch> {
        let mut inner = self.lock();
        let order = std::mem::take(&mut inner.order);
        let mut entries = std::mem::take(&mut inner.entries);
        order
            .iter()
            .filter_map(|id| entries.remove(id))
            .filter(|e| !e.spans.is_empty())
            .map(|e| Batch { resource: e.resource, spans: e.spans })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::thread;

    fn span(id: &str, name: &str) -> Value {
        json!({ "spanId": id, "name": name })
    }

    #[test]
    fn resolves_when_the_final_batch_arrives_before_or_after_waiting() {
        let s = Arc::new(SpanStore::default());
        s.add("r1", true, json!([]), vec![span("a", "x")]);
        assert!(s.wait_for("r1", Duration::from_secs(1)));

        let s2 = s.clone();
        let t = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            s2.add("r2", true, json!([]), vec![span("b", "x")]);
        });
        assert!(s.wait_for("r2", Duration::from_secs(1)));
        t.join().unwrap();
    }

    #[test]
    fn times_out_without_a_final_batch() {
        let s = SpanStore::default();
        s.add("r1", false, json!([]), vec![span("a", "x")]);
        let started = Instant::now();
        assert!(!s.wait_for("r1", Duration::from_millis(30)));
        assert!(started.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn final_batch_supersedes_provisional_spans_with_the_same_id() {
        let s = SpanStore::default();
        s.add("r1", false, json!([]), vec![span("root", "timeout")]);
        s.add("r1", true, json!([{"key": "service.name"}]), vec![span("root", "final"), span("child", "x")]);
        let batches = s.drain();
        assert_eq!(batches.len(), 1);
        let names: Vec<_> = batches[0].spans.iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["final", "x"]);
        assert_eq!(batches[0].resource, json!([{"key": "service.name"}]));
        assert!(s.drain().is_empty());
    }

    #[test]
    fn drain_keeps_arrival_order_and_skips_empty_entries() {
        let s = SpanStore::default();
        s.add("b", true, json!([]), vec![span("1", "b")]);
        assert!(!s.wait_for("empty", Duration::ZERO));
        s.add("a", true, json!([]), vec![span("2", "a")]);
        let names: Vec<_> = s.drain().iter().map(|b| b.spans[0]["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["b", "a"]);
    }
}
