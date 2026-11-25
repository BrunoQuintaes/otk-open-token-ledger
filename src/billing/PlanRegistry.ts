/**
 * PlanRegistry — Commercial plan tier definitions and lookup
 *
 * Defines FREE / STARTER / PRO plan tiers with:
 * - CU quotas per epoch (not USD — CU ≠ USD)
 * - Rate limit thresholds
 * - Feature flags
 *
 * H2.1: Storage migrated from in-memory Map to IPlanStore (PG or memory).
 * PlanRegistry is deterministic and bigint-safe.
 *
 * Keeps a synchronous in-process cache of each tenant's tier in front of the asynchronous `IPlanStore`, so hot
 * paths can call `getTenantPlan()` without awaiting; admission paths use `getTenantPlanAsync()` to read the store.
 * The store is replaced at startup by `setPlanStore()` (see `src/infra/storeBootstrap.ts`).
 *
 * Environment variable read: `OTK_PLAN_STORE_TIMEOUT_MS` (bound of one store call, default 5000 ms).
 * Side effect: increments the Prometheus counter `planStoreOpsTotal` on every write.
 *
 * It does NOT verify Stripe signatures (the webhook route does, with `stripe/StripeClient.ts`) and does NOT enforce
 * rate limits itself;
 * it only returns the numbers.
 *
 * @module src/billing/PlanRegistry
 * @since S2.1 (Wave 1 Pack 5), updated Wave 2H (H2.1)
 */

import { type IPlanStore, type PlanAssignMeta, type PlanAuditRecord, type PlanWriteResult, type StripeEventRef, type StripeSkipReason, MemoryPlanStore, PlanVersionConflictError, PLAN_VERSION_NONE } from './IPlanStore.js';

import { planStoreOpsTotal } from '../observability/prometheusMetrics.js';

export { PlanVersionConflictError, PLAN_VERSION_NONE };
export type { PlanAuditRecord };

/** Plan tier identifier */
export type PlanTier = 'FREE' | 'STARTER' | 'PRO';

/** Plan definition */
export interface PlanDefinition {
  /** Tier this definition describes. */
  tier: PlanTier;
  /** Display name. */
  name: string;
  /** Compute-unit quota per accounting epoch; 0n means no hard limit (PRO). */
  cuQuotaPerEpoch: bigint;
  /** Maximum requests per minute. */
  rateLimitPerMinute: number;
  /** Maximum requests per hour. */
  rateLimitPerHour: number;
  /** Maximum items in one batch request. */
  maxBatchSize: number;
  /** Whether ZK proofs are generated for this tier. */
  zkProofsEnabled: boolean;
  /** Whether on-chain anchoring is enabled for this tier. */
  onChainEnabled: boolean;
  /** Queue priority; a higher number is served first. */
  queuePriority: number;
  /** BILL-04: Monthly price in USD (0 for free tier) */
  priceUsd: number;
  /** BILL-04: How the plan is billed */
  billingModel: 'free' | 'flat' | 'usage';
}

/** Canonical plan definitions (immutable) */
const PLANS: Record<PlanTier, PlanDefinition> = {
  FREE: {
    tier: 'FREE', name: 'Free', cuQuotaPerEpoch: 10_000n,
    rateLimitPerMinute: 60, rateLimitPerHour: 500, maxBatchSize: 10,
    zkProofsEnabled: false, onChainEnabled: false, queuePriority: 1,
    priceUsd: 0, billingModel: 'free',
  },
  STARTER: {
    tier: 'STARTER', name: 'Starter', cuQuotaPerEpoch: 1_000_000n,
    rateLimitPerMinute: 300, rateLimitPerHour: 10_000, maxBatchSize: 100,
    zkProofsEnabled: true, onChainEnabled: false, queuePriority: 5,
    priceUsd: 49, billingModel: 'flat',
  },
  PRO: {
    tier: 'PRO', name: 'Pro', cuQuotaPerEpoch: 0n,
    rateLimitPerMinute: 1000, rateLimitPerHour: 50_000, maxBatchSize: 1000,
    zkProofsEnabled: true, onChainEnabled: true, queuePriority: 10,
    priceUsd: 0, billingModel: 'usage',
  },
};

const DEFAULT_TIER: PlanTier = 'FREE';

/** SEC02-N01 / H1-S01: order of the tiers (a higher rank has a larger CU quota; PRO has no hard limit). */
export const PLAN_RANK: Readonly<Record<PlanTier, number>> = { FREE: 0, STARTER: 1, PRO: 2 };

