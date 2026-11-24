/**
 * Receipt Store — Shared in-memory receipt store + audit chain + batch aggregation
 *
 * Singleton module shared between API routes and ProxyGateway.
 * Provides: idempotent storage, AuditLogChain wiring, ProverDaemon dispatch,
 * BatchAggregator integration for flush-batch, JSONL durability, and TAL debiting.
 *
 * @module api/receiptStore
 * @since u12.post.d (alpha bridge) | u12.alpha.c (e2e runtime) | u12.alpha.d (hardening)
 *        u12.closure.b (TAL startup replay, chainHead persistence)
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { RawReceipt } from '../types/receipt.js';
import { type AuditRecord, chainHash } from '../security/AuditLogChain.js';
import { deriveEpoch, deriveUsage } from '../types/receipt.js';
import { BatchAggregator } from '../batch/BatchAggregator.js';
import type { CanonicalReceiptV1 } from '../receipt/canonicalReceiptV1.js';
import { getAccountingLayer } from '../security/talRuntime.js';
import { getAuditStore } from '../security/IAuditStore.js';
import { PostgresReceiptStore, type DurableWriteResult } from './PostgresReceiptStore.js';
import { setDurableBalanceSource } from '../security/talRuntime.js';
import { ACCOUNTING_SCALE } from '../operations/accounting.js';
import { OutboxWorker, type EffectOutcome } from '../operations/OutboxWorker.js';
import type { ClaimedEffect } from '../operations/PgEffectOutbox.js';
import { randomUUID } from 'node:crypto';

const _receipts = new Map<string, RawReceipt>();

/**
 * M24-DYN-04 (RUN-M1-24H): a requestId already held for ANOTHER tenant is that tenant's receipt, never this caller's
 * duplicate. The memory check used to answer 'duplicate' first, so the caller got 200 ok while nothing was stored for it
 * (the tenant_mismatch rule below only compared the caller with the NEW receipt, always equal).
 */
function _knownOutcome(input: RawReceipt, tenantId: string | undefined): 'duplicate' | 'tenant_mismatch' | null {
  const existing = _receipts.get(input.requestId);
  if (!existing) return null;
  return (existing.tenantId ?? 'default') === (tenantId ?? input.tenantId ?? 'default') ? 'duplicate' : 'tenant_mismatch';
}
// PA-02: in-memory correlation requestId → ProverDaemon jobId.
// Populated on successful dispatch. Cleared on resetProverStateForTest().
// Limitation: does not survive API restart — proofStatus returns 'unknown' for
// receipts dispatched before the last restart. PA-03 will tighten this.
const _proofJobs = new Map<string, string>();
let _chainHead = '0000000000000000000000000000000000000000000000000000000000000000';
let _entryCount = 0;

// ProverDaemon endpoint — lazy getter so env override takes effect at call-time.
// Using a const captured at module-load would freeze the value on import,
// breaking in-process env injection in tests (require child-process workaround).
function getProverUrl(): string {
  return process.env['PROVER_URL'] ?? 'http://localhost:3001';
}

// Circuit breaker for ProverDaemon dispatch (GAP-C-005 partial):
// After CB_THRESHOLD consecutive failures the circuit opens and dispatch is skipped.
// R14: after the cooldown one trial call is allowed (half-open); success closes the
// circuit and replays every pending receipt. Before R14 the circuit never reopened.
const CB_THRESHOLD = Number(process.env['PROVER_CB_THRESHOLD'] ?? 5);
function getCbCooldownMs(): number {
  return Number(process.env['PROVER_CB_COOLDOWN_MS'] ?? 10_000);
}
let _proverConsecutiveFails = 0;
let _proverCircuitOpen = false;
let _proverOpenedAt = 0;
let _halfOpenTrialInFlight = false;

// R14: receipts whose proof was not accepted by the daemon (failed or skipped).
// Replayed in insertion order once a dispatch succeeds. A receipt with a known
// jobId is never re-sent (the daemon does not deduplicate).
const _pendingProofs = new Map<string, { receipt: RawReceipt; tenantId?: string }>();
let _drainInProgress = false;

// RV04: requestIds whose POST /prove is in flight. Initial dispatch, drain and retry skip
// them, so one receipt never has two concurrent attempts. Before RV04 the drain started by
// A's success re-sent B while B's first request was still in flight (nonces [1, 2, 2]).
const _inFlight = new Set<string>();
// RV04: local idempotency is not remote idempotency. An attempt that ends without an answer
// (timeout, reset, unreadable reply) may or may not have been enqueued by the daemon, which
// does not deduplicate. Such receipts stay pending and are re-sent; an acceptance after an
// uncertain attempt is counted as a possible duplicate job instead of being hidden.
const _uncertain = new Set<string>();
let _uncertainDispatches = 0;
let _possibleDuplicateJobs = 0;

// RV05: recovery loop bound to the server lifecycle (startProofRecovery/stopProofRecovery).
// Before RV05 pending receipts were retried only when a new receipt arrived.
let _recoveryTimer: ReturnType<typeof setInterval> | null = null;
let _recoveryTick: Promise<void> | null = null;
function getRecoveryIntervalMs(): number {
  return Number(process.env['PROVER_RECOVERY_INTERVAL_MS'] ?? 5_000);
}

// JSONL persistence (OTK_RECEIPT_LOG env — empty = disabled)
const RECEIPT_LOG = process.env['OTK_RECEIPT_LOG'] ?? '';
// R14: requestId → jobId correlation persisted next to the receipt log, so a restart
// can tell which restored receipts still lack a proof job.
const PROOF_JOBS_FILE = RECEIPT_LOG ? RECEIPT_LOG + '.jobs' : '';

function _persistProofJob(requestId: string, jobId: string): void {
  // N14: with Postgres configured the correlation also goes to otk_proof_jobs (in every mode,
  // so a later switch from JSONL+PG to PG-only does not see an empty table). If this write is
  // lost, a restart treats the receipt as pending and re-sends it; the daemon then finds the
  // commitment already registered and does not submit again (N15).
  if (_pgStore?.setProofJob) {
    _pgStore.setProofJob(requestId, jobId).catch((err) => {
      process.stderr.write(JSON.stringify({ event: 'proof_job_persist_failed', requestId, error: String(err), ts: Date.now() }) + '\n');
    });
  }
  if (!PROOF_JOBS_FILE) return;
  try { appendFileSync(PROOF_JOBS_FILE, JSON.stringify({ requestId, jobId }) + '\n', 'utf-8'); } catch { /* non-critical */ }
}

// AuditLogChain head persistence: stored alongside JSONL as <log>.head
// Enables cross-restart chain continuity (GAP-B-005)
const CHAIN_HEAD_FILE = RECEIPT_LOG ? RECEIPT_LOG + '.head' : '';

/**
 * Append a receipt as a JSONL line. Throws on I/O error (R13): when JSONL is the
 * configured durable store, a receipt that could not be written is not acknowledged.
 */
