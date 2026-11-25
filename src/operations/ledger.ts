/**
 * D1–D8 / C — durable debit ledger and quota/budget counters (RV30-02, RV30-04, RV30-05).
 *
 * The ledger row (tenant, effect_id) is the identity of one confirmed debit and is never deleted
 * while a counter includes it (identity_retention_ge_aggregate_retention@1). Counters are a
 * projection inside PostgreSQL, rebuildable from the ledger plus the open reservations; Redis is
 * a further projection (operations/redisProjection.ts). All helpers here run inside a caller's
 * transaction; the row lock on (tenant, epoch) serializes admissions of every instance that
 * shares the database, which is what makes the quota rule global.
 *
 * Units: CU counters are micro-CU and budget amounts are pico-USD (bigint, see `accounting.ts`).
 *
 * @module src/operations/ledger
 */
import { big } from './codec.js';
import type { PgQueryable } from './schema.js';

/** Quota counters of one (tenant, epoch), micro-CU: settled usage and open reservations. */
export interface QuotaRow { confirmed: bigint; held: bigint }

/**
 * Lock (creating if needed) the counter row of (tenant, epoch). Call inside a transaction.
 *
 * @param tx - An open transaction client.
 * @param tenantId - The tenant.
 * @param epochId - The quota epoch.
 * @returns The current counters, row-locked until the transaction ends.
 * @throws {Error} When the row cannot be read back after the insert (should not happen).
 */
export async function lockQuotaRow(tx: PgQueryable, tenantId: string, epochId: string): Promise<QuotaRow> {
  await tx.query(
    'INSERT INTO otk_quota_usage (tenant_id, epoch_id) VALUES ($1, $2) ON CONFLICT (tenant_id, epoch_id) DO NOTHING',
    [tenantId, epochId],
  );
  const r = await tx.query<{ confirmed_units: string; held_units: string }>(
    'SELECT confirmed_units::text, held_units::text FROM otk_quota_usage WHERE tenant_id = $1 AND epoch_id = $2 FOR UPDATE',
    [tenantId, epochId],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`quota row ${tenantId}/${epochId} vanished under lock`);
  return { confirmed: big(row.confirmed_units, 'confirmed_units'), held: big(row.held_units, 'held_units') };
}

/**
 * Add deltas (may be negative) to a locked counter row. Never lets a counter go below zero.
 *
 * @param tx - An open transaction client that already locked the row.
 * @param tenantId - The tenant.
 * @param epochId - The quota epoch.
 * @param dConfirmed - Change of the confirmed counter, micro-CU.
 * @param dHeld - Change of the held counter, micro-CU.
 * @throws {Error} When the row is missing or a counter would become negative (nothing is changed).
 */
export async function addQuota(tx: PgQueryable, tenantId: string, epochId: string, dConfirmed: bigint, dHeld: bigint): Promise<void> {
  const r = await tx.query(
    `UPDATE otk_quota_usage
        SET confirmed_units = confirmed_units + $3::numeric, held_units = held_units + $4::numeric, updated_at = now()
      WHERE tenant_id = $1 AND epoch_id = $2
        AND confirmed_units + $3::numeric >= 0 AND held_units + $4::numeric >= 0`,
    [tenantId, epochId, dConfirmed.toString(), dHeld.toString()],
  );
  if ((r.rowCount ?? 0) !== 1) throw new Error(`quota counter ${tenantId}/${epochId} would become negative (Δconfirmed=${dConfirmed}, Δheld=${dHeld})`);
}

/**
 * Insert one confirmed debit. Returns false when this identity was already debited (replay);
 * then the caller must not touch the counters again.
 *
 * @param tx - An open transaction client.
 * @param e - Debit identity (tenant, effect id), epoch, amount in micro-CU, source and operation id
 *   (`null` for legacy receipts).
 * @returns `true` when the row was inserted.
 */
