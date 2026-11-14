let anchorDate = Date.now();
let anchorPerf = performance.now();

/** Re-anchors the high-resolution clock to wall time (called once per invocation). */
export function anchorClock(): void {
  anchorDate = Date.now();
  anchorPerf = performance.now();
}

/** Epoch milliseconds with sub-millisecond precision. */
export function now(): number {
  return anchorDate + (performance.now() - anchorPerf);
}
