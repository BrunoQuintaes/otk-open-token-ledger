/**
 * D1–D8 / C — PostgreSQL OperationStore (contract `OperationStore`, src/types/d1d8/modules.ts).
 *
 * admit(): one transaction that (1) answers an existing (tenant, operation) idempotently or as a
 * conflict, (2) locks the (tenant, epoch) quota row and applies check_before_crossing_admitted@1,
 * (3) locks the tenant's money budgets and applies strict_ceiling_worst_case@1, (4) inserts the
 * operation and adds its reservation to the held counters. 'admitted' is returned only after
 * COMMIT; any database failure returns 'persistence_unavailable', never a volatile ack (RV30-01).
 *
 * transition(): compare-and-set on `revision` under a row lock, legal transitions only
 * (operations/transitions.ts). A reservation state change moves the counters in the same
 * transaction: settlement writes the ledger identity debit:<tenant>:<op> exactly once and
 * converts held → confirmed; held_uncertain keeps the exposure; released returns it. Effects
 * passed in `extras.enqueue` are written in the same transaction (outbox).
 *
 * @module operations/PgOperationStore
 */
import type {
  AdmitRequest, AdmitResult, DurableOperation, IsoTime, OperationKey, OperationStore,
} from '../types/d1d8/index.js';
import type { LocalCountResult } from '../types/d1d8/index.js';
import { ACCOUNTING_SCALE, MONEY_SCALE, admitByMoney, admitByQuota, settlementPolicy, toAccountingUnits, toMoneyUnits, type SettlementNote } from './accounting.js';
import { big, encodeJson, decodeOperationRow, decodeLocalCount, type OperationRow } from './codec.js';
import { effectId } from './ids.js';
import { checkRegisteredTx, insertAttributionTx, isUnattributed, readAttributionTx, sameAttribution } from './attribution.js';
import { addBudget, addQuota, freezeBudget, insertLedger, lockBudgets, lockMoneyScope, lockQuotaRow } from './ledger.js';
import { enqueueTx, type EnqueueInput } from './PgEffectOutbox.js';
import { applyPatch, assertInvariants, type OperationPatch } from './transitions.js';
import { returnedModelAllowed, serviceTierMatches } from './moneyBound.js';
import type { PgClientLike, PgPoolLike } from './schema.js';
import { guardClient } from '../infra/pg/clientGuard.js';

export class OperationNotFoundError extends Error {
  constructor(key: OperationKey) { super(`operation ${key.tenantId}/${key.operationId} not found`); this.name = 'OperationNotFoundError'; }
}
/** A second debit for an identity already in the ledger (logic error, never an outage). */
export class LedgerIdentityError extends Error {
  constructor(id: string) { super(`ledger identity ${id} already exists: refusing a second debit`); this.name = 'LedgerIdentityError'; }
}

export class RevisionConflictError extends Error {
  constructor(readonly current: DurableOperation, expected: bigint) {
    super(`revision conflict: expected ${expected}, current ${current.revision}`);
    this.name = 'RevisionConflictError';
  }
}

export interface PgOperationStoreOptions {
  /** Plan quota of the tenant in accounting units (null = no hard limit). */
  quotaFor(tenantId: string): bigint | null;
  /** Quota epoch of an instant (frozen into the operation at admission). */
  epochOf(at: Date): string;
  /**
   * H1-S07: refuse admission when no money budget applies to the tenant (no USD ceiling at all). Without it a tenant
   * without budgets is limited only by its CU quota, and PRO has no CU quota: spend on the operator key is unbounded.
   */
  requireMoneyBudget?: boolean;
  /**
   * H1-S07: operator-wide ceiling. When set, this shared budget must be in every tenant's money scope (membership), so
   * every admission reserves against it as well (same row lock, same worst-case reservation as any budget).
   */
  globalBudgetId?: string | null;
  now?: () => Date;
}

export interface OperationDetail {
  operation: DurableOperation;
  epochId: string;
  reservedUnits: bigint;
  reservedMoney: bigint | null;
  settlementNote: SettlementNote | null;
  localCount: LocalCountResult | null;
  lease: { owner: string; until: IsoTime } | null;
}

export interface TransitionExtras {
  /** Effects written in the same transaction (outbox). */
  enqueue?: EnqueueInput[];
  /** Why a complete measurement could not settle (kept with the operation, visible in status). */
  settlementNote?: SettlementNote;
  /** Numeric result of the in-memory auxiliary counter (no text), kept for the conference. */
  localCount?: LocalCountResult | null;
}

