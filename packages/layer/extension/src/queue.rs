use crate::store::Batch;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::Duration;

const MIN_BACKOFF_MS: u64 = 5_000;
const MAX_BACKOFF_MS: u64 = 5 * 60_000;
const MAX_SPANS_PER_REQUEST: usize = 500;
const SCOPE_NAME: &str = "ivy-layer";
const SCOPE_VERSION: &str = "0.1.0";

/// Sends one OTLP/HTTP JSON body within `budget`; true when the collector accepted it.
pub trait Exporter {
    fn send(&mut self, body: Vec<u8>, budget: Duration) -> bool;
}

/// Bounded span queue with backoff and a dropped-span counter reported on the next export.
pub struct ExportQueue<E: Exporter> {
    exporter: E,
    max_queue_spans: usize,
    batches: VecDeque<Batch>,
    queued: usize,
    pub dropped: u64,
    next_attempt_at: u64,
    backoff_ms: u64,
    now: Box<dyn Fn() -> u64>,
    log: Box<dyn Fn(&str)>,
}

pub fn build_export_request(batches: &[Batch]) -> Value {
    let mut groups: Vec<(String, Value, Vec<Value>)> = Vec::new();
    for batch in batches {
        let key = batch.resource.to_string();
        match groups.iter_mut().find(|g| g.0 == key) {
            Some(g) => g.2.extend(batch.spans.iter().cloned()),
            None => groups.push((key, batch.resource.clone(), batch.spans.clone())),
        }
    }
    let resource_spans: Vec<Value> = groups
        .into_iter()
        .map(|(_, resource, spans)| {
            json!({
                "resource": { "attributes": resource },
                "scopeSpans": [{ "scope": { "name": SCOPE_NAME, "version": SCOPE_VERSION }, "spans": spans }],
            })
        })
        .collect();
    json!({ "resourceSpans": resource_spans })
}

fn set_dropped_attribute(span: &mut Value, dropped: u64) {
    let Some(obj) = span.as_object_mut() else { return };
    let attrs = obj.entry("attributes").or_insert_with(|| json!([]));
    if !attrs.is_array() {
        *attrs = json!([]);
    }
    if let Some(list) = attrs.as_array_mut() {
        list.retain(|a| a.get("key").and_then(Value::as_str) != Some("ivy.dropped_spans"));
        list.push(json!({ "key": "ivy.dropped_spans", "value": { "intValue": dropped.to_string() } }));
    }
}

impl<E: Exporter> ExportQueue<E> {
    pub fn new(exporter: E, max_queue_spans: usize, now: Box<dyn Fn() -> u64>, log: Box<dyn Fn(&str)>) -> Self {
        ExportQueue { exporter, max_queue_spans, batches: VecDeque::new(), queued: 0, dropped: 0, next_attempt_at: 0, backoff_ms: 0, now, log }
    }

    pub fn size(&self) -> usize {
        self.queued
    }

    pub fn add(&mut self, batch: Batch) {
        let n = batch.spans.len();
        if n == 0 {
            return;
        }
        while !self.batches.is_empty() && self.queued + n > self.max_queue_spans {
            if let Some(old) = self.batches.pop_front() {
                self.queued -= old.spans.len();
                self.drop_spans(old.spans.len(), "queue full");
            }
        }
        if n > self.max_queue_spans {
            self.drop_spans(n, "batch larger than queue");
            return;
        }
        self.batches.push_back(batch);
        self.queued += n;
    }

    fn drop_spans(&mut self, n: usize, reason: &str) {
        self.dropped += n as u64;
        (self.log)(&format!("dropped {n} spans ({reason}); {} dropped since last successful export", self.dropped));
    }

