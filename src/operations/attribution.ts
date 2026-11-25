/**
 * D1–D8 / OVERNIGHT 20261005 (Phase 7) — attribution of operations to projects and tasks (private, off-chain).
 *
 * Who decides what: the tenant comes from the credential; the request may name a project/application that the
 * tenant registered beforehand (otk_projects/otk_applications), a task type and a task run. The attribution is
 * checked and written in the SAME transaction that admits the operation (no admitted operation can lose it, no
 * attribution exists without its operation). It is part of the request identity: a retry with another
 * attribution is a conflict, never a re-attribution.
 *
 * Totals: the canonical CU total is the ledger (otk_ledger) of the tenant; money is the confirmed amount on the
 * operation's money axis (otk_operations.money, one value per operation even when several budgets hold it). The
 * summary groups those same rows by project; operations without attribution (and legacy receipts without an
 * operation) form "unattributed". Applications and task types are other DIMENSIONS of the same rows: their
 * totals are never added to the project totals.
 *
 * Used by the admission transaction in `PgOperationStore.ts` (read/check/insert helpers ending in `Tx`) and by
 * the tenant routes in `attributionRoutes.ts` ({@link PgAttributionStore}). Amounts returned are bigint: CU in
 * micro-CU (scale 10^6) and money in pico-USD (scale 10^12).
 *
 * @module src/operations/attribution
 */
import type { OperationAttribution, OperationKey } from '../types/d1d8/index.js';
import type { PgPoolLike, PgQueryable } from './schema.js';

/** Allowed format of project/application ids and task labels: 1 to 128 of letters, digits, `.`, `_`, `:`, `-`. */
export const ATTRIBUTION_LABEL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The "no attribution" value: every field `null` (frozen; copy before changing). */
export const EMPTY_ATTRIBUTION: OperationAttribution = Object.freeze({ projectId: null, applicationId: null, taskType: null, taskRunId: null, teamId: null });

/** Request header name for each attribution field (lower case). The team id never comes from a header. */
export const HEADERS = Object.freeze({
  projectId: 'x-otk-project',
  applicationId: 'x-otk-application',
  taskType: 'x-otk-task-type',
  taskRunId: 'x-otk-task-run',
} as const);

/**
 * Whether an attribution names nothing at all.
 *
 * @param a - Attribution, or `null`/`undefined` (treated as unattributed).
 * @returns `true` when every field is `null` or the value is absent.
 */
export function isUnattributed(a: OperationAttribution | null | undefined): boolean {
  return !a || (a.projectId === null && a.applicationId === null && a.taskType === null && a.taskRunId === null && a.teamId === null);
}

/**
 * Field-by-field equality of two attributions; absent values compare as {@link EMPTY_ATTRIBUTION}.
 *
 * @param a - First attribution.
 * @param b - Second attribution.
 * @returns `true` when all five fields are equal.
 */
export function sameAttribution(a: OperationAttribution | null | undefined, b: OperationAttribution | null | undefined): boolean {
  const x = a ?? EMPTY_ATTRIBUTION; const y = b ?? EMPTY_ATTRIBUTION;
  return x.projectId === y.projectId && x.applicationId === y.applicationId && x.taskType === y.taskType && x.taskRunId === y.taskRunId && x.teamId === y.teamId;
}

/**
 * Attribution named by request headers (format only; registration is checked at admission). A header present
 * with an invalid value is an error, not "absent": a typo must not silently become unattributed.
 *
 * Values are trimmed; a repeated header is refused.
 *
 * @param headers - Incoming request headers (lower-case names, as Node delivers them).
 * @param teamId - Team id decided by the caller's credential, copied as is.
 * @returns `{ ok: true, attribution }`, or `{ ok: false, detail }` naming the bad header.
 */
