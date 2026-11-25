/**
 * Tests the absolute per-batch cost ceiling of pilot plans and the single, signed doubling of a pilot batch cap.
 *
 * Modules under test: `scripts/h2eval/cli/plan.ts` (`buildPlan`, `PILOT_INITIAL_BATCH_CAP_USD`,
 * `PILOT_ABSOLUTE_BATCH_CAP_USD`), `scripts/h2eval/cli/pilot.ts`, `scripts/h2eval/cli/run.ts` (`runBatch`) and the
 * CLI entry point `scripts/h2eval/cli/main.ts`.
 *
 * Strategy / partitions: the constants and the default initial cap of a pilot plan (USD 0.30); a doubling that
 * stays at or under the absolute ceiling (USD 0.60), an explicit higher cap that is lowered, and a doubling above the
 * ceiling that is refused with an exit code; and a campaign plan, which has no pilot list and cannot be doubled.
 *
 * Needs: a writable temporary directory; reads the pilot prompt list fixture
 * `test/h2eval/fixtures/pilot/pilot_prompts.v3.json` and the pilot design file. No network, no secret.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/pilot_ceiling.test.ts`
 *
 * @module test/h2eval/cli/pilot_ceiling.test
 */
// SYNTHETIC — OFFLINE. C157 §9.2 absolute ceiling per pilot batch (US$ 0.60 after the single duplication) enforced IN CODE (MET-02 W3), and what the duplication
// permits (W4): only to record exactly 2x of the batch cap, once, never above US$ 0.60, with a signature that cites the order. No network, no secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, writePlan, PILOT_INITIAL_BATCH_CAP_USD, PILOT_ABSOLUTE_BATCH_CAP_USD } from '../../../scripts/h2eval/cli/plan.js';
import { loadPilotList, materializePilotCorpus } from '../../../scripts/h2eval/cli/pilot.js';
import { runBatch } from '../../../scripts/h2eval/cli/run.js';
import { main } from '../../../scripts/h2eval/cli/main.js';
import { EXIT, sha256File } from '../../../scripts/h2eval/cli/common.js';
import { usdToPico } from '../../../scripts/h2eval/core/ledger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIST = path.resolve(HERE, '../fixtures/pilot/pilot_prompts.v3.json');
const DESIGN = path.resolve(HERE, '../../../scripts/h2eval/design/R6_PILOT_DESIGN_PARAMS.json');
const OPU = 'claude-opus-5-5' as const; const SON = 'claude-sonnet-5-5' as const;
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-ceil-${p}-`));
const WORK = tmp('work'); const PREREG = path.join(WORK, 'P.md'); writeFileSync(PREREG, '# synthetic pilot protocol\n');
const SHA = 'e'.repeat(40);

function plan(model: typeof OPU | typeof SON, batchCapUsd?: string) {
  const corpus = path.join(tmp('c'), 'pc'); mkdirSync(corpus, { recursive: true }); const list = loadPilotList(LIST); materializePilotCorpus(list, corpus);
  const p = buildPlan({ corpusDir: corpus, preregFile: PREREG, ratifiedSha256: sha256File(PREREG), phase: 'PILOT', pilotList: list, designParamsFile: DESIGN, models: [model], batchCapUsd, now: () => '2026-11-12T12:00:00.000Z' });
  return { p, corpus };
}

test('constants are the C157 §9.2 figures; a pilot plan WITHOUT --batch-cap-usd already carries the initial US$ 0.30 (never the rule 0.425 of the Opus)', () => {
  assert.deepEqual([PILOT_INITIAL_BATCH_CAP_USD, PILOT_ABSOLUTE_BATCH_CAP_USD], ['0.30', '0.60']);
  const { p } = plan(OPU); const b = p.batches[0]!;
  assert.equal(BigInt(b.batchCapUsdPico), usdToPico('0.30')); assert.equal(p.pilotAbsoluteBatchCapUsd, '0.60'); assert.match(b.batchCapRule, /--batch-cap-usd 0\.30/);
  const s = plan(SON).p.batches[0]!; assert.ok(BigInt(s.batchCapUsdPico) < usdToPico('0.30'), 'the rule already gives less than 0.30 for the Sonnet: kept (the flag only lowers)');
});

test('without the flag the duplication of the Opus can never exceed US$ 0.60; an explicit higher cap is lowered; a doubling above the ceiling is refused with a signed attempt', { timeout: 180_000 }, async () => {
  // an explicit --batch-cap-usd 0.50 does NOT raise anything: a pilot cap is clamped to 0.30
  assert.equal(BigInt(plan(OPU, '0.50').p.batches[0]!.batchCapUsdPico), usdToPico('0.30'));
  // a TAMPERED plan (cap edited to the old rule 0.425) is refused by the ceiling when the duplication is attempted (doubling = 0.85 > 0.60)
  const { p, corpus } = plan(OPU); const b = p.batches[0]!; b.batchCapUsdPico = usdToPico('0.425202').toString();
  const planFile = path.join(tmp('plan'), 'plan.json'); writePlan(p, planFile); const campaign = tmp('campaign');
  await runBatch({ planFile, batchId: b.batchId, batchDir: path.join(campaign, 'batches', b.batchId), corpusDir: corpus, mode: 'offline', executorCodeSha: SHA, campaignDir: campaign });
  const out: string[] = [];
  const code = await main(['raise-batch-cap', '--plan', planFile, '--campaign-dir', campaign, '--batch', b.batchId, '--signed-by', 'human:Bruno (C157 §9.2, teste)', '--reason', 'tentativa acima do teto absoluto'], (s) => { out.push(s); });
  assert.equal(code, EXIT.REFUSED_BY_POLICY); assert.match(out.join(' '), /cap_raise_above_absolute_ceiling/, 'the duplication is refused by the absolute US$ 0.60 ceiling');
  // the default plan (0.30) doubles to exactly 0.60 and is accepted
  const d = plan(OPU); const bb = d.p.batches[0]!; const pf = path.join(tmp('plan2'), 'plan.json'); writePlan(d.p, pf); const camp2 = tmp('campaign2');
  await runBatch({ planFile: pf, batchId: bb.batchId, batchDir: path.join(camp2, 'batches', bb.batchId), corpusDir: d.corpus, mode: 'offline', executorCodeSha: SHA, campaignDir: camp2 });
  const out2: string[] = [];
  assert.equal(await main(['raise-batch-cap', '--plan', pf, '--campaign-dir', camp2, '--batch', bb.batchId, '--signed-by', 'human:Bruno (C157 §9.2, teste)', '--reason', 'unica duplicacao registrada em teste'], (s) => { out2.push(s); }), EXIT.OK);
  const ok = JSON.parse(out2[out2.length - 1]!) as { toUsd: string; absoluteCeilingUsd: string }; assert.equal(usdToPico(ok.toUsd), usdToPico('0.60')); assert.equal(usdToPico(ok.absoluteCeilingUsd), usdToPico('0.60'));
});

test('the duplication is only for PILOT plans (a campaign plan has no pilotList): refused', async () => {
  const { p, corpus } = plan(OPU); const planFile = path.join(tmp('plan3'), 'plan.json'); const copy = { ...p } as Record<string, unknown>; delete copy['pilotList']; delete copy['pilotAbsoluteBatchCapUsd'];
  writeFileSync(planFile, JSON.stringify(copy)); const out: string[] = []; void corpus;
  const code = await main(['raise-batch-cap', '--plan', planFile, '--campaign-dir', tmp('x'), '--batch', p.batches[0]!.batchId, '--signed-by', 'human:Bruno (C157 §9.2)', '--reason', 'plano que nao e de piloto'], (s) => { out.push(s); });
  assert.equal(code, EXIT.REFUSED_BY_POLICY); assert.match(out.join(' '), /CAP_RAISE_ONLY_FOR_PILOT_PLANS/);
});
