/**
 * H2.1 — Plan Store Interface
 *
 * Storage backend contract for tenant plan assignments.
 * Plan definitions remain hardcoded constants — only assignments are stored.
 *
 * H1-S01 (FA-01..FA-06, OTK-H1-MEGA 2026-10-13): every assignment carries a version (optimistic concurrency) and
 * appends an audit row. `assign` resolves only after the write is durable in the backend and rejects otherwise;
 * with `expectedVersion` it rejects with PlanVersionConflictError when another writer got there first.
 *
 * H1R2 R-07/R-11 (OTK H1 final closure R2, 2026-10-13): authoritative per-tenant order between administrative
 * decisions and Stripe events, decided inside the same per-tenant critical section (PostgreSQL: advisory lock + one
 * transaction) as the event record and the plan change:
 *   - every assignment WITHOUT a Stripe event is an administrative decision: the store records its version and the
 *     store clock (one clock for every replica) and revokes every subscription known for the tenant at that moment;
 *   - a Stripe grant (tier above FREE) for a revoked subscription, or for an unknown one whose `created` is not after
 *     the decision (+ OTK_PLAN_ADMIN_ORDER_SKEW_S), is recorded as `superseded_by_admin` and changes nothing (R-07);
 *   - a cancellation only cancels the subscription that granted the current tier; the cancellation of another one is
 *     recorded as `other_subscription` (R-11), and events of different known subscriptions are not ordered by time;
 *   - events without a subscription id keep the H1-S03 rules (tenant-wide `created`, ties fail closed).
 *
 * @module billing/IPlanStore
 * @since Wave 2H (H2.1)
 */

import type { PlanTier } from './PlanRegistry.js';

/** Version of a tenant without any stored assignment (implicit FREE). */
export const PLAN_VERSION_NONE = 0;

/**
 * H1R2 R-07/R-11: Stripe event as seen by the store. `subscriptionId` (when the event names one) makes the order
 * per subscription instead of per tenant-wide timestamp: cancelling subscription A never cancels B, and an event of a
 * subscription revoked by an administrative decision never restores the tier that decision removed.
 */
export interface StripeEventRef { id: string; created: number; type: string; subscriptionId?: string }

export interface PlanAssignMeta {
  /** Reject unless the stored version equals this value (PLAN_VERSION_NONE = no row yet). */
  expectedVersion?: number;
  /** Who asked for the change (tenant id, 'platform', 'stripe:<event id>'). Audit only. */
  actor?: string;
  /** Entry point of the change ('admin_api', 'stripe_webhook', 'test'). Audit only. */
  source?: string;
  /**
   * H1-S03b: Stripe event carrying this change. The event record and the plan change are one atomic operation:
   * duplicate id → nothing written (skipped 'duplicate'); otherwise the event is recorded and, when the order rules
   * refuse it (see StripeSkipReason), only the event is recorded. Absent = administrative decision (H1R2 R-07).
   */
  stripeEvent?: StripeEventRef;
}

/**
 * Why a Stripe event was recorded without changing the plan:
 *   duplicate           event id already recorded (nothing written);
 *   stale               older than (or same second while raising) the last applied event it is comparable with, or a
 *                       grant for a subscription already recorded as cancelled;
 *   superseded_by_admin H1R2 R-07: a grant from before the last administrative decision (by identity: subscription
 *                       known when the decision was taken; by time: `created` not after the decision + skew);
 *   other_subscription  H1R2 R-11: cancellation of a subscription that is not the one granting the current tier.
 */
export type StripeSkipReason = 'duplicate' | 'stale' | 'superseded_by_admin' | 'other_subscription';

export interface PlanWriteResult {
  previous: PlanTier | null;
  version: number;
  /** false when a Stripe event was not applied (see `skipped`). Absent/true = the change was applied. */
  applied?: boolean;
  skipped?: StripeSkipReason;
}

