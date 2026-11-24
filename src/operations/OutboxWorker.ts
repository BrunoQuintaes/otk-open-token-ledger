/**
 * D1–D8 / C — outbox worker: claims effects with a lease and runs the handler of their kind.
 *
 * Any instance can run it; claims are exclusive (PgEffectOutbox) and an effect whose owner died
 * becomes claimable when its lease expires, so pending work is recovered during normal
 * operation, without a restart and without a client retry (RV30-03, D7 §7). A handler failure
 * reschedules the effect with capped exponential backoff; it is never silently dropped.
 *
 * @module operations/OutboxWorker
 */
import type { IsoTime, OutboxEffect } from '../types/d1d8/index.js';
import { LeaseLostError, type ClaimedEffect, type PgEffectOutbox } from './PgEffectOutbox.js';

export type EffectOutcome = 'done' | { done: true; result: Record<string, unknown> } | { retryAt: IsoTime | null; reason: string };
export type EffectHandler = (effect: ClaimedEffect) => Promise<EffectOutcome>;

export interface OutboxWorkerOptions {
  leaseMs?: number;
  batch?: number;
  intervalMs?: number;
  /** Backoff after a thrown handler error: min(maxBackoffMs, baseBackoffMs × 2^(attempts-1)). */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  onEvent?: (event: { kind: 'done' | 'retry' | 'error' | 'lease_lost'; effectId: string; effectKind: string; reason?: string }) => void;
  /** Only effects of this payload flavor (see PgEffectOutbox.claim). */
  flavor?: 'v3' | 'legacy';
}

export class OutboxWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private rerun = false;
  private readonly kinds: OutboxEffect['kind'][];

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

  /** Claim and process one batch. Single-flight: concurrent calls share the running tick. */
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

  /** Run a tick soon without waiting for it (request paths). */
  kick(): Promise<number> {
    return this.tick().catch(() => 0);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.kick(); }, this.opts.intervalMs ?? 2_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => 0);
  }

  get started(): boolean { return this.timer !== null; }
}
