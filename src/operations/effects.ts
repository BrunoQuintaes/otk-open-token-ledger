/**
 * D1–D8 / C — handlers of the effects created by a settled operation, and recovery of operations
 * whose owner died (D3 §6–7, D2 §5, D7 §3/§7).
 *
 * persist_receipt (v3, with A's ports): opening stored durably FIRST (D2 §5) → receipt v3 with
 *   publicCommitment → signed and stored → conference report from the numeric local count (if
 *   any) signed and stored, bound to the receipt digest → operation effects updated → only then
 *   the proof job is enqueued with its destination frozen (D7 §11). Every step is idempotent.
 * persist_receipt (legacy, no A ports): the legacy receipt row, without a second debit (the
 *   operation's settlement already wrote the ledger), plus the legacy proof effect.
 * Recovery: an admitted operation never started → released (no provider call happened); a started
 *   one whose lease expired → process_lost + uncertain, exposure kept, never re-sent.
 *
 * @module operations/effects
 */
import type { AttributionStatementV1, ConferenceReport, DurableOperation, Hex32, ModelSupport, PrivateReceiptV3, TokenizerIdentity } from '../types/d1d8/index.js';
import { PgAttributionStore } from './attribution.js';
import { toJsonValue } from './codec.js';
import type { EffectOutcome } from './OutboxWorker.js';
import type { ClaimedEffect } from './PgEffectOutbox.js';
import { enqueueTx } from './PgEffectOutbox.js';
import { effectId, payloadDigest } from './ids.js';
import { keyString, legacyReceiptId, type OperationsContext } from './context.js';
import { RevisionConflictError } from './PgOperationStore.js';
import { toAccountingUnits } from './accounting.js';
import { OpeningConflictError } from './PgOpeningStore.js';
import { legacyKey } from '../api/PostgresReceiptStore.js';

const sameTokenizer = (a: TokenizerIdentity, b: TokenizerIdentity): boolean =>
  a.package === b.package && a.packageVersion === b.packageVersion && a.encoding === b.encoding && a.vocabularyDigest === b.vocabularyDigest
  && JSON.stringify(a.messageAssembly) === JSON.stringify(b.messageAssembly);

/**
 * FINAL CLOSURE (F-FC-02): the calibration profile is selected for the model the provider RETURNED (an observed fact,
 * the same rule the CU uses), not for the requested alias, but only when that model's local tokenizer is identical to
 * the one that produced the local count; otherwise the requested model's support is kept. No alias is added: a returned
 * snapshot that no profile names stays ABSENT.
 */
export function calibrationSupportFor(requested: ModelSupport, returned: ModelSupport | null): ModelSupport {
  if (!returned || !requested.tokenizer || !returned.tokenizer) return requested;
  return sameTokenizer(requested.tokenizer, returned.tokenizer) ? returned : requested;
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Deterministic receipt of a settled operation (same bytes on every retry). */
export function buildReceiptV3(ctx: OperationsContext, op: DurableOperation, publicCommitment: string | null): PrivateReceiptV3 | { error: string } {
  if (op.reservation.state !== 'settled' || !op.usage) return { error: 'operation not settled' };
  const cfg = ctx.measurement.cuConfigByRef(op.config.cuWeights);
  if (!cfg) return { error: `weights ${op.config.cuWeights.version} not available for recomputation` };
  const cu = ctx.measurement.computeCu(op.usage, cfg);
  if (cu.status !== 'computed' || !cu.cu || toAccountingUnits(cu.cu) !== toAccountingUnits(op.reservation.cu)) {
    return { error: 'recomputed CU differs from the settled CU' };
  }
  let price = null;
  if (ctx.measurement.priceUsage && op.config.priceTable) price = ctx.measurement.priceUsage(op.usage, op.usage.observedAt, op.config.priceTable);
  return {
    schema: 'otk.receipt.v3',
    key: op.key,
    source: 'otk_proxy_observed',
    provider: op.provider,
    usage: op.usage,
    cu,
    price,
    config: op.config,
    userRef: ctx.crypto!.userRefOf(op.key),
    timing: { admittedAt: op.createdAt, upstreamStartedAt: null, usageFinalAt: op.usage.observedAt, latencyMs: null },
    publicCommitment,
    contentDigests: null,
  };
}

async function setEffects(ctx: OperationsContext, op: DurableOperation, patch: Partial<DurableOperation['effects']>): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const cur = i === 0 ? op : (await ctx.store.get(op.key))!;
    const next = { ...cur.effects, ...patch };
    if (JSON.stringify(next) === JSON.stringify(cur.effects)) return;
    try { await ctx.store.transition(op.key, cur.revision, { effects: next }); return; } catch (e) { if (!(e instanceof RevisionConflictError)) throw e; }
  }
  throw new Error('effects update kept conflicting');
}

