// process.hrtime rather than performance.now(): the `performance` global loads perf_hooks on first use
// (~1 ms in a fresh worker thread).
const monotonicMs = () => {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
};

let anchorDate = Date.now();
let anchorMono = monotonicMs();

/** Re-anchors the high-resolution clock to wall time (called once per invocation). */
export function anchorClock(): void {
  anchorDate = Date.now();
  anchorMono = monotonicMs();
}

/** Epoch milliseconds with sub-millisecond precision. */
export function now(): number {
  return anchorDate + (monotonicMs() - anchorMono);
}