/** H1R2 R-07: per-tenant ordering state (the "epoch" of the last administrative decision). */
export interface PlanOrdering {
  /** Store version written by the last administrative (non-Stripe) decision; null = none. */
  adminVersion: number | null;
  /** Store clock (ms) of that decision; null = none. */
  adminDecidedAtMs: number | null;
  /** Subscription whose event granted the current tier; null = unknown, admin-set or none. */
  activeSubscriptionId: string | null;
}

export interface StripeEventRecord {
  eventId: string;
  tenantId: string;
  created: number;
  type: string;
  subscriptionId: string | null;
  applied: boolean;
  /** null for applied events (and for unapplied events recorded before H1R2). */
  skipReason: Exclude<StripeSkipReason, 'duplicate'> | null;
}

const RANK: Readonly<Record<PlanTier, number>> = { FREE: 0, STARTER: 1, PRO: 2 };

/**
 * H1R2 R-07: clock tolerance (seconds) between Stripe's `event.created` and the store clock, used only when a grant of
 * an UNKNOWN subscription (or without subscription id) is compared with an administrative decision. A grant created up
 * to this many seconds after the decision is still treated as older (fail closed: recorded as superseded_by_admin,
 * reconcilable by an operator). Subscriptions known at decision time are decided by identity, never by this clock.
 * Default 60. PENDING_HUMAN_POLICY (D1/D2): the value, and the rule "an admin decision beats an older Stripe grant".
 */
export function adminOrderSkewSeconds(): number {
  const raw = process.env['OTK_PLAN_ADMIN_ORDER_SKEW_S'];
  const v = Number(raw ?? '');
  return raw !== undefined && raw !== '' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 60;
}

/** Snapshot read inside the per-tenant critical section (both stores). */
interface StripeOrderInput {
  current: PlanTier;
  /** Max `created` of applied events comparable with this one (same subscription, or either side unidentified). */
  lastComparable: number | null;
  /** Record of the event's subscription, when it names one already seen. */
  sub: { status: 'active' | 'canceled'; adminRevoked: boolean } | null;
  activeSubscriptionId: string | null;
  adminDecidedAtMs: number | null;
}

/** Shared decision for a Stripe event (both stores): null = apply. */
function stripeSkip(ev: StripeEventRef, next: PlanTier, s: StripeOrderInput): Exclude<StripeSkipReason, 'duplicate'> | null {
  const subId = ev.subscriptionId ?? null;
  if (next === 'FREE') {
    // H1R2 R-11: a cancellation only cancels the subscription that grants the current tier, whatever the timestamps
    if (subId !== null && s.activeSubscriptionId !== null && s.activeSubscriptionId !== subId) return 'other_subscription';
    // cancelling the active subscription is terminal → applied (fail closed) even when its `created` is older
    if (subId !== null && s.activeSubscriptionId === subId) return null;
  } else {
    // a cancelled subscription is terminal in Stripe: no later grant for it
    if (s.sub?.status === 'canceled') return 'stale';
    // H1R2 R-07: the last administrative decision wins over grants that precede it (identity first, then time)
    if (s.sub?.adminRevoked) return 'superseded_by_admin';
    if (s.adminDecidedAtMs !== null && ev.created <= Math.floor(s.adminDecidedAtMs / 1000) + adminOrderSkewSeconds()) return 'superseded_by_admin';
  }
  // H1-S03 order, restricted to comparable events (H1R2 R-11: events of another known subscription do not compete)
  if (s.lastComparable === null) return null;
  if (ev.created < s.lastComparable) return 'stale';
  if (ev.created === s.lastComparable && RANK[next] > RANK[s.current]) return 'stale';
  return null;
}

export interface PlanAuditRecord {
  tenantId: string;
  fromTier: PlanTier | null;
  toTier: PlanTier;
  version: number;
  actor: string;
  source: string;
  at: string;
}

