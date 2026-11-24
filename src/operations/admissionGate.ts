/**
 * D1–D8 / OVERNIGHT 20261005 (Phase 1, F-P1-04) — per-process admission concurrency limit.
 *
 * Observed (services gate run on fcf15aa and repeated quota runs): 10 concurrent admissions per process, a pool of 10
 * PostgreSQL connections. Every admission transaction holds its connection while it waits for the tenant's quota row
 * lock (FOR UPDATE), so the pool is exhausted by waiters; the other queries of the same process (money-scope read,
 * the execution lease of admitted operations, recovery, effects) wait for a connection and fail after
 * connectionTimeoutMillis ("timeout exceeded when trying to connect"). Each such failure answered 503
 * persistence_unavailable although PostgreSQL was up.
 *
 * The gate keeps at most `limit` admissions inside the database at once (limit < pool size); the others wait IN
 * MEMORY, in arrival order, without holding a connection. A wait longer than `queueTimeoutMs` is refused as
 * backpressure (503 admission_busy), named as such, before anything is reserved or sent.
 *
 * @module operations/admissionGate
 */
export class AdmissionQueueTimeout extends Error {
  constructor(ms: number) { super(`admission waited more than ${ms} ms for a slot`); this.name = 'AdmissionQueueTimeout'; }
}

export class AdmissionGate {
  private active = 0;
  private readonly waiting: Array<{ go: () => void; timer: ReturnType<typeof setTimeout> | null }> = [];
  /** Highest number of waiters seen (observability). */
  maxQueued = 0;

  constructor(readonly limit: number, readonly queueTimeoutMs: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('admission limit must be a positive integer');
  }

  get inFlight(): number { return this.active; }
  get queued(): number { return this.waiting.length; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) { this.active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const entry = { go: () => { this.active++; resolve(); }, timer: null as ReturnType<typeof setTimeout> | null };
      entry.timer = setTimeout(() => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new AdmissionQueueTimeout(this.queueTimeoutMs));
      }, this.queueTimeoutMs);
      this.waiting.push(entry);
      if (this.waiting.length > this.maxQueued) this.maxQueued = this.waiting.length;
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) { if (next.timer) clearTimeout(next.timer); next.go(); }
  }
}
