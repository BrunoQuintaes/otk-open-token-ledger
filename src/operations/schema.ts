/**
 * D1–D8 / C — canonical DDL of the durable operation, ledger, outbox, opening and receipt v3
 * tables (D3 storage, D7). Additive and idempotent: every statement is IF NOT EXISTS.
 *
 * The same text is shipped as scripts/migrations/100–103_*.sql (and 150–155_*.sql) for `scripts/ops/migrate.js`
 * (a unit test keeps both identical). The runtime applies it too, under an advisory lock,
 * because the API image does not carry scripts/. Rollback scripts live in
 * scripts/migrations/rollback/ (migrate.js is forward-only by design).
 *
 * Units: CU columns use the accounting scale ACCOUNTING_SCALE (10^6, micro-CU); money columns
 * use MONEY_SCALE (10^12, pico-USD). NUMERIC(78,0) holds any uint256.
 *
 * Do not edit the SQL text of an existing migration: the `.sql` copies must stay byte-equal and databases
 * already migrated would not see the change. Add a new migration instead.
 *
 * @module src/operations/schema
 */
import { guardClient } from '../infra/pg/clientGuard.js';

/** Ordered migrations of the durable runtime: version id (also the `.sql` file name) and its idempotent DDL. */
export const D1D8_MIGRATIONS: ReadonlyArray<{ version: string; sql: string }> = Object.freeze([
  {
    version: '100_d1d8_operations',
    sql: `-- D1-D8 / C: durable operations, quota counters, money budgets, debit ledger (D7, RV30-02/04/05)
CREATE TABLE IF NOT EXISTS otk_operations (
  tenant_id          TEXT        NOT NULL,
  operation_id       TEXT        NOT NULL,
  schema             TEXT        NOT NULL DEFAULT 'otk.operation.v1',
  request_digest     TEXT        NOT NULL,
  provider           TEXT        NOT NULL,
  api                TEXT        NOT NULL,
  model_requested    TEXT        NOT NULL,
  config             JSONB       NOT NULL,
  limits             JSONB       NOT NULL,
  reservation        JSONB       NOT NULL,
  epoch_id           TEXT        NOT NULL,
  reserved_units     NUMERIC(78,0) NOT NULL,
  reserved_money     NUMERIC(78,0),
  budget_ids         TEXT[]      NOT NULL DEFAULT '{}',
  provider_request_id TEXT,
  execution          TEXT        NOT NULL,
  measurement        TEXT        NOT NULL,
  delivery           TEXT        NOT NULL,
  usage              JSONB,
  cancellation       JSONB,
  effects            JSONB       NOT NULL,
  local_count        JSONB,
  settlement_note    TEXT,
  owner              TEXT,
  lease_until        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revision           BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, operation_id)
);
CREATE INDEX IF NOT EXISTS otk_operations_incomplete_idx ON otk_operations (execution, updated_at);

CREATE TABLE IF NOT EXISTS otk_quota_usage (
  tenant_id        TEXT          NOT NULL,
  epoch_id         TEXT          NOT NULL,
  confirmed_units  NUMERIC(78,0) NOT NULL DEFAULT 0,
  held_units       NUMERIC(78,0) NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, epoch_id)
);

CREATE TABLE IF NOT EXISTS otk_money_budget (
  budget_id        TEXT          PRIMARY KEY,
  tenant_id        TEXT          NOT NULL,
  ceiling_units    NUMERIC(78,0) NOT NULL,
  spent_units      NUMERIC(78,0) NOT NULL DEFAULT 0,
  held_units       NUMERIC(78,0) NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otk_money_budget_tenant_idx ON otk_money_budget (tenant_id);

CREATE TABLE IF NOT EXISTS otk_ledger (
  tenant_id        TEXT          NOT NULL,
  effect_id        TEXT          NOT NULL,
  epoch_id         TEXT          NOT NULL,
  units            NUMERIC(78,0) NOT NULL,
  source           TEXT          NOT NULL,
  operation_id     TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, effect_id)
);
CREATE INDEX IF NOT EXISTS otk_ledger_epoch_idx ON otk_ledger (tenant_id, epoch_id);
`,
  },
  {
    version: '101_d1d8_outbox',
    sql: `-- D1-D8 / C: durable side effects, at-least-once with lease and deduplication (D7 §6-7, RV30-03)
CREATE TABLE IF NOT EXISTS otk_outbox (
  effect_id        TEXT        PRIMARY KEY,
  schema           TEXT        NOT NULL DEFAULT 'otk.outbox_effect.v1',
  tenant_id        TEXT        NOT NULL,
  operation_id     TEXT        NOT NULL,
  kind             TEXT        NOT NULL,
  payload_digest   TEXT        NOT NULL,
  payload          JSONB,
  target           JSONB,
  state            TEXT        NOT NULL DEFAULT 'pending',
  attempts         INTEGER     NOT NULL DEFAULT 0,
  lease_owner      TEXT,
  lease_until      TIMESTAMPTZ,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS otk_outbox_claim_idx ON otk_outbox (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS otk_outbox_op_idx ON otk_outbox (tenant_id, operation_id);
`,
  },
  {
    version: '102_d1d8_openings',
    sql: `-- D1-D8 / C: private commitment openings, stored before the dependent public effect (D2 §5)
CREATE TABLE IF NOT EXISTS otk_openings (
  tenant_id        TEXT        NOT NULL,
  operation_id     TEXT        NOT NULL,
  circuit_id       TEXT        NOT NULL,
  opening          JSONB       NOT NULL,
  opening_digest   TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
`,
  },
  {
    version: '103_d1d8_receipts_v3',
    sql: `-- D1-D8 / C: private receipt v3 and conference report with their envelopes (D3 §6-7)
CREATE TABLE IF NOT EXISTS otk_receipts_v3 (
  tenant_id        TEXT        NOT NULL,
  operation_id     TEXT        NOT NULL,
  schema           TEXT        NOT NULL,
  source           TEXT        NOT NULL,
  receipt_digest   TEXT        NOT NULL,
  receipt          JSONB       NOT NULL,
  envelope         JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id),
  UNIQUE (receipt_digest)
);

CREATE TABLE IF NOT EXISTS otk_conferences (
  tenant_id        TEXT        NOT NULL,
  operation_id     TEXT        NOT NULL,
  schema           TEXT        NOT NULL,
  receipt_digest   TEXT        NOT NULL,
  state            TEXT        NOT NULL,
  verdict          TEXT        NOT NULL,
  report_digest    TEXT        NOT NULL,
  report           JSONB       NOT NULL,
  envelope         JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id),
  FOREIGN KEY (tenant_id, operation_id) REFERENCES otk_receipts_v3 (tenant_id, operation_id),
  FOREIGN KEY (receipt_digest) REFERENCES otk_receipts_v3 (receipt_digest)
);
`,
  },
  {
    version: '150_d1d8_s4_money',
    sql: `-- D1-D8 / S4: monetary axis separate from the CU settlement (audit ABC-03), shared money budgets and
-- guarantee freeze (audit ABC-04). Additive and idempotent, rollback in rollback/150_*.down.sql.
ALTER TABLE otk_operations ADD COLUMN IF NOT EXISTS money JSONB;
ALTER TABLE otk_money_budget ADD COLUMN IF NOT EXISTS frozen_reason TEXT;
ALTER TABLE otk_money_budget ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS otk_money_budget_members (
  budget_id        TEXT          NOT NULL REFERENCES otk_money_budget (budget_id),
  tenant_id        TEXT          NOT NULL,
  PRIMARY KEY (budget_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS otk_money_budget_members_tenant_idx ON otk_money_budget_members (tenant_id);

CREATE TABLE IF NOT EXISTS otk_money_ledger (
  budget_id        TEXT          NOT NULL,
  tenant_id        TEXT          NOT NULL,
  operation_id     TEXT          NOT NULL,
  units            NUMERIC(78,0) NOT NULL,
  reserved_units   NUMERIC(78,0) NOT NULL,
  price_table      JSONB,
  note             TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (budget_id, tenant_id, operation_id)
);

-- rows written before this migration (C semantics: money moved to spent at CU settlement) get
-- an explicit money axis, settled ones are marked legacy_pre_s4 (confirmed = what C moved to spent)
UPDATE otk_operations SET money = jsonb_build_object(
    'state', CASE reservation->>'state' WHEN 'settled' THEN 'settled' ELSE reservation->>'state' END,
    'reserved', jsonb_build_object('units', reserved_money::text, 'scale', '1000000000000', 'currency', 'USD'),
    'confirmed', CASE WHEN reservation->>'state' = 'settled' THEN reservation->'money' ELSE 'null'::jsonb END,
    'knownSubtotal', 'null'::jsonb, 'priceStatus', 'null'::jsonb, 'priceTable', 'null'::jsonb,
    'origin', CASE WHEN reservation->>'state' = 'settled' THEN to_jsonb('legacy_pre_s4'::text) ELSE 'null'::jsonb END)
  WHERE money IS NULL AND reserved_money IS NOT NULL;
`,
  },
  {
    version: '151_d1d8_fps5_money_scope',
    sql: `-- D1-D8 / fechamento pós-S5 (RV2-01, AUD-6): the money scope of a tenant is decided atomically with
-- the admission. Admission takes otk_money_scope_lock(tenant), then reads/locks the budgets that apply.
-- Creating a budget or linking a tenant takes the same lock (trigger); changing a budget's policy or
-- deleting it holds the budget row lock that admissions also take. Additive and idempotent, rollback in
-- rollback/151_*.down.sql.
ALTER TABLE otk_money_budget ADD COLUMN IF NOT EXISTS money_policy TEXT;
UPDATE otk_money_budget SET money_policy = 'otk.money_bound_policy.v2@2026-10-02' WHERE money_policy IS NULL;
ALTER TABLE otk_money_budget ALTER COLUMN money_policy SET DEFAULT 'otk.money_bound_policy.v2@2026-10-02';
ALTER TABLE otk_money_budget ALTER COLUMN money_policy SET NOT NULL;
CREATE INDEX IF NOT EXISTS otk_operations_open_money_idx ON otk_operations (tenant_id)
  WHERE money->>'state' IN ('held', 'held_uncertain', 'pending_price') OR reservation->>'state' IN ('held', 'held_uncertain');

CREATE OR REPLACE FUNCTION otk_money_scope_lock(p_tenant TEXT) RETURNS void LANGUAGE sql AS $fn$
  SELECT pg_advisory_xact_lock(hashtextextended('otk_money_scope:' || p_tenant, 0))
$fn$;

CREATE OR REPLACE FUNCTION otk_money_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_bad TEXT;
BEGIN
  IF TG_TABLE_NAME = 'otk_money_budget' AND TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'otk_money_budget_owner_immutable: budget % (create a new budget instead)', OLD.budget_id;
  END IF;
  IF TG_TABLE_NAME = 'otk_money_budget' AND TG_OP = 'DELETE' THEN
    -- the budget row is locked by this statement; an admission that locked it first has committed
    SELECT tenant_id || '/' || operation_id INTO v_bad FROM otk_operations
     WHERE OLD.budget_id = ANY (budget_ids)
       AND (money->>'state' IN ('held', 'held_uncertain', 'pending_price') OR reservation->>'state' IN ('held', 'held_uncertain'))
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'otk_money_scope_open_exposure: budget % still holds open operation %', OLD.budget_id, v_bad;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'otk_money_budget' AND TG_OP = 'UPDATE' THEN
    -- policy change: refused while an operation reserved under another policy is open in this budget
    SELECT tenant_id || '/' || operation_id INTO v_bad FROM otk_operations
     WHERE OLD.budget_id = ANY (budget_ids)
       AND (money->>'state' IN ('held', 'held_uncertain', 'pending_price') OR reservation->>'state' IN ('held', 'held_uncertain'))
       AND limits->>'moneyBoundPolicy' IS DISTINCT FROM NEW.money_policy
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'otk_money_scope_open_exposure: budget % has open operation % reserved under another policy', OLD.budget_id, v_bad;
    END IF;
    RETURN NEW;
  END IF;
  -- INSERT of a budget, INSERT/UPDATE of a membership: NEW.tenant_id enters the scope of NEW.budget_id
  PERFORM otk_money_scope_lock(NEW.tenant_id);
  SELECT tenant_id || '/' || operation_id INTO v_bad FROM otk_operations
   WHERE tenant_id = NEW.tenant_id
     AND (money->>'state' IN ('held', 'held_uncertain', 'pending_price') OR reservation->>'state' IN ('held', 'held_uncertain'))
     AND NOT (NEW.budget_id = ANY (budget_ids))
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'otk_money_scope_open_exposure: tenant % has open operation % not covered by budget %', NEW.tenant_id, v_bad, NEW.budget_id;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER otk_money_budget_scope_ins BEFORE INSERT ON otk_money_budget
  FOR EACH ROW EXECUTE FUNCTION otk_money_scope_guard();
CREATE OR REPLACE TRIGGER otk_money_budget_scope_upd BEFORE UPDATE OF tenant_id, money_policy ON otk_money_budget
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.money_policy IS DISTINCT FROM NEW.money_policy)
  EXECUTE FUNCTION otk_money_scope_guard();
CREATE OR REPLACE TRIGGER otk_money_budget_scope_del BEFORE DELETE ON otk_money_budget
  FOR EACH ROW EXECUTE FUNCTION otk_money_scope_guard();
CREATE OR REPLACE TRIGGER otk_money_budget_members_scope BEFORE INSERT OR UPDATE ON otk_money_budget_members
  FOR EACH ROW EXECUTE FUNCTION otk_money_scope_guard();
`,
  },
  {
    version: '152_d1d8_fps5_price_schedule',
    sql: `-- D1-D8 / fechamento pós-S5 (RV2-02, AUD-4): fair, persistent reconciliation of pending prices. Each pass
-- claims the operations that are due (never tried first, then by due time) and schedules the next attempt
-- with exponential backoff, so permanently unpriceable operations cannot occupy every batch. Scheduling
-- columns only: business timestamps (created_at/updated_at) and the money axis are not touched. Additive and
-- idempotent, rollback in rollback/152_*.down.sql.
ALTER TABLE otk_operations ADD COLUMN IF NOT EXISTS price_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE otk_operations ADD COLUMN IF NOT EXISTS price_next_attempt_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS otk_operations_price_due_idx ON otk_operations (price_next_attempt_at NULLS FIRST, updated_at)
  WHERE money->>'state' = 'pending_price';
`,
  },
  {
    version: '153_d1d8_request_digest_version',
    sql: `-- D1-D8 / OVERNIGHT 20261005 (identity across versions): construction of request_digest. NULL = every row
-- admitted before this column existed, which used otk.request_digest.v1 (digest of the FORWARDED body). New rows
-- record otk.request_digest.v2 (digest of the request as the client sent it). The stored digest of an old row
-- is never rewritten. Additive and idempotent, rollback in rollback/153_*.down.sql.
ALTER TABLE otk_operations ADD COLUMN IF NOT EXISTS request_digest_version TEXT;
`,
  },
  {
    version: '154_d1d8_attribution',
    sql: `-- D1-D8 / OVERNIGHT 20261005 (Phase 7): attribution of operations to projects and tasks, private and off-chain.
-- otk_projects / otk_applications: what a tenant may name (registered, tenant-scoped ids; labels are private).
-- otk_operation_attribution: written in the SAME transaction that admits the operation; absent row = unattributed.
-- otk_attribution_statements: the attribution signed by the operator and bound to the receipt digest.
-- Additive and idempotent, rollback in rollback/154_*.down.sql.
CREATE TABLE IF NOT EXISTS otk_projects (
  tenant_id   TEXT        NOT NULL,
  project_id  TEXT        NOT NULL,
  label       TEXT,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id)
);
CREATE TABLE IF NOT EXISTS otk_applications (
  tenant_id       TEXT        NOT NULL,
  application_id  TEXT        NOT NULL,
  label           TEXT,
  active          BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, application_id)
);
CREATE TABLE IF NOT EXISTS otk_operation_attribution (
  tenant_id       TEXT        NOT NULL,
  operation_id    TEXT        NOT NULL,
  schema          TEXT        NOT NULL DEFAULT 'otk.attribution.v1',
  project_id      TEXT,
  application_id  TEXT,
  task_type       TEXT,
  task_run_id     TEXT,
  team_id         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
CREATE INDEX IF NOT EXISTS otk_operation_attribution_project_idx ON otk_operation_attribution (tenant_id, project_id);
CREATE INDEX IF NOT EXISTS otk_operation_attribution_task_run_idx ON otk_operation_attribution (tenant_id, task_run_id);
CREATE TABLE IF NOT EXISTS otk_attribution_statements (
  tenant_id     TEXT        NOT NULL,
  operation_id  TEXT        NOT NULL,
  digest        TEXT        NOT NULL,
  statement     JSONB       NOT NULL,
  envelope      JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
`,
  },
  {
    version: '155_d1d8_erasure_tombstones',
    sql: `-- D1-D8 / OVERNIGHT 20261005 (Phase 4): erasure tombstones. One row per erased operation, written in the same
-- transaction that removes its private material; keeps the identity (tenant, operation id, request digest) so a
-- retry of an erased operation is answered "erased" and never re-admitted (no second paid call). The pseudonym is
-- what the kept ledger rows now carry instead of the operation id. Additive and idempotent, rollback in
-- rollback/155_*.down.sql.
CREATE TABLE IF NOT EXISTS otk_erasure_tombstones (
  tenant_id               TEXT        NOT NULL,
  operation_id            TEXT        NOT NULL,
  request_digest          TEXT        NOT NULL,
  request_digest_version  TEXT,
  ledger_pseudonym        TEXT        NOT NULL,
  reason                  TEXT        NOT NULL,
  policy_version          TEXT        NOT NULL,
  erased_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
`,
  },
]);