/** The stored version differs from the one the caller read (another writer changed the plan in between). */
export class PlanVersionConflictError extends Error {
  readonly code = 'plan_version_conflict';
  constructor(readonly tenantId: string, readonly expected: number, readonly actual: number) {
    super(`plan of ${tenantId} changed concurrently (expected version ${expected}, found ${actual})`);
    this.name = 'PlanVersionConflictError';
  }
}

export interface IPlanStore {
  assign(tenantId: string, tier: PlanTier, meta?: PlanAssignMeta): Promise<PlanWriteResult>;
  get(tenantId: string): Promise<PlanTier | null>;
  getVersioned(tenantId: string): Promise<{ tier: PlanTier; version: number } | null>;
  list(): Promise<Array<{ tenantId: string; tier: PlanTier }>>;
  listAudit(tenantId?: string): Promise<PlanAuditRecord[]>;
  clear(): Promise<void>;
  /** H1R2 R-07: ordering state of a tenant (optional for test doubles). */
  getPlanOrdering?(tenantId: string): Promise<PlanOrdering>;
  /** H1R2 R-07/R-11: recorded Stripe events of a tenant, applied or not, with the reason (optional for doubles). */
  listStripeEvents?(tenantId: string): Promise<StripeEventRecord[]>;
}

/** In-memory implementation (development and tests only; refused by deployedStoreProblems in deployed envs). */
export class MemoryPlanStore implements IPlanStore {
  private _map = new Map<string, { tier: PlanTier; version: number }>();
  private _audit: PlanAuditRecord[] = [];
  private _events = new Map<string, StripeEventRecord>();
  private _order = new Map<string, PlanOrdering>();
  private _subs = new Map<string, { tenantId: string; status: 'active' | 'canceled'; adminRevoked: boolean; lastCreated: number }>();

  private _subKey(tenantId: string, subId: string): string { return `${tenantId}\u0000${subId}`; }

  private _setSub(tenantId: string, subId: string, status: 'active' | 'canceled', created: number): void {
    const k = this._subKey(tenantId, subId);
    const cur = this._subs.get(k);
    this._subs.set(k, { tenantId, status, adminRevoked: cur?.adminRevoked ?? false, lastCreated: Math.max(cur?.lastCreated ?? created, created) });
  }

  // No await inside: the whole operation is atomic with respect to other callers in this process.
  async assign(tenantId: string, tier: PlanTier, meta: PlanAssignMeta = {}): Promise<PlanWriteResult> {
    const cur = this._map.get(tenantId);
    const actual = cur?.version ?? PLAN_VERSION_NONE;
    const ev = meta.stripeEvent;
    if (ev && this._events.has(ev.id)) return { previous: cur?.tier ?? null, version: actual, applied: false, skipped: 'duplicate' };
    // checked before anything is recorded (same order as PgPlanStore)
    if (meta.expectedVersion !== undefined && meta.expectedVersion !== actual) {
      throw new PlanVersionConflictError(tenantId, meta.expectedVersion, actual);
    }
    const ord = this._order.get(tenantId) ?? { adminVersion: null, adminDecidedAtMs: null, activeSubscriptionId: null };
    const subId = ev?.subscriptionId ?? null;
    if (ev) {
      let last: number | null = null;
      for (const e of this._events.values()) {
        if (e.tenantId !== tenantId || !e.applied) continue;
        if (subId !== null && e.subscriptionId !== null && e.subscriptionId !== subId) continue;
        if (last === null || e.created > last) last = e.created;
      }
      const sub = subId !== null ? this._subs.get(this._subKey(tenantId, subId)) ?? null : null;
      const skip = stripeSkip(ev, tier, {
        current: cur?.tier ?? 'FREE', lastComparable: last, sub, activeSubscriptionId: ord.activeSubscriptionId, adminDecidedAtMs: ord.adminDecidedAtMs,
      });
      this._events.set(ev.id, { eventId: ev.id, tenantId, created: ev.created, type: ev.type, subscriptionId: subId, applied: skip === null, skipReason: skip });
      if (skip) {
        if (skip === 'other_subscription' && subId !== null) this._setSub(tenantId, subId, 'canceled', ev.created);
        return { previous: cur?.tier ?? null, version: actual, applied: false, skipped: skip };
      }
    }
    const version = actual + 1;
    this._map.set(tenantId, { tier, version });
    if (ev) {
      if (subId !== null) this._setSub(tenantId, subId, tier === 'FREE' ? 'canceled' : 'active', ev.created);
      this._order.set(tenantId, { ...ord, activeSubscriptionId: tier !== 'FREE' && subId !== null ? subId : null });
    } else {
      // H1R2 R-07: administrative decision — new epoch; every subscription known now is revoked
      this._order.set(tenantId, { adminVersion: version, adminDecidedAtMs: Date.now(), activeSubscriptionId: null });
      for (const s of this._subs.values()) if (s.tenantId === tenantId) s.adminRevoked = true;
    }
    this._audit.push({
      tenantId, fromTier: cur?.tier ?? null, toTier: tier, version,
      actor: meta.actor ?? 'unknown', source: meta.source ?? 'unknown', at: new Date().toISOString(),
    });
    return { previous: cur?.tier ?? null, version };
  }

