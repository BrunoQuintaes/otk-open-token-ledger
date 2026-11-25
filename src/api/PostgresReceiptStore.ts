/**
 * PA-07B — PostgresReceiptStore
 *
 * Provides Postgres-backed durable receipt storage.
 * Used as write-behind from receiptStore.ts when OTK_DB_URL is set.
 *
 * Architecture: write-behind cache pattern.
 *   - in-memory Map in receiptStore.ts is the authoritative read source
 *   - Postgres is the durable backup (restored into Map on startup)
 *   - All writes to the Map are also async-written to Postgres
 *   - If Postgres write fails: non-critical (receipt already in Map/JSONL)
 *
 * Schema: see scripts/ops/pa07_migration.sql
 *
 * Also owns the transactional "durable write" path (`storeDurable`): in one PostgreSQL transaction it checks
 * the tenant's quota, inserts the receipt, writes its ledger debit and enqueues its outbox effects
 * (`src/operations/ledger.ts`, `src/operations/PgEffectOutbox.ts`). Tables: `otk_receipts`,
 * `otk_proof_jobs` (created by `init`), plus the ledger/quota/outbox tables from `src/operations/schema.ts`.
 *
 * Configuration: the connection string is passed by the caller (`src/api/receiptStore.ts` reads `OTK_DB_URL`);
 * this file reads no environment variable. It does NOT decide quotas or prices: the caller passes the
 * receipt's units and the quota.
 *
 * @since PA-07 (2026-03-13)
 * @module src/api/PostgresReceiptStore
 */

import { Pool, type PoolConfig } from 'pg';
import type { RawReceipt } from '../types/receipt.js';
import { ensureD1D8Schema } from '../operations/schema.js';
import { admitByQuota } from '../operations/accounting.js';
import { addQuota, insertLedger, ledgerTotal, lockQuotaRow, rebuildQuotaRow } from '../operations/ledger.js';
import { enqueueTx, PgEffectOutbox } from '../operations/PgEffectOutbox.js';
import { effectId, payloadDigest } from '../operations/ids.js';
import { guardClient } from '../infra/pg/clientGuard.js';

/** Options of the transactional durable write (RV30-02/03/05). */
export interface DurableWriteOptions {
  /** Quota epoch of the receipt (String(deriveEpoch(timestamp))). */
  epochId: string;
  /** This receipt's CU in accounting units (micro-CU). */
  units: bigint;
  /** Quota in accounting units: null = no hard limit; undefined = do not check (internal callers). */
  quota?: bigint | null;
  /** Write the enqueue_proof effect (false when the prover is disabled). */
  enqueueProof: boolean;
}

/**
 * Outcome of `storeDurable`: stored, already present for the same tenant, already present for another tenant,
 * or refused because the tenant's quota would be exceeded (`quota` and `current` in accounting units, micro-CU).
 */
export type DurableWriteResult =
  | { outcome: 'inserted' }
  | { outcome: 'duplicate' }
  | { outcome: 'tenant_mismatch' }
  | { outcome: 'quota_exceeded'; quota: bigint; current: bigint };

/**
 * Legacy receipts have no operation id: their outbox key is (tenant, 'rcpt:' + requestId), a
 * namespace operations never use (review M3: a receipt X and an operation X of the same tenant
 * used to share effect ids, and the second projection was silently dropped).
 *
 * @param tenantId - Tenant of the receipt.
 * @param requestId - The receipt's requestId.
 * @returns The outbox key `{ tenantId, operationId: 'rcpt:<requestId>' }`.
 */
export const legacyKey = (tenantId: string, requestId: string) => ({ tenantId, operationId: `rcpt:${requestId}` });

/** Prefix of receipt ids written for durable operations; clients may not use it (review MEDIUM-4). */
export const OPERATION_RECEIPT_PREFIX = 'op:';

/** Serializable form of RawReceipt (bigint → string) stored in Postgres JSONB column */
interface ReceiptRow {
  request_id: string;
  receipt_json: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUnits: number;
    latencyMs: number;
    timestamp: number;
    requestId: string;
    userId: string;
    nonce: string;
    tenantId?: string;
    cwVersion?: string;
  };
  created_at: Date;
}

