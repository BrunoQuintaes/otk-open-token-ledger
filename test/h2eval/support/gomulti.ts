/**
 * Synthetic multi-batch GO (h2eval.go.multi.v1) builder for OFFLINE tests. Never a real GO: campaign ids, nonces and signatures are test values.
 *
 * A GO file is the signed go-ahead that the multi-batch runner (`runAuthorized` in `scripts/h2eval/cli/run.ts`)
 * requires before it runs any batch. Side effect on import: when `H2EVAL_CONTROL_DIR` is unset, this module sets
 * it to a new temporary directory, so tests never write the machine's real campaign control registry.
 *
 * @module test/h2eval/support/gomulti
 */
import { createHash } from 'node:crypto';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { GO_REQUIRED_STOPS, type GoFileMultiV1 } from '../../../scripts/h2eval/core/egress.js';
import type { BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initCampaignIdentity, canonicalPath } from '../../../scripts/h2eval/cli/campaign.js';
// VNEXT-F: tests never write the machine's real control registry; each test process gets its own
process.env['H2EVAL_CONTROL_DIR'] ??= mkdtempSync(path.join(tmpdir(), 'h2eval-test-control-'));
/** Synthetic identity sha used by pure-validator tests that have no directory. */
export const SYNTHETIC_IDENTITY_SHA = '1'.repeat(64);

/**
 * Derives a deterministic batch nonce for a synthetic GO file.
 *
 * @param seed - Test-chosen seed; a different seed gives a different nonce for the same batch.
 * @param batchId - Batch the nonce is for.
 * @returns The first 32 hex characters of sha256(`seed|batchId`).
 */
export function nonceFor(seed: string, batchId: string): string { return createHash('sha256').update(`${seed}|${batchId}`).digest('hex').slice(0, 32); }

/**
 * Builds the JSON text of a synthetic multi-batch GO file for a plan and a set of its batches.
 *
 * Defaults: providers and models are those of the batches in scope; caps are the 5/3/3 USD provider sub-ledgers
 * and an 11 USD campaign total with a pause at 80%; the attempt limit is the sum of the batches' calls; the time
 * window runs from 60 s before to 1 h after `nowMs`; one nonce per batch from {@link nonceFor}. The digest field is
 * the canonical sha256 of the other fields unless `over` sets it.
 *
 * @param plan - The batch plan the GO refers to (its study id, protocol hash, preregistration and corpus).
 * @param batchIds - Batches in scope.
 * @param o - Options: `executorCodeSha` (required), optional overrides of the defaults above, `campaignDir` (the
 *   campaign identity in that directory is created if absent and pinned, together with its canonical path and
 *   ledger opening digest), `pilotProtocolHash`, and `over` (raw fields merged last, to build invalid GO files).
 * @returns The GO file content as a JSON string, ready to write to disk.
 */
export function syntheticMultiGo(plan: BatchPlan, batchIds: string[], o: { executorCodeSha: string; prereg?: string; nonceSeed?: string; maxAttempts?: number; windowMs?: number; notBeforeMs?: number; providers?: GoFileMultiV1['providers']; pauseAck?: GoFileMultiV1['pauseAck80pct']; preAuth?: GoFileMultiV1['preAuthorizeTo100pct']; over?: Partial<GoFileMultiV1>; nowMs?: number; /** VNEXT-3: the campaign directory this GO is bound to (identity created if absent); else a synthetic sha */ campaignDir?: string; pilotProtocolHash?: string; /** VNEXT-F: override of the pinned opening digest (default: the file's digest when present, else 'none') */ ledgerOpeningDigest?: string }): string {
  const now = o.nowMs ?? Date.now();
  const identitySha = o.campaignDir ? initCampaignIdentity(o.campaignDir, { studyId: plan.studyId, corpusSha256: plan.corpus.corpusSha256, createdBy: 'human:SYNTHETIC' }).sha256 : SYNTHETIC_IDENTITY_SHA;
  const openingPath = o.campaignDir ? path.join(o.campaignDir, 'LEDGER_OPENING.json') : null;
  const openingDigest = o.ledgerOpeningDigest ?? (openingPath && existsSync(openingPath) ? (JSON.parse(readFileSync(openingPath, 'utf8')) as { digestSha256?: string }).digestSha256 ?? 'none' : 'none');
  const inScope = plan.batches.filter((b) => batchIds.includes(b.batchId));
  const base: Omit<GoFileMultiV1, 'goDigestSha256'> = {
    schema: 'h2eval.go.multi.v1', campaign: plan.studyId, preregistrationSha256: o.prereg ?? plan.preregistration.sha256, executorCodeSha: o.executorCodeSha, planProtocolHash: plan.protocolHash,
    batchIds: [...batchIds], providers: o.providers ?? ([...new Set(inScope.map((b) => b.provider))] as GoFileMultiV1['providers']), modelIds: [...new Set(inScope.map((b) => b.model))],
    caps: { perProviderSubLedgerUsd: { anthropic: '5', openai: '3', google: '3' }, globalCampaignUsd: '11', pauseAtFractionOfSubLedger: 0.8 },
    maxAttempts: o.maxAttempts ?? inScope.reduce((a, b) => a + b.calls, 0),
    window: { notBeforeUtc: new Date(now - (o.notBeforeMs ?? 60_000)).toISOString(), notAfterUtc: new Date(now + (o.windowMs ?? 3_600_000)).toISOString() },
    nonces: Object.fromEntries(batchIds.map((b) => [b, nonceFor(o.nonceSeed ?? 'seed', b)])),
    ...(o.pauseAck ? { pauseAck80pct: o.pauseAck } : {}), ...(o.preAuth ? { preAuthorizeTo100pct: o.preAuth } : {}),
    requiresG17ForCampaignBatches: true, stops: [...GO_REQUIRED_STOPS], signedBy: 'human:SYNTHETIC', campaignIdentitySha256: identitySha, campaignDirCanonical: o.campaignDir ? canonicalPath(o.campaignDir) : 'synthetic:/no-directory', ledgerOpeningDigestSha256: openingDigest, ...(o.pilotProtocolHash ? { pilotProtocolHash: o.pilotProtocolHash } : {}), signatureStatement: 'Declaro que li o pre-registro de hash acima, conferi contas, limites e precos, e autorizo SOMENTE o que este arquivo diz.',
  };
  const merged = { ...base, ...(o.over ?? {}) } as Omit<GoFileMultiV1, 'goDigestSha256'> & { goDigestSha256?: string };
  const digest = merged.goDigestSha256 ?? sha256Canon({ ...merged, goDigestSha256: undefined });
  return JSON.stringify({ ...merged, goDigestSha256: digest });
}