async function persistV3(ctx: OperationsContext, op: DurableOperation): Promise<EffectOutcome> {
  const crypto = ctx.crypto!;
  // 1. opening durable before anything public depends on it (D2 §5)
  let opening = await ctx.openings.get(op.key);
  if (!opening) {
    const detail = await ctx.store.getDetail(op.key);
    opening = crypto.newOpening(op.key, op.reservation.cu, op.config.circuitId, { userRef: crypto.userRefOf(op.key), epoch: detail?.epochId ?? '0' });
    try { await ctx.openings.put(opening); } catch (err) { if (!(err instanceof OpeningConflictError)) throw err; }
    opening = (await ctx.openings.get(op.key))!; // the stored one wins if two attempts raced (review L3)
  }
  // 2. receipt bound to the commitment, signed, stored
  const commitment = await crypto.commitmentOf(opening);
  const receipt = buildReceiptV3(ctx, op, commitment);
  if ('error' in receipt) return { retryAt: null, reason: receipt.error };
  const digest = crypto.receiptCrypto.digestReceipt(receipt);
  await ctx.receiptsV3.putReceipt(receipt, await crypto.receiptCrypto.signReceipt(receipt), digest);
  // 3. conference report from the numeric local count, bound to this receipt
  let conferenceDigest: Hex32 | null = null;
  const detail = await ctx.store.getDetail(op.key);
  const local = detail?.localCount ?? null;
  if (local && ctx.measurement.buildConferenceReport && ctx.measurement.resolveModelSupport && ctx.measurement.conferenceThreshold) {
    const support = ctx.measurement.resolveModelSupport(op.provider, op.api, op.modelRequested);
    // Phase 8: calibration profile of (provider, api, model) selected now, from profiles loaded at startup; anything
    // but COMPATIBLE keeps the heuristic threshold and is recorded in the report (explicit not-calibrated outcome)
    const returnedModel = op.usage?.modelReturned ?? null;
    const calSupport = calibrationSupportFor(support, returnedModel && returnedModel !== op.modelRequested ? ctx.measurement.resolveModelSupport(op.provider, op.api, returnedModel) : null);
    const cal = ctx.measurement.selectCalibration ? ctx.measurement.selectCalibration(calSupport, local.counterVersion) : null;
    if (cal && cal.state !== 'COMPATIBLE') {
      ctx.log('conference_calibration_not_applied', { key: keyString(op.key), provider: op.provider, api: op.api, model: op.modelRequested, modelReturned: returnedModel, state: cal.state, reason: cal.reason, profileId: cal.profileId });
    }
    const report: ConferenceReport = ctx.measurement.buildConferenceReport({
      key: op.key, receiptDigest: digest, usage: op.usage!, local, support,
      threshold: cal ? cal.threshold : ctx.measurement.conferenceThreshold, now: op.usage!.observedAt,
      ...(cal ? { calibration: cal.conference } : {}),
    });
    conferenceDigest = crypto.receiptCrypto.digestConference(report);
    await ctx.receiptsV3.putConference(report, await crypto.receiptCrypto.signConference(report), conferenceDigest);
  }
  await setEffects(ctx, op, { receiptDigest: digest, conferenceDigest });
  // 4. proof job with its destination frozen now; the opening is referenced by key only
  const target = crypto.proofTarget(op.config);
  if (target) {
    const ref = { flavor: 'v3', key: op.key };
    await enqueueTx(ctx.pool, { schema: 'otk.outbox_effect.v1', effectId: effectId('enqueue_proof', op.key), key: op.key, kind: 'enqueue_proof', payloadDigest: payloadDigest(ref), target, payload: ref });
  }
  // 5. OVERNIGHT 20261005 (Phase 7): the attribution frozen at admission, signed by the operator and bound to
  // this receipt digest. Deterministic bytes (admission time, no clock), so a retry stores the same statement.
  // Audit AUD-001: written AFTER the receipt effects and the proof job, so an (unexpected) conflict can never strand the
  // receipt/proof pipeline; the conflict makes this effect dead (visible in outbox metrics) and is logged.
  const attributions = new PgAttributionStore(ctx.pool);
  const attribution = await attributions.get(op.key);
  if (attribution && crypto.receiptCrypto.signAttribution && crypto.receiptCrypto.digestAttribution) {
    const statement: AttributionStatementV1 = { schema: 'otk.attribution.v1', key: op.key, receiptDigest: digest, attribution, attributedAt: op.createdAt, supersedes: null };
    const stDigest = crypto.receiptCrypto.digestAttribution(statement);
    const stored = await attributions.putStatement(op.key, stDigest, toJsonValue(statement), toJsonValue(await crypto.receiptCrypto.signAttribution(statement)));
    if (stored === 'different') {
      ctx.log('attribution_statement_conflict', { key: keyString(op.key), stored: 'different', computed: stDigest });
      return { retryAt: null, reason: 'a different attribution statement is already stored for this operation' };
    }
  }
  return 'done';
}