function _appendReceiptLog(receipt: RawReceipt): void {
  if (!RECEIPT_LOG) return;
  const line = JSON.stringify({
    ...receipt,
    userId: String(receipt.userId),
    nonce: String(receipt.nonce),
  }) + '\n';
  appendFileSync(RECEIPT_LOG, line, 'utf-8');
}

/** Persist current chainHead to disk. Non-critical; silences I/O errors. */
function _persistChainHead(): void {
  if (!CHAIN_HEAD_FILE) return;
  try { writeFileSync(CHAIN_HEAD_FILE, _chainHead, 'utf-8'); } catch { /* non-critical */ }
}

/**
 * N14: receipts restored from Postgres that must be sent for proving: no recorded job, and
 * the prover is enabled. Receipts marked 'legacy-unknown' have a job entry and are skipped.
 * Limit: another live replica may still be dispatching a receipt it stored moments ago; the
 * daemon's check of already-registered commitments (N15) prevents a second registration.
 */
export function pendingFromRestore(receipts: RawReceipt[], jobs: ReadonlyMap<string, string>, proverDisabled: boolean): RawReceipt[] {
  if (proverDisabled) return [];
  return receipts.filter(r => r.requestId && !jobs.has(r.requestId));
}

/**
 * Process-memory debit. With the transactional PostgreSQL store the Redis projection has a single
 * writer (the outbox effect project_redis), so only memory is updated here.
 */
function _debitAccounting(entry: Parameters<ReturnType<typeof getAccountingLayer>['debit']>[0]): void {
  const tal = getAccountingLayer();
  // OTK_DB_URL (no JSONL): every Redis projection comes from the outbox, including at restore
  if ((OTK_DB_URL || _pgStore instanceof PostgresReceiptStore) && !RECEIPT_LOG && 'debitLocal' in tal) tal.debitLocal(entry);
  else tal.debit(entry);
}

/** Debit one restored receipt into the accounting layer (idempotent by requestId). */
function _rehydrateAccounting(r: RawReceipt, withTokens: boolean): void {
  _debitAccounting({
    tenantId: r.tenantId ?? 'default',
    epochId: String(deriveEpoch(r.timestamp)),
    requestId: r.requestId,
    provider: r.provider,
    model: r.model,
    cu: BigInt(Math.max(0, Math.floor(r.costUnits))),
    ts: r.timestamp * 1000,
    ...(withTokens ? { inputTokens: r.inputTokens, outputTokens: r.outputTokens } : {}),
  });
}

// PA-07B: Postgres store. Initialized via top-level await when OTK_DB_URL is set.
// If OTK_DB_URL is absent, _pgStore stays null and all ops use in-memory Map only.
const OTK_DB_URL = process.env['OTK_DB_URL'];
let _pgStore: PostgresReceiptStore | null = null;
// R13: failures of the asynchronous Postgres write-behind are counted and logged,
// so the degraded durability of that mode is observable instead of silent.
let _pgWriteFailures = 0;

/**
 * RV30-01: state of the configured PostgreSQL store. Before, an error at startup set
 * _pgStore = null and the API acknowledged receipts held only in memory (HTTP 201,
 * mode memory-only) although durability had been configured. Now an unreachable database
 * keeps the store 'unavailable': writes are refused (503) and the connection is retried
 * in the background; memory-only remains the mode only when no persistence is configured.
 */
type PgState = 'not_configured' | 'unavailable' | 'ready';
let _pgState: PgState = OTK_DB_URL ? 'unavailable' : 'not_configured';
let _pgLastError: string | null = null;
let _pgReconnectTimer: ReturnType<typeof setTimeout> | null = null;
function getPgReconnectMs(): number {
  return Math.max(100, Number(process.env['OTK_PG_RECONNECT_MS'] ?? 2_000) || 2_000);
}

/** RV30-03: durable effects (proof dispatch, Redis projection) of receipts written in PG mode. */
let _outboxWorker: OutboxWorker | null = null;
/** Set once startProofRecovery() ran: a store that becomes ready later starts its worker too. */
let _outboxAutoStart = false;
const INSTANCE_OWNER = `${process.env['OTK_INSTANCE_ID'] ?? 'api'}:${process.pid}:${randomUUID().slice(0, 8)}`;

async function _initPg(url: string): Promise<boolean> {
  const store = new PostgresReceiptStore(url, { ssl: isDeployedEnv() ? { rejectUnauthorized: true } : false });
  try {
    await store.init();
    // Restore receipts from Postgres into in-memory Map (overrides JSONL restore if both set)
    const pgReceipts = await store.getAll();
    for (const r of pgReceipts) {
      if (!r.requestId) continue;
      _receipts.set(r.requestId, r);
      // N10: rehydrate the accounting layer as the JSONL restore does. Before, a restart in
      // Postgres mode kept the receipts but reset balances and quota to zero.
      _rehydrateAccounting(r, true);
    }
    if (store.legacyMarked > 0) {
      process.stderr.write(JSON.stringify({ event: 'proof_correlation_unknown', receipts: store.legacyMarked, ts: Date.now() }) + '\n');
    }
    if (!RECEIPT_LOG) {
      const jobs = await store.getProofJobs();
      for (const [requestId, jobId] of jobs) _proofJobs.set(requestId, jobId);
      // N14 + RV30-03: receipts without a proof job get a durable enqueue_proof effect (the
      // same set N14 re-sent from memory after a restart); any instance dispatches them.
      const pending = pendingFromRestore(pgReceipts, jobs, getProverUrl() === 'disabled');
      if (pending.length > 0) await store.ensureProofEffects(pending);
      // review M2: receipts from before the ledger get their debit once (counters rebuilt)
      const added = await store.backfillLedger(pgReceipts, (r) => String(deriveEpoch(r.timestamp)),
        (cu) => (Number.isSafeInteger(cu) && cu >= 0 ? BigInt(cu) * ACCOUNTING_SCALE : null));
      if (added > 0) process.stderr.write(JSON.stringify({ event: 'ledger_backfill', added, ts: Date.now() }) + '\n');
    }
    _pgStore = store;
    _pgState = 'ready';
    _pgLastError = null;
    // review H5: only the PostgreSQL-only mode writes the ledger; with JSONL the receipts reach PG
    // by write-behind without a debit, so the ledger would read 0
    setDurableBalanceSource(RECEIPT_LOG ? null : async (tenantId, epochId) => {
      const { units, entries } = await store.ledgerBalance(tenantId, epochId);
      // integer CU view of the exact ledger (micro-CU); exact values stay in the ledger
      return { tenantId, epochId, totalCU: units / ACCOUNTING_SCALE, entryCount: entries };
    });
    _outboxWorker = new OutboxWorker(store.outbox({ maxAttempts: 1000 }), INSTANCE_OWNER, {
      enqueue_proof: _handleProofEffect,
      project_redis: _handleProjectionEffect,
    }, { flavor: 'legacy', intervalMs: getRecoveryIntervalMs(), onEvent: (e) => { if (e.kind !== 'done') process.stderr.write(JSON.stringify({ event: 'receipt_effect', ...e, ts: Date.now() }) + '\n'); } });
    if (_outboxAutoStart) _outboxWorker.start();
    process.stderr.write(JSON.stringify({ event: 'pg_store_init', restored: pgReceipts.length, ts: Date.now() }) + '\n');
    return true;
  } catch (err) {
    await store.close().catch(() => {});
    _pgState = 'unavailable';
    _pgLastError = String(err);
    process.stderr.write(JSON.stringify({ event: 'pg_store_init_error', error: String(err), retryInMs: getPgReconnectMs(), ts: Date.now() }) + '\n');
    _schedulePgReconnect(url);
    return false;
  }
}

