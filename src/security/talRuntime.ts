/**
 * TokenAccountingLayer Runtime — process-level TAL singleton (u12.alpha.d)
 *
 * Canonical access point for CU ledger across the process.
 * Mirrors the pattern of rateLimitRuntime.ts.
 *
 * Supports late-binding via setAccountingLayer() to allow RedisTAL injection
 * after Redis is initialized (Wave 3A Pack 02).
 *
 * @module security/talRuntime
 * @since u12.alpha.d | updated Wave 3A (Pack 02)
 */

import { TokenAccountingLayer } from './TokenAccountingLayer.js';
import type { RedisTAL } from './RedisTAL.js';

type AccountingLayer = TokenAccountingLayer | RedisTAL;
let _tal: AccountingLayer = new TokenAccountingLayer();

/**
 * Returns the process-level accounting layer singleton.
 * May be a TokenAccountingLayer (in-memory) or RedisTAL (distributed).
 *
 * @returns The current accounting layer (in-memory unless replaced with `setAccountingLayer`).
 */
export function getAccountingLayer(): AccountingLayer {
  return _tal;
}

/**
 * Replace the accounting layer (e.g., inject RedisTAL after Redis init).
 * Called from storeBootstrap.ts when Redis is available.
 */
/**
 * N11: balance shared by every instance. With RedisTAL this reads the Redis total (the
 * synchronous balance() is this process's memory only, which after a restart or on another
 * replica is 0); with the in-memory TAL it is the same as balance().
 *
 * Order: the durable source when installed (its errors fall back), then the Redis total, then memory.
 *
 * @param tenantId - Tenant ID.
 * @param epochId - Epoch ID.
 * @returns The balance from the first available source.
 */
export async function sharedBalance(tenantId: string, epochId: string): Promise<ReturnType<AccountingLayer['balance']>> {
  // RV30-02: with PostgreSQL the durable ledger is the source every instance reads; Redis and
  // memory are projections that may lag (a failed Redis write, a restarted writer)
  if (_durableSource) {
    try { return await _durableSource(tenantId, epochId); } catch { /* fall back to the projection */ }
  }
  const tal = getAccountingLayer();
  return 'balanceAsync' in tal ? tal.balanceAsync(tenantId, epochId) : tal.balance(tenantId, epochId);
}

type BalanceSource = (tenantId: string, epochId: string) => Promise<ReturnType<AccountingLayer['balance']>>;
let _durableSource: BalanceSource | null = null;

/**
 * Install (or remove with null) the durable balance source (receiptStore, Postgres mode).
 *
 * @param source - Function that reads the durable balance, or `null` to remove it.
 */
export function setDurableBalanceSource(source: BalanceSource | null): void {
  _durableSource = source;
}

/**
 * Replaces the process-wide accounting layer (e.g. with a `RedisTAL` once Redis is ready).
 *
 * Entries already recorded in the previous layer are not copied.
 *
 * @param tal - New accounting layer.
 */
export function setAccountingLayer(tal: AccountingLayer): void {
  _tal = tal;
}

/**
 * Reset to default in-memory TAL (test isolation).
 */
export function resetAccountingLayerForTest(): void {
  _tal = new TokenAccountingLayer();
}