async function persistLegacy(ctx: OperationsContext, op: DurableOperation): Promise<EffectOutcome> {
  const units = toAccountingUnits(op.reservation.cu);
  if (units % 1_000_000n !== 0n) return { retryAt: null, reason: 'legacy receipts carry integer CU; this settlement is fractional (needs the v3 path)' };
  const requestId = legacyReceiptId(op.key);
  const receipt = {
    provider: op.provider, model: op.usage?.modelReturned ?? op.modelRequested,
    inputTokens: Number(op.usage?.tIn ?? 0n), outputTokens: Number(op.usage?.tOut ?? 0n),
    costUnits: Number(units / 1_000_000n), latencyMs: 0, timestamp: Math.floor(Date.parse(op.usage?.observedAt ?? op.updatedAt) / 1000),
    requestId, userId: '0', nonce: '0', tenantId: op.key.tenantId, cwVersion: op.config.cuWeights.version,
    operationId: op.key.operationId, cuFormula: op.config.cuFormula,
  };
  // The legacy tables belong to the receipt store (PostgresReceiptStore.init, which also marks
  // pre-existing receipts in otk_proof_jobs); wait for it instead of creating them here.
  const t = await ctx.pool.query<{ r: string | null; j: string | null }>("SELECT to_regclass('otk_receipts')::text AS r, to_regclass('otk_proof_jobs')::text AS j");
  if (!t.rows[0]?.r || !t.rows[0]?.j) return { retryAt: later(5_000), reason: 'legacy_receipt_tables_missing' };
  // receipt row only: the debit is the operation's ledger entry (no second debit)
  const ins = await ctx.pool.query(
    'INSERT INTO otk_receipts (request_id, receipt_json) VALUES ($1, $2::jsonb) ON CONFLICT (request_id) DO NOTHING',
    [requestId, JSON.stringify(receipt)],
  );
  if ((ins.rowCount ?? 0) === 0) {
    // the id exists: it must be this operation's own row (a retry), never another tenant's
    const cur = await ctx.pool.query<{ t: string | null; o: string | null }>("SELECT receipt_json->>'tenantId' AS t, receipt_json->>'operationId' AS o FROM otk_receipts WHERE request_id = $1", [requestId]);
    if (cur.rows[0]?.t !== op.key.tenantId || cur.rows[0]?.o !== op.key.operationId) return { retryAt: null, reason: 'legacy receipt id already used by another receipt' };
  }
  if (ctx.legacyProverEnabled()) {
    const key = legacyKey(op.key.tenantId, requestId);
    const ref = { requestId };
    await enqueueTx(ctx.pool, { schema: 'otk.outbox_effect.v1', effectId: effectId('enqueue_proof', key), key, kind: 'enqueue_proof', payloadDigest: payloadDigest(ref), target: null, payload: ref });
  }
  return 'done';
}

export function persistReceiptHandler(ctx: OperationsContext): (e: ClaimedEffect) => Promise<EffectOutcome> {
  return async (e) => {
    const detail = await ctx.store.getDetail(e.key);
    if (!detail) return { retryAt: later(5_000), reason: 'operation_not_found' };
    const op = detail.operation;
    if (op.reservation.state !== 'settled') return { retryAt: null, reason: `operation not settled (${op.reservation.state})` };
    return ctx.crypto ? persistV3(ctx, op) : persistLegacy(ctx, op);
  };
}

/**
 * Recovery of operations whose owner is gone (lease expired), during normal operation and at
 * startup. Never re-sends a call and never invents usage (D7 §3).
 */
export async function recoverOrphans(ctx: OperationsContext, opts: { olderThanMs: number; limit?: number }): Promise<{ released: number; lost: number }> {
  const olderThan = new Date(Date.now() - opts.olderThanMs).toISOString();
  const ops = await ctx.store.listIncomplete({ olderThan, limit: opts.limit ?? 100 });
  let released = 0; let lost = 0;
  for (const op of ops) {
    // S4-F06: an operation this process is still streaming is alive even if its lease renewal
    // lagged (event loop or database under load); only other instances rely on the lease alone
    if (ctx.inflight.has(keyString(op.key))) continue;
    try {
      if (op.execution === 'admitted' && op.measurement === 'none') {
        // upstream_started is written before the provider is called: none happened here
        await ctx.store.transition(op.key, op.revision, { execution: 'process_lost', reservation: { ...op.reservation, state: 'released' } });
        released++;
      } else {
        await ctx.store.transition(op.key, op.revision, {
          execution: 'process_lost',
          ...(op.measurement === 'partial' ? {} : { measurement: 'uncertain' as const }),
          reservation: { ...op.reservation, state: 'held_uncertain' },
        });
        lost++;
      }
      ctx.log('operation_recovered', { key: keyString(op.key), from: op.execution });
    } catch (err) {
      if (!(err instanceof RevisionConflictError)) ctx.log('operation_recovery_failed', { key: keyString(op.key), error: String(err) });
    }
  }
  return { released, lost };
}
