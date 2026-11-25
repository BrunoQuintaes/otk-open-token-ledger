/**
 * D1–D8 / C — outbox worker: claims effects with a lease and runs the handler of their kind.
 *
 * Any instance can run it; claims are exclusive (PgEffectOutbox) and an effect whose owner died
 * becomes claimable when its lease expires, so pending work is recovered during normal
 * operation, without a restart and without a client retry (RV30-03, D7 §7). A handler failure
 * reschedules the effect with capped exponential backoff; it is never silently dropped.
 *
 * Handlers must be idempotent: an effect can run more than once (lease expiry, crash after the handler
 * but before the outcome is recorded). Timers are `unref`'d, so a running worker does not keep the
 * process alive. Reads no environment variables; the caller passes all options.
 *
 * @module src/operations/OutboxWorker
 */
import type { IsoTime, OutboxEffect } from '../types/d1d8/index.js';
import { LeaseLostError, type ClaimedEffect, type PgEffectOutbox } from './PgEffectOutbox.js';

/**
 * What a handler reports for one effect.
 *
 * - `'done'`: completed, nothing to record.
 * - `{ done: true, result }`: completed; `result` (public, non-secret) is merged into the stored payload.
 * - `{ retryAt, reason }`: not done; retry at `retryAt`, or mark the effect dead when `retryAt` is `null`
 *   (or the attempt limit is reached).
 */
export type EffectOutcome = 'done' | { done: true; result: Record<string, unknown> } | { retryAt: IsoTime | null; reason: string };
/** Runs one claimed effect. A thrown error is treated as a retry with backoff. Must be idempotent. */
export type EffectHandler = (effect: ClaimedEffect) => Promise<EffectOutcome>;

/** Tuning for {@link OutboxWorker}; every field has a default. */
export interface OutboxWorkerOptions {
  /** Lease length per claimed effect, ms (default 30000). Renewed every third of it while the handler runs. */
  leaseMs?: number;
  /** Maximum effects claimed per pass (default 50). */
  batch?: number;
  /** Polling period of {@link OutboxWorker.start}, ms (default 2000). */
  intervalMs?: number;
  /** Backoff after a thrown handler error: min(maxBackoffMs, baseBackoffMs × 2^(attempts-1)). */
  baseBackoffMs?: number;
  /** Cap of the backoff, ms (default 60000). The base defaults to 500 ms. */
  maxBackoffMs?: number;
  /** Optional observer called after each effect; must not throw (an exception would abort the pass). */
  onEvent?: (event: { kind: 'done' | 'retry' | 'error' | 'lease_lost'; effectId: string; effectKind: string; reason?: string }) => void;
  /** Only effects of this payload flavor (see PgEffectOutbox.claim). */
  flavor?: 'v3' | 'legacy';
}