export function attributionFromHeaders(headers: Record<string, string | string[] | undefined>, teamId: string | null = null):
  { ok: true; attribution: OperationAttribution } | { ok: false; detail: string } {
  const out: OperationAttribution = { ...EMPTY_ATTRIBUTION, teamId };
  for (const [field, header] of Object.entries(HEADERS) as Array<[keyof typeof HEADERS, string]>) {
    const raw = headers[header];
    if (raw === undefined) continue;
    const v = Array.isArray(raw) ? raw : [raw];
    if (v.length !== 1 || !ATTRIBUTION_LABEL_RE.test(v[0]!.trim())) return { ok: false, detail: `${header} must be one label matching ${ATTRIBUTION_LABEL_RE.source}` };
    out[field] = v[0]!.trim();
  }
  return { ok: true, attribution: out };
}

interface AttributionRow { project_id: string | null; application_id: string | null; task_type: string | null; task_run_id: string | null; team_id: string | null }
const fromRow = (r: AttributionRow | undefined): OperationAttribution => r
  ? { projectId: r.project_id, applicationId: r.application_id, taskType: r.task_type, taskRunId: r.task_run_id, teamId: r.team_id }
  : { ...EMPTY_ATTRIBUTION };

/**
 * Inside the admission transaction: the attribution of an existing operation (all-null when none).
 *
 * @param c - The open transaction client.
 * @param key - Tenant and operation id.
 * @returns The stored attribution, or an all-null one.
 */
export async function readAttributionTx(c: PgQueryable, key: OperationKey): Promise<OperationAttribution> {
  const r = await c.query<AttributionRow & Record<string, unknown>>('SELECT project_id, application_id, task_type, task_run_id, team_id FROM otk_operation_attribution WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId]);
  return fromRow(r.rows[0]);
}

/**
 * Inside the admission transaction: registered and active for THIS tenant (row-locked against deactivation).
 *
 * @param c - The open transaction client.
 * @param tenantId - The tenant from the credential.
 * @param a - The requested attribution.
 * @returns `null` when every named project/application is registered and active, else which one is unknown.
 */
export async function checkRegisteredTx(c: PgQueryable, tenantId: string, a: OperationAttribution): Promise<null | 'project_unknown' | 'application_unknown'> {
  if (a.projectId !== null) {
    const p = await c.query('SELECT 1 FROM otk_projects WHERE tenant_id = $1 AND project_id = $2 AND active FOR SHARE', [tenantId, a.projectId]);
    if ((p.rowCount ?? 0) !== 1) return 'project_unknown';
  }
  if (a.applicationId !== null) {
    const p = await c.query('SELECT 1 FROM otk_applications WHERE tenant_id = $1 AND application_id = $2 AND active FOR SHARE', [tenantId, a.applicationId]);
    if ((p.rowCount ?? 0) !== 1) return 'application_unknown';
  }
  return null;
}

/**
 * Inside the admission transaction: stores the attribution of a newly admitted operation.
 *
 * @param c - The open transaction client.
 * @param key - Tenant and operation id.
 * @param a - The attribution (already checked).
 * @throws {Error} Database errors, including a unique violation if the operation already has one.
 */
export async function insertAttributionTx(c: PgQueryable, key: OperationKey, a: OperationAttribution): Promise<void> {
  await c.query(
    'INSERT INTO otk_operation_attribution (tenant_id, operation_id, project_id, application_id, task_type, task_run_id, team_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [key.tenantId, key.operationId, a.projectId, a.applicationId, a.taskType, a.taskRunId, a.teamId],
  );
}

/** Totals of one group: distinct operations, CU (micro-CU) and confirmed money (pico-USD). */
export interface AttributionTotals { operations: number; cuUnits: bigint; moneyConfirmedUnits: bigint }
/** Result of {@link PgAttributionStore.summary}: per-project totals checked against the canonical totals. */
export interface AttributionSummary {
  tenantId: string;
  /** The epoch summarized, or `null` for all epochs. */
  epochId: string | null;
  /** Always 10^6 (micro-CU). */
  cuScale: bigint;
  /** Always 10^12 (pico-USD). */
  moneyScale: bigint;
  /** One entry per project id, sorted by id. */
  byProject: Array<{ projectId: string } & AttributionTotals>;
  /** Operations without attribution plus legacy ledger rows that have no operation. */
  unattributed: AttributionTotals & { legacyLedgerRows: number };
  /** Canonical totals computed independently of the attribution join. */
  canonical: { ledgerRows: number; cuUnits: bigint; moneyConfirmedUnits: bigint };
  /** SUM(byProject) + unattributed == canonical, for CU and for money. */
  invariant: { cu: boolean; money: boolean };
  /** Other dimensions of the SAME rows: not additive with byProject. */
  byApplication: Array<{ applicationId: string | null } & AttributionTotals>;
  byTaskType: Array<{ taskType: string | null } & AttributionTotals>;
}

// A SQL sum over no rows is NULL; here it means a zero total (not "unknown").
const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt(String(v)));