    /// Exports queued spans within `budget_ms`. `force` ignores the failure backoff (shutdown).
    pub fn flush(&mut self, budget_ms: u64, force: bool) {
        let deadline = (self.now)() + budget_ms;
        if !force && (self.now)() < self.next_attempt_at {
            return;
        }
        while !self.batches.is_empty() && deadline.saturating_sub((self.now)()) > 50 {
            let mut taken: Vec<Batch> = Vec::new();
            let mut count = 0;
            while let Some(next) = self.batches.front() {
                if count > 0 && count + next.spans.len() > MAX_SPANS_PER_REQUEST {
                    break;
                }
                count += next.spans.len();
                taken.extend(self.batches.pop_front());
            }
            self.queued -= count;
            let dropped = self.dropped;
            if dropped > 0 {
                if let Some(first) = taken.first_mut().and_then(|b| b.spans.first_mut()) {
                    set_dropped_attribute(first, dropped);
                }
            }
            let body = build_export_request(&taken).to_string().into_bytes();
            let remaining = Duration::from_millis(deadline.saturating_sub((self.now)()));
            if self.exporter.send(body, remaining) {
                self.dropped -= dropped;
                self.backoff_ms = 0;
                self.next_attempt_at = 0;
            } else {
                self.drop_spans(count, "export failed");
                self.backoff_ms = if self.backoff_ms == 0 { MIN_BACKOFF_MS } else { (self.backoff_ms * 2).min(MAX_BACKOFF_MS) };
                self.next_attempt_at = (self.now)() + self.backoff_ms;
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    struct Fake {
        results: Rc<RefCell<VecDeque<bool>>>,
        sent: Rc<RefCell<Vec<Value>>>,
    }

    impl Exporter for Fake {
        fn send(&mut self, body: Vec<u8>, _budget: Duration) -> bool {
            self.sent.borrow_mut().push(serde_json::from_slice(&body).unwrap());
            self.results.borrow_mut().pop_front().unwrap_or(true)
        }
    }

    struct Setup {
        q: ExportQueue<Fake>,
        sent: Rc<RefCell<Vec<Value>>>,
        time: Rc<Cell<u64>>,
    }

    fn setup(results: &[bool], max_queue_spans: usize) -> Setup {
        let sent = Rc::new(RefCell::new(Vec::new()));
        let time = Rc::new(Cell::new(1_000_000));
        let t = time.clone();
        let fake = Fake { results: Rc::new(RefCell::new(results.iter().copied().collect())), sent: sent.clone() };
        let q = ExportQueue::new(fake, max_queue_spans, Box::new(move || t.get()), Box::new(|_| {}));
        Setup { q, sent, time }
    }

    fn span(id: &str) -> Value {
        json!({ "traceId": "t".repeat(32), "spanId": id, "name": "x", "kind": 1, "attributes": [], "events": [], "status": { "code": 0 } })
    }

    fn batch(ids: &[&str]) -> Batch {
        Batch { resource: json!([]), spans: ids.iter().map(|id| span(id)).collect() }
    }

    fn dropped_attr(req: &Value) -> Option<String> {
        req["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"]
            .as_array()?
            .iter()
            .find(|a| a["key"] == "ivy.dropped_spans")
            .and_then(|a| a["value"]["intValue"].as_str().map(String::from))
    }

    #[test]
    fn exports_queued_batches() {
        let mut s = setup(&[true], 10);
        s.q.add(batch(&["a", "b"]));
        s.q.flush(1000, false);
        assert_eq!(s.sent.borrow().len(), 1);
        assert_eq!(s.q.size(), 0);
        let req = &s.sent.borrow()[0];
        assert_eq!(req["resourceSpans"][0]["scopeSpans"][0]["scope"]["name"], "ivy-layer");
        assert_eq!(req["resourceSpans"][0]["scopeSpans"][0]["spans"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn drops_a_failed_batch_backs_off_and_reports_the_dropped_count_on_the_next_export() {
        let mut s = setup(&[false, true], 10);
        s.q.add(batch(&["a", "b"]));
        s.q.flush(1000, false);
        assert_eq!(s.q.dropped, 2);

        s.q.add(batch(&["c"]));
        s.q.flush(1000, false);
        assert_eq!(s.sent.borrow().len(), 1, "still backing off");

        s.time.set(s.time.get() + 10_000);
        s.q.flush(1000, false);
        assert_eq!(s.sent.borrow().len(), 2);
        assert_eq!(dropped_attr(&s.sent.borrow()[1]).as_deref(), Some("2"));
        assert_eq!(s.q.dropped, 0);
    }

    #[test]
    fn backoff_doubles_up_to_five_minutes_and_resets_on_success() {
        let mut s = setup(&[false; 12], 10_000);
        let mut gaps = Vec::new();
        for _ in 0..8 {
            s.q.add(batch(&["a"]));
            s.q.flush(1000, false);
            gaps.push(s.q.next_attempt_at - s.time.get());
            s.time.set(s.q.next_attempt_at);
        }
        assert_eq!(gaps, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);

        let mut ok = setup(&[false, true], 10);
        ok.q.add(batch(&["a"]));
        ok.q.flush(1000, false);
        ok.time.set(ok.time.get() + 5_000);
        ok.q.add(batch(&["b"]));
        ok.q.flush(1000, false);
        assert_eq!(ok.q.backoff_ms, 0);
        assert_eq!(ok.q.next_attempt_at, 0);
    }

    #[test]
    fn bounds_the_queue_dropping_oldest_spans() {
        let mut s = setup(&[], 3);
        s.q.add(batch(&["a", "b"]));
        s.q.add(batch(&["c", "d"]));
        assert_eq!(s.q.size(), 2);
        assert_eq!(s.q.dropped, 2);
        s.q.add(batch(&["e", "f", "g", "h"]));
        assert_eq!(s.q.size(), 0);
        assert_eq!(s.q.dropped, 8);
    }

    #[test]
    fn force_flush_ignores_the_backoff() {
        let mut s = setup(&[false, true], 10);
        s.q.add(batch(&["a"]));
        s.q.flush(1000, false);
        s.q.add(batch(&["b"]));
        s.q.flush(1000, true);
        assert_eq!(s.sent.borrow().len(), 2);
    }

    #[test]
    fn splits_large_queues_into_requests_of_at_most_500_spans() {
        let mut s = setup(&[], 2000);
        let ids: Vec<String> = (0..300).map(|i| i.to_string()).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        s.q.add(batch(&refs));
        s.q.add(batch(&refs));
        s.q.add(batch(&refs));
        s.q.flush(1000, false);
        let counts: Vec<usize> = s.sent.borrow().iter().map(|r| r["resourceSpans"][0]["scopeSpans"][0]["spans"].as_array().unwrap().len()).collect();
        assert_eq!(counts, [300, 300, 300]);
    }

    #[test]
    fn groups_spans_by_resource() {
        let a = Batch { resource: json!([{"key": "service.name", "value": {"stringValue": "a"}}]), spans: vec![span("1")] };
        let b = Batch { resource: json!([{"key": "service.name", "value": {"stringValue": "b"}}]), spans: vec![span("2")] };
        let req = build_export_request(&[a.clone(), b, a]);
        let rs = req["resourceSpans"].as_array().unwrap();
        assert_eq!(rs.len(), 2);
        assert_eq!(rs[0]["scopeSpans"][0]["spans"].as_array().unwrap().len(), 2);
    }
}
