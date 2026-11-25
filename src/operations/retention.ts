/**
 * D1–D8 / OVERNIGHT 20261005 (Phase 4) — retention and erasure of v3 data, and how a restore respects erasures.
 *
 * What erasing ONE operation does (eraseOperation), in one transaction, after a write-ahead journal entry:
 *   removed  : the commitment opening (secret: the commitment can no longer be re-opened; proofs already published
 *              keep verifying), the private receipt v3, its conference report, the attribution and its signed
 *              statement, the outbox rows, the operation row itself;
 *   kept     : the confirmed debits (otk_ledger, otk_money_ledger) with the operation id replaced by a pseudonym, so
 *              tenant totals and quota counters stay exact; public chain data (cannot be erased);
 *   added    : a tombstone with the request identity, so a retry of the erased id answers "erased" (HTTP 410) and is
 *              never admitted again (no second paid call, no second debit).
 * Refused  : operations that are not terminal or still carry exposure (held / held_uncertain / pending price): their
 *            reconciliation needs the record.
 *
 * Backups: a restore of a dump taken BEFORE an erasure brings the erased rows back. The ErasureJournal (append-only
 * JSONL, fsync, kept OUTSIDE the database backups) is replayed after any restore (reapplyErasures) and re-erases them.
 * Retention by age (runRetention) uses a policy whose periods are a decision of the author: the shipped default keeps
 * everything (RETENTION_POLICY_UNSET, BLOCKED_BY_BRUNO); tests pass explicit periods.
 *
 * Not covered here (documented limits): Redis projections (rebuildable from PostgreSQL; rebuild after a restore), the
 * local spool / intervention files and logs (per-instance files), and copies outside this database.
 *
 * Every function here DELETES or rewrites rows (irreversibly, except through a backup) and appends to the
 * journal file. Missing optional tables are skipped (checked with `to_regclass`).
 *
 * @module src/operations/retention
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { OperationKey } from '../types/d1d8/index.js';
import type { PgClientLike, PgPoolLike } from './schema.js';
import { legacyReceiptId } from './context.js';
import { guardClient } from '../infra/pg/clientGuard.js';

/** Retention periods by age; `null` periods mean "keep forever". */
export interface V3RetentionPolicy {
  /** Version label recorded in the journal and tombstones of each erasure. */
  policyVersion: string;
  /** Terminal, fully settled/released operations older than this are erased; null = keep. */
  operationsMaxAgeDays: number | null;
  /** Outbox rows already done older than this are deleted (operational only); null = keep. */
  outboxDoneMaxAgeDays: number | null;
}

/** Default: nothing is erased by age. The periods are the author's decision (04_DECISIONS_NEEDED DN-02). */
export const RETENTION_POLICY_UNSET: V3RetentionPolicy = Object.freeze({
  policyVersion: 'unset (BLOCKED_BY_BRUNO: retention periods not decided)',
  operationsMaxAgeDays: null,
  outboxDoneMaxAgeDays: null,
});

/** One line of the erasure journal (an erasure intent). */
export interface ErasureJournalEntry {
  v: 1;
  tenantId: string;
  operationId: string;
  /** Why it was erased (e.g. `retention_age`, or a reason given by the operator). */
  reason: string;
  policyVersion: string;
  /** ISO time the erasure was journalled. */
  requestedAt: string;
}