/**
 * PostgreSQL-backed receipt store with its own connection pool (max 5 connections, 5 s connect timeout,
 * overridable through `poolConfig`).
 *
 * Constructing it opens no connection; call `init()` before use and `close()` on shutdown.
 */
export class PostgresReceiptStore {
  private readonly pool: Pool;

  constructor(connectionString: string, poolConfig?: Partial<PoolConfig>) {
    this.pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000, ...poolConfig });
    // N12: an idle client error (e.g. PostgreSQL restarted) is emitted on the pool; without
    // a listener Node treats it as unhandled and the whole API process exits.
    this.pool.on('error', (err: Error) => {
      process.stderr.write(JSON.stringify({ event: 'pg_pool_idle_error', pool: 'receipts', error: err.message, ts: Date.now() }) + '\n');
    });
  }

  /**
   * Create the receipts table if it does not exist.
   * Idempotent — safe to call on every startup.
   */
  async init(): Promise<void> {
    // D1–D8: ledger, quota counters and outbox used by storeDurable() (idempotent DDL)
    await ensureD1D8Schema(this.pool);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS otk_receipts (
        request_id  TEXT PRIMARY KEY,
        receipt_json JSONB NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // N14: receipt → proof job correlation. Created in one transaction under an advisory lock
    // (replicas may boot together); receipts stored before the table existed are marked
    // 'legacy-unknown' in the same statement, so they are never re-sent for proving.
    const client = await this.pool.connect();
    const clientGuard = guardClient(client); // F-P2-01: a lost connection must not crash the process
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('otk_proof_jobs_init'))");
      const existed = await client.query<{ t: string | null }>("SELECT to_regclass('public.otk_proof_jobs') AS t");
      if (existed.rows[0]?.t == null) {
        await client.query(`
          CREATE TABLE otk_proof_jobs (
            request_id  TEXT PRIMARY KEY,
            job_id      TEXT NOT NULL,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        const marked = await client.query(
          `INSERT INTO otk_proof_jobs (request_id, job_id)
           SELECT request_id, 'legacy-unknown' FROM otk_receipts ON CONFLICT DO NOTHING`,
        );
        this.legacyMarked = marked.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      clientGuard.release();
    }
  }

  /** Receipts marked 'legacy-unknown' when init() created the proof-job table. */
  legacyMarked = 0;

  /**
   * Record (or replace) the proof job accepted for a receipt.
   *
   * @param requestId - The receipt's requestId.
   * @param jobId - Prover job id returned when the proof was accepted.
   */
  async setProofJob(requestId: string, jobId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO otk_proof_jobs (request_id, job_id) VALUES ($1, $2)
       ON CONFLICT (request_id) DO UPDATE SET job_id = EXCLUDED.job_id, updated_at = now()`,
      [requestId, jobId],
    );
  }

  /**
   * Proof job recorded for one receipt (any instance may have recorded it).
   *
   * @param requestId - The receipt's requestId.
   * @returns The job id, or `undefined` when none is recorded.
   */
  async getProofJob(requestId: string): Promise<string | undefined> {
    const r = await this.pool.query<{ job_id: string }>('SELECT job_id FROM otk_proof_jobs WHERE request_id = $1', [requestId]);
    return r.rows[0]?.job_id;
  }

  /**
   * RV30-02/03/05 — one transaction: lock the (tenant, epoch) quota row, answer an existing
   * requestId as duplicate (or tenant_mismatch), apply check_before_crossing_admitted@1, insert
   * the receipt, its ledger debit (identity receipt:<requestId>) and its outbox effects
   * (project_redis, enqueue_proof). If the commit lands after the caller stopped waiting, the
   * effects still exist and any instance runs them; the counters are already right.
   *
   * @param receipt - The receipt to store; `tenantId` absent means tenant `'default'`.
   * @param opts - Epoch, units and quota of this write, and whether to enqueue a proof.
   * @returns The outcome; a duplicate or tenant mismatch changes nothing.
   * @throws {Error} Database errors other than a unique-key race on the same requestId (the transaction is
   *   rolled back first).
   */
  async storeDurable(receipt: RawReceipt, opts: DurableWriteOptions): Promise<DurableWriteResult> {
    const tenantId = receipt.tenantId ?? 'default';
    const client = await this.pool.connect();
    const clientGuard = guardClient(client); // F-P2-01: a lost connection must not crash the process
    try {
      await client.query('BEGIN');
      const q = await lockQuotaRow(client, tenantId, opts.epochId);
      const existing = await client.query<{ tenant: string | null }>(
        "SELECT receipt_json->>'tenantId' AS tenant FROM otk_receipts WHERE request_id = $1", [receipt.requestId]);
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return (existing.rows[0].tenant ?? 'default') === tenantId ? { outcome: 'duplicate' } : { outcome: 'tenant_mismatch' };
      }
      if (opts.quota !== undefined && !admitByQuota(q.confirmed, q.held, opts.quota)) {
        await client.query('ROLLBACK');
        return { outcome: 'quota_exceeded', quota: opts.quota ?? 0n, current: q.confirmed + q.held };
      }
      const serialized = { ...receipt, userId: String(receipt.userId), nonce: String(receipt.nonce) };
      await client.query(
        'INSERT INTO otk_receipts (request_id, receipt_json) VALUES ($1, $2::jsonb)',
        [receipt.requestId, JSON.stringify(serialized)],
      );
      const key = legacyKey(tenantId, receipt.requestId);
      const fresh = await insertLedger(client, { tenantId, effectId: `receipt:${encodeURIComponent(receipt.requestId)}`, epochId: opts.epochId, units: opts.units, source: 'legacy_receipt', operationId: null });
      // review L4: the identity was debited before and only the receipt row was flushed
      // (flushAll/flushBatch): keep the single debit, store the row again
      if (fresh) await addQuota(client, tenantId, opts.epochId, opts.units, 0n);
      const projection = { requestId: receipt.requestId, epochId: opts.epochId, cu: String(receipt.costUnits), provider: receipt.provider, model: receipt.model, ts: receipt.timestamp * 1000 };
      await enqueueTx(client, { schema: 'otk.outbox_effect.v1', effectId: effectId('project_redis', key), key, kind: 'project_redis', payloadDigest: payloadDigest(projection), target: null, payload: projection });
      if (opts.enqueueProof) {
        const ref = { requestId: receipt.requestId };
        // legacy jobs: the daemon freezes the registry when it creates the job (N15)
        await enqueueTx(client, { schema: 'otk.outbox_effect.v1', effectId: effectId('enqueue_proof', key), key, kind: 'enqueue_proof', payloadDigest: payloadDigest(ref), target: null, payload: ref });
      }
      await client.query('COMMIT');
      return { outcome: 'inserted' };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // a concurrent insert of the same requestId by another tenant (no shared lock row)
      if ((err as { code?: string }).code === '23505') {
        const cur = await this.get(receipt.requestId);
        if (cur) return (cur.tenantId ?? 'default') === tenantId ? { outcome: 'duplicate' } : { outcome: 'tenant_mismatch' };
      }
      throw err;
    } finally {
      clientGuard.release();
    }
  }

  /**
   * N14/RV30-03: give receipts that still lack a proof job a durable enqueue_proof effect
   * (idempotent: effectId per (tenant, requestId); an existing effect is left untouched).
   * Same set that N14 re-sent from memory after a restart; now any instance dispatches it.
   *
   * @param receipts - Receipts to cover (typically those restored without a proof job).
   * @returns Number of effects newly enqueued (existing ones are not counted).
   */
  async ensureProofEffects(receipts: RawReceipt[]): Promise<number> {
    let added = 0;
    for (const r of receipts) {
      const key = legacyKey(r.tenantId ?? 'default', r.requestId);
      const ref = { requestId: r.requestId };
      const res = await enqueueTx(this.pool, { schema: 'otk.outbox_effect.v1', effectId: effectId('enqueue_proof', key), key, kind: 'enqueue_proof', payloadDigest: payloadDigest(ref), target: null, payload: ref });
      if (res === 'enqueued') added++;
    }
    return added;
  }

  /**
   * Review M2: receipts stored before the ledger existed get their debit identity once
   * (idempotent), then the PostgreSQL counters of the touched (tenant, epoch) are rebuilt from the
   * ledger. Receipts written for durable operations are skipped (their debit is the operation's).
   * Returns the number of ledger rows added.
   *
   * @param receipts - Receipts to backfill; those without requestId, with the operation prefix or with
   *   non-convertible cost are skipped.
   * @param epochOf - Maps a receipt to its quota epoch id.
   * @param toUnits - Converts CU to accounting units (micro-CU); `null` means "cannot convert" and skips the receipt.
   * @returns Number of ledger rows added.
   * @throws {Error} Database errors (the transaction is rolled back first).
   */
  async backfillLedger(receipts: RawReceipt[], epochOf: (r: RawReceipt) => string, toUnits: (cu: number) => bigint | null): Promise<number> {
    const rows = receipts.filter((r) => r.requestId && !r.requestId.startsWith(OPERATION_RECEIPT_PREFIX))
      .map((r) => ({ t: r.tenantId ?? 'default', id: `receipt:${encodeURIComponent(r.requestId)}`, e: epochOf(r), u: toUnits(r.costUnits) }))
      .filter((x): x is { t: string; id: string; e: string; u: bigint } => x.u !== null);
    if (rows.length === 0) return 0;
    const client = await this.pool.connect();
    const clientGuard = guardClient(client); // F-P2-01: a lost connection must not crash the process
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('otk_d1d8_ledger_backfill'))");
      const ins = await client.query<{ tenant_id: string; epoch_id: string }>(
        `INSERT INTO otk_ledger (tenant_id, effect_id, epoch_id, units, source)
         SELECT t, id, e, u::numeric, 'legacy_receipt' FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(t, id, e, u)
         ON CONFLICT (tenant_id, effect_id) DO NOTHING RETURNING tenant_id, epoch_id`,
        [rows.map((x) => x.t), rows.map((x) => x.id), rows.map((x) => x.e), rows.map((x) => x.u.toString())],
      );
      const touched = new Map(ins.rows.map((x) => [`${x.tenant_id}\u0000${x.epoch_id}`, x]));
      for (const x of touched.values()) await rebuildQuotaRow(client, x.tenant_id, x.epoch_id);
      await client.query('COMMIT');
      return ins.rows.length;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      clientGuard.release();
    }
  }

  /**
   * Confirmed CU of (tenant, epoch) from the durable ledger, in accounting units.
   *
   * @param tenantId - Tenant id.
   * @param epochId - Quota epoch id.
   * @returns Total units (micro-CU) and the number of ledger entries.
   */
  async ledgerBalance(tenantId: string, epochId: string): Promise<{ units: bigint; entries: number }> {
    return ledgerTotal(this.pool, tenantId, epochId);
  }

  /**
   * Outbox over this store's pool (shared tables).
   *
   * @param opts - Outbox options; `maxAttempts` caps delivery attempts per effect.
   * @returns A new outbox bound to this pool.
   */
  outbox(opts: { maxAttempts?: number } = {}): PgEffectOutbox {
    return new PgEffectOutbox(this.pool, opts);
  }

  /**
   * All recorded proof jobs, by requestId.
   *
   * @returns Map from requestId to proof job id.
   */
  async getProofJobs(): Promise<Map<string, string>> {
    const r = await this.pool.query<{ request_id: string; job_id: string }>('SELECT request_id, job_id FROM otk_proof_jobs');
    return new Map(r.rows.map(x => [x.request_id, x.job_id]));
  }

  /**
   * Insert a receipt. Returns true if inserted (new), false if duplicate (ON CONFLICT).
   * Idempotent by request_id.
   *
   * @param receipt - Receipt to insert (bigint fields are stored as strings).
   * @returns `true` when inserted, `false` when the requestId already existed.
   */
  async store(receipt: RawReceipt): Promise<boolean> {
    const serialized = {
      ...receipt,
      userId: String(receipt.userId),
      nonce: String(receipt.nonce),
    };
    const result = await this.pool.query(
      `INSERT INTO otk_receipts (request_id, receipt_json)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (request_id) DO NOTHING`,
      [receipt.requestId, JSON.stringify(serialized)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Retrieve a single receipt by requestId. Returns undefined if not found.
   *
   * @param requestId - The receipt's requestId.
   * @returns The receipt, or `undefined`.
   */
  async get(requestId: string): Promise<RawReceipt | undefined> {
    const result = await this.pool.query<ReceiptRow>(
      'SELECT receipt_json FROM otk_receipts WHERE request_id = $1',
      [requestId],
    );
    if (!result.rows[0]) return undefined;
    return this._deserialize(result.rows[0].receipt_json);
  }

  /**
   * Load all receipts (for startup restore into in-memory Map).
   *
   * @returns Every stored receipt, oldest first.
   */
  async getAll(): Promise<RawReceipt[]> {
    const result = await this.pool.query<ReceiptRow>(
      'SELECT receipt_json FROM otk_receipts ORDER BY created_at ASC',
    );
    return result.rows.map((r) => this._deserialize(r.receipt_json));
  }

  /**
   * H1R2 S23-F02: one page of the receipts of a tenant, keyset-paginated by request_id (read-only).
   * Pass the last requestId of the previous page as `afterRequestId` ('' for the first page); a page shorter
   * than `limit` is the last one. Rows with no tenantId (legacy) belong to 'default', as in storeReceipt().
   *
   * @param tenantId - Tenant whose receipts are listed.
   * @param afterRequestId - Exclusive lower bound on requestId; `''` for the first page.
   * @param limit - Maximum number of rows.
   * @returns Up to `limit` receipts, ordered by requestId.
   */
  async listReceiptsPageForTenant(tenantId: string, afterRequestId: string, limit: number): Promise<RawReceipt[]> {
    const result = await this.pool.query<ReceiptRow>(
      `SELECT request_id, receipt_json FROM otk_receipts
       WHERE COALESCE(receipt_json->>'tenantId', 'default') = $1 AND request_id > $2
       ORDER BY request_id ASC LIMIT $3`,
      [tenantId, afterRequestId, limit],
    );
    return result.rows.map((r) => ({ ...this._deserialize(r.receipt_json), requestId: r.request_id }));
  }

  /**
   * Delete all receipts. Returns row count before deletion.
   *
   * @returns Number of rows before the deletion.
   */
  async deleteAll(): Promise<number> {
    const count = await this.count();
    await this.pool.query('DELETE FROM otk_receipts');
    return count;
  }

  /**
   * Delete a single receipt.
   *
   * @param requestId - The receipt's requestId; unknown ids are ignored.
   */
  async delete(requestId: string): Promise<void> {
    await this.pool.query('DELETE FROM otk_receipts WHERE request_id = $1', [requestId]);
  }

  /**
   * Current receipt count.
   *
   * @returns Number of rows in `otk_receipts`.
   */
  async count(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM otk_receipts',
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /** Graceful shutdown. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Rebuilds a RawReceipt from its JSONB form (strings back to bigint and numbers).
   *
   * @param row - The stored `receipt_json` value.
   * @returns The receipt with `userId` and `nonce` as bigint.
   */
  private _deserialize(row: ReceiptRow['receipt_json']): RawReceipt {
    return {
      provider: row.provider,
      model: row.model,
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      costUnits: Number(row.costUnits),
      latencyMs: Number(row.latencyMs),
      timestamp: Number(row.timestamp),
      requestId: row.requestId,
      userId: BigInt(row.userId),
      nonce: BigInt(row.nonce),
      tenantId: row.tenantId ?? undefined,
      cwVersion: row.cwVersion ?? undefined,
    };
  }
}