function _schedulePgReconnect(url: string): void {
  if (_pgReconnectTimer) return;
  _pgReconnectTimer = setTimeout(() => {
    _pgReconnectTimer = null;
    void _initPg(url);
  }, getPgReconnectMs());
  _pgReconnectTimer.unref?.();
}

if (OTK_DB_URL) await _initPg(OTK_DB_URL);

// Load state from JSONL on startup (if configured): receipts + TAL + chainHead
if (RECEIPT_LOG) {
  // Restore chainHead from persisted file (GAP-B-005)
  try {
    const saved = readFileSync(CHAIN_HEAD_FILE, 'utf-8').trim();
    if (/^[0-9a-f]{64}$/i.test(saved)) _chainHead = saved;
  } catch { /* file not found — start from zero hash */ }

  // Reload receipts + reidrate TAL (GAP-A-002)
  let legacyWithoutTenant = 0;
  try {
    const lines = readFileSync(RECEIPT_LOG, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const p = JSON.parse(line) as Record<string, unknown>;
        const r: RawReceipt = {
          provider: String(p['provider'] ?? ''),
          model: String(p['model'] ?? ''),
          inputTokens: Number(p['inputTokens'] ?? 0),
          outputTokens: Number(p['outputTokens'] ?? 0),
          costUnits: Number(p['costUnits'] ?? 0),
          latencyMs: Number(p['latencyMs'] ?? 0),
          timestamp: Number(p['timestamp'] ?? 0),
          requestId: String(p['requestId'] ?? ''),
          userId: BigInt(String(p['userId'] ?? '0')),
          nonce: BigInt(String(p['nonce'] ?? '0')),
          tenantId: p['tenantId'] != null ? String(p['tenantId']) : undefined,
          cwVersion: p['cwVersion'] != null ? String(p['cwVersion']) : undefined,
        };
        if (r.requestId) {
          _receipts.set(r.requestId, r);
          // Reidrate TAL so GET /accounting/balance is consistent after restart.
          // Lines written before R12 carry no tenantId; they stay attributed to
          // 'default' and are counted below so the migration gap is visible.
          if (r.tenantId === undefined) legacyWithoutTenant++;
          _rehydrateAccounting(r, p['inputTokens'] != null && p['outputTokens'] != null);
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file not found — start fresh */ }
  if (legacyWithoutTenant > 0) {
    process.stderr.write(JSON.stringify({ event: 'receipt_log_legacy_without_tenant', count: legacyWithoutTenant, ts: Date.now() }) + '\n');
  }

  // R14: restore proof-job correlations; receipts without one become pending.
  // Without a .jobs file (logs written before R14) the proof state of restored
  // receipts is unknown, so nothing is re-sent automatically (avoids duplicate proofs).
  let jobsFileFound = false;
  try {
    const lines = readFileSync(PROOF_JOBS_FILE, 'utf-8').split('\n').filter(Boolean);
    jobsFileFound = true;
    for (const line of lines) {
      try {
        const { requestId, jobId } = JSON.parse(line) as { requestId?: string; jobId?: string };
        if (requestId && jobId) _proofJobs.set(requestId, jobId);
      } catch { /* skip malformed lines */ }
    }
  } catch { /* no correlation file */ }
  if (jobsFileFound) {
    for (const r of _receipts.values()) {
      if (!_proofJobs.has(r.requestId)) _pendingProofs.set(r.requestId, { receipt: r, tenantId: r.tenantId });
    }
  } else {
    // Start tracking now. Receipts restored from a pre-R14 log are marked so they
    // are never re-sent on a later restart.
    try {
      const marks = [..._receipts.keys()].map(id => JSON.stringify({ requestId: id, jobId: 'legacy-unknown' }) + '\n').join('');
      appendFileSync(PROOF_JOBS_FILE, marks, 'utf-8');
      for (const id of _receipts.keys()) _proofJobs.set(id, 'legacy-unknown');
    } catch { /* non-critical */ }
    if (_receipts.size > 0) {
      process.stderr.write(JSON.stringify({ event: 'proof_correlation_unknown', receipts: _receipts.size, ts: Date.now() }) + '\n');
    }
  }
}

/**
 * Store a receipt and append a metering entry to the audit chain.
 * Idempotent by requestId — duplicate requestIds are rejected with no side effects.
 * Returns { stored: true } on first store, { stored: false } on duplicate.
 * On duplicate: no TAL debit, no JSONL append, no ProverDaemon dispatch, no chain advance.
 * Fires an async prove job to ProverDaemon (fire-and-forget, non-blocking).
 */
export function storeReceipt(
  input: RawReceipt,
  tenantId?: string,
): { stored: boolean; reason?: 'duplicate' | 'tenant_mismatch' | 'persistence_failed' } {
  // Idempotency guard: reject duplicate requestId with no side effects (another tenant's id: tenant_mismatch, M24-DYN-04)
  const known = _knownOutcome(input, tenantId);
  if (known) return { stored: false, reason: known };

  // R12: the tenant used for accounting must be the one persisted with the receipt,
  // otherwise a restart re-attributes the consumption to 'default'.
  // tenantId is not part of canonicalHash(), so stamping it does not alter signatures.
  if (tenantId !== undefined && input.tenantId !== undefined && tenantId !== input.tenantId) {
    return { stored: false, reason: 'tenant_mismatch' };
  }
  const resolvedTenant = tenantId ?? input.tenantId ?? 'default';
  const receipt: RawReceipt = input.tenantId === resolvedTenant ? input : { ...input, tenantId: resolvedTenant };

  // RV30-01: configured persistence that is unavailable is never replaced by a memory ack
  if (!RECEIPT_LOG && _pgState === 'unavailable') return { stored: false, reason: 'persistence_failed' };

  // R13: persist first. If the synchronous JSONL write fails, nothing else happens
  // (no memory entry, no debit, no audit, no proof job) and the caller is told why.
  try {
    _appendReceiptLog(receipt);
  } catch (err) {
    process.stderr.write(JSON.stringify({ event: 'receipt_persist_failed', requestId: receipt.requestId, error: String(err), ts: Date.now() }) + '\n');
    return { stored: false, reason: 'persistence_failed' };
  }

  // PA-07B: Postgres write-behind (asynchronous — acknowledged before the write lands).
  // Entry points use storeReceiptDurable(), which writes Postgres first (R13); this
  // synchronous path keeps write-behind only for callers that cannot await.
  if (_pgStore) {
    _pgStore.store(receipt).catch((err) => {
      _pgWriteFailures++;
      process.stderr.write(JSON.stringify({ event: 'pg_receipt_write_failed', requestId: receipt.requestId, error: String(err), ts: Date.now() }) + '\n');
    });
  }

  _applyStoreEffects(receipt, resolvedTenant, tenantId);
  return { stored: true };
}

/** Maximum wait for the durable Postgres write before answering 503 (OTK_PG_WRITE_TIMEOUT_MS). */
const PG_WRITE_TIMEOUT_MS = Math.max(100, Number(process.env['OTK_PG_WRITE_TIMEOUT_MS'] ?? 5000) || 5000);

type DurableStoreResult = {
  stored: boolean;
  reason?: 'duplicate' | 'tenant_mismatch' | 'persistence_failed' | 'quota_exceeded';
  /** With reason 'quota_exceeded': quota and confirmed+held, in accounting units (micro-CU). */
  quota?: { quota: bigint; current: bigint };
};

export interface DurableStoreOptions {
  /**
   * RV30-05: quota checked inside the PostgreSQL transaction, in accounting units (micro-CU);
   * null = no hard limit. Only applied in Postgres mode; other modes keep the caller's check.
   */
  quota?: bigint | null;
}

/**
 * Durable writes running now, by requestId. A concurrent request for the same id waits for
 * the first outcome instead of being told 'duplicate' while that write may still fail
 * (independent review, 2026-09-30: the second client would stop retrying a lost receipt).
 */
const _durableInFlight = new Map<string, Promise<DurableStoreResult>>();

/**
 * R13 (Postgres mode): store a receipt only after Postgres has accepted it.
 * With the JSONL log configured (synchronous) or without Postgres, same as storeReceipt().
 * With Postgres only: the INSERT is awaited before any effect (memory, audit chain, debit,
 * proof job); if it fails the caller gets 'persistence_failed' and nothing happened.
 * A row that already exists in Postgres (e.g. stored by another instance) is a duplicate.
 */
export async function storeReceiptDurable(
  input: RawReceipt,
  tenantId?: string,
  opts: DurableStoreOptions = {},
): Promise<DurableStoreResult> {
  if (!RECEIPT_LOG && _pgState === 'unavailable') return { stored: false, reason: 'persistence_failed' }; // RV30-01
  if (RECEIPT_LOG || !_pgStore) return storeReceipt(input, tenantId);
  const running = _durableInFlight.get(input.requestId);
  if (running) {
    await running.catch(() => undefined);
    // Decide again now that the first attempt's outcome is known
    return storeReceiptDurable(input, tenantId, opts);
  }
  const known = _knownOutcome(input, tenantId); // M24-DYN-04
  if (known) return { stored: false, reason: known };
  if (tenantId !== undefined && input.tenantId !== undefined && tenantId !== input.tenantId) {
    return { stored: false, reason: 'tenant_mismatch' };
  }
  const resolvedTenant = tenantId ?? input.tenantId ?? 'default';
  const receipt: RawReceipt = input.tenantId === resolvedTenant ? input : { ...input, tenantId: resolvedTenant };
  const attempt = 'storeDurable' in _pgStore
    ? _transactionalWrite(_pgStore, receipt, resolvedTenant, tenantId, opts)
    : _durableWrite(_pgStore, receipt, resolvedTenant, tenantId);
  _durableInFlight.set(receipt.requestId, attempt);
  try {
    return await attempt;
  } finally {
    if (_durableInFlight.get(receipt.requestId) === attempt) _durableInFlight.delete(receipt.requestId);
  }
}

/** Wait at most PG_WRITE_TIMEOUT_MS; the outcome of a write still running is then uncertain. */
async function _withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`pg write timeout after ${PG_WRITE_TIMEOUT_MS} ms (outcome uncertain)`)), PG_WRITE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * RV30-02/03/05: Postgres mode with the real store. Quota, receipt, ledger debit and the
 * durable effects (project_redis, enqueue_proof) are one transaction. A timeout answers 503;
 * if the commit lands later the effects exist and the outbox worker of any instance runs them,
 * so no proof is left behind without a client retry or an API restart (RV30-03).
 */