/** Tenant-scoped storage of projects, applications, attribution statements and attribution reports. */
export class PgAttributionStore {
  /**
   * Binds the store to a database pool.
   *
   * @param pool - PostgreSQL pool.
   */
  constructor(private readonly pool: PgPoolLike) {}

  /**
   * Registers a project for the tenant, or re-activates it; a `null` label keeps the stored one.
   *
   * @param tenantId - The tenant from the credential.
   * @param projectId - Project id matching {@link ATTRIBUTION_LABEL_RE}.
   * @param label - Optional private label.
   * @throws {RangeError} When the id has an invalid format.
   */
  async registerProject(tenantId: string, projectId: string, label: string | null = null): Promise<void> {
    if (!ATTRIBUTION_LABEL_RE.test(projectId)) throw new RangeError('invalid project id');
    await this.pool.query('INSERT INTO otk_projects (tenant_id, project_id, label) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, project_id) DO UPDATE SET label = COALESCE(EXCLUDED.label, otk_projects.label), active = true', [tenantId, projectId, label]);
  }

  /**
   * Registers an application for the tenant, or re-activates it; a `null` label keeps the stored one.
   *
   * @param tenantId - The tenant from the credential.
   * @param applicationId - Application id matching {@link ATTRIBUTION_LABEL_RE}.
   * @param label - Optional private label.
   * @throws {RangeError} When the id has an invalid format.
   */
  async registerApplication(tenantId: string, applicationId: string, label: string | null = null): Promise<void> {
    if (!ATTRIBUTION_LABEL_RE.test(applicationId)) throw new RangeError('invalid application id');
    await this.pool.query('INSERT INTO otk_applications (tenant_id, application_id, label) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, application_id) DO UPDATE SET label = COALESCE(EXCLUDED.label, otk_applications.label), active = true', [tenantId, applicationId, label]);
  }

  /**
   * Deactivates a project: new admissions naming it are refused; past attributions are kept.
   *
   * @param tenantId - The tenant.
   * @param projectId - The project id.
   */
  async deactivateProject(tenantId: string, projectId: string): Promise<void> {
    await this.pool.query('UPDATE otk_projects SET active = false WHERE tenant_id = $1 AND project_id = $2', [tenantId, projectId]);
  }