type Row = OperationRow & {
  epoch_id: string; reserved_units: string; reserved_money: string | null; budget_ids: string[] | null;
  local_count: unknown; settlement_note: string | null; owner: string | null; lease_until: Date | null;
} & Record<string, unknown>;

/** Errors that come from our own rules, not from the database being unavailable. */
function isLogicError(err: unknown): boolean {
  const n = (err as Error | null)?.name;
  return n === 'ScaleLossError' || n === 'IllegalTransitionError' || n === 'RangeError' || n === 'CodecError' || n === 'LedgerIdentityError';
}

/** Short, secret-free description of a database error (code + message head), for logs. */
function errorDetail(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  return `${e?.code ?? 'no_code'}: ${String(e?.message ?? err).slice(0, 160)}`;
}

export class PgOperationStore implements OperationStore {
  private readonly now: () => Date;
  constructor(private readonly pool: PgPoolLike, private readonly opts: PgOperationStoreOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  private async tx<T>(fn: (c: PgClientLike) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    const cGuard = guardClient(c); // F-P2-01: a lost connection must not crash the process
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      cGuard.release();
    }
  }

  async admit(req: AdmitRequest): Promise<AdmitResult> {
    // Programming errors (bad scale, negative amounts) surface as exceptions, not as outages.
    const reservedUnits = toAccountingUnits(req.reservation.cu);
    const reservedMoney = req.reservation.money ? toMoneyUnits(req.reservation.money) : null;
    if (req.reservation.state !== 'held') throw new RangeError(`admission needs a 'held' reservation, got ${req.reservation.state}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.tx((c) => this.admitTx(c, req, reservedUnits, reservedMoney));
      } catch (err) {
        if (isLogicError(err)) throw err;
        // concurrent admission of the same key: the loser re-reads and answers existing/conflict
        if ((err as { code?: string }).code === '23505' && attempt === 0) continue;
        // OVERNIGHT 20261005 / Phase 1: the cause travels with the outcome (it was swallowed; a 503 had no trace)
        return { outcome: 'persistence_unavailable', detail: errorDetail(err) };
      }
    }
    return { outcome: 'persistence_unavailable' };
  }

  private async admitTx(c: PgClientLike, req: AdmitRequest, reservedUnits: bigint, reservedMoney: bigint | null): Promise<AdmitResult> {
    // Phase 4: an erased operation id keeps its tombstone; a retry is answered "erased", never re-admitted (no new call)
    const tomb = await c.query<{ at: string }>('SELECT erased_at::text AS at FROM otk_erasure_tombstones WHERE tenant_id = $1 AND operation_id = $2', [req.key.tenantId, req.key.operationId]);
    if (tomb.rows[0]) return { outcome: 'erased', erasedAt: tomb.rows[0].at };
    const existing = await c.query<Row>('SELECT * FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2', [req.key.tenantId, req.key.operationId]);
    if (existing.rows[0]) {
      const op = decodeOperationRow(existing.rows[0]);
      // OVERNIGHT 20261005 (identity across versions): a row digested by an earlier release (v1) is the same
      // operation when its stored digest is one of the enumerated v1 representations of THIS request; a v2 row
      // compares only with the v2 digest. Nothing is rewritten: the stored digest and its version stay as admitted.
      const same = op.requestDigest === req.requestDigest
        || (op.requestDigestVersion === 'otk.request_digest.v1' && (req.equivalentDigests ?? []).includes(op.requestDigest));
      // Phase 7: the attribution is part of the request identity (a retry cannot re-attribute an operation)
      return same && sameAttribution(await readAttributionTx(c, req.key), req.attribution)
        ? { outcome: 'existing', operation: op }
        : { outcome: 'conflict', existingRequestDigest: op.requestDigest };
    }
    // Phase 7: a named project/application must be registered and active for THIS tenant (another tenant's id
    // is simply unknown here); checked before quota/budget, nothing is reserved when refused
    if (!isUnattributed(req.attribution)) {
      const bad = await checkRegisteredTx(c, req.key.tenantId, req.attribution!);
      if (bad) return { outcome: 'attribution_rejected', reason: bad };
    }
    const now = this.now();
    const epochId = this.opts.epochOf(now);
    // RV2-01 (AUD-6): atomic point of the money scope. From this lock to the commit, no budget or
    // membership can be added for this tenant (trigger, same lock) and every budget read below is
    // row-locked (policy change / deletion wait for it): the scope seen here is the one committed with.
    await lockMoneyScope(c, req.key.tenantId);
    const q = await lockQuotaRow(c, req.key.tenantId, epochId);
    const quota = this.opts.quotaFor(req.key.tenantId);
    if (!admitByQuota(q.confirmed, q.held, quota)) {
      return { outcome: 'quota_exceeded', quota: { units: quota ?? 0n, scale: ACCOUNTING_SCALE }, current: { units: q.confirmed + q.held, scale: ACCOUNTING_SCALE } };
    }
    const budgets = await lockBudgets(c, req.key.tenantId);
    // H1-S07: no USD ceiling at all (or outside the operator-wide budget) → refused before any reservation
    const globalId = this.opts.globalBudgetId ?? null;
    if ((this.opts.requireMoneyBudget && budgets.length === 0) || (globalId !== null && !budgets.some((b) => b.budgetId === globalId))) {
      return { outcome: 'money_budget_required', globalBudgetId: globalId };
    }
    // a budget admits only a strict reservation made under the bound policy it requires; anything
    // else (the gateway read the scope earlier, or applies another policy) is refused before upstream.
    // An unknown cost (no money reservation) stays budget_exceeded below (admitByMoney refuses it).
    const offered = req.limits.moneyBoundPolicy ?? null;
    if (reservedMoney !== null && budgets.some((b) => b.moneyPolicy !== offered)) {
      return { outcome: 'money_policy_required', required: [...new Set(budgets.map((b) => b.moneyPolicy))].sort(), offered };
    }
    for (const b of budgets) {
      // ABC-04: a budget whose guarantee broke (observed cost above its reservation) admits nothing
      // more until an operator reviews it
      if (b.frozenReason !== null || !admitByMoney(b.spent, b.held, reservedMoney, b.ceiling)) {
        const left = b.ceiling - b.spent - b.held;
        return { outcome: 'budget_exceeded', remaining: { units: left > 0n ? left : 0n, scale: MONEY_SCALE, currency: 'USD' } };
      }
    }
    const op: DurableOperation = {
      schema: 'otk.operation.v1',
      key: req.key,
      requestDigest: req.requestDigest,
      requestDigestVersion: req.requestDigestVersion ?? 'otk.request_digest.v1',
      provider: req.provider,
      api: req.api,
      modelRequested: req.modelRequested,
      config: req.config,
      limits: req.limits,
      reservation: req.reservation,
      providerRequestId: null,
      execution: 'admitted',
      measurement: 'none',
      delivery: 'pending',
      usage: null,
      cancellation: null,
      effects: { receiptDigest: null, conferenceDigest: null, debitApplied: false, proofJobId: null },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      revision: 0n,
      // ABC-03: the money axis starts held at the reserved worst case
      ...(req.reservation.money ? { money: { state: 'held' as const, reserved: req.reservation.money, confirmed: null, knownSubtotal: null, priceStatus: null, priceTable: null } } : {}),
    };
    assertInvariants(op);
    // every budget that admitted the worst case holds it, and is settled/released with it (review H1)
    const budgetIds = budgets.map((b) => b.budgetId);
    const ins = await c.query<Row>(
      `INSERT INTO otk_operations (tenant_id, operation_id, request_digest, provider, api, model_requested, config, limits,
         reservation, epoch_id, reserved_units, reserved_money, budget_ids, execution, measurement, delivery, effects, created_at, updated_at, money,
         request_digest_version, owner, lease_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11::numeric,$12::numeric,$13::text[],'admitted','none','pending',$14::jsonb,$15,$15,$16::jsonb,$17,
         $18, CASE WHEN $19::int IS NULL THEN NULL ELSE now() + ($19::int * interval '1 millisecond') END)
       RETURNING *`,
      [req.key.tenantId, req.key.operationId, req.requestDigest, req.provider, req.api, req.modelRequested,
        encodeJson(req.config), encodeJson(req.limits), encodeJson(req.reservation), epochId, reservedUnits.toString(),
        reservedMoney === null ? null : reservedMoney.toString(), budgetIds, encodeJson(op.effects), now.toISOString(),
        op.money ? encodeJson(op.money) : null, req.requestDigestVersion ?? 'otk.request_digest.v1',
        req.lease?.owner ?? null, req.lease ? Math.max(1, Math.floor(req.lease.ms)) : null],
    );
    if (!isUnattributed(req.attribution)) await insertAttributionTx(c, req.key, req.attribution!);
    await addQuota(c, req.key.tenantId, epochId, 0n, reservedUnits);
    if (reservedMoney !== null) for (const b of budgets) await addBudget(c, b.budgetId, 0n, reservedMoney);
    return { outcome: 'admitted', operation: decodeOperationRow(ins.rows[0]!) };
  }

  async get(key: OperationKey): Promise<DurableOperation | null> {
    const r = await this.pool.query<Row>('SELECT * FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId]);
    return r.rows[0] ? decodeOperationRow(r.rows[0]) : null;
  }

  async getDetail(key: OperationKey): Promise<OperationDetail | null> {
    const r = await this.pool.query<Row>('SELECT * FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId]);
    const row = r.rows[0];
    return row ? this.detail(row) : null;
  }

  private detail(row: Row): OperationDetail {
    return {
      operation: decodeOperationRow(row),
      epochId: row.epoch_id,
      reservedUnits: big(row.reserved_units, 'reserved_units'),
      reservedMoney: row.reserved_money == null ? null : big(row.reserved_money, 'reserved_money'),
      settlementNote: (row.settlement_note ?? null) as SettlementNote | null,
      localCount: row.local_count == null ? null : decodeLocalCount(row.local_count),
      lease: row.owner && row.lease_until ? { owner: row.owner, until: new Date(row.lease_until).toISOString() } : null,
    };
  }

  async transition(key: OperationKey, expectedRevision: bigint, patch: OperationPatch, extras: TransitionExtras = {}): Promise<DurableOperation> {
    return this.tx(async (c) => {
      const r = await c.query<Row>('SELECT * FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2 FOR UPDATE', [key.tenantId, key.operationId]);
      const row = r.rows[0];
      if (!row) throw new OperationNotFoundError(key);
      const d = this.detail(row);
      const cur = d.operation;
      if (cur.revision !== expectedRevision) throw new RevisionConflictError(cur, expectedRevision);
      const next = applyPatch(cur, patch);
      let effects = next.effects;
      let note: SettlementNote | null = extras.settlementNote ?? d.settlementNote;
      const from = cur.reservation.state;
      const to = next.reservation.state;
      if (from !== to) {
        const wasHeld = from === 'held' || from === 'held_uncertain';
        if (to === 'settled') {
          const finalUnits = toAccountingUnits(next.reservation.cu);
          const fresh = await insertLedger(c, { tenantId: key.tenantId, effectId: effectId('debit', key), epochId: d.epochId, units: finalUnits, source: 'operation', operationId: key.operationId });
          if (!fresh) throw new LedgerIdentityError(effectId('debit', key));
          await lockQuotaRow(c, key.tenantId, d.epochId);
          await addQuota(c, key.tenantId, d.epochId, finalUnits, wasHeld ? -d.reservedUnits : 0n);
          note = settlementPolicy(d.reservedUnits, finalUnits);
          effects = { ...effects, debitApplied: true };
        } else if (to === 'released') {
          await lockQuotaRow(c, key.tenantId, d.epochId);
          await addQuota(c, key.tenantId, d.epochId, 0n, -d.reservedUnits);
        }
        // held → held_uncertain: exposure kept, counters unchanged (D7 §9)
      }
      // ABC-03: money budgets move with the MONEY axis only. A reservation or a partial subtotal is
      // never spend: pending_price and held_uncertain keep the worst case held.
      const mFrom = cur.money?.state ?? null;
      const mTo = next.money?.state ?? null;
      if (mFrom !== mTo && d.reservedMoney !== null) {
        const budgetIds = [...(row.budget_ids ?? [])].sort();
        if (mTo === 'settled') {
          const confirmed = toMoneyUnits(next.money!.confirmed!);
          for (const b of budgetIds) {
            const ins = await c.query(
              `INSERT INTO otk_money_ledger (budget_id, tenant_id, operation_id, units, reserved_units, price_table, note)
               VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6::jsonb,$7) ON CONFLICT DO NOTHING`,
              [b, key.tenantId, key.operationId, confirmed.toString(), d.reservedMoney.toString(), next.money!.priceTable ? encodeJson(next.money!.priceTable) : null, null],
            );
            if ((ins.rowCount ?? 0) !== 1) throw new LedgerIdentityError(`money:${b}:${key.tenantId}:${key.operationId}`);
            await addBudget(c, b, confirmed, -d.reservedMoney);
          }
          if (confirmed > d.reservedMoney) {
            // ABC-04: the observed cost broke the reserved worst case: recorded as is (never
            // truncated), and every budget involved stops admitting until reviewed
            note = 'money_excess_over_reservation';
            for (const b of budgetIds) await freezeBudget(c, b, `money_excess_over_reservation:${key.tenantId}/${key.operationId}`);
          }
        } else if (mTo === 'released') {
          for (const b of budgetIds) await addBudget(c, b, 0n, -d.reservedMoney);
        } else if (mTo === 'pending_price' && next.money!.knownSubtotal && toMoneyUnits(next.money!.knownSubtotal) > d.reservedMoney) {
          // S5 AUD-2: the KNOWN part of a partial quote already exceeds the reserved worst case: the
          // guarantee broke exactly as in the complete-quote case above, so the budgets are frozen
          // too (the reservation stays held; a subtotal is never moved to spent)
          note = 'money_excess_over_reservation';
          for (const b of budgetIds) await freezeBudget(c, b, `money_excess_over_reservation:${key.tenantId}/${key.operationId}`);
        }
      }
      // ABC-04: the reservation covered only the declared returnable models; any other model
      // reported by the provider breaks the bound, so the budgets stop admitting until reviewed.
      // S5 AUD-1: a model reported in a PARTIAL usage (stream cut before the final usage) breaks it
      // as well: the exposure stays held_uncertain at a worst case priced for other models only.
      const becameFinal = cur.measurement !== 'final' && next.measurement === 'final';
      const reportedNow = patch.usage !== undefined ? (next.usage?.modelReturned ?? null) : null;
      if (d.reservedMoney !== null && (
        (becameFinal && !returnedModelAllowed(next.limits.allowedReturnedModels, next.usage?.modelReturned ?? null))
        || (reportedNow !== null && !returnedModelAllowed(next.limits.allowedReturnedModels, reportedNow)))) {
        note = 'unexpected_returned_model';
        for (const b of [...(row.budget_ids ?? [])].sort()) await freezeBudget(c, b, `unexpected_returned_model:${next.usage?.modelReturned ?? 'none'}:${key.tenantId}/${key.operationId}`);
      }
      // FECHAMENTO_GEMINI_AD (DL-07/DL-08): the tariff assumptions of the admission. A REPORTED tier other than the
      // admitted one, or thinking tokens on an admission with thinking off, break the bound the same way: the
      // budgets stop admitting until reviewed (the cost of the usage is still recorded as observed). An
      // unreported tier only keeps the price pending (proxyDurable), without freezing.
      const terms = next.limits.pricingTerms;
      if (d.reservedMoney !== null && terms && patch.usage !== undefined && next.usage) {
        const reportedTier = next.usage.serviceTier ?? null;
        const thoughts = next.usage.categories.find((x) => x.name === 'output_reasoning')?.count ?? null;
        const breach = terms.serviceTier && reportedTier !== null && !serviceTierMatches(terms.serviceTier, reportedTier) ? `unexpected_service_tier:${reportedTier}`
          : terms.thinking === 'off' && thoughts !== null && thoughts > 0n ? `unexpected_thinking:${thoughts}` : null;
        if (breach) {
          // review L3: an earlier freeze reason of this transition stays (the budget's frozen_reason records each one)
          if (note !== 'money_excess_over_reservation' && note !== 'unexpected_returned_model') note = breach.startsWith('unexpected_service_tier') ? 'unexpected_service_tier' : 'unexpected_thinking';
          for (const b of [...(row.budget_ids ?? [])].sort()) await freezeBudget(c, b, `${breach}:${key.tenantId}/${key.operationId}`);
        }
      }
      const upd = await c.query<Row>(
        `UPDATE otk_operations SET execution = $3, measurement = $4, delivery = $5, usage = $6::jsonb, provider_request_id = $7,
            cancellation = $8::jsonb, effects = $9::jsonb, reservation = $10::jsonb, settlement_note = $11,
            local_count = COALESCE($12::jsonb, local_count), money = $13::jsonb, revision = revision + 1, updated_at = now()
          WHERE tenant_id = $1 AND operation_id = $2 RETURNING *`,
        [key.tenantId, key.operationId, next.execution, next.measurement, next.delivery,
          next.usage === null ? null : encodeJson(next.usage), next.providerRequestId,
          next.cancellation === null ? null : encodeJson(next.cancellation), encodeJson(effects), encodeJson(next.reservation),
          note, extras.localCount == null ? null : encodeJson(extras.localCount), next.money ? encodeJson(next.money) : null],
      );
      for (const e of extras.enqueue ?? []) await enqueueTx(c, e);
      return decodeOperationRow(upd.rows[0]!);
    });
  }

  async listIncomplete(opts: { olderThan: IsoTime; limit: number }): Promise<DurableOperation[]> {
    const r = await this.pool.query<Row>(
      `SELECT * FROM otk_operations
        WHERE execution IN ('admitted', 'upstream_started', 'cancel_requested')
          AND updated_at < $1::timestamptz AND (lease_until IS NULL OR lease_until < now())
        ORDER BY updated_at LIMIT $2`,
      [opts.olderThan, Math.max(1, Math.floor(opts.limit))],
    );
    return r.rows.map(decodeOperationRow);
  }

  /** Whether a money budget (own or shared) applies to the tenant: strict money mode (ABC-04). */
  async hasMoneyBudget(tenantId: string): Promise<boolean> {
    const r = await this.pool.query(
      'SELECT 1 FROM otk_money_budget WHERE tenant_id = $1 OR budget_id IN (SELECT budget_id FROM otk_money_budget_members WHERE tenant_id = $1) LIMIT 1',
      [tenantId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Claim the pending-price operations that are due for a reconciliation attempt (RV2-02, AUD-4):
   * never-tried ones first (oldest first), then by due time. In the same statement each claimed row gets
   * its next attempt scheduled (backoff base × 2^attempts, capped), so permanently unpriceable operations
   * leave the head of the queue and concurrent workers (SKIP LOCKED) never claim the same row twice in a
   * window. Only the scheduling columns change; business timestamps and the money axis do not.
   */
  async claimPendingPrice(limit: number, backoff: { baseMs: number; maxMs: number }): Promise<Array<OperationKey & { attempts: number }>> {
    const r = await this.pool.query<{ tenant_id: string; operation_id: string; price_attempts: number }>(
      `WITH due AS (
         SELECT tenant_id, operation_id FROM otk_operations
          WHERE money->>'state' = 'pending_price' AND (price_next_attempt_at IS NULL OR price_next_attempt_at <= now())
          ORDER BY price_next_attempt_at NULLS FIRST, updated_at, tenant_id, operation_id
          LIMIT $1 FOR UPDATE SKIP LOCKED)
       UPDATE otk_operations o
          SET price_attempts = o.price_attempts + 1,
              price_next_attempt_at = now() + LEAST($2::numeric * power(2::numeric, LEAST(o.price_attempts, 40)), $3::numeric) * interval '1 millisecond'
         FROM due WHERE o.tenant_id = due.tenant_id AND o.operation_id = due.operation_id
       RETURNING o.tenant_id, o.operation_id, o.price_attempts`,
      [Math.max(1, Math.floor(limit)), Math.max(1, Math.floor(backoff.baseMs)), Math.max(1, Math.floor(backoff.maxMs))],
    );
    return r.rows.map((x) => ({ tenantId: x.tenant_id, operationId: x.operation_id, attempts: Number(x.price_attempts) }));
  }

  /** Take or renew the execution lease of an operation. False when another live owner holds it. */
  async claimLease(key: OperationKey, owner: string, ms: number): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE otk_operations SET owner = $3, lease_until = now() + ($4::int * interval '1 millisecond')
        WHERE tenant_id = $1 AND operation_id = $2 AND (owner IS NULL OR owner = $3 OR lease_until IS NULL OR lease_until < now())`,
      [key.tenantId, key.operationId, owner, Math.max(1, Math.floor(ms))],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async releaseLease(key: OperationKey, owner: string): Promise<void> {
    await this.pool.query('UPDATE otk_operations SET lease_until = NULL WHERE tenant_id = $1 AND operation_id = $2 AND owner = $3', [key.tenantId, key.operationId, owner]);
  }
}