async function _transactionalWrite(
  pgStore: PostgresReceiptStore,
  receipt: RawReceipt,
  resolvedTenant: string,
  tenantId: string | undefined,
  opts: DurableStoreOptions,
): Promise<DurableStoreResult> {
  if (!Number.isSafeInteger(receipt.costUnits) || receipt.costUnits < 0) {
    throw new RangeError(`costUnits must be a non-negative integer CU, got ${receipt.costUnits}`);
  }
  let res: DurableWriteResult;
  try {
    res = await _withTimeout(pgStore.storeDurable(receipt, {
      epochId: String(deriveEpoch(receipt.timestamp)),
      units: BigInt(receipt.costUnits) * ACCOUNTING_SCALE,
      ...(opts.quota !== undefined ? { quota: opts.quota } : {}),
      enqueueProof: getProverUrl() !== 'disabled',
    }));
  } catch (err) {
    _pgWriteFailures++;
    process.stderr.write(JSON.stringify({ event: 'receipt_persist_failed', mode: 'pg-tx', requestId: receipt.requestId, error: String(err), ts: Date.now() }) + '\n');
    return { stored: false, reason: 'persistence_failed' };
  }
  if (res.outcome === 'quota_exceeded') return { stored: false, reason: 'quota_exceeded', quota: { quota: res.quota, current: res.current } };
  if (res.outcome === 'tenant_mismatch') return { stored: false, reason: 'tenant_mismatch' };
  if (res.outcome === 'duplicate') {
    // Stored earlier (e.g. a commit that landed after a timeout) or by another instance: adopt
    // into this process's memory; its effects are already in the outbox.
    const persisted = await pgStore.get(receipt.requestId).catch(() => undefined);
    if (persisted && !_receipts.has(persisted.requestId)) {
      _receipts.set(persisted.requestId, persisted);
      _rehydrateAccounting(persisted, true);
      process.stderr.write(JSON.stringify({ event: 'receipt_adopted_from_pg', requestId: persisted.requestId, ts: Date.now() }) + '\n');
    }
    return { stored: false, reason: 'duplicate' };
  }
  _applyStoreEffects(receipt, resolvedTenant, tenantId, 'outbox');
  return { stored: true };
}

