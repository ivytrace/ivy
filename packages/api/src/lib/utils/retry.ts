const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries `fn` (e.g. startup work while ClickHouse comes up) for up to `budgetMs`. */
export async function retry<T>(label: string, fn: () => Promise<T>, budgetMs = 60_000, intervalMs = 2_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() + intervalMs > deadline) throw err;
      console.warn(`${label} failed, retrying: ${(err as Error).message}`);
      await sleep(intervalMs);
    }
  }
}
