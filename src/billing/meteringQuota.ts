/**
 * RV01 — one quota rule for every entry that creates receipts: API `POST /receipts`,
 * proxy MITM (`/v1/*`) and proxy legacy event (`POST /proxy`).
 *
 * Consumption is read from the TokenAccountingLayer, the store that `storeReceipt()`
 * debits. Before RV01 the API read a budget tracker that nothing recorded spend into
 * (always 0), so its quota never triggered; the proxy already used the TAL.
 *
 * Rule: a tenant whose consumption in the current epoch has reached the plan quota is
 * refused before any effect. The request that crosses the limit is still accepted
 * (the check happens before its CU are known). Quota 0 (PRO) = no hard limit.
 * Scope of checkMeteringQuota: the TAL of this process. checkMeteringQuotaAsync (used by
 * the entry points, N11) reads the shared balance (Redis when configured), so a restart or
 * another replica no longer resets consumption to 0. Replicas still race between the check
 * and the debit: two concurrent requests can both pass just below the limit.
 *
 * Called by the receipt and proxy entry points (`src/api/routes.ts`, `src/proxy/ProxyGateway.ts`) and by
 * `src/operations/runtime.ts` (`quotaUnitsFor`). The epoch is derived from the time with `deriveEpoch`.
 * It does NOT debit anything: the debit happens when the receipt is stored.
 *
 * @module src/billing/meteringQuota
 */
import { checkQuota, getTenantPlanDefinition, getTenantPlanAsync } from './PlanRegistry.js';
import { quotaUnits } from '../operations/accounting.js';
import { getAccountingLayer, sharedBalance } from '../security/talRuntime.js';
import { deriveEpoch } from '../types/receipt.js';

/**
 * Checks the tenant's quota against this process's accounting layer only (cached plan tier).
 *
 * @param tenantId - Tenant to check.
 * @param nowSec - Current time in Unix seconds; selects the epoch.
 * @returns Whether the quota is reached, the quota and the current CU (quota 0n = no hard limit).
 */
export function checkMeteringQuota(
  tenantId: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): { exceeded: boolean; quota: bigint; current: bigint } {
  const epochId = String(deriveEpoch(nowSec));
  const { exceeded, quota, current } = checkQuota(tenantId, getAccountingLayer().balance(tenantId, epochId).totalCU);
  return { exceeded, quota, current };
}

/** CU admitted in this process whose durable write has not finished, by tenant and epoch. */
const _inFlightCU = new Map<string, bigint>();

/** Result of `reserveMeteringQuota`: the quota check plus a handle to free the reserved CU. */
export interface QuotaReservation {
  /** True when the tenant has already reached the quota (nothing was reserved). */
  exceeded: boolean;
  /** Plan quota in CU per epoch; 0n means no hard limit. */
  quota: bigint;
  /** CU counted at check time (stored plus in flight in this process). */
  current: bigint;
  /** Call once the receipt was stored, refused or failed (idempotent). */
  release(): void;
}

/**
 * Same rule for an entry whose CU is known before storing (POST /receipts), counting the CU
 * of receipts still being written by this process. The check and the reservation run with no
 * await between them, so concurrent requests in one process see each other (sequential
 * semantics). Without this, reading the shared balance and awaiting the Postgres write let
 * 20 simultaneous requests of 3000 CU all pass a 10000 CU quota in one instance (session
 * 2026-09-30, S7c). Replicas still race with each other.
 * H1-S01: the tier is read from the plan store first (see checkMeteringQuotaAsync).
 *
 * @param tenantId - Tenant to check.
 * @param cu - CU of the receipt about to be stored.
 * @param nowSec - Receipt time in Unix seconds; selects the epoch.
 * @returns The check result; unless `exceeded`, `cu` stays reserved until `release()` is called.
 * @throws {Error} When the plan store or the shared balance cannot be read.
 */
export async function reserveMeteringQuota(
  tenantId: string,
  cu: bigint,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<QuotaReservation> {
  const epochId = String(deriveEpoch(nowSec));
  // H1-S01 (FA-05): the plan is read from the store, so a change made by another replica applies now
  await getTenantPlanAsync(tenantId);
  const shared = (await sharedBalance(tenantId, epochId)).totalCU;
  // No await from here on
  const local = getAccountingLayer().balance(tenantId, epochId).totalCU;
  const key = `${tenantId}|${epochId}`;
  const pending = _inFlightCU.get(key) ?? 0n;
  const { exceeded, quota, current } = checkQuota(tenantId, (shared > local ? shared : local) + pending);
  if (exceeded) return { exceeded, quota, current, release: () => {} };
  _inFlightCU.set(key, pending + cu);
  let released = false;
  return {
    exceeded, quota, current,
    release: () => {
      if (released) return;
      released = true;
      const left = (_inFlightCU.get(key) ?? 0n) - cu;
      if (left > 0n) _inFlightCU.set(key, left); else _inFlightCU.delete(key);
    },
  };
}

/**
 * Same rule, reading the balance shared across instances (N11).
 *
 * @param tenantId - Tenant to check.
 * @param nowSec - Current time in Unix seconds; selects the epoch.
 * @returns Whether the quota is reached, the quota and the shared CU total.
 * @throws {Error} When the plan store or the shared balance cannot be read.
 */
export async function checkMeteringQuotaAsync(
  tenantId: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ exceeded: boolean; quota: bigint; current: bigint }> {
  const epochId = String(deriveEpoch(nowSec));
  // H1-S01 (FA-05): plan read from the store (shared by replicas) before the check; also refreshes the sync view
  // used by quotaUnitsFor() in the same request. A store failure propagates (the entry answers with an error).
  await getTenantPlanAsync(tenantId);
  const { exceeded, quota, current } = checkQuota(tenantId, (await sharedBalance(tenantId, epochId)).totalCU);
  return { exceeded, quota, current };
}

/**
 * RV30-05: plan quota of the tenant in accounting units (micro-CU) for the check made inside
 * the PostgreSQL transaction (same rule, global across instances). null = no hard limit.
 *
 * @param tenantId - Tenant to look up (cached plan tier).
 * @returns The quota in micro-CU, or null when the plan has no hard limit.
 */
export function quotaUnitsFor(tenantId: string): bigint | null {
  return quotaUnits(getTenantPlanDefinition(tenantId).cuQuotaPerEpoch);
}