/** Append-only, fsync'ed erasure intent log. Must live outside the database and its backups. */
export class ErasureJournal {
  /**
   * Binds the journal to a file; nothing is read or written until used.
   *
   * @param file - JSONL path, outside the database backups.
   */
  constructor(readonly file: string) {}
  /**
   * Appends one entry and fsyncs it before returning.
   *
   * @param e - The entry without its version field.
   * @throws {Error} When the file cannot be opened, written or synced.
   */
  append(e: Omit<ErasureJournalEntry, 'v'>): void {
    const fd = openSync(this.file, 'a');
    try { appendFileSync(fd, JSON.stringify({ v: 1, ...e }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }
  /**
   * Reads every journalled entry, oldest first.
   *
   * @returns The entries; empty when the file does not exist.
   * @throws {SyntaxError} When a line is not valid JSON (a torn last line is not tolerated here).
   */
  entries(): ErasureJournalEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ErasureJournalEntry);
  }
}

/**
 * Pseudonym that replaces an erased operation id in the ledgers (deterministic, so a re-erasure matches).
 *
 * It is a hash of tenant and operation id, not a secret: anyone who knows both ids can recompute it.
 *
 * @param k - Tenant and operation id.
 * @returns `erased-` followed by the first 32 hex characters of SHA-256 of `tenant\noperation`.
 */
export const ledgerPseudonym = (k: OperationKey): string =>
  `erased-${createHash('sha256').update(`${k.tenantId}\n${k.operationId}`, 'utf8').digest('hex').slice(0, 32)}`;

/** Result of erasing one operation; `not_terminal` also covers operations with open exposure. */
export type EraseOutcome = 'erased' | 'already_erased' | 'not_found' | 'not_terminal';

const TERMINAL = new Set(['completed', 'cancelled', 'upstream_failed', 'process_lost']);

async function tx<T>(pool: PgPoolLike, fn: (c: PgClientLike) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  const cGuard = guardClient(c); // F-P2-01: a lost connection must not crash the process
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { cGuard.release(); }
}

function exposureOpenOf(st: string, moneyState: string | null): boolean {
  return !(st === 'settled' || st === 'released') || (moneyState !== null && moneyState !== 'settled' && moneyState !== 'released');
}

async function precheck(pool: PgPoolLike, key: OperationKey): Promise<'eligible' | EraseOutcome> {
  const r = await pool.query<{ execution: string; st: string; money_state: string | null }>(
    `SELECT execution, reservation->>'state' AS st, money->>'state' AS money_state FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2`, [key.tenantId, key.operationId]);
  const op = r.rows[0];
  if (!op) {
    const t = await pool.query('SELECT 1 FROM otk_erasure_tombstones WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId]);
    return (t.rowCount ?? 0) > 0 ? 'already_erased' : 'not_found';
  }
  return TERMINAL.has(op.execution) && !exposureOpenOf(op.st, op.money_state) ? 'eligible' : 'not_terminal';
}

const has = async (c: PgClientLike, rel: string) => ((await c.query<{ t: string | null }>('SELECT to_regclass($1)::text AS t', [rel])).rows[0]?.t ?? null) !== null;

/**
 * Erase one operation (see the module header). The journal entry is written first (write-ahead).
 *
 * @param pool - PostgreSQL pool.
 * @param key - Tenant and operation id.
 * @param o - Journal, reason, policy version, and `journalled: true` when replaying an existing journal entry
 *   (then nothing is appended).
 * @returns The outcome.
 * @throws {Error} Database or journal errors propagate; the transaction is rolled back.
 */
export async function eraseOperation(pool: PgPoolLike, key: OperationKey, o: { journal: ErasureJournal; reason: string; policyVersion: string; journalled?: boolean }): Promise<EraseOutcome> {
  if (!o.journalled) {
    // journal only what is eligible now (a refused erasure must not be re-applied later by a replay); the
    // transaction below re-checks under the row lock
    const pre = await precheck(pool, key);
    if (pre !== 'eligible') return pre;
    o.journal.append({ tenantId: key.tenantId, operationId: key.operationId, reason: o.reason, policyVersion: o.policyVersion, requestedAt: new Date().toISOString() });
  }
  return tx(pool, async (c) => {
    const r = await c.query<{ request_digest: string; request_digest_version: string | null; execution: string; st: string; money_state: string | null }>(
      `SELECT request_digest, request_digest_version, execution, reservation->>'state' AS st, money->>'state' AS money_state
         FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2 FOR UPDATE`, [key.tenantId, key.operationId]);
    const op = r.rows[0];
    if (!op) {
      const t = await c.query('SELECT 1 FROM otk_erasure_tombstones WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId]);
      return (t.rowCount ?? 0) > 0 ? 'already_erased' : 'not_found';
    }
    if (!TERMINAL.has(op.execution) || exposureOpenOf(op.st, op.money_state)) return 'not_terminal';
    const pseudo = ledgerPseudonym(key);
    await c.query(
      `INSERT INTO otk_erasure_tombstones (tenant_id, operation_id, request_digest, request_digest_version, ledger_pseudonym, reason, policy_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, operation_id) DO NOTHING`,
      [key.tenantId, key.operationId, op.request_digest, op.request_digest_version, pseudo, o.reason, o.policyVersion]);
    // confirmed debits stay (exact totals), without the operation id
    await c.query(`UPDATE otk_ledger SET operation_id = $3, effect_id = 'debit:' || $4 || ':' || $3 WHERE tenant_id = $1 AND operation_id = $2`,
      [key.tenantId, key.operationId, pseudo, encodeURIComponent(key.tenantId)]);
    await c.query('UPDATE otk_money_ledger SET operation_id = $3 WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId, pseudo]);
    for (const t of ['otk_attribution_statements', 'otk_operation_attribution', 'otk_conferences', 'otk_receipts_v3', 'otk_openings', 'otk_outbox']) {
      if (await has(c, t)) await c.query(`DELETE FROM ${t} WHERE tenant_id = $1 AND operation_id = $2`, [key.tenantId, key.operationId]);
    }
    // legacy-format rows of this operation (written only when the runtime had no v3 crypto ports)
    const legacyId = legacyReceiptId(key);
    if (await has(c, 'otk_proof_jobs')) await c.query('DELETE FROM otk_proof_jobs WHERE request_id = $1', [legacyId]);
    if (await has(c, 'otk_receipts')) await c.query('DELETE FROM otk_receipts WHERE request_id = $1', [legacyId]);
    await c.query('DELETE FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2', [key.tenantId, key.operationId]);
    return 'erased';
  });
}

/**
 * After a restore (or at startup): re-erase every journalled operation the database still holds. Idempotent.
 *
 * @param pool - PostgreSQL pool.
 * @param journal - The erasure journal.
 * @returns Counts of re-erased and already-erased operations, and the entries refused (with their outcome).
 * @throws {Error} When the journal cannot be read or a database call fails.
 */
export async function reapplyErasures(pool: PgPoolLike, journal: ErasureJournal): Promise<{ reapplied: number; alreadyErased: number; refused: Array<{ key: OperationKey; outcome: EraseOutcome }> }> {
  let reapplied = 0; let alreadyErased = 0; const refused: Array<{ key: OperationKey; outcome: EraseOutcome }> = [];
  for (const e of journal.entries()) {
    const key = { tenantId: e.tenantId, operationId: e.operationId };
    const out = await eraseOperation(pool, key, { journal, reason: e.reason, policyVersion: e.policyVersion, journalled: true });
    if (out === 'erased') reapplied++;
    else if (out === 'already_erased') alreadyErased++;
    else refused.push({ key, outcome: out });
  }
  return { reapplied, alreadyErased, refused };
}

/**
 * Age-based retention. With RETENTION_POLICY_UNSET it does nothing.
 *
 * Erases at most 1000 operations per call (oldest `updated_at` first); call again for more.
 *
 * @param pool - PostgreSQL pool.
 * @param policy - Retention periods.
 * @param journal - Erasure journal (each erasure is journalled first).
 * @param now - Reference time for the cut-offs.
 * @returns Counts of erased operations, candidates skipped as not terminal, and deleted done outbox rows.
 * @throws {Error} Database or journal errors propagate.
 */
export async function runRetention(pool: PgPoolLike, policy: V3RetentionPolicy, journal: ErasureJournal, now: Date = new Date()):
  Promise<{ erased: number; skippedNotTerminal: number; outboxDeleted: number }> {
  let erased = 0; let skippedNotTerminal = 0; let outboxDeleted = 0;
  if (policy.operationsMaxAgeDays !== null) {
    const cutoff = new Date(now.getTime() - policy.operationsMaxAgeDays * 86_400_000).toISOString();
    const cands = await pool.query<{ tenant_id: string; operation_id: string }>(
      `SELECT tenant_id, operation_id FROM otk_operations WHERE updated_at <= $1::timestamptz ORDER BY updated_at LIMIT 1000`, [cutoff]);
    for (const r of cands.rows) {
      const out = await eraseOperation(pool, { tenantId: r.tenant_id, operationId: r.operation_id }, { journal, reason: 'retention_age', policyVersion: policy.policyVersion });
      if (out === 'erased') erased++; else if (out === 'not_terminal') skippedNotTerminal++;
    }
  }
  if (policy.outboxDoneMaxAgeDays !== null) {
    const cutoff = new Date(now.getTime() - policy.outboxDoneMaxAgeDays * 86_400_000).toISOString();
    const d = await pool.query(`DELETE FROM otk_outbox WHERE state = 'done' AND done_at <= $1::timestamptz`, [cutoff]);
    outboxDeleted = d.rowCount ?? 0;
  }
  return { erased, skippedNotTerminal, outboxDeleted };
}