async function _durableWrite(
  pgStore: PostgresReceiptStore,
  receipt: RawReceipt,
  resolvedTenant: string,
  tenantId: string | undefined,
): Promise<DurableStoreResult> {
  let inserted: boolean;
  try {
    // A frozen database (connection open, no answer) must not hang the request forever.
    // On timeout the INSERT may still commit later: the outcome is uncertain, the caller
    // gets 503 and a retry with the same requestId finds the row (adopted below).
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`pg write timeout after ${PG_WRITE_TIMEOUT_MS} ms (outcome uncertain)`)), PG_WRITE_TIMEOUT_MS);
    });
    try {
      inserted = await Promise.race([pgStore.store(receipt), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    _pgWriteFailures++;
    process.stderr.write(JSON.stringify({ event: 'receipt_persist_failed', mode: 'pg-sync', requestId: receipt.requestId, error: String(err), ts: Date.now() }) + '\n');
    return { stored: false, reason: 'persistence_failed' };
  }
  if (!inserted) {
    // The row was already in Postgres: an earlier attempt whose answer timed out, or a
    // receipt stored by another instance. Another tenant's id is refused. Otherwise the
    // persisted row is adopted into this process's memory and accounting (debit is
    // idempotent by requestId), without a new proof job or audit entry: the instance that
    // stored it owns those, and the prover does not deduplicate jobs.
    const persisted = await pgStore.get(receipt.requestId).catch(() => undefined);
    if (persisted && (persisted.tenantId ?? 'default') !== resolvedTenant) return { stored: false, reason: 'tenant_mismatch' };
    if (persisted && !_receipts.has(persisted.requestId)) {
      _receipts.set(persisted.requestId, persisted);
      _rehydrateAccounting(persisted, true);
      process.stderr.write(JSON.stringify({ event: 'receipt_adopted_from_pg', requestId: persisted.requestId, ts: Date.now() }) + '\n');
    }
    return { stored: false, reason: 'duplicate' };
  }
  if (_receipts.has(receipt.requestId)) return { stored: false, reason: 'duplicate' };
  _applyStoreEffects(receipt, resolvedTenant, tenantId);
  return { stored: true };
}

/**
 * Replace the Postgres receipt store (tests only): lets unit tests drive the durable path
 * with a controllable fake. Pass null to return to the configured behaviour.
 * @internal
 */
export function setPgStoreForTest(store: Pick<PostgresReceiptStore, 'store' | 'get'> | null): void {
  _pgStore = store as PostgresReceiptStore | null;
  _durableInFlight.clear();
  void _outboxWorker?.stop();
  _outboxWorker = null;
  if (store === null) return;
  if (!OTK_DB_URL) _pgState = 'not_configured';
  // a real store injected by a test or probe gets the same durable effects as configured mode
  if (store instanceof PostgresReceiptStore) {
    _outboxWorker = new OutboxWorker(store.outbox({ maxAttempts: 1000 }), INSTANCE_OWNER, {
      enqueue_proof: _handleProofEffect,
      project_redis: _handleProjectionEffect,
    }, { flavor: 'legacy', intervalMs: getRecoveryIntervalMs() });
    if (_outboxAutoStart) _outboxWorker.start();
  }
}

/**
 * Receipt by requestId: memory first, then Postgres when configured, so an instance can
 * read receipts stored by another instance sharing the database.
 */
export async function getReceiptDurable(requestId: string): Promise<RawReceipt | undefined> {
  const local = _receipts.get(requestId);
  if (local || !_pgStore) return local;
  try { return await _pgStore.get(requestId); } catch { return undefined; }
}

/** H1R2 S23-F02: a receipt source required for a complete export could not be read. */
export class ExportSourceUnavailableError extends Error {
  constructor(readonly source: string, cause: string) {
    super(`receipt source ${source} unavailable: ${cause}`);
    this.name = 'ExportSourceUnavailableError';
  }
}

/** Page size of the PostgreSQL read of listReceiptsForTenant (OTK_EXPORT_PAGE_SIZE, default 1000). */
function getExportPageSize(): number {
  const n = Number(process.env['OTK_EXPORT_PAGE_SIZE'] ?? 1000);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 10_000) : 1000;
}

/**
 * H1R2 S23-F02: ALL the receipts of a tenant held by the receipt store, read-only. Memory first, then every page of
 * PostgreSQL when it is configured (receipts written by another instance sharing the database are only there).
 * A configured PostgreSQL that cannot be read throws ExportSourceUnavailableError: a partial list must never be
 * presented as the complete export. Receipts with no tenantId belong to 'default', as in storeReceipt().
 */
export async function listReceiptsForTenant(tenantId: string): Promise<{ receipts: RawReceipt[]; sources: string[] }> {
  const byId = new Map<string, RawReceipt>();
  for (const r of _receipts.values()) {
    if ((r.tenantId ?? 'default') === tenantId) byId.set(r.requestId, r);
  }
  const sources = ['receipt_store_memory'];
  const pg = _pgStore as (Partial<PostgresReceiptStore> & object) | null;
  if (pg && typeof pg.listReceiptsPageForTenant === 'function') {
    const pageSize = getExportPageSize();
    let after = '';
    try {
      for (;;) {
        const page = await pg.listReceiptsPageForTenant(tenantId, after, pageSize);
        for (const r of page) if (!byId.has(r.requestId)) byId.set(r.requestId, r);
        if (page.length < pageSize) break;
        const last = page[page.length - 1]!.requestId;
        if (last === after) throw new Error('pagination did not advance'); // order is the database collation's
        after = last;
      }
    } catch (err) {
      throw new ExportSourceUnavailableError('receipt_store_pg', (err as Error).message);
    }
    sources.push('receipt_store_pg');
  } else if (_pgState === 'unavailable') {
    // PostgreSQL configured but not connected: memory alone may miss receipts of other instances
    throw new ExportSourceUnavailableError('receipt_store_pg', _pgLastError ?? 'not connected');
  }
  return { receipts: [...byId.values()], sources };
}

/** Effects of a receipt that is already durably written (or memory-only by configuration). */
function _applyStoreEffects(receipt: RawReceipt, resolvedTenant: string, tenantId: string | undefined, dispatch: 'direct' | 'outbox' = 'direct'): void {
  _receipts.set(receipt.requestId, receipt);

  const record: AuditRecord = {
    ts: new Date().toISOString(),
    tenantId: resolvedTenant,
    actor: String(receipt.userId),
    action: 'metered',
    meta: {
      requestId: receipt.requestId,
      provider: receipt.provider,
      model: receipt.model,
      costUnits: receipt.costUnits,
    },
  };
  _chainHead = chainHash(_chainHead, record);
  _entryCount++;
  _persistChainHead();
  // Durable audit trail — parallel write to IAuditStore (fire-and-forget)
  getAuditStore().append(record).catch(() => {});

  // TokenAccountingLayer debit — records CU spent per (tenantId, epochId)
  const epoch = deriveEpoch(receipt.timestamp);
  _debitAccounting({
    tenantId: resolvedTenant,
    epochId: String(epoch),
    requestId: receipt.requestId,
    provider: receipt.provider,
    model: receipt.model,
    cu: BigInt(Math.max(0, Math.floor(receipt.costUnits))),
    ts: Date.now(),
    inputTokens: receipt.inputTokens,
    outputTokens: receipt.outputTokens,
  });

  if (dispatch === 'outbox') {
    // RV30-03: the proof and the Redis projection are durable effects of the transaction;
    // run the worker now instead of waiting for its interval (any instance may also run them)
    if (_outboxWorker) _lastDispatchPromise = _outboxWorker.kick().then(() => {});
    return;
  }
  // Fire-and-forget: dispatch prove job to ProverDaemon (non-blocking)
  _lastDispatchPromise = _dispatchProveJob(receipt, tenantId).catch(() => { /* non-critical: daemon may be offline */ });
}