/** Minimal pool surface used by every D1–D8 store (node-postgres Pool satisfies it). */
export interface PgQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}
/** A client checked out of a pool (for transactions); must be released. */
export interface PgClientLike extends PgQueryable { release(err?: Error | boolean): void }
/** A pool that can also hand out a dedicated client for a transaction. */
export interface PgPoolLike extends PgQueryable { connect(): Promise<PgClientLike> }

/** Every relation (table or index) the DDL above creates; kept equal to it by a unit test. */
export const D1D8_RELATIONS: readonly string[] = Object.freeze([
  'otk_operations', 'otk_operations_incomplete_idx', 'otk_quota_usage', 'otk_money_budget', 'otk_money_budget_tenant_idx',
  'otk_ledger', 'otk_ledger_epoch_idx', 'otk_outbox', 'otk_outbox_claim_idx', 'otk_outbox_op_idx', 'otk_openings',
  'otk_receipts_v3', 'otk_conferences',
  // S4 (ABC-03/04)
  'otk_money_budget_members', 'otk_money_budget_members_tenant_idx', 'otk_money_ledger',
  // fechamento pós-S5
  'otk_operations_open_money_idx',
  'otk_operations_price_due_idx',
  // OVERNIGHT 20261005 (Phase 7)
  'otk_projects', 'otk_applications', 'otk_operation_attribution', 'otk_operation_attribution_project_idx',
  'otk_operation_attribution_task_run_idx', 'otk_attribution_statements',
  // OVERNIGHT 20261005 (Phase 4)
  'otk_erasure_tombstones',
]);