  async get(tenantId: string): Promise<PlanTier | null> {
    return this._map.get(tenantId)?.tier ?? null;
  }

  async getVersioned(tenantId: string): Promise<{ tier: PlanTier; version: number } | null> {
    const cur = this._map.get(tenantId);
    return cur ? { ...cur } : null;
  }

  async list(): Promise<Array<{ tenantId: string; tier: PlanTier }>> {
    return Array.from(this._map.entries()).map(([tenantId, v]) => ({ tenantId, tier: v.tier }));
  }

  async listAudit(tenantId?: string): Promise<PlanAuditRecord[]> {
    return this._audit.filter((r) => tenantId === undefined || r.tenantId === tenantId).map((r) => ({ ...r }));
  }

  async getPlanOrdering(tenantId: string): Promise<PlanOrdering> {
    return { ...(this._order.get(tenantId) ?? { adminVersion: null, adminDecidedAtMs: null, activeSubscriptionId: null }) };
  }

  async listStripeEvents(tenantId: string): Promise<StripeEventRecord[]> {
    return Array.from(this._events.values()).filter((e) => e.tenantId === tenantId).map((e) => ({ ...e }));
  }

  async clear(): Promise<void> {
    this._map.clear();
    this._audit = [];
    this._events.clear();
    this._order.clear();
    this._subs.clear();
  }
}

/** Server-side bound of one plan transaction: 80% of OTK_PLAN_STORE_TIMEOUT_MS (default 5000), at least 50 ms. */
function serverTimeoutMs(): number {
  const v = Number(process.env['OTK_PLAN_STORE_TIMEOUT_MS'] ?? '');
  const client = Number.isFinite(v) && v > 0 ? v : 5_000;
  return Math.max(50, Math.floor(client * 0.8));
}

/** PostgreSQL implementation (activated when OTK_DB_URL is set). */
export class PgPlanStore implements IPlanStore {
  private _pool: any; // pg.Pool

  constructor(pool: any) {
    this._pool = pool;
  }