/** Retry instant for effects the daemon/Redis could not take now (bounded, never dropped). */
function _retryIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Outbox handler: legacy proof dispatch of one receipt (POST /prove), idempotent per receipt. */
async function _handleProofEffect(e: ClaimedEffect): Promise<EffectOutcome> {
  const requestId = String(e.payload?.['requestId'] ?? '');
  if (getProverUrl() === 'disabled') return 'done';
  if (_proofJobs.has(requestId)) return 'done';
  const store = _pgStore;
  if (!store) return { retryAt: _retryIn(getPgReconnectMs()), reason: 'pg_unavailable' };
  const recorded = await store.getProofJob(requestId);
  if (recorded) { _proofJobs.set(requestId, recorded); return 'done'; }
  const receipt = _receipts.get(requestId) ?? await store.get(requestId);
  if (!receipt) return { retryAt: _retryIn(5_000), reason: 'receipt_not_found' };
  if (_proverCircuitOpen && Date.now() - _proverOpenedAt < getCbCooldownMs()) {
    return { retryAt: new Date(_proverOpenedAt + getCbCooldownMs()).toISOString(), reason: 'prover_circuit_open' };
  }
  if (_inFlight.has(requestId)) return { retryAt: _retryIn(1_000), reason: 'in_flight' };
  const ok = await _sendProveJob(receipt, receipt.tenantId, { awaitJobRecord: true });
  return ok ? 'done' : { retryAt: _retryIn(Math.min(60_000, 500 * 2 ** Math.min(e.attempts, 7))), reason: 'prover_dispatch_failed' };
}

/** Outbox handler: project one ledger debit into the Redis TAL (idempotent by requestId). */
async function _handleProjectionEffect(e: ClaimedEffect): Promise<EffectOutcome> {
  const tal = getAccountingLayer();
  const p = e.payload ?? {};
  if (!('debitStrict' in tal)) {
    // No Redis TAL in this process. If Redis is configured it is degraded here: leave the
    // effect for an instance that has it (or for this one after a restart), never drop it.
    return process.env['OTK_REDIS_URL'] ? { retryAt: _retryIn(10_000), reason: 'redis_tal_unavailable_here' } : 'done';
  }
  await tal.debitStrict({
    tenantId: e.key.tenantId,
    epochId: String(p['epochId']),
    requestId: String(p['requestId']),
    provider: String(p['provider'] ?? ''),
    model: String(p['model'] ?? ''),
    cu: BigInt(String(p['cu'])),
    ts: Number(p['ts'] ?? Date.now()),
  });
  return 'done';
}

/**
 * Last dispatch promise — tracks the most recent fire-and-forget dispatch.
 * @internal Exposed for test determinism (replaces flaky setTimeout waits).
 */
let _lastDispatchPromise: Promise<void> = Promise.resolve();

/**
 * Await the most recent fire-and-forget proof dispatch.
 * Use in tests instead of setTimeout to eliminate timing flakiness.
 * In production, dispatch is fire-and-forget and this is never called.
 */
export async function awaitLastDispatch(): Promise<void> {
  await _lastDispatchPromise;
}

/**
 * Dispatch a ZK prove job to ProverDaemon for the given receipt.
 * Gracefully no-ops if PROVER_URL is 'disabled'. When the daemon is unreachable the
 * receipt stays pending and is replayed after a later successful dispatch (R14).
 *
 * @internal
 */
async function _dispatchProveJob(receipt: RawReceipt, tenantId?: string): Promise<void> {
  if (getProverUrl() === 'disabled') return;
  if (_proofJobs.has(receipt.requestId)) return; // already accepted by the daemon
  _pendingProofs.set(receipt.requestId, { receipt, tenantId });
  if (_inFlight.has(receipt.requestId)) return; // RV04: its attempt is still running

  if (_proverCircuitOpen) {
    // Open: skip until the cooldown elapses, then allow a single half-open trial.
    if (_halfOpenTrialInFlight || Date.now() - _proverOpenedAt < getCbCooldownMs()) return;
    _halfOpenTrialInFlight = true;
  }
  let ok: boolean;
  try {
    ok = await _sendProveJob(receipt, tenantId);
  } finally {
    _halfOpenTrialInFlight = false;
  }
  if (ok) await _drainPendingProofs();
}

/** Replay pending receipts in insertion order; stops at the first failure. */
async function _drainPendingProofs(): Promise<void> {
  if (_drainInProgress) return;
  _drainInProgress = true;
  try {
    for (const [requestId, { receipt, tenantId }] of [..._pendingProofs]) {
      if (_proverCircuitOpen) break;
      if (_proofJobs.has(requestId)) { _pendingProofs.delete(requestId); continue; }
      if (_inFlight.has(requestId)) continue; // RV04: owned by the attempt in flight
      if (!(await _sendProveJob(receipt, tenantId))) break;
    }
  } finally {
    _drainInProgress = false;
  }
}

/**
 * Retry pending proofs now (ops hook / scheduler). Respects the circuit breaker:
 * while open and inside the cooldown nothing is sent. Returns the pending count left.
 */
export async function retryPendingProofs(): Promise<number> {
  // RV30-03: durable effects first (receipts committed late or by another instance)
  if (_outboxWorker) await _outboxWorker.tick().catch(() => 0);
  for (const [requestId, { receipt, tenantId }] of _pendingProofs) {
    if (_inFlight.has(requestId)) continue; // RV04
    await _dispatchProveJob(receipt, tenantId);
    break;
  }
  return _pendingProofs.size;
}

/**
 * RV05: start the recovery loop (idempotent; no-op when PROVER_URL=disabled). Every
 * `intervalMs` (default PROVER_RECOVERY_INTERVAL_MS, 5 s) it calls retryPendingProofs()
 * if something is pending and the previous tick has finished. It respects the circuit
 * breaker (nothing is sent while open inside the cooldown) and each attempt keeps the
 * 5 s request timeout, so a tick waits a bounded time. The timer does not keep the
 * process alive (unref). Receipts restored as pending after a restart are covered.
 */
export function startProofRecovery(opts: { intervalMs?: number } = {}): void {
  // RV30-02: the outbox also carries Redis projections, so its worker runs even without a prover
  _outboxWorker?.start();
  _outboxAutoStart = true;
  if (_recoveryTimer || getProverUrl() === 'disabled') return;
  const intervalMs = opts.intervalMs ?? getRecoveryIntervalMs();
  _recoveryTimer = setInterval(() => {
    if (_recoveryTick || _pendingProofs.size === 0) return;
    _recoveryTick = retryPendingProofs().then(() => {}, () => {}).finally(() => { _recoveryTick = null; });
  }, intervalMs);
  _recoveryTimer.unref?.();
}


/** RV05: stop the recovery loop; resolves once a tick that is running has finished. */
export async function stopProofRecovery(): Promise<void> {
  if (_recoveryTimer) clearInterval(_recoveryTimer);
  _recoveryTimer = null;
  _outboxAutoStart = false;
  if (_recoveryTick) await _recoveryTick;
  await _outboxWorker?.stop();
}

/** RV05: whether the recovery loop is active (monitoring / tests). */
export function proofRecoveryRunning(): boolean {
  return _recoveryTimer !== null;
}