/**
 * Columns added by column-only migrations (no new relation): the fast path of ensureD1D8Schema must
 * also see them, or a database created before the migration would never receive it.
 */
export const D1D8_COLUMNS: ReadonlyArray<{ table: string; column: string }> = Object.freeze([
  { table: 'otk_operations', column: 'request_digest_version' },
]);

/**
 * Apply the D1–D8 DDL idempotently, serialized across replicas that boot together.
 * Records the versions in otk_migrations when that table exists (same bookkeeping as
 * migrate.js), so a later migrate.js run skips them.
 *
 * When every relation already exists no DDL runs at all: `CREATE INDEX IF NOT EXISTS` still
 * takes a ShareLock on its table, and a replica booting while others settle operations deadlocked
 * with them (observed in d1d8_c_proxy_durable, 2026-10-01). DDL that does run gives up after
 * `lock_timeout` instead of queueing behind traffic.
 *
 * @param pool - PostgreSQL pool (needs DDL rights when the schema is incomplete).
 * @throws {Error} When a migration fails or a lock is not obtained within 10 s; the transaction is rolled back.
 */
export async function ensureD1D8Schema(pool: PgPoolLike): Promise<void> {
  const present = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])',
    [D1D8_RELATIONS],
  );
  const cols = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND (table_name || '.' || column_name) = ANY($1::text[])`,
    [D1D8_COLUMNS.map((c) => `${c.table}.${c.column}`)],
  );
  if (Number(present.rows[0]?.n ?? 0) === D1D8_RELATIONS.length && Number(cols.rows[0]?.n ?? 0) === D1D8_COLUMNS.length) return;
  const client = await pool.connect();
  const clientGuard = guardClient(client); // F-P2-01: a lost connection must not crash the process
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('otk_d1d8_schema'))");
    for (const m of D1D8_MIGRATIONS) await client.query(m.sql);
    const tracked = await client.query<{ t: string | null }>("SELECT to_regclass('public.otk_migrations') AS t");
    if (tracked.rows[0]?.t != null) {
      for (const m of D1D8_MIGRATIONS) {
        await client.query(
          'INSERT INTO otk_migrations (version, filename) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
          [m.version, `${m.version}.sql`],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    clientGuard.release();
  }
}