  /**
   * Reads the attribution of one operation.
   *
   * @param key - Tenant and operation id.
   * @returns The attribution, or `null` when the operation has none.
   */
  async get(key: OperationKey): Promise<OperationAttribution | null> {
    const r = await this.pool.query<AttributionRow & Record<string, unknown>>('SELECT project_id, application_id, task_type, task_run_id, team_id FROM otk_operation_attribution WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId]);
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }

  /**
   * Stores the signed attribution statement of an operation once.
   *
   * @param key - Tenant and operation id.
   * @param digest - Digest of the statement.
   * @param statement - The statement, stored as JSON.
   * @param envelope - Its signed envelope, stored as JSON.
   * @returns `'stored'` on first write; `'same'` or `'different'` when one already exists (compared by digest).
   */
  async putStatement(key: OperationKey, digest: string, statement: unknown, envelope: unknown): Promise<'stored' | 'same' | 'different'> {
    const ins = await this.pool.query(
      'INSERT INTO otk_attribution_statements (tenant_id, operation_id, digest, statement, envelope) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) ON CONFLICT (tenant_id, operation_id) DO NOTHING',
      [key.tenantId, key.operationId, digest, JSON.stringify(statement), JSON.stringify(envelope)],
    );
    if ((ins.rowCount ?? 0) === 1) return 'stored';
    const cur = await this.pool.query<{ d: string }>('SELECT digest AS d FROM otk_attribution_statements WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId]);
    return cur.rows[0]?.d === digest ? 'same' : 'different';
  }

  /**
   * Reads the signed attribution statement of an operation.
   *
   * @param key - Tenant and operation id.
   * @returns Digest, statement and envelope, or `null` when none is stored.
   */
  async getStatement(key: OperationKey): Promise<{ digest: string; statement: unknown; envelope: unknown } | null> {
    const r = await this.pool.query<{ digest: string; statement: unknown; envelope: unknown }>('SELECT digest, statement, envelope FROM otk_attribution_statements WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId]);
    return r.rows[0] ?? null;
  }

  /**
   * Tenant-scoped totals; epochId null = every epoch.
   *
   * Read-only; runs several separate queries (not one snapshot), so concurrent writes can make the
   * invariant flags false for that one call.
   *
   * @param tenantId - The tenant.
   * @param epochId - Quota epoch, or `null` for all.
   * @returns The summary with its invariant check.
   */
  async summary(tenantId: string, epochId: string | null): Promise<AttributionSummary> {
    const p = [tenantId, epochId];
    const epochL = '($2::text IS NULL OR l.epoch_id = $2)';
    const epochO = '($2::text IS NULL OR o.epoch_id = $2)';
    // canonical, without any join to attribution
    const canonCu = await this.pool.query<{ n: string; u: string | null }>(`SELECT count(*)::text AS n, sum(l.units)::text AS u FROM otk_ledger l WHERE l.tenant_id = $1 AND ${epochL}`, p);
    const canonMoney = await this.pool.query<{ m: string | null }>(`SELECT sum((o.money->'confirmed'->>'units')::numeric)::text AS m FROM otk_operations o WHERE o.tenant_id = $1 AND ${epochO} AND o.money->'confirmed' IS NOT NULL AND o.money->'confirmed' <> 'null'::jsonb`, p);
    // per ledger row: its operation's attribution (none for legacy rows and unattributed operations)
    const rows = await this.pool.query<{ project_id: string | null; application_id: string | null; task_type: string | null; legacy: boolean; ops: string; cu: string | null }>(
      `SELECT a.project_id, a.application_id, a.task_type, (l.operation_id IS NULL) AS legacy,
              count(DISTINCT l.operation_id)::text AS ops, sum(l.units)::text AS cu
         FROM otk_ledger l
         LEFT JOIN otk_operation_attribution a ON a.tenant_id = l.tenant_id AND a.operation_id = l.operation_id
        WHERE l.tenant_id = $1 AND ${epochL}
        GROUP BY a.project_id, a.application_id, a.task_type, (l.operation_id IS NULL)`, p);
    const money = await this.pool.query<{ project_id: string | null; application_id: string | null; task_type: string | null; m: string | null }>(
      `SELECT a.project_id, a.application_id, a.task_type, sum((o.money->'confirmed'->>'units')::numeric)::text AS m
         FROM otk_operations o
         LEFT JOIN otk_operation_attribution a ON a.tenant_id = o.tenant_id AND a.operation_id = o.operation_id
        WHERE o.tenant_id = $1 AND ${epochO} AND o.money->'confirmed' IS NOT NULL AND o.money->'confirmed' <> 'null'::jsonb
        GROUP BY a.project_id, a.application_id, a.task_type`, p);

    const add = (m: Map<string | null, AttributionTotals>, k: string | null, ops: number, cu: bigint, mon: bigint) => {
      const t = m.get(k) ?? { operations: 0, cuUnits: 0n, moneyConfirmedUnits: 0n };
      t.operations += ops; t.cuUnits += cu; t.moneyConfirmedUnits += mon; m.set(k, t);
    };
    const byProject = new Map<string | null, AttributionTotals>();
    const byApp = new Map<string | null, AttributionTotals>();
    const byTask = new Map<string | null, AttributionTotals>();
    for (const r of rows.rows) {
      const ops = r.legacy ? 0 : Number(r.ops);
      add(byProject, r.project_id, ops, big(r.cu), 0n);
      add(byApp, r.application_id, ops, big(r.cu), 0n);
      add(byTask, r.task_type, ops, big(r.cu), 0n);
    }
    for (const r of money.rows) {
      add(byProject, r.project_id, 0, 0n, big(r.m));
      add(byApp, r.application_id, 0, 0n, big(r.m));
      add(byTask, r.task_type, 0, 0n, big(r.m));
    }
    const legacyCount = await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM otk_ledger l WHERE l.tenant_id = $1 AND ${epochL} AND l.operation_id IS NULL`, p);
    const un = byProject.get(null) ?? { operations: 0, cuUnits: 0n, moneyConfirmedUnits: 0n };
    byProject.delete(null);
    const projects = [...byProject.entries()].map(([projectId, t]) => ({ projectId: projectId!, ...t })).sort((a, b) => a.projectId.localeCompare(b.projectId));
    const canonical = { ledgerRows: Number(canonCu.rows[0]!.n), cuUnits: big(canonCu.rows[0]!.u), moneyConfirmedUnits: big(canonMoney.rows[0]!.m) };
    const sumCu = projects.reduce((s, x) => s + x.cuUnits, 0n) + un.cuUnits;
    const sumMoney = projects.reduce((s, x) => s + x.moneyConfirmedUnits, 0n) + un.moneyConfirmedUnits;
    return {
      tenantId, epochId, cuScale: 1_000_000n, moneyScale: 1_000_000_000_000n,
      byProject: projects,
      unattributed: { ...un, legacyLedgerRows: Number(legacyCount.rows[0]!.n) },
      canonical,
      invariant: { cu: sumCu === canonical.cuUnits, money: sumMoney === canonical.moneyConfirmedUnits },
      byApplication: [...byApp.entries()].map(([applicationId, t]) => ({ applicationId, ...t })),
      byTaskType: [...byTask.entries()].map(([taskType, t]) => ({ taskType, ...t })),
    };
  }

  /**
   * Tenant-scoped export: one row per operation of the ledger, with attribution and the signed statement.
   *
   * Legacy ledger rows without an operation are not exported.
   *
   * @param tenantId - The tenant.
   * @param epochId - Quota epoch, or `null` for all.
   * @param projectId - Optional project filter.
   * @returns Rows ordered by operation id; `attribution` is `null` for unattributed operations.
   */
  async exportRows(tenantId: string, epochId: string | null, projectId?: string): Promise<Array<{ operationId: string; cuUnits: bigint; attribution: OperationAttribution | null; statement: unknown; envelope: unknown; statementDigest: string | null }>> {
    const r = await this.pool.query<{ operation_id: string; cu: string; project_id: string | null; application_id: string | null; task_type: string | null; task_run_id: string | null; team_id: string | null; has: boolean; digest: string | null; statement: unknown; envelope: unknown }>(
      `SELECT l.operation_id, sum(l.units)::text AS cu, a.project_id, a.application_id, a.task_type, a.task_run_id, a.team_id,
              (a.operation_id IS NOT NULL) AS has, s.digest, s.statement, s.envelope
         FROM otk_ledger l
         LEFT JOIN otk_operation_attribution a ON a.tenant_id = l.tenant_id AND a.operation_id = l.operation_id
         LEFT JOIN otk_attribution_statements s ON s.tenant_id = l.tenant_id AND s.operation_id = l.operation_id
        WHERE l.tenant_id = $1 AND l.operation_id IS NOT NULL AND ($2::text IS NULL OR l.epoch_id = $2)
          AND ($3::text IS NULL OR a.project_id = $3)
        GROUP BY l.operation_id, a.operation_id, a.project_id, a.application_id, a.task_type, a.task_run_id, a.team_id, s.digest, s.statement, s.envelope
        ORDER BY l.operation_id`, [tenantId, epochId, projectId ?? null]);
    return r.rows.map((x) => ({
      operationId: x.operation_id, cuUnits: big(x.cu),
      attribution: x.has ? fromRow(x) : null,
      statement: x.statement ?? null, envelope: x.envelope ?? null, statementDigest: x.digest,
    }));
  }
}