export async function insertLedger(tx: PgQueryable, e: {
  tenantId: string; effectId: string; epochId: string; units: bigint; source: 'operation' | 'legacy_receipt'; operationId: string | null;
}): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO otk_ledger (tenant_id, effect_id, epoch_id, units, source, operation_id)
     VALUES ($1, $2, $3, $4::numeric, $5, $6) ON CONFLICT (tenant_id, effect_id) DO NOTHING`,
    [e.tenantId, e.effectId, e.epochId, e.units.toString(), e.source, e.operationId],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * Durable confirmed total of (tenant, epoch): the source every projection must converge to.
 *
 * @param q - Pool or transaction client.
 * @param tenantId - The tenant.
 * @param epochId - The quota epoch.
 * @returns Sum of ledger units (micro-CU, 0 when none) and the number of ledger rows.
 */
export async function ledgerTotal(q: PgQueryable, tenantId: string, epochId: string): Promise<{ units: bigint; entries: number }> {
  const r = await q.query<{ s: string; n: string }>(
    'SELECT COALESCE(sum(units), 0)::text AS s, count(*)::text AS n FROM otk_ledger WHERE tenant_id = $1 AND epoch_id = $2',
    [tenantId, epochId],
  );
  return { units: big(r.rows[0]?.s ?? '0', 'ledger.sum'), entries: Number(r.rows[0]?.n ?? 0) };
}

/**
 * One money budget as locked for admission: ceiling, spent and held in pico-USD; `frozenReason` non-null
 * means the budget admits nothing until reviewed; `moneyPolicy` is the bound policy id it requires.
 */
export interface BudgetRow { budgetId: string; ceiling: bigint; spent: bigint; held: bigint; frozenReason: string | null; moneyPolicy: string }

/**
 * Lock every money budget that applies to a tenant: its own budgets and the shared ones it is a
 * member of (S4, ABC-04: one pilot ceiling shared by several tenants/operations). Strict ceilings;
 * none configured = no money limit. Locked in budget_id order, so concurrent admissions of
 * different tenants on the same shared budget serialize without deadlock.
 * Fechamento pós-S5 (RV2-01): call after lockMoneyScope(tenant), so budget creation and new
 * membership (which take the same lock in a trigger) cannot slip between this read and the commit.
 *
 * @param tx - An open transaction client.
 * @param tenantId - The tenant.
 * @returns The applicable budgets in budget_id order (empty when none).
 */
export async function lockBudgets(tx: PgQueryable, tenantId: string): Promise<BudgetRow[]> {
  const r = await tx.query<{ budget_id: string; ceiling_units: string; spent_units: string; held_units: string; frozen_reason: string | null; money_policy: string }>(
    `SELECT budget_id, ceiling_units::text, spent_units::text, held_units::text, frozen_reason, money_policy
       FROM otk_money_budget
      WHERE tenant_id = $1 OR budget_id IN (SELECT budget_id FROM otk_money_budget_members WHERE tenant_id = $1)
      ORDER BY budget_id FOR UPDATE`,
    [tenantId],
  );
  return r.rows.map((x) => ({ budgetId: x.budget_id, ceiling: big(x.ceiling_units, 'ceiling'), spent: big(x.spent_units, 'spent'), held: big(x.held_units, 'held'), frozenReason: x.frozen_reason ?? null, moneyPolicy: x.money_policy }));
}

/**
 * Take the money-scope lock of a tenant (transaction-scoped advisory lock, migration 151). Admission
 * holds it while it decides which budgets and which bound policy apply; the budget/membership
 * triggers take it before adding the tenant to a budget.
 *
 * @param tx - An open transaction client (the lock is released at commit or rollback).
 * @param tenantId - The tenant.
 */
export async function lockMoneyScope(tx: PgQueryable, tenantId: string): Promise<void> {
  await tx.query('SELECT otk_money_scope_lock($1)', [tenantId]);
}

/**
 * Stop a budget from admitting anything (its guarantee no longer holds); first reason kept.
 *
 * @param tx - An open transaction client.
 * @param budgetId - The budget.
 * @param reason - Why it is frozen (machine-readable reason plus operation reference; no secrets).
 */
export async function freezeBudget(tx: PgQueryable, budgetId: string, reason: string): Promise<void> {
  await tx.query('UPDATE otk_money_budget SET frozen_reason = COALESCE(frozen_reason, $2), frozen_at = COALESCE(frozen_at, now()), updated_at = now() WHERE budget_id = $1', [budgetId, reason]);
}

/**
 * Adds deltas to a budget's spent and held amounts; never lets either go below zero.
 *
 * @param tx - An open transaction client that already locked the budget.
 * @param budgetId - The budget.
 * @param dSpent - Change of the spent amount, pico-USD.
 * @param dHeld - Change of the held amount, pico-USD.
 * @throws {Error} When the budget is missing or an amount would become negative.
 */
export async function addBudget(tx: PgQueryable, budgetId: string, dSpent: bigint, dHeld: bigint): Promise<void> {
  const r = await tx.query(
    `UPDATE otk_money_budget SET spent_units = spent_units + $2::numeric, held_units = held_units + $3::numeric, updated_at = now()
      WHERE budget_id = $1 AND spent_units + $2::numeric >= 0 AND held_units + $3::numeric >= 0`,
    [budgetId, dSpent.toString(), dHeld.toString()],
  );
  if ((r.rowCount ?? 0) !== 1) throw new Error(`budget ${budgetId} would become negative`);
}

/**
 * Recompute the PostgreSQL counters of (tenant, epoch) from their sources: confirmed = Σ ledger,
 * held = Σ open reservations (held / held_uncertain). Returns the values written.
 *
 * @param tx - An open transaction client.
 * @param tenantId - The tenant.
 * @param epochId - The quota epoch.
 * @returns The rebuilt counters, micro-CU.
 */
export async function rebuildQuotaRow(tx: PgQueryable, tenantId: string, epochId: string): Promise<QuotaRow> {
  await lockQuotaRow(tx, tenantId, epochId);
  const c = await ledgerTotal(tx, tenantId, epochId);
  const h = await tx.query<{ s: string }>(
    `SELECT COALESCE(sum(reserved_units), 0)::text AS s FROM otk_operations
      WHERE tenant_id = $1 AND epoch_id = $2 AND reservation->>'state' IN ('held', 'held_uncertain')`,
    [tenantId, epochId],
  );
  const held = big(h.rows[0]?.s ?? '0', 'held.sum');
  await tx.query(
    'UPDATE otk_quota_usage SET confirmed_units = $3::numeric, held_units = $4::numeric, updated_at = now() WHERE tenant_id = $1 AND epoch_id = $2',
    [tenantId, epochId, c.units.toString(), held.toString()],
  );
  return { confirmed: c.units, held };
}
