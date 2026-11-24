/**
 * D1–D8 / S4 — later completion of a pending price (audit ABC-03).
 *
 * An operation whose measurement and CU are final may still have `money.state = pending_price`
 * (missing or partial quote): its reserved worst case stays held in every money budget. This
 * module settles it once a COMPLETE quote of the SAME stored usage exists — re-pricing the usage
 * already persisted with the operation, never calling the provider again (no new inference, no
 * second CU debit, no second receipt). Idempotent: a settled operation answers 'already'.
 *
 * Price source: the frozen table of the operation (config.priceTable), e.g. when the table was
 * not loaded at settlement time, or an explicit table chosen by the operator (correction); the
 * table used is recorded in money.priceTable and in otk_money_ledger.
 *
 * @module operations/pricingResolution
 */
import type { OperationKey, VersionRef } from '../types/d1d8/index.js';
import type { OperationsContext } from './context.js';
import { keyString } from './context.js';
import { moneyFromQuote } from './proxyDurable.js';
import { RevisionConflictError } from './PgOperationStore.js';

export type PriceResolution =
  | { outcome: 'settled'; table: VersionRef }
  | { outcome: 'already' }
  | { outcome: 'still_pending'; priceStatus: 'missing_price' | 'partial' }
  | { outcome: 'not_applicable'; reason: string };

export async function resolveOperationPrice(ctx: OperationsContext, key: OperationKey, table?: VersionRef): Promise<PriceResolution> {
  if (!ctx.measurement.priceUsage) return { outcome: 'not_applicable', reason: 'no_price_function' };
  for (let attempt = 0; attempt < 5; attempt++) {
    const op = await ctx.store.get(key);
    if (!op) return { outcome: 'not_applicable', reason: 'not_found' };
    if (!op.money) return { outcome: 'not_applicable', reason: 'no_money_held' };
    if (op.money.state === 'settled') return { outcome: 'already' };
    if (op.money.state !== 'pending_price' || op.measurement !== 'final' || !op.usage) return { outcome: 'not_applicable', reason: `money_${op.money.state}` };
    const ref = table ?? op.config.priceTable;
    if (!ref) return { outcome: 'still_pending', priceStatus: 'missing_price' };
    const quote = ctx.measurement.priceUsage(op.usage, op.usage.observedAt, ref);
    if (quote.status !== 'priced' || !quote.total) return { outcome: 'still_pending', priceStatus: quote.status === 'partial' ? 'partial' : 'missing_price' };
    try {
      await ctx.store.transition(key, op.revision, { money: moneyFromQuote(op.money, quote) });
      ctx.log('operation_price_resolved', { key: keyString(key), table: ref.version });
      return { outcome: 'settled', table: ref };
    } catch (err) {
      if (err instanceof RevisionConflictError) continue;
      throw err;
    }
  }
  return { outcome: 'not_applicable', reason: 'busy' };
}

export interface ReconciliationOptions {
  /** Operations claimed per pass (bounded cost). */
  limit?: number;
  /** Backoff after an attempt: base × 2^(attempts before it), capped at maxMs. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Attempts from which a still-pending operation is reported as stuck (alert). */
  alertAfterAttempts?: number;
}

/**
 * Reconciliation pass (RV2-02, AUD-4): claim the DUE pending-price operations (never tried first, then by
 * due time; see PgOperationStore.claimPendingPrice) and try the frozen table of each. An operation that
 * stays pending keeps its money held and is retried after its backoff, so it cannot block the others.
 * What is guaranteed (and what is not): backoff bounds ELIGIBILITY, not execution. A tried operation becomes
 * eligible again at most maxBackoffMs after its last attempt; it is claimed in the first pass whose `limit`
 * slots are not all taken by operations ahead of it — never-tried ones (always first) and earlier-due ones.
 * With a finite backlog and no new arrivals, a never-tried operation of rank r (oldest first) is claimed
 * within ceil(r / limit) passes (demonstrated: 101 → pass 2, 30 at limit 10 → pass 3). Under sustained arrivals
 * faster than limit per pass, or slow passes, no time bound holds: capacity (limit × pass rate) must exceed
 * the arrival rate of pending prices. Idempotent across restarts and workers: the schedule is in PostgreSQL and
 * every settlement is a revision-checked transition (money ledger keyed by operation).
 */
export async function resolvePendingPrices(ctx: OperationsContext, opts: ReconciliationOptions = {}): Promise<{ settled: number; pending: number; stuck: number }> {
  const limit = opts.limit ?? 100;
  const alertAfter = opts.alertAfterAttempts ?? 5;
  const keys = await ctx.store.claimPendingPrice(limit, { baseMs: opts.baseBackoffMs ?? 60_000, maxMs: opts.maxBackoffMs ?? 3_600_000 });
  let settled = 0; let pending = 0; let stuck = 0;
  for (const k of keys) {
    const r = await resolveOperationPrice(ctx, k).catch(() => null);
    if (r?.outcome === 'settled') settled++;
    else {
      pending++;
      if (k.attempts >= alertAfter) {
        stuck++;
        ctx.log('operation_price_pending_stuck', { key: keyString(k), attempts: k.attempts, outcome: r?.outcome ?? 'error' });
      }
    }
  }
  if (keys.length > 0) ctx.log('operation_price_reconciliation', { settled, pending, stuck });
  return { settled, pending, stuck };
}
