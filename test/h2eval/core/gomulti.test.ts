/**
 * Tests the validator of the multi-batch GO file against a real plan: one valid file and a list of invalid
 * variants, each refused with its own code.
 *
 * Module under test: `scripts/h2eval/core/egress.ts` (`validateGoMultiV1`, `GO_MULTI_MAX_ATTEMPTS`), with a plan
 * from `scripts/h2eval/cli/plan.ts` and GO files from `../support/gomulti.ts`.
 *
 * Strategy / partitions: valid; expired, not yet valid, or a window over 72 hours; a batch outside the plan;
 * wildcard or empty scope; repeated or short nonces; wrong executor SHA; dirty working tree; another plan; caps that
 * differ from the effective ledger on either side; attempt limit above the scope or the global maximum;
 * preregistration mismatch or not configured; placeholder values; tampered digest; missing per-model gate
 * requirement; unsigned pre-approval; unsigned GO.
 *
 * Needs: a writable temporary directory and a synthetic corpus frozen in the `setup` test (allow up to 5 minutes);
 * sets `H2EVAL_CONTROL_DIR` to a temporary folder when unset. No network, no credential.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/gomulti.test.ts`
 *
 * @module test/h2eval/core/gomulti.test
 */
// SYNTHETIC — OFFLINE. C144 D144-05: negatives of the multi-batch GO validator (h2eval.go.multi.v1): expired / not yet valid / window > 72 h,
// batch outside the plan, wildcard or empty scope, repeated or short nonces, wrong executor SHA, dirty tree, other plan, caps != effective
// ledger (either side), maxAttempts above the scope or above 1 446, pre-registration mismatch / unconfigured, placeholder, tampered digest,
// missing G17 requirement, unsigned pre-authorisation, unsigned GO. The valid file passes. No network, no credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { validateGoMultiV1, GO_MULTI_MAX_ATTEMPTS } from '../../../scripts/h2eval/core/egress.js';
import { SYNTHETIC_IDENTITY_SHA, syntheticMultiGo } from '../support/gomulti.js';

const SHA = 'c'.repeat(40);
const WORK = mkdtempSync(path.join(tmpdir(), 'h2eval-gomulti-')); const CORPUS = path.join(WORK, 'corpus');
const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg');
const CAPS = { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } };
let pilot: BatchPlan;

test('setup: corpus + pilot plan', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: 424242, s2: 2, s3: 3, noRepoScan: true });
  pilot = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-MULTI' });
});

test('validador do GO multilote: valido; expirado; ainda nao valido; janela > 72 h; lote fora do plano; curinga; nonces repetidos/invalidos; SHA errado; arvore suja; tetos != efetivos; maxAttempts > escopo e > 1446; pre-registro; placeholder; digest; G17 flag; assinatura', () => {
  const ids = pilot.batches.filter((b) => !b.branchLocked).map((b) => b.batchId);
  const ctx = { campaignDirCanonical: null as string | null, campaignIdentitySha256: SYNTHETIC_IDENTITY_SHA as string | null, campaign: pilot.studyId, preregistrationSha256: pilot.preregistration.sha256, executorCodeSha: SHA, treeClean: true as boolean | null, planProtocolHash: pilot.protocolHash, planBatchIds: pilot.batches.map((b) => b.batchId), plannedOpsInScope: (x: readonly string[]) => pilot.batches.filter((b) => x.includes(b.batchId)).reduce((a, b) => a + b.calls, 0), ledgerCaps: CAPS, nowMs: Date.now() };
  assert.equal(validateGoMultiV1(syntheticMultiGo(pilot, ids, { executorCodeSha: SHA }), ctx), null);
  const cases: Array<[string, string, string, Partial<typeof ctx>?]> = [
    ['expirado', 'GO_EXPIRED', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, windowMs: -1000 })],
    ['ainda nao valido', 'GO_NOT_YET_VALID', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, notBeforeMs: -3_600_000 })],
    ['janela > 72 h', 'GO_WINDOW_TOO_LONG', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, windowMs: 80 * 3600 * 1000 })],
    ['lote fora do plano', 'GO_BATCH_NOT_IN_PLAN', syntheticMultiGo(pilot, [...ids, 'campaign-train-nope-b1'], { executorCodeSha: SHA })],
    ['curinga', 'GO_BATCHIDS_INVALID', syntheticMultiGo(pilot, ['*'], { executorCodeSha: SHA })],
    ['lista vazia', 'GO_BATCHIDS_INVALID', syntheticMultiGo(pilot, [], { executorCodeSha: SHA, maxAttempts: 1 })],
    ['nonce repetido entre lotes', 'GO_NONCES_INVALID', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, over: { nonces: Object.fromEntries(ids.map((b) => [b, 'a'.repeat(16)])) } })],
    ['nonce curto', 'GO_NONCES_INVALID', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, over: { nonces: Object.fromEntries(ids.map((b, i) => [b, `${i}abc`])) } })],
    ['SHA do executor errado', 'GO_EXECUTOR_MISMATCH', syntheticMultiGo(pilot, ids, { executorCodeSha: 'd'.repeat(40) })],
    ['arvore suja', 'GO_EXECUTOR_TREE_DIRTY', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA }), { treeClean: false }],
    ['plano diferente', 'GO_PLAN_MISMATCH', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, over: { planProtocolHash: '0'.repeat(64) } })],
    ['tetos != efetivos (ledger 50)', 'GO_CAPS_MISMATCH', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA }), { ledgerCaps: { campaignUsd: '11', providersUsd: { anthropic: '50', openai: '3', google: '3' } } }],
    ['GO declara 50', 'GO_CAPS_MISMATCH', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, over: { caps: { perProviderSubLedgerUsd: { anthropic: 50, openai: 3, google: 3 }, globalCampaignUsd: 11, pauseAtFractionOfSubLedger: 0.8 } } })],
    ['maxAttempts > escopo', 'GO_MAX_ATTEMPTS', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, maxAttempts: 9999 })],
    ['maxAttempts > 1446', 'GO_MAX_ATTEMPTS', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, maxAttempts: GO_MULTI_MAX_ATTEMPTS + 1 })],
    ['pre-registro diferente', 'GO_PREREG_MISMATCH', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, prereg: 'ab'.repeat(32) })],
    ['pre-registro nao configurado', 'GO_PREREG_UNCONFIGURED', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA }), { preregistrationSha256: undefined }],
    ['placeholder', 'GO_PLACEHOLDER_LEFT', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA }).replace('"human:SYNTHETIC"', '"human:<Nome>"')],
    ['digest adulterado', 'GO_DIGEST_MISMATCH', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, over: { goDigestSha256: '0'.repeat(64) } as never })],
    ['sem requisito G17', 'GO_G17_REQUIREMENT_MISSING', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, over: { requiresG17ForCampaignBatches: false as never } })],
    ['pre-autorizacao sem assinatura humana', 'GO_PAUSE_ACK_INVALID', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, preAuth: { anthropic: { acknowledgedBy: 'agent:x', atUtc: 'x' } } })],
    ['nao assinado', 'GO_UNSIGNED', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, over: { signedBy: 'bot' } })],
  ];
  for (const [name, code, text, cx] of cases) { const got = validateGoMultiV1(text, { ...ctx, ...(cx ?? {}) }); assert.equal(got, code, name); assert.doesNotMatch(String(got), /SYNTHETIC|H2EVAL-MULTI/); }
});

