// Brute-force brake shared by every door into the hub: passwords, invite links, agent tokens (REST and MCP).
// Counts failures per key inside a fixed window. Memory stays bounded: expired keys are swept on a timer,
// and when an attacker cycles through more keys than `maxKeys` the oldest ones are dropped first.
export class RateLimiter {
  private hits = new Map<string, { n: number; since: number }>();
  private timer?: NodeJS.Timeout;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly maxKeys = 10_000,
  ) {
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.timer.unref();
  }

  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.since > this.windowMs) return false;
    return h.n >= this.limit;
  }

  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (h && now - h.since <= this.windowMs) {
      h.n++;
      return;
    }
    this.hits.delete(key); // re-insert so Map order stays "oldest window first"
    if (this.hits.size >= this.maxKeys) {
      this.sweep(now);
      // Still full: forget the oldest. An attacker can only make us forget, never grow.
      for (const k of this.hits.keys()) {
        if (this.hits.size < this.maxKeys) break;
        this.hits.delete(k);
      }
    }
    this.hits.set(key, { n: 1, since: now });
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  sweep(now = Date.now()): void {
    for (const [k, h] of this.hits) if (now - h.since > this.windowMs) this.hits.delete(k);
  }

  get size(): number {
    return this.hits.size;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