/** Polls the outbox, claims effects of the kinds it has handlers for, and records each outcome. */
export class OutboxWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private rerun = false;
  private readonly kinds: OutboxEffect['kind'][];

  /**
   * Creates a stopped worker; call {@link OutboxWorker.start} or {@link OutboxWorker.tick} to process.
   *
   * @param outbox - The PostgreSQL outbox to claim from.
   * @param owner - Lease owner id of this instance; must be unique per running process.
   * @param handlers - One handler per effect kind; only these kinds are claimed.
   * @param opts - Tuning options.
   */
  constructor(
    private readonly outbox: PgEffectOutbox,
    readonly owner: string,
    private readonly handlers: Partial<Record<OutboxEffect['kind'], EffectHandler>>,
    private readonly opts: OutboxWorkerOptions = {},
  ) {
    this.kinds = Object.keys(handlers) as OutboxEffect['kind'][];
  }

  private backoff(attempts: number): IsoTime {
    const base = this.opts.baseBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 60_000;
    const ms = Math.min(max, base * 2 ** Math.max(0, Math.min(attempts - 1, 20)));
    return new Date(Date.now() + ms).toISOString();
  }

  /**
   * Claim and process one batch. Single-flight: concurrent calls share the running tick.
   *
   * A call made while a pass is running schedules one more pass before the shared promise resolves.
   *
   * @returns Number of effects claimed across the passes of this tick.
   * @throws {Error} Database errors from claim/complete/fail (other than a lost lease) propagate.
   */
  tick(): Promise<number> {
    if (this.running) { this.rerun = true; return this.running; }
    this.running = this.runLoop().finally(() => { this.running = null; });
    return this.running;
  }

  private async runLoop(): Promise<number> {
    let total = 0;
    do {
      this.rerun = false;
      total += await this.runOnce();
    } while (this.rerun);
    return total;
  }

  private async runOnce(): Promise<number> {
    if (this.kinds.length === 0) return 0;
    const claimed = await this.outbox.claim(this.owner, this.kinds, this.opts.leaseMs ?? 30_000, this.opts.batch ?? 50, this.opts.flavor);
    const leaseMs = this.opts.leaseMs ?? 30_000;
    for (const e of claimed) {
      const handler = this.handlers[e.kind];
      // review H6: a batch can outlast the lease; renew before each handler and keep renewing
      // while it runs, so another instance never runs the same effect concurrently
      if (!(await this.outbox.renew(e.effectId, this.owner, leaseMs).catch(() => false))) {
        this.opts.onEvent?.({ kind: 'lease_lost', effectId: e.effectId, effectKind: e.kind });
        continue;
      }
      const heartbeat = setInterval(() => { void this.outbox.renew(e.effectId, this.owner, leaseMs).catch(() => false); }, Math.max(50, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
      let outcome: EffectOutcome;
      try {
        outcome = handler ? await handler(e) : { retryAt: this.backoff(e.attempts), reason: 'no handler' };
      } catch (err) {
        outcome = { retryAt: this.backoff(e.attempts), reason: err instanceof Error ? err.message : String(err) };
        this.opts.onEvent?.({ kind: 'error', effectId: e.effectId, effectKind: e.kind, reason: outcome.reason });
      }
      // OVERNIGHT 20261005 / INC-03: the heartbeat keeps running until the outcome is RECORDED. It used to stop when the
      // handler returned; if complete()/fail() then took longer than the lease left (≤ 2/3 of it), another worker
      // claimed an effect whose handler had already succeeded and ran it again (traced: probes/p1_inc03).
      try {
        if (outcome === 'done' || 'done' in outcome) {
          await this.outbox.complete(e.effectId, this.owner, outcome === 'done' ? undefined : outcome.result);
          this.opts.onEvent?.({ kind: 'done', effectId: e.effectId, effectKind: e.kind });
        } else {
          await this.outbox.fail(e.effectId, this.owner, outcome.reason, outcome.retryAt);
          this.opts.onEvent?.({ kind: 'retry', effectId: e.effectId, effectKind: e.kind, reason: outcome.reason });
        }
      } catch (err) {
        if (!(err instanceof LeaseLostError)) throw err;
        // our lease expired while the handler ran; the new owner decides (handlers are idempotent)
        this.opts.onEvent?.({ kind: 'lease_lost', effectId: e.effectId, effectKind: e.kind });
      } finally {
        clearInterval(heartbeat);
      }
    }
    return claimed.length;
  }

  /**
   * Run a tick soon without waiting for it (request paths).
   *
   * @returns The tick's claimed count, or 0 when it failed (errors are swallowed).
   */
  kick(): Promise<number> {
    return this.tick().catch(() => 0);
  }

  /** Starts periodic ticks every `intervalMs`; a second call is a no-op. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.kick(); }, this.opts.intervalMs ?? 2_000);
    this.timer.unref?.();
  }

  /** Stops the timer and waits for the running tick (if any) to finish; tick errors are ignored. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => 0);
  }

  /**
   * Whether periodic ticks are scheduled.
   *
   * @returns `true` between {@link OutboxWorker.start} and {@link OutboxWorker.stop}.
   */
  get started(): boolean { return this.timer !== null; }
}