/**
 * The lower (financially more conservative) of two tiers.
 *
 * @param a - First tier.
 * @param b - Second tier.
 * @returns `a` when it ranks lower or equal to `b`, otherwise `b`.
 */
export function lowerTier(a: PlanTier, b: PlanTier): PlanTier {
  return PLAN_RANK[a] <= PLAN_RANK[b] ? a : b;
}

/**
 * H1-S01 (FA-01, FA-03): the plan store did not confirm the write (error or timeout). The outcome is unknown, so the
 * caller must answer with an error (never a success) and may retry; the local view keeps the lower of the old and
 * requested tiers until the store is read again.
 */
export class PlanStoreUnavailableError extends Error {
  /** Stable error code for callers and API responses. */
  readonly code = 'plan_store_unavailable';
  constructor(readonly tenantId: string, readonly cause: unknown) {
    super(`plan store did not confirm the assignment for ${tenantId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PlanStoreUnavailableError';
  }
}

/** Upper bound for one plan-store operation (OTK_PLAN_STORE_TIMEOUT_MS, default 5000 ms). */
function storeTimeoutMs(): number {
  const v = Number(process.env['OTK_PLAN_STORE_TIMEOUT_MS'] ?? '');
  return Number.isFinite(v) && v > 0 ? v : 5_000;
}

/**
 * Races `p` against a timer; the losing promise is NOT cancelled (the store call may still complete later).
 *
 * @param p - The store call.
 * @param ms - Timeout in milliseconds.
 * @param what - Label used in the timeout error message.
 * @returns The value of `p` when it settles first.
 * @throws {Error} `"<what> timed out after <ms> ms"` when the timer fires first, or the rejection of `p`.
 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

// H2.1: Pluggable store + sync cache for backward compat
let _store: IPlanStore = new MemoryPlanStore();
// Sync cache mirrors the async store. H1-S01b: each entry carries the store version it came from and is only
// replaced by an equal or newer version, so a read that started before a write and finished after it cannot put the
// old tier back (version 0 = hydrated from list() without versions; any versioned read replaces it).
const _syncCache = new Map<string, { tier: PlanTier; version: number; floorSeq?: number }>();
// H1 R-01: every store read takes a sequence number when it STARTS. After an ambiguous write the entry gets a floor:
// reads that started before the failure are ignored even at an equal version (they may carry the pre-write tier),
// reads that started after it are the truth whatever version they return.
let _readSeq = 0;

function cacheOffer(tenantId: string, tier: PlanTier, version: number, startedSeq?: number): void {
  const cur = _syncCache.get(tenantId);
  if (cur?.floorSeq !== undefined) {
    if (startedSeq === undefined || startedSeq <= cur.floorSeq) return;
    _syncCache.set(tenantId, { tier, version });
    return;
  }
  if (!cur || version >= cur.version) _syncCache.set(tenantId, { tier, version });
}

/**
 * Replace the plan store backend (e.g., PgPlanStore after DB init) and hydrate
 * the sync cache from it (R07). Without hydration, getTenantPlan() returned FREE
 * for every tenant persisted before the restart. Await it before serving traffic.
 *
 * @param store - The new backend (it must already be initialized).
 * @returns Number of assignments loaded into the cache.
 * @throws {Error} When listing the store fails (the new store stays installed).
 */
export async function setPlanStore(store: IPlanStore): Promise<number> {
  _store = store;
  return refreshPlanCache();
}

/**
 * Reload the sync cache from the persistent store. Returns the number of assignments.
 * Replicas do not notify each other: a plan changed on another instance is seen
 * here only after the next refresh or getTenantPlanAsync() for that tenant.
 *
 * Cached entries are reset to version 0, so the next versioned read replaces them.
 *
 * @returns Number of assignments loaded.
 * @throws {Error} When listing the store fails (the cache is left unchanged).
 */
export async function refreshPlanCache(): Promise<number> {
  const rows = await _store.list();
  _syncCache.clear();
  for (const { tenantId, tier } of rows) _syncCache.set(tenantId, { tier, version: 0 });
  return rows.length;
}

/**
 * Returns the plan store currently installed.
 *
 * @returns The active backend (memory until `setPlanStore` is called).
 */
export function getPlanStore(): IPlanStore {
  return _store;
}

/**
 * Returns the fixed definition of a tier.
 *
 * @param tier - Plan tier.
 * @returns The shared definition object (do not mutate).
 */
export function getPlan(tier: PlanTier): PlanDefinition {
  return PLANS[tier];
}

/**
 * Lists the three plan definitions.
 *
 * @returns FREE, STARTER and PRO, in that order.
 */
export function getAllPlans(): PlanDefinition[] {
  return Object.values(PLANS);
}

/** Result of `assignPlan`. */
export interface PlanAssignment {
  tenantId: string;
  tier: PlanTier;
  /** Tier before the change (FREE when the tenant had no stored assignment). */
  previous: PlanTier;
  /** Store version written by this change. */
  version: number;
}

/**
 * Assign a tier to a tenant. H1-S01 (FA-01..FA-04): the store is written FIRST and the call resolves only after the
 * write is durable; the sync view changes only after that, so a promotion is never visible before it is persisted.
 * Before H1-S01 the cache was updated synchronously and the store write was fire-and-forget with errors swallowed:
 * a failed PostgreSQL write answered 200, served PRO until restart and then silently reverted (or, for a downgrade,
 * restored PRO after restart).
 *
 * Rejects with:
 *   - PlanVersionConflictError when `meta.expectedVersion` no longer matches (concurrent change, nothing written);
 *   - PlanStoreUnavailableError on a store error or timeout (outcome unknown; the sync view keeps the LOWER of the
 *     previous and requested tiers, so an unconfirmed promotion grants nothing and an unconfirmed downgrade is
 *     already applied locally, until the store is read again).
 *
 * @param tenantId - Tenant to change.
 * @param tier - New tier.
 * @param meta - Expected version and audit fields (see `PlanAssignMeta`).
 * @returns The new tier, the previous one and the version written.
 * @throws {Error} When `tier` is not FREE, STARTER or PRO.
 * @throws {@link PlanVersionConflictError} When `meta.expectedVersion` no longer matches.
 * @throws {@link PlanStoreUnavailableError} On a store error or timeout.
 */
export async function assignPlan(tenantId: string, tier: PlanTier, meta: PlanAssignMeta = {}): Promise<PlanAssignment> {
  if (!(tier in PLANS)) throw new Error(`unknown plan tier: ${String(tier)}`);
  const written = await writeStore(tenantId, tier, meta);
  return { tenantId, tier, previous: written.previous ?? DEFAULT_TIER, version: written.version };
}

/**
 * One store write with the H1-S01 failure rules. An error or timeout leaves the outcome UNKNOWN: Promise.race does not
 * cancel the SQL, and PgPlanStore also bounds the transaction on the server (statement_timeout / lock_timeout) so a
 * timed-out write normally rolls back; a COMMIT already in flight may still land. Reconciliation is by reading the
 * store: the cache keeps the LOWER tier at the version it had (never above the store), and the next versioned read
 * started after the failure (every admission path does one, the durable proxy included since R-01) replaces it with whatever the store holds. Callers answer with an error (503) and
 * may retry with the version they read (409 tells them the ambiguous write did commit).
 *
 * @param tenantId - Tenant to change.
 * @param tier - New tier.
 * @param meta - Expected version, audit fields and optional Stripe event.
 * @returns The store's result (a skipped Stripe event leaves the cache untouched).
 * @throws {@link PlanVersionConflictError} When the expected version no longer matches (cache untouched).
 * @throws {@link PlanStoreUnavailableError} On any other store error or timeout (cache lowered as described).
 */
async function writeStore(tenantId: string, tier: PlanTier, meta: PlanAssignMeta): Promise<PlanWriteResult> {
  const before = _syncCache.get(tenantId) ?? { tier: DEFAULT_TIER, version: PLAN_VERSION_NONE };
  let written: PlanWriteResult;
  const source = meta.source ?? 'unknown';
  try {
    written = await withTimeout(_store.assign(tenantId, tier, meta), storeTimeoutMs(), 'plan store write');
  } catch (err) {
    if (err instanceof PlanVersionConflictError) { planStoreOpsTotal.inc({ source, outcome: 'conflict' }); throw err; }
    planStoreOpsTotal.inc({ source, outcome: 'unavailable' });
    const cur = _syncCache.get(tenantId) ?? before;
    _syncCache.set(tenantId, { tier: lowerTier(cur.tier, tier), version: cur.version, floorSeq: ++_readSeq });
    throw new PlanStoreUnavailableError(tenantId, err);
  }
  planStoreOpsTotal.inc({ source, outcome: written.applied === false ? `skipped_${written.skipped ?? 'unknown'}` : 'applied' });
  if (written.applied !== false) {
    // a confirmed write is the truth: it also clears a floor left by an earlier ambiguous write
    const cur = _syncCache.get(tenantId);
    if (!cur || cur.floorSeq !== undefined || written.version >= cur.version) _syncCache.set(tenantId, { tier, version: written.version });
  }
  return written;
}

/** Stripe event reference accepted by `applyStripePlanEvent` (same shape as `StripeEventRef`). */
export type StripePlanEvent = StripeEventRef;

/**
 * H1-S03b: apply a plan change carried by a Stripe event as ONE atomic store operation: the event record and the plan
 * change commit together or not at all (before, the plan committed and the ledger write could fail afterwards).
 * Duplicate event id → not applied ('duplicate'); event older than the last comparable one applied to the tenant, or in
 * the same second but raising the tier → not applied ('stale'). H1R2 R-07/R-11: a grant preceding the last
 * administrative decision → 'superseded_by_admin'; cancellation of a subscription other than the active one →
 * 'other_subscription' (see IPlanStore). Rejects like assignPlan on store failure.
 *
 * The audit actor is `stripe:<event id>` and the source `stripe_webhook`.
 *
 * @param tenantId - Tenant named by the event's metadata.
 * @param tier - Tier the event grants (FREE for a cancellation).
 * @param event - Event id, `created` (Unix seconds), type and subscription id.
 * @returns Whether the change was applied, the skip reason when it was not, and the stored version.
 * @throws {Error} When `tier` is not FREE, STARTER or PRO.
 * @throws {@link PlanStoreUnavailableError} On a store error or timeout.
 */
export async function applyStripePlanEvent(
  tenantId: string, tier: PlanTier, event: StripePlanEvent,
): Promise<{ applied: boolean; skipped?: StripeSkipReason; version: number }> {
  if (!(tier in PLANS)) throw new Error(`unknown plan tier: ${String(tier)}`);
  const w = await writeStore(tenantId, tier, { actor: `stripe:${event.id}`, source: 'stripe_webhook', stripeEvent: event });
  return { applied: w.applied !== false, ...(w.skipped ? { skipped: w.skipped } : {}), version: w.version };
}

/**
 * Current tier and version read from the store (PLAN_VERSION_NONE when nothing was ever assigned).
 *
 * The result is offered to the sync cache, which only accepts it when it is not older than what it holds.
 *
 * @param tenantId - Tenant to read.
 * @returns The stored tier (FREE when none) and its version.
 * @throws {Error} When the store read fails or exceeds `OTK_PLAN_STORE_TIMEOUT_MS`.
 */
export async function getTenantPlanVersioned(tenantId: string): Promise<{ tier: PlanTier; version: number }> {
  const started = ++_readSeq;
  const cur = await withTimeout(_store.getVersioned(tenantId), storeTimeoutMs(), 'plan store read');
  const tier = cur?.tier ?? DEFAULT_TIER;
  const version = cur?.version ?? PLAN_VERSION_NONE;
  cacheOffer(tenantId, tier, version, started);
  return { tier, version };
}

/** Audit trail of plan changes (H1-S01). */
/**
 * Lists the plan audit trail.
 *
 * @param tenantId - Only this tenant's rows; all tenants when undefined.
 * @returns Audit rows in write order.
 */
export async function listPlanAudit(tenantId?: string): Promise<PlanAuditRecord[]> {
  return _store.listAudit(tenantId);
}

/**
 * Returns the tenant's tier from the in-process cache, without touching the store.
 *
 * May lag a change made on another replica; admission paths use `getTenantPlanAsync` instead.
 *
 * @param tenantId - Tenant to look up.
 * @returns The cached tier, or FREE when the tenant is not cached.
 */
export function getTenantPlan(tenantId: string): PlanTier {
  return _syncCache.get(tenantId)?.tier ?? DEFAULT_TIER;
}

/**
 * Async version — reads from the persistent store (the source of truth) and refreshes the sync view with what it
 * read. H1-S01 (FA-05): admission paths call this, so a plan changed by another replica (or a downgrade done
 * elsewhere) takes effect on the next request instead of after the next restart. A null read means no assignment
 * (FREE); assignPlan() writes the store before the cache, so it cannot evict a fresher local value.
 * Store errors propagate (no silent fallback to the cached tier).
 *
 * @param tenantId - Tenant to read.
 * @returns The stored tier (FREE when none).
 * @throws {Error} When the store read fails or times out.
 */
export async function getTenantPlanAsync(tenantId: string): Promise<PlanTier> {
  // H1-S01b: versioned read; the cache only moves forward (see cacheOffer)
  return (await getTenantPlanVersioned(tenantId)).tier;
}

/**
 * Returns the plan definition of the tenant's cached tier.
 *
 * @param tenantId - Tenant to look up.
 * @returns The definition (FREE when the tenant is not cached).
 */
export function getTenantPlanDefinition(tenantId: string): PlanDefinition {
  return PLANS[getTenantPlan(tenantId)];
}

/**
 * Compares a CU total with the tenant's per-epoch quota (cached tier).
 *
 * @param tenantId - Tenant to check.
 * @param currentCU - Compute units already used in the epoch.
 * @returns `exceeded` is true when `currentCU >= quota`; for an unlimited plan (quota 0n) it is always false and
 *   `remaining` is 0n.
 */
export function checkQuota(
  tenantId: string,
  currentCU: bigint,
): { exceeded: boolean; quota: bigint; current: bigint; remaining: bigint } {
  const plan = getTenantPlanDefinition(tenantId);
  const quota = plan.cuQuotaPerEpoch;
  if (quota === 0n) return { exceeded: false, quota, current: currentCU, remaining: 0n };
  const remaining = quota > currentCU ? quota - currentCU : 0n;
  return { exceeded: currentCU >= quota, quota, current: currentCU, remaining };
}

/**
 * Returns the per-minute request limit of the tenant's cached tier.
 *
 * @param tenantId - Tenant to look up.
 * @returns A 60-second window and the plan's `rateLimitPerMinute`.
 */
export function getPlanRateLimit(tenantId: string): { windowSeconds: number; maxRequests: number } {
  const plan = getTenantPlanDefinition(tenantId);
  return { windowSeconds: 60, maxRequests: plan.rateLimitPerMinute };
}

/**
 * Lists the assignments held in the in-process cache (may lag the store).
 *
 * @returns One entry per cached tenant.
 */
export function listAssignments(): Array<{ tenantId: string; tier: PlanTier }> {
  return Array.from(_syncCache.entries()).map(([tenantId, v]) => ({ tenantId, tier: v.tier }));
}

/**
 * Async version: lists the assignments from the store.
 *
 * @returns One entry per tenant with a stored tier.
 */
export async function listAssignmentsAsync(): Promise<Array<{ tenantId: string; tier: PlanTier }>> {
  return _store.list();
}

/**
 * Clears the cache and, without awaiting, the store (tests only; store errors are ignored).
 */
export function clearAssignmentsForTest(): void {
  _syncCache.clear();
  _store.clear().catch(() => {});
}

/** Reset to default memory store (test cleanup). */
export function resetPlanStoreForTest(): void {
  _syncCache.clear();
  _store = new MemoryPlanStore();
}

// ---------------------------------------------------------------------------
// SLA tiers (P4.4 — W5-5C02)
// ---------------------------------------------------------------------------

/** Service-level targets of one plan tier. */
export interface SLADefinition {
  /** Tier this SLA applies to. */
  tier: PlanTier;
  /** Max p99 latency guarantee in ms. 0 = no SLA (best effort). */
  maxLatencyP99Ms: number;
  /** SLA uptime percentage guarantee. 0 = no SLA. */
  uptimePercent: number;
  /** Human-readable description. */
  label: string;
}

const SLA_TIERS: Record<PlanTier, SLADefinition> = {
  FREE:    { tier: 'FREE',    maxLatencyP99Ms: 0,    uptimePercent: 0,     label: 'Best-effort — no SLA' },
  STARTER: { tier: 'STARTER', maxLatencyP99Ms: 3000, uptimePercent: 99.0,  label: '99.0% uptime, p99 < 3 s' },
  PRO:     { tier: 'PRO',     maxLatencyP99Ms: 1000, uptimePercent: 99.9,  label: '99.9% uptime, p99 < 1 s' },
};

/**
 * Return the SLA definition for a given plan tier.
 *
 * FREE returns maxLatencyP99Ms=0 (no SLA guarantee).
 * STARTER / PRO return the contractual p99 and uptime bounds.
 *
 * @param tier - Plan tier.
 * @returns The shared SLA definition (do not mutate).
 */
export function getSLAForTier(tier: PlanTier): SLADefinition {
  return SLA_TIERS[tier];
}
