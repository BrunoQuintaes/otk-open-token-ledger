// SYNTHETIC — OFFLINE. C157 §9.2 / E2E-01: delta of the executor for the Sonnet 5.5 / Opus 5.5 engineering pilots.
// Covers: ids in the closed types, price table v2 (v1 entries untouched; Sonnet 2/10, Opus 4/20 USD/MTok; reasoning = output; cache/image/audio null),
// adapter (thinking ADAPTIVE effort low, NEVER thinking disabled, no cache, standard tier, stream false), `plan --pilot-prompts` (closed list, hashes
// recomputed, ≤ 10, per-prompt max_tokens + 1024 reasoning allowance in the cost cap), compatibility of the frozen design files, --batch-cap-usd, and
// an OFFLINE run of the pilot batch through the existing runner. No network, no secret, no real call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, writePlan } from '../../../scripts/h2eval/cli/plan.js';
import { loadPilotList, materializePilotCorpus, contentOfPilot, maxTokensOf, PILOT_MAX_PROMPTS } from '../../../scripts/h2eval/cli/pilot.js';
import { runBatch } from '../../../scripts/h2eval/cli/run.js';
import { main } from '../../../scripts/h2eval/cli/main.js';
import { CliError, EXIT, sha256File } from '../../../scripts/h2eval/cli/common.js';
import { loadDesignParams, DEFAULT_DESIGN_PARAMS_FILE, R4_CANDIDATE_FILE } from '../../../scripts/h2eval/design/designParams.js';
import { bodyOf, AdapterError, loadPriceTable } from '../../../scripts/h2eval/modal/index.js';
import { defaultThinkingFor, REASONING_ALLOWANCE_TOKENS } from '../../../scripts/h2eval/modal/contract_r2.js';
import { usdToPico } from '../../../scripts/h2eval/core/ledger.js';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Chosen design (coordination, C157 §9.2): MET-01 R5 list (v3): max_tokens per prompt AND per model (Sonnet sum 5184, Opus sum 3392) + reasoning allowance 1024 only in the reservation
const LIST = path.resolve(HERE, '../fixtures/pilot/pilot_prompts.v3.json');
const LIST_SHA = '61dd17567117c8f9e8bed39f69339c1f2bf9add6aa537ca5a0da50ddecbb3468'; // listaPromptsSha256 (prompts only)
const SHA_SON = '4c7a4039502aefe026fbbdac0b3e7d043147a4900d055aa779f7d58410d8fa92'; const SHA_OPU = '2cfe1de473dad701704b3c89a0c77bbd537aef0b3c8a9dc4d69c971bb0a31a88';
const LIST_V1 = path.resolve(HERE, '../fixtures/pilot/pilot_prompts.v1.json'); const LIST_V1_SHA = 'c9c7c23209605de3b762789b46b37bc55f01f5dd78bae591caff2ad895dd1fab'; // discarded variant (sum 480), still loadable
const DESIGN = path.resolve(HERE, '../../../scripts/h2eval/design/R6_PILOT_DESIGN_PARAMS.json');
const PRICE_V1 = path.resolve(HERE, '../../../scripts/h2eval/modal/pricing/price_table_h2eval_v1.json');
const PRICE_V2 = path.resolve(HERE, '../../../scripts/h2eval/modal/pricing/price_table_h2eval_v2.json');
const PRICE_V3 = path.resolve(HERE, '../../../scripts/h2eval/modal/pricing/price_table_h2eval_v3.json'); // C159C E-1
const SON = 'claude-sonnet-5-5' as const; const OPU = 'claude-opus-5-5' as const;
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-pilot-${p}-`));
const WORK = tmp('work'); const PREREG = path.join(WORK, 'PILOT_PROTOCOL_SYNTHETIC.md'); writeFileSync(PREREG, '# synthetic pilot protocol\n');
const PREREG_SHA = sha256File(PREREG);
const SHA = 'd'.repeat(40);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const NOW = '2026-11-12T12:00:00.000Z';

function pilotPlan(extra: { batchCapUsd?: string; models?: Array<typeof SON | typeof OPU>; designParamsFile?: string } = {}) {
  const corpus = path.join(tmp('corpus'), 'pilot_corpus');
  const list = loadPilotList(LIST, LIST_SHA); mkdirSync(corpus, { recursive: true }); materializePilotCorpus(list, corpus);
  const plan = buildPlan({ corpusDir: corpus, preregFile: PREREG, ratifiedSha256: PREREG_SHA, phase: 'PILOT', pilotList: list, designParamsFile: extra.designParamsFile ?? DESIGN, models: extra.models ?? [SON, OPU], studyId: 'estudo_r6_pilotos', batchCapUsd: extra.batchCapUsd, now: () => NOW });
  return { plan, corpus, list };
}

test('catalog: ids in the closed types, defaultThinkingFor adaptive/low/offDocumented:false, allowance 1024', () => {
  for (const m of [SON, OPU]) {
    const t = defaultThinkingFor(m); assert.deepEqual([t.mode, (t as { effort: string }).effort, t.offDocumented], ['adaptive', 'low', false]);
    assert.equal(REASONING_ALLOWANCE_TOKENS[m], 1024n);
  }
});

test('price table v2: v1 entries unchanged byte for byte; Sonnet 2/10 and Opus 4/20 USD per MTok; reasoning = output; cache/image/audio null (never zero)', () => {
  const v1 = JSON.parse(readFileSync(PRICE_V1, 'utf8')); const v2 = JSON.parse(readFileSync(PRICE_V2, 'utf8'));
  assert.equal(sha256File(PRICE_V1), 'b7a9a2d6f0c55ad6a75d341e1a6cf634ee9d3bc7eb61c9b8130e7751dbeb3a91', 'v1 must stay untouched');
  for (const m of Object.keys(v1.models)) assert.deepEqual(v2.models[m], v1.models[m], `legacy model ${m} changed in v2`);
  assert.deepEqual(Object.keys(v2.models).filter((m) => !(m in v1.models)).sort(), [OPU, SON]);
  const p = (m: string) => v2.models[m].tiers[0].prices;
  assert.deepEqual([p(SON).input, p(SON).output, p(SON).reasoning], ['2000000', '10000000', '10000000']);
  assert.deepEqual([p(OPU).input, p(OPU).output, p(OPU).reasoning], ['4000000', '20000000', '20000000']);
  for (const m of [SON, OPU]) for (const k of ['cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite', 'imageTokens', 'audioTokens']) assert.equal(p(m)[k], null, `${m}.${k}`);
  assert.equal(sha256File(PRICE_V2), '780505d5808da7d226455e4a2aff62931cf600d72d934f18fc4a07f515ff9ca0', 'v2 must stay untouched'); // C159C E-1: the v2 FILE is unchanged; the ACTIVE table is now v3
  const PT = loadPriceTable(); assert.equal(PT.table.version, 'h2eval-v3-2026-11-13'); assert.equal(PT.sha256, sha256File(PRICE_V3));
});

test('pilot list v3: all three hashes recomputed; expected sha = prompts-only OR a per-model list hash; foreign hash refused; tampering refused; ≤ 10', () => {
  const l = loadPilotList(LIST, LIST_SHA); assert.equal(l.prompts.length, 10); assert.equal(l.listaSha256, LIST_SHA); assert.ok(l.prompts.length <= PILOT_MAX_PROMPTS);
  assert.deepEqual(l.perModelListSha256, { [SON]: SHA_SON, [OPU]: SHA_OPU });
  assert.deepEqual(l.prompts.map((p) => maxTokensOf(p, SON)), [16, 16, 16, 512, 1024, 512, 1024, 1024, 16, 1024]); assert.equal(l.prompts.reduce((a, p) => a + maxTokensOf(p, SON), 0), 5184);
  assert.deepEqual(l.prompts.map((p) => maxTokensOf(p, OPU)), [16, 16, 16, 256, 512, 256, 640, 640, 16, 1024]); assert.equal(l.prompts.reduce((a, p) => a + maxTokensOf(p, OPU), 0), 3392);
  assert.doesNotThrow(() => loadPilotList(LIST, SHA_SON)); assert.doesNotThrow(() => loadPilotList(LIST, SHA_OPU));
  assert.throws(() => loadPilotList(LIST, 'f'.repeat(64)), (e: unknown) => e instanceof CliError && e.code === 'PILOT_LIST_NOT_THE_EXPECTED_ONE');
  assert.throws(() => loadPilotList(LIST, LIST_V1_SHA), (e: unknown) => e instanceof CliError && e.code === 'PILOT_LIST_NOT_THE_EXPECTED_ONE', 'the discarded variant (sum 480) hash is NOT accepted for the v3 list');
  const j = JSON.parse(readFileSync(LIST, 'utf8')); const d = tmp('tamper'); const w = (n: string, o: unknown) => { writeFileSync(path.join(d, n), JSON.stringify(o)); return path.join(d, n); };
  const bad1 = structuredClone(j); bad1.prompts[0].user = 'Repita exatamente: NOT OK';
  assert.throws(() => loadPilotList(w('a.json', bad1)), (e: unknown) => e instanceof CliError && e.code === 'PILOT_LIST_HASH_MISMATCH');
  const bad2 = structuredClone(j); bad2.prompts[3].maxTokensOpus = 4096;
  assert.throws(() => loadPilotList(w('b.json', bad2)), (e: unknown) => e instanceof CliError && e.code === 'PILOT_LIST_HASH_MISMATCH', 'a changed Opus max_tokens breaks the Opus list hash');
  const bad2s = structuredClone(j); bad2s.prompts[4].maxTokensSonnet = 8;
  assert.throws(() => loadPilotList(w('b2.json', bad2s)), (e: unknown) => e instanceof CliError && e.code === 'PILOT_LIST_HASH_MISMATCH', 'a changed Sonnet max_tokens breaks the Sonnet list hash');
  const bad3 = structuredClone(j); bad3.prompts.push({ ...bad3.prompts[0], id: 'P11' });
  assert.throws(() => loadPilotList(w('c.json', bad3)), (e: unknown) => e instanceof CliError && e.code === 'PILOT_LIST_INVALID');
  const bad4 = structuredClone(j); delete bad4.prompts[2].maxTokensOpus;
  assert.throws(() => loadPilotList(w('d.json', bad4)), (e: unknown) => e instanceof CliError && e.code === 'PILOT_LIST_INVALID', 'every prompt needs a ceiling for both models');
  // the discarded v1 list (sum 480) still loads with its own hash (no silent break), but it is not the chosen design
  const v1 = loadPilotList(LIST_V1, LIST_V1_SHA); assert.deepEqual(v1.prompts.map((p) => maxTokensOf(p, SON)), [16, 16, 16, 32, 64, 64, 64, 64, 16, 128]);
});

test('plan --pilot-prompts: one batch per model (10 calls), max_tokens per prompt, allowance 1024, cost cap = input·in + (max+1024)·out on the v2 table', () => {
  const { plan, list } = pilotPlan();
  assert.equal(plan.phase, 'PILOT'); assert.deepEqual(plan.pilotList, { schema: 'otk.n5.pilot_prompts.v3', fileSha256: list.fileSha256, listaSha256: LIST_SHA, perModelListSha256: { [SON]: SHA_SON, [OPU]: SHA_OPU } }, 'the plan records the list identity'); assert.deepEqual(plan.batches.map((b) => b.batchId).sort(), ['pilot-claude-opus-5-5-b1', 'pilot-claude-sonnet-5-5-b1']);
  assert.equal(plan.priceTable.id, 'h2eval-v3-2026-11-13'); // C159C E-1: active table v3
  // C159C E-1: with the published cache prices the cap's input price is the dearest write TTL (1h: Sonnet 4, Opus 8 USD/MTok; rule R2 items 5/6, unchanged), as for Haiku 5.5
  const price = { [SON]: [4_000_000n, 10_000_000n], [OPU]: [8_000_000n, 20_000_000n] } as const;
  for (const b of plan.batches) {
    assert.equal(b.calls, 10); assert.equal(b.block, 'pilot'); assert.equal(b.provider, 'anthropic');
    let sum = 0n;
    for (const op of b.operations) {
      const [pin, pout] = price[b.model as typeof SON]; const max = BigInt(op.plan.params.maxTokens);
      assert.equal(op.plan.params.maxTokens, maxTokensOf(list.prompts.find((p) => p.id === op.plan.promptId)!, b.model), 'max_tokens of the operation = the list value for THIS model');
      const expected = BigInt(op.inputUpperBoundTokens) * pin + (max + 1024n) * pout; // pico-USD (micro-USD/MTok × tokens)
      assert.equal(BigInt(op.costCapUsdPico), expected, `${b.model} ${op.plan.promptId}`);
      assert.equal(op.reasoningAllowanceTokens, 1024); assert.deepEqual(op.plan.params.reasoning, { effort: 'low' }); assert.equal(op.plan.params.cacheDirectives, 'NONE');
      assert.equal(op.plan.phase, 'PILOT'); assert.equal(op.plan.split, 'NONE'); sum += expected;
    }
    assert.equal(BigInt(b.sumCostCapUsdPico), sum);
    assert.ok(BigInt(b.batchCapUsdPico) >= sum, 'the batch cap covers Σ costCap');
  }
  const son = plan.batches.find((b) => b.model === SON)!; const opu = plan.batches.find((b) => b.model === OPU)!;
  assert.equal(son.operations.reduce((a, o) => a + o.plan.params.maxTokens, 0), 5184); assert.equal(opu.operations.reduce((a, o) => a + o.plan.params.maxTokens, 0), 3392);
  assert.ok(BigInt(son.sumCostCapUsdPico) < usdToPico('0.30'), 'Sonnet worst case fits US$ 0.30'); assert.ok(BigInt(opu.sumCostCapUsdPico) <= usdToPico('0.30'), 'Opus worst case fits US$ 0.30 WITHOUT the duplication (gate G1)');
});

test('request body (Sonnet and Opus): adaptive effort low, NO thinking field, standard tier, stream false, no cache_control, system + user', () => {
  const { plan, corpus } = pilotPlan();
  for (const b of plan.batches) for (const op of b.operations) {
    const r = bodyOf(op.plan as never, contentOfPilot(loadPilotList(LIST).prompts.find((p) => p.id === op.plan.promptId)!) as never);
    const body = r.body as Record<string, unknown>;
    assert.equal(body['model'], b.model); assert.equal(body['max_tokens'], op.plan.params.maxTokens); assert.equal(body['stream'], false); assert.equal(body['service_tier'], 'standard_only');
    assert.deepEqual(body['output_config'], { effort: 'low' }); assert.equal('thinking' in body, false, 'thinking must not be sent (Sonnet 5.5 refuses disabled; Opus is always adaptive)');
    assert.equal('temperature' in body, false); assert.equal('tools' in body, false);
    assert.equal(JSON.stringify(body).includes('cache_control'), false); assert.ok(Array.isArray(body['system'])); assert.equal((body['messages'] as unknown[]).length, 1);
    assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(op.bodySha256, r.bodySha256, 'the plan records the same body hash the adapter produces');
  }
  assert.ok(existsSync(path.join(corpus, 'content')));
});

test('the adapter REFUSES thinking disabled for Sonnet/Opus (plan reasoning NONE) with H2EVAL_PARAM_NOT_DOCUMENTED', () => {
  const { plan } = pilotPlan(); const op = plan.batches[0]!.operations[0]!; const pr = loadPilotList(LIST).prompts[0]!;
  const bad = { ...op.plan, params: { ...op.plan.params, reasoning: 'NONE', thinking: { mode: 'none' } } };
  assert.throws(() => bodyOf(bad as never, contentOfPilot(pr) as never), (e: unknown) => e instanceof AdapterError && /H2EVAL_PARAM_NOT_DOCUMENTED/.test(e.message));
  const unk = { ...op.plan, params: { ...op.plan.params, reasoning: { budget_tokens: 2048 } } };
  assert.throws(() => bodyOf(unk as never, contentOfPilot(pr) as never), (e: unknown) => e instanceof AdapterError);
});

test('legacy design files stay valid and byte-identical in effect: R3_2 and the R4 candidate load; planning Sonnet with them is refused (DESIGN_MODEL_NOT_DECLARED)', () => {
  assert.doesNotThrow(() => loadDesignParams(DEFAULT_DESIGN_PARAMS_FILE)); assert.doesNotThrow(() => loadDesignParams(R4_CANDIDATE_FILE)); assert.doesNotThrow(() => loadDesignParams(DESIGN));
  const list = loadPilotList(LIST); const corpus = path.join(tmp('corpus2'), 'c'); mkdirSync(corpus, { recursive: true }); materializePilotCorpus(list, corpus);
  assert.throws(() => buildPlan({ corpusDir: corpus, preregFile: PREREG, ratifiedSha256: PREREG_SHA, phase: 'PILOT', pilotList: list, models: [SON], now: () => NOW }), (e: unknown) => e instanceof CliError && e.code === 'DESIGN_MODEL_NOT_DECLARED');
  assert.throws(() => buildPlan({ corpusDir: corpus, preregFile: PREREG, ratifiedSha256: PREREG_SHA, phase: 'CONFIRMATORY', pilotList: list, orderBySplit: true, designParamsFile: DESIGN, now: () => NOW }), (e: unknown) => e instanceof CliError && e.code === 'PILOT_LIST_ONLY_FOR_PILOT');
});

test('--batch-cap-usd: can only LOWER the rule and must cover Σ costCap', () => {
  const rule = pilotPlan(); const opuRule = BigInt(rule.plan.batches.find((b) => b.model === OPU)!.batchCapUsdPico);
  const low = pilotPlan({ batchCapUsd: '0.30' }); const opu = low.plan.batches.find((b) => b.model === OPU)!; const son = low.plan.batches.find((b) => b.model === SON)!;
  assert.equal(BigInt(opu.batchCapUsdPico), opuRule < usdToPico('0.30') ? opuRule : usdToPico('0.30'));
  assert.ok(BigInt(son.batchCapUsdPico) <= usdToPico('0.30') && BigInt(opu.batchCapUsdPico) <= usdToPico('0.30'));
  assert.match(opu.batchCapRule, /--batch-cap-usd 0\.30/);
  const above = pilotPlan({ batchCapUsd: '1.20' }); assert.equal(above.plan.batches.find((b) => b.model === OPU)!.batchCapUsdPico, rule.plan.batches.find((b) => b.model === OPU)!.batchCapUsdPico, 'a cap above the rule never raises it');
  assert.throws(() => pilotPlan({ batchCapUsd: '0.05' }), (e: unknown) => e instanceof CliError && e.code === 'BATCH_CAP_BELOW_SUM');
});

test('OFFLINE end to end: run the Sonnet pilot batch through the existing runner with the simulated provider; 10 settled, ledger coherent, no network', { timeout: 120_000 }, async () => {
  const { plan, corpus } = pilotPlan({ models: [SON] }); const planFile = path.join(tmp('plan'), 'plan.json'); writePlan(plan, planFile);
  const dir = path.join(tmp('batch'), 'b');
  const s = await runBatch({ planFile, batchId: 'pilot-claude-sonnet-5-5-b1', batchDir: dir, corpusDir: corpus, mode: 'offline', executorCodeSha: SHA });
  assert.equal(s.planned, 10); assert.equal(s.executed, 10); assert.equal(s.stoppedBy, null);
  const j = readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'); assert.ok(j.length > 0);
});

test('CLI: main plan --phase pilot --pilot-prompts writes the plan and the pilot corpus; a wrong --pilot-list-sha is refused before anything is written', async () => {
  const d = tmp('cli'); const out: string[] = []; const corpus = path.join(d, 'pc'); const planFile = path.join(d, 'plan.json');
  const base = ['plan', '--phase', 'pilot', '--pilot-prompts', LIST, '--corpus', corpus, '--prereg', PREREG, '--ratified-sha', PREREG_SHA, '--out', planFile, '--design-params', DESIGN, '--models', `${SON},${OPU}`, '--study-id', 'estudo_r6_pilotos', '--batch-cap-usd', '0.30'];
  const bad = await main([...base, '--pilot-list-sha', 'a'.repeat(64)], (s) => { out.push(s); });
  assert.equal(bad, EXIT.REFUSED_BY_POLICY); assert.match(out.join(' '), /PILOT_LIST_NOT_THE_EXPECTED_ONE/);
  assert.equal(existsSync(planFile), false); assert.equal(existsSync(path.join(corpus, 'manifest.json')), false, 'nothing written before the list is accepted');
  const code = await main([...base, '--pilot-list-sha', LIST_SHA], (s) => { out.push(s); });
  assert.equal(code, EXIT.OK); assert.ok(existsSync(planFile)); assert.ok(existsSync(path.join(corpus, 'manifest.json')));
  const man = JSON.parse(readFileSync(path.join(corpus, 'manifest.json'), 'utf8')); assert.equal(man.kind, 'PILOT_CLOSED_LIST'); assert.equal(man.pilotList.listaSha256, LIST_SHA); assert.deepEqual(man.pilotList.perModelListSha256, { [SON]: SHA_SON, [OPU]: SHA_OPU }); assert.equal(man.pilotList.prompts.length, 10);
  const written = JSON.parse(readFileSync(planFile, 'utf8')); assert.equal(written.pilotList.listaSha256, LIST_SHA);
  assert.equal(await main([...base, '--pilot-list-sha', SHA_OPU], (s) => { out.push(s); }), EXIT.OK, 'a per-model list hash is also accepted as the expected one');
  assert.equal(sha('x').length, 64); copyFileSync(LIST, path.join(d, 'copy.json'));
});

// ---- C157 §9.2: the ONE financial duplication, registered in the ledger -------------------------------------------------------------------------
import { openLedger, BudgetStop } from '../../../scripts/h2eval/core/ledger.js';

const CFG = (b: string) => ({ campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, batchesUsd: { [b]: '0.30' } });
test('ledger cap_raise: exactly 2×, once, signed, ≤ 25 % of the sub-ledger; replayed on reopen; nothing else moves', () => {
  const d = tmp('capraise'); const lp = path.join(d, 'ledger.jsonl'); const B = 'pilot-claude-opus-5-5-b1';
  const l = openLedger(lp, CFG(B), () => NOW);
  l.reserve('op1', 'anthropic', B, usdToPico('0.20')); l.settle('op1', 'anthropic', B, usdToPico('0.15'));
  assert.throws(() => l.reserve('op2', 'anthropic', B, usdToPico('0.20')), (e: unknown) => e instanceof BudgetStop && e.reason === 'STOP_BUDGET_BATCH', 'base cap 0.30 holds');
  for (const [to, signed, why] of [['0.50', 'human:Bruno', 'cap_raise_must_be_exactly_2x'], ['0.60', 'bruno', 'cap_raise_unsigned'], ['0.60', '', 'cap_raise_unsigned']] as const) {
    assert.throws(() => l.raiseBatchCap(B, 'anthropic', usdToPico(to), signed, 'x'), (e: unknown) => e instanceof BudgetStop && e.detail['reason'] === why, `${to}/${signed}`);
  }
  assert.throws(() => l.raiseBatchCap(B, 'anthropic', usdToPico('0.60'), 'human:Bruno', 'x') && l.raiseBatchCap(B, 'anthropic', usdToPico('1.20'), 'human:Bruno', 'x'), (e: unknown) => e instanceof BudgetStop && e.detail['reason'] === 'cap_raise_already_applied', 'a second duplication is refused');
  const lines = readFileSync(lp, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x) as { kind: string; usd: string; note?: string });
  assert.equal(lines.filter((x) => x.kind === 'cap_raise').length, 1); const ev = lines.find((x) => x.kind === 'cap_raise')!; assert.equal(ev.usd, usdToPico('0.60').toString()); assert.match(ev.note!, /human:Bruno/);
  l.reserve('op2', 'anthropic', B, usdToPico('0.20')); // 0.15 spent + 0.20 > 0.30 but ≤ 0.60: allowed only after the raise
  assert.throws(() => l.reserve('op3', 'anthropic', B, usdToPico('0.30')), (e: unknown) => e instanceof BudgetStop && e.reason === 'STOP_BUDGET_BATCH', 'the raised cap 0.60 is also a ceiling');
  const l2 = openLedger(lp, CFG(B), () => NOW); // reopen with the BASE cap in the config: the event is replayed
  const st = l2.state(); assert.equal(st.batches[B]!.capUsd, usdToPico('0.60').toString()); assert.equal(st.providers['anthropic']!.capUsd, usdToPico('5').toString()); assert.equal(st.campaignCapUsd, usdToPico('11').toString());
  assert.throws(() => l2.raiseBatchCap(B, 'anthropic', usdToPico('1.20'), 'human:Bruno', 'x'), (e: unknown) => e instanceof BudgetStop, 'still once after reopening');
  // above 25 % of the sub-ledger (5 → 1.25): a base cap of 0.80 cannot be doubled to 1.60
  const l3 = openLedger(path.join(d, 'l3.jsonl'), { ...CFG('Z'), batchesUsd: { Z: '0.80' } }, () => NOW);
  assert.throws(() => l3.raiseBatchCap('Z', 'anthropic', usdToPico('1.60'), 'human:Bruno', 'x'), (e: unknown) => e instanceof BudgetStop && e.detail['reason'] === 'cap_raise_above_25pct_of_provider');
});

test('CLI raise-batch-cap: needs a signature and an existing ledger; doubles the plan cap once; the plan and the number of calls do not change', { timeout: 120_000 }, async () => {
  const { plan, corpus } = pilotPlan({ models: [OPU], batchCapUsd: '0.30' }); const planFile = path.join(tmp('plan2'), 'plan.json'); writePlan(plan, planFile);
  const campaign = tmp('campaign'); const B = 'pilot-claude-opus-5-5-b1';
  await runBatch({ planFile, batchId: B, batchDir: path.join(campaign, 'batches', B), corpusDir: corpus, mode: 'offline', executorCodeSha: SHA, campaignDir: campaign });
  const out: string[] = []; const planBefore = readFileSync(planFile, 'utf8');
  const base = ['raise-batch-cap', '--plan', planFile, '--campaign-dir', campaign, '--batch', B, '--reason', 'unica duplicacao C157 9.2 (teste)'];
  assert.equal(await main([...base, '--signed-by', 'bruno'], (s) => { out.push(s); }), EXIT.REFUSED_BY_POLICY); assert.match(out.join(' '), /cap_raise_unsigned/);
  assert.equal(await main([...base, '--signed-by', 'human:Bruno (C157 §9.2, teste)'], (s) => { out.push(s); }), EXIT.OK);
  const ok = JSON.parse(out[out.length - 1]!) as { fromUsd: string; toUsd: string }; assert.equal(usdToPico(ok.toUsd), usdToPico(ok.fromUsd) * 2n);
  assert.equal(await main([...base, '--signed-by', 'human:Bruno (C157 §9.2, teste)'], (s) => { out.push(s); }), EXIT.REFUSED_BY_POLICY); assert.match(out.join(' '), /cap_raise_already_applied/);
  assert.equal(await main([...base, '--signed-by', 'human:x'], (s) => { out.push(s); }), EXIT.REFUSED_BY_POLICY); assert.match(out.join(' '), /signature_must_cite_C157_9_2/, 'a bare human:x is refused: the signature must cite the order');
  assert.equal(await main(['raise-batch-cap', '--plan', planFile, '--campaign-dir', campaign, '--batch', B, '--signed-by', 'human:Bruno (C157 §9.2)', '--reason', 'curto'], (s) => { out.push(s); }), EXIT.USAGE, 'a reason shorter than 10 characters is refused');
  assert.equal(readFileSync(planFile, 'utf8'), planBefore, 'the plan is untouched'); assert.equal(plan.batches[0]!.calls, 10);
});