/**
 * D7-G08: Redis lost or rebuilt — re-apply every Redis projection from the durable source
 * (ledger-backed `project_redis` effects of receipts and operations). Idempotent: markers inside
 * each aggregate prevent double counting where Redis still has data. Null outside Postgres mode.
 */
export async function reprojectRedis(filter: { tenantId?: string | null; epochId?: string | null } = {}): Promise<number | null> {
  if (!(_pgStore instanceof PostgresReceiptStore)) return null;
  const n = await _pgStore.outbox().replayKind('project_redis', filter);
  if (_outboxWorker) _lastDispatchPromise = _outboxWorker.kick().then(() => {});
  return n;
}

/** RV30-03: outbox counts by state (pending/leased/done/dead), or null outside Postgres mode. */
export async function receiptEffectsStatus(): Promise<Record<string, number> | null> {
  return _pgStore && 'outbox' in _pgStore ? _pgStore.outbox().stats() : null;
}

/** RV04: the error proves the request never reached the daemon (safe to re-send). */
function _isCertainNonDelivery(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

/** Single POST /prove. Updates breaker state; returns true when the daemon accepted the job. */
async function _sendProveJob(receipt: RawReceipt, tenantId?: string, opts: { awaitJobRecord?: boolean } = {}): Promise<boolean> {
  const epoch = deriveEpoch(receipt.timestamp);
  const usage = deriveUsage(receipt);

  // Circuit version selection (GAP-C-001):
  // Use v2 when OTK_CIRCUIT_DEFAULT=2 OR when receipt has circuitVersion override.
  // Default: v1 (metering_v1 — canonical for dissertation + ReceiptRegistry).
  const circuitVersion: '1' | '2' =
    (receipt as unknown as Record<string, unknown>)['circuitVersion'] === '2' ||
    process.env['OTK_CIRCUIT_DEFAULT'] === '2'
      ? '2'
      : '1';

  const usageNum = Number(usage);
  const proofBody: Record<string, string> = {
    userId: String(receipt.userId),
    usage: String(usage),
    nonce: String(receipt.nonce),
    epoch: String(epoch),
    circuitVersion,
  };

  if (circuitVersion === '2') {
    // v2 range proof: bucket = [usage, usage*2] or OTK_V2_BUCKET_MULTIPLIER
    const mult = Number(process.env['OTK_V2_BUCKET_MULTIPLIER'] ?? 2);
    proofBody['minUsageBucket'] = String(usageNum);
    proofBody['maxUsageBucket'] = String(Math.max(usageNum * mult, 1000000));
  } else {
    proofBody['maxUsage'] = String(Math.max(usageNum * 2, 1000000));
  }

  const fail = (): false => {
    _proverConsecutiveFails++;
    if (_proverConsecutiveFails >= CB_THRESHOLD) {
      _proverCircuitOpen = true;
      _proverOpenedAt = Date.now();
    }
    return false;
  };

  _inFlight.add(receipt.requestId);
  try {
    const resp = await fetch(`${getProverUrl()}/prove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(proofBody),
      signal: AbortSignal.timeout(5000), // 5s timeout — daemon is local
    });
    if (!resp.ok) return fail(); // non-OK response counts as a failure
    const { jobId } = await resp.json() as { jobId?: string };
    // PA-02: store requestId → jobId correlation for proofStatus lookups
    const acceptedJob = jobId ?? 'accepted-without-id';
    _proofJobs.set(receipt.requestId, acceptedJob);
    if (opts.awaitJobRecord && _pgStore?.setProofJob) {
      // outbox path: the job is recorded before the effect is marked done, so a restart or
      // another instance never re-sends an accepted receipt because of a lost async write
      await _pgStore.setProofJob(receipt.requestId, acceptedJob);
    } else {
      _persistProofJob(receipt.requestId, acceptedJob);
    }
    _pendingProofs.delete(receipt.requestId);
    if (_uncertain.delete(receipt.requestId)) _possibleDuplicateJobs++; // RV04
    // Success: reset circuit breaker
    _proverConsecutiveFails = 0;
    _proverCircuitOpen = false;
    // Audit: proved-dispatched
    const auditRecord: AuditRecord = {
      ts: new Date().toISOString(),
      tenantId: tenantId ?? receipt.tenantId ?? 'default',
      actor: String(receipt.userId),
      action: 'prove_dispatched',
      meta: { requestId: receipt.requestId, jobId: jobId ?? 'unknown' },
    };
    _chainHead = chainHash(_chainHead, auditRecord);
    _entryCount++;
    _persistChainHead();
    // Durable audit trail — parallel write to IAuditStore (fire-and-forget)
    getAuditStore().append(auditRecord).catch(() => {});
    return true;
  } catch (err) {
    // Receipt is stored and stays pending. RV04: a timeout/reset may hide an acceptance;
    // it is recorded as uncertain (see _uncertain) rather than as a clean failure.
    if (!_isCertainNonDelivery(err)) {
      _uncertainDispatches++;
      _uncertain.add(receipt.requestId);
    }
    return fail();
  } finally {
    _inFlight.delete(receipt.requestId);
  }
}

/** Retrieve a stored receipt by requestId. */
export function getReceipt(requestId: string): RawReceipt | undefined {
  return _receipts.get(requestId);
}

/** Flush all stored receipts. Returns count before flush. */
export function flushAll(): number {
  const count = _receipts.size;
  _receipts.clear();
  // PA-07B: async delete from Postgres (fire-and-forget)
  if (_pgStore) _pgStore.deleteAll().catch(() => { /* non-critical */ });
  return count;
}

/**
 * Flush receipts into a BatchAggregator Merkle batch.
 *
 * Converts all stored RawReceipts to CanonicalReceiptV1, aggregates into a
 * Merkle batch, appends a batch_finalized audit record, then clears the store.
 *
 * Returns null if no receipts are stored.
 */
export function flushBatch(opts?: { tenantId?: string }): import('../batch/BatchAggregator.js').BatchResult | null {
  if (_receipts.size === 0) return null;

  const tenantId = opts?.tenantId ?? 'system';
  const agg = new BatchAggregator();

  for (const receipt of _receipts.values()) {
    const epoch = deriveEpoch(receipt.timestamp);
    const usage = deriveUsage(receipt);
    const canonical: CanonicalReceiptV1 = {
      provider: receipt.provider,
      model: receipt.model,
      input_tokens: BigInt(receipt.inputTokens),
      output_tokens: BigInt(receipt.outputTokens),
      total_tokens: BigInt(receipt.inputTokens + receipt.outputTokens),
      latency_ms: BigInt(receipt.latencyMs),
      cost_unit: usage,
      user_id: String(receipt.userId),
      project_id: receipt.tenantId ?? tenantId,
      timestamp: BigInt(receipt.timestamp) * 1000n, // sec → ms
      nonce: receipt.nonce,
      epoch,
    };
    agg.addReceipt(canonical);
  }

  const result = agg.finalizeBatch();
  const count = _receipts.size;
  _receipts.clear();
  // PA-07B: async delete from Postgres after batch (fire-and-forget)
  if (_pgStore) _pgStore.deleteAll().catch(() => { /* non-critical */ });

  // Audit: batch finalized
  const auditRecord: AuditRecord = {
    ts: new Date().toISOString(),
    tenantId,
    actor: 'system',
    action: 'batch_finalized',
    meta: { count, root: result.header.root, epoch: String(result.header.epoch) },
  };
  _chainHead = chainHash(_chainHead, auditRecord);
  _entryCount++;
  _persistChainHead();
  // Durable audit trail — parallel write to IAuditStore (fire-and-forget)
  getAuditStore().append(auditRecord).catch(() => {});

  return result;
}

/** Current receipt count. */
export function size(): number {
  return _receipts.size;
}

/** Current audit chain head hash. */
export function chainHead(): string {
  return _chainHead;
}

/** Total audit entries appended (does not reset on flush). */
export function auditCount(): number {
  return _entryCount;
}

/**
 * R13: which durability guarantee a stored=true acknowledgement carries.
 *   'jsonl-sync'      — written to the JSONL file before acknowledging
 *   'pg-sync'         — Postgres accepted the row before acknowledging (entry points use
 *                       storeReceiptDurable; the synchronous storeReceipt() is write-behind)
 *   'memory-only'     — nothing survives a restart
 * JSONL is reported when configured because it is the synchronous one.
 */
export function persistenceStatus(): {
  mode: 'jsonl-sync' | 'pg-sync' | 'pg-unavailable' | 'memory-only';
  durableBeforeAck: boolean;
  pgWriteFailures: number;
  pgLastError?: string;
} {
  // RV30-01: configured-but-unreachable PostgreSQL is reported as such (writes refused)
  const mode = RECEIPT_LOG ? 'jsonl-sync' : _pgState === 'unavailable' ? 'pg-unavailable' : _pgStore ? 'pg-sync' : 'memory-only';
  return {
    mode, durableBeforeAck: mode === 'jsonl-sync' || mode === 'pg-sync', pgWriteFailures: _pgWriteFailures,
    ...(mode === 'pg-unavailable' && _pgLastError ? { pgLastError: _pgLastError } : {}),
  };
}

/**
 * ProverDaemon circuit breaker status (for monitoring).
 * RV04: `inFlight` attempts running now; `uncertainDispatches` attempts that ended without
 * an answer; `possibleDuplicateJobs` acceptances that followed an uncertain attempt.
 */
export function circuitBreakerStatus(): {
  open: boolean; consecutiveFails: number; pendingProofs: number;
  inFlight: number; uncertainDispatches: number; possibleDuplicateJobs: number;
} {
  return {
    open: _proverCircuitOpen, consecutiveFails: _proverConsecutiveFails, pendingProofs: _pendingProofs.size,
    inFlight: _inFlight.size, uncertainDispatches: _uncertainDispatches, possibleDuplicateJobs: _possibleDuplicateJobs,
  };
}

/**
 * PA-02: Proof status values for GET /receipts/:id.
 * 'pending'  — job exists and has not yet completed
 * 'proved'   — job completed successfully (proof available)
 * 'failed'   — job reached dead-letter (exhausted retries)
 * 'unknown'  — no correlation found or ProverDaemon unreachable
 * 'disabled' — PROVER_URL=disabled
 */
export type ProofStatus = 'pending' | 'proved' | 'failed' | 'unknown' | 'disabled';

export interface ProofStatusResult {
  proofStatus: ProofStatus;
  jobId?: string;
  attempts?: number;
  nextRetryAt?: number;
  error?: string;
  /** PA-03: on-chain tx hash from ReceiptRegistry.submitReceipt(). */
  txHash?: string;
}

/**
 * Resolve the proof status for a given receipt requestId.
 * Queries ProverDaemon GET /status/:jobId (1s timeout, fail-safe).
 * Returns 'unknown' when the daemon is unreachable or no correlation exists.
 * Returns 'disabled' when PROVER_URL=disabled.
 *
 * @since PA-02
 */
export async function getProofStatus(requestId: string): Promise<ProofStatusResult> {
  if (getProverUrl() === 'disabled') return { proofStatus: 'disabled' };
  let jobId = _proofJobs.get(requestId);
  // a job recorded by another instance (or after this process started)
  if (!jobId && _pgStore && 'getProofJob' in _pgStore) jobId = await _pgStore.getProofJob(requestId).catch(() => undefined);
  if (!jobId || jobId === 'legacy-unknown' || jobId === 'accepted-without-id') return { proofStatus: 'unknown' };
  try {
    const resp = await fetch(`${getProverUrl()}/status/${jobId}`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!resp.ok) return { proofStatus: 'unknown', jobId };
    const data = await resp.json() as {
      status?: string;
      attempts?: number;
      nextRetryAt?: number;
      error?: string;
      txHash?: string;
    };
    let proofStatus: ProofStatus = 'unknown';
    if (data.status === 'done') proofStatus = 'proved';
    else if (data.status === 'dead_letter') proofStatus = 'failed';
    else if (data.status === 'pending' || data.status === 'processing') proofStatus = 'pending';
    return {
      proofStatus,
      jobId,
      ...(data.attempts !== undefined ? { attempts: data.attempts } : {}),
      ...(data.nextRetryAt ? { nextRetryAt: data.nextRetryAt } : {}),
      ...(data.error ? { error: data.error } : {}),
      ...(data.txHash ? { txHash: data.txHash } : {}),
    };
  } catch {
    return { proofStatus: 'unknown', jobId };
  }
}

/**
 * Reset ProverDaemon circuit breaker state and proof job map.
 * For tests only — ensures test isolation between suites.
 */
export function resetProverStateForTest(): void {
  _proverConsecutiveFails = 0;
  _proverCircuitOpen = false;
  _proverOpenedAt = 0;
  _halfOpenTrialInFlight = false;
  _proofJobs.clear();
  _pendingProofs.clear();
  _drainInProgress = false;
  _inFlight.clear();
  _uncertain.clear();
  _uncertainDispatches = 0;
  _possibleDuplicateJobs = 0;
  if (_recoveryTimer) clearInterval(_recoveryTimer);
  _recoveryTimer = null;
  _recoveryTick = null;
}

// ---------------------------------------------------------------------------
// Compile-time conformance check — IReceiptStoreWithProver (ADR-0205)
// Ensures module-level exports satisfy the IReceiptStore contract.
// This assignment fails at build-time if any interface method is missing.
// ---------------------------------------------------------------------------
import type { IReceiptStoreWithProver } from './IReceiptStore.js';
import { isDeployedEnv } from '../infra/deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard
const _conformanceCheck: IReceiptStoreWithProver = {
  storeReceipt,
  getReceipt,
  size,
  flushBatch,
  flushAll,
  chainHead,
  auditCount,
  circuitBreakerStatus,
};
void _conformanceCheck;

/**
 * RV30-05: whether the quota of POST /receipts is applied inside the PostgreSQL transaction
 * (global across instances). False in JSONL, memory or test-fake modes, where the caller keeps
 * the per-process reservation.
 */
export function transactionalQuotaActive(): boolean {
  return !RECEIPT_LOG && _pgState !== 'unavailable' && _pgStore instanceof PostgresReceiptStore;
}