  async init(): Promise<void> {
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS otk_plan_assignments (
        tenant_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL DEFAULT 'FREE',
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // H1-S01: additive migration (rows written before it start at version 1)
    await this._pool.query('ALTER TABLE otk_plan_assignments ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1');
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS otk_plan_audit (
        id BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        from_plan TEXT,
        to_plan TEXT NOT NULL,
        version BIGINT NOT NULL,
        actor TEXT NOT NULL,
        source TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // H1-S03b: Stripe events recorded in the same transaction as the plan change they carry
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS otk_stripe_events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created BIGINT NOT NULL,
        type TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this._pool.query('ALTER TABLE otk_stripe_events ADD COLUMN IF NOT EXISTS applied BOOLEAN NOT NULL DEFAULT TRUE');
    await this._pool.query('CREATE INDEX IF NOT EXISTS otk_stripe_events_tenant ON otk_stripe_events (tenant_id, created)');
    // H1R2 R-07/R-11: additive migration — ordering state per tenant, subscription identity, reason of ignored events
    await this._pool.query('ALTER TABLE otk_plan_assignments ADD COLUMN IF NOT EXISTS admin_version BIGINT');
    await this._pool.query('ALTER TABLE otk_plan_assignments ADD COLUMN IF NOT EXISTS admin_decided_at_ms BIGINT');
    await this._pool.query('ALTER TABLE otk_plan_assignments ADD COLUMN IF NOT EXISTS active_subscription_id TEXT');
    await this._pool.query('ALTER TABLE otk_stripe_events ADD COLUMN IF NOT EXISTS subscription_id TEXT');
    await this._pool.query('ALTER TABLE otk_stripe_events ADD COLUMN IF NOT EXISTS skip_reason TEXT');
    await this._pool.query(`
      CREATE TABLE IF NOT EXISTS otk_plan_subscriptions (
        tenant_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        status TEXT NOT NULL,
        admin_revoked BOOLEAN NOT NULL DEFAULT FALSE,
        last_created BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, subscription_id)
      )
    `);
    // H1R2 R-07: decisions taken before this migration — epoch rebuilt from the audit trail (last non-Stripe change).
    // Subscriptions were not tracked then, so for those decisions only the time rule applies. Idempotent.
    await this._pool.query(`
      UPDATE otk_plan_assignments a
         SET admin_version = d.version,
             admin_decided_at_ms = (EXTRACT(EPOCH FROM d.at) * 1000)::BIGINT
        FROM (SELECT DISTINCT ON (tenant_id) tenant_id, version, at FROM otk_plan_audit
               WHERE source <> 'stripe_webhook' ORDER BY tenant_id, id DESC) d
       WHERE a.tenant_id = d.tenant_id AND a.admin_decided_at_ms IS NULL
    `);
  }

  /**
   * One transaction: lock the row (or the absence of a row, through the primary key on insert), check the expected
   * version, decide the order of a Stripe event (H1R2), write the new tier with version + 1, the ordering state, the
   * subscription record and the audit row. Either everything commits or nothing does.
   */
  async assign(tenantId: string, tier: PlanTier, meta: PlanAssignMeta = {}): Promise<PlanWriteResult> {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      // H1-S01b: the server bounds the transaction below the client timeout, so a write the caller gave up on rolls
      // back instead of committing later (a COMMIT already in flight can still land: see PlanRegistry.writeStore)
      const ms = serverTimeoutMs();
      await client.query(`SET LOCAL statement_timeout = ${ms}`);
      await client.query(`SET LOCAL lock_timeout = ${ms}`);
      // one writer per tenant, also when no row exists yet (first assignment, Stripe event ordering)
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('otk_plan:' || $1, 0))", [tenantId]);
      const { rows } = await client.query(
        'SELECT plan, version, admin_decided_at_ms, active_subscription_id FROM otk_plan_assignments WHERE tenant_id = $1 FOR UPDATE',
        [tenantId],
      );
      const previous: PlanTier | null = rows[0]?.plan ?? null;
      const actual = rows[0] ? Number(rows[0].version) : PLAN_VERSION_NONE;
      if (meta.expectedVersion !== undefined && meta.expectedVersion !== actual) {
        throw new PlanVersionConflictError(tenantId, meta.expectedVersion, actual);
      }
      const ev = meta.stripeEvent;
      const subId = ev?.subscriptionId ?? null;
      if (ev) {
        const dup = await client.query('SELECT 1 FROM otk_stripe_events WHERE event_id = $1', [ev.id]);
        if (dup.rows.length > 0) {
          await client.query('ROLLBACK');
          return { previous, version: actual, applied: false, skipped: 'duplicate' };
        }
        const lastQ = await client.query(
          `SELECT MAX(created) AS last FROM otk_stripe_events WHERE tenant_id = $1 AND applied
             AND ($2::text IS NULL OR subscription_id IS NULL OR subscription_id = $2)`,
          [tenantId, subId],
        );
        const lastV = lastQ.rows[0]?.last;
        let sub: StripeOrderInput['sub'] = null;
        if (subId !== null) {
          const sq = await client.query('SELECT status, admin_revoked FROM otk_plan_subscriptions WHERE tenant_id = $1 AND subscription_id = $2', [tenantId, subId]);
          if (sq.rows[0]) sub = { status: sq.rows[0].status, adminRevoked: sq.rows[0].admin_revoked === true };
        }
        const adm = rows[0]?.admin_decided_at_ms;
        const skip = stripeSkip(ev, tier, {
          current: previous ?? 'FREE',
          lastComparable: lastV === null || lastV === undefined ? null : Number(lastV),
          sub,
          activeSubscriptionId: rows[0]?.active_subscription_id ?? null,
          adminDecidedAtMs: adm === null || adm === undefined ? null : Number(adm),
        });
        // the PRIMARY KEY makes a concurrent duplicate fail with 23505 → whole transaction rolls back
        await client.query(
          'INSERT INTO otk_stripe_events (event_id, tenant_id, created, type, applied, subscription_id, skip_reason) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [ev.id, tenantId, ev.created, ev.type, skip === null, subId, skip],
        );
        if (skip) {
          if (skip === 'other_subscription' && subId !== null) await this._upsertSub(client, tenantId, subId, 'canceled', ev.created);
          await client.query('COMMIT');
          return { previous, version: actual, applied: false, skipped: skip };
        }
      }
      const version = actual + 1;
      const active = ev && tier !== 'FREE' && subId !== null ? subId : null;
      if (ev) {
        if (rows[0]) {
          await client.query(
            'UPDATE otk_plan_assignments SET plan = $2, version = $3, assigned_at = NOW(), active_subscription_id = $4 WHERE tenant_id = $1',
            [tenantId, tier, version, active],
          );
        } else {
          // Two first assignments racing: the loser hits the primary key (23505) and the whole transaction rolls back
          await client.query(
            'INSERT INTO otk_plan_assignments (tenant_id, plan, version, assigned_at, active_subscription_id) VALUES ($1, $2, $3, NOW(), $4)',
            [tenantId, tier, version, active],
          );
        }
        if (subId !== null) await this._upsertSub(client, tenantId, subId, tier === 'FREE' ? 'canceled' : 'active', ev.created);
      } else {
        // H1R2 R-07: administrative decision — new epoch on the database clock (shared by all replicas); every
        // subscription known now is revoked, so none of its events can restore what this decision removed
        const epoch = "(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT";
        if (rows[0]) {
          await client.query(
            `UPDATE otk_plan_assignments SET plan = $2, version = $3, assigned_at = NOW(), active_subscription_id = NULL,
               admin_version = $3, admin_decided_at_ms = ${epoch} WHERE tenant_id = $1`,
            [tenantId, tier, version],
          );
        } else {
          await client.query(
            `INSERT INTO otk_plan_assignments (tenant_id, plan, version, assigned_at, admin_version, admin_decided_at_ms)
             VALUES ($1, $2, $3, NOW(), $3, ${epoch})`,
            [tenantId, tier, version],
          );
        }
        await client.query('UPDATE otk_plan_subscriptions SET admin_revoked = TRUE, updated_at = NOW() WHERE tenant_id = $1', [tenantId]);
      }
      await client.query(
        'INSERT INTO otk_plan_audit (tenant_id, from_plan, to_plan, version, actor, source) VALUES ($1, $2, $3, $4, $5, $6)',
        [tenantId, previous, tier, version, meta.actor ?? 'unknown', meta.source ?? 'unknown'],
      );
      await client.query('COMMIT');
      return { previous, version };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
      if ((err as { code?: string }).code === '23505') {
        if (meta.stripeEvent) return { previous: null, version: PLAN_VERSION_NONE, applied: false, skipped: 'duplicate' };
        throw new PlanVersionConflictError(tenantId, meta.expectedVersion ?? PLAN_VERSION_NONE, PLAN_VERSION_NONE + 1);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async _upsertSub(client: any, tenantId: string, subId: string, status: 'active' | 'canceled', created: number): Promise<void> {
    await client.query(
      `INSERT INTO otk_plan_subscriptions (tenant_id, subscription_id, status, last_created) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, subscription_id) DO UPDATE SET status = EXCLUDED.status,
         last_created = GREATEST(otk_plan_subscriptions.last_created, EXCLUDED.last_created), updated_at = NOW()`,
      [tenantId, subId, status, created],
    );
  }

  async get(tenantId: string): Promise<PlanTier | null> {
    const { rows } = await this._pool.query(
      'SELECT plan FROM otk_plan_assignments WHERE tenant_id = $1',
      [tenantId],
    );
    return rows[0]?.plan ?? null;
  }

  async getVersioned(tenantId: string): Promise<{ tier: PlanTier; version: number } | null> {
    const { rows } = await this._pool.query(
      'SELECT plan, version FROM otk_plan_assignments WHERE tenant_id = $1',
      [tenantId],
    );
    return rows[0] ? { tier: rows[0].plan, version: Number(rows[0].version) } : null;
  }

  async list(): Promise<Array<{ tenantId: string; tier: PlanTier }>> {
    const { rows } = await this._pool.query(
      'SELECT tenant_id, plan FROM otk_plan_assignments ORDER BY tenant_id',
    );
    return rows.map((r: any) => ({ tenantId: r.tenant_id, tier: r.plan }));
  }

  async listAudit(tenantId?: string): Promise<PlanAuditRecord[]> {
    const { rows } = tenantId === undefined
      ? await this._pool.query('SELECT * FROM otk_plan_audit ORDER BY id')
      : await this._pool.query('SELECT * FROM otk_plan_audit WHERE tenant_id = $1 ORDER BY id', [tenantId]);
    return rows.map((r: any) => ({
      tenantId: r.tenant_id, fromTier: r.from_plan ?? null, toTier: r.to_plan, version: Number(r.version),
      actor: r.actor, source: r.source, at: new Date(r.at).toISOString(),
    }));
  }

  async getPlanOrdering(tenantId: string): Promise<PlanOrdering> {
    const { rows } = await this._pool.query(
      'SELECT admin_version, admin_decided_at_ms, active_subscription_id FROM otk_plan_assignments WHERE tenant_id = $1',
      [tenantId],
    );
    const r = rows[0];
    return {
      adminVersion: r?.admin_version === null || r?.admin_version === undefined ? null : Number(r.admin_version),
      adminDecidedAtMs: r?.admin_decided_at_ms === null || r?.admin_decided_at_ms === undefined ? null : Number(r.admin_decided_at_ms),
      activeSubscriptionId: r?.active_subscription_id ?? null,
    };
  }

  async listStripeEvents(tenantId: string): Promise<StripeEventRecord[]> {
    const { rows } = await this._pool.query(
      'SELECT * FROM otk_stripe_events WHERE tenant_id = $1 ORDER BY processed_at, created, event_id',
      [tenantId],
    );
    return rows.map((r: any) => ({
      eventId: r.event_id, tenantId: r.tenant_id, created: Number(r.created), type: r.type,
      subscriptionId: r.subscription_id ?? null, applied: r.applied === true, skipReason: r.skip_reason ?? null,
    }));
  }

  async clear(): Promise<void> {
    await this._pool.query('DELETE FROM otk_plan_assignments');
    await this._pool.query('DELETE FROM otk_plan_audit');
    await this._pool.query('DELETE FROM otk_stripe_events');
    await this._pool.query('DELETE FROM otk_plan_subscriptions');
  }
}
