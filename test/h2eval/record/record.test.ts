/**
 * Tests the record layer of the evaluation harness: immutable pre-call snapshots, the hash-chained journal, the
 * ledger with independent provider sub-ledgers, cost rules, cache classification by usage and canonical JSON.
 *
 * Modules under test: `scripts/h2eval/record/snapshot.ts`, `scripts/h2eval/core/journal.ts`,
 * `scripts/h2eval/core/ledger.ts`, `scripts/h2eval/record/cost.ts` (`computeCost`, `computeCostCap`),
 * `scripts/h2eval/record/usage.ts` (`cacheObservedOf`, `validateUsage`) and `scripts/h2eval/core/canon.ts`.
 *
 * Strategy / partitions: snapshots (canonical hash, second write of the same operation refused, one changed byte or
 * hash detected as tampered); journal (append with hash chain; gaps, reordering, edits, false hashes and long or
 * multi-line bodies refused); ledger (reserve before settle, settlement not above the reservation, no transfer
 * between sub-ledgers, batch and campaign caps, uncertain money kept as possibly charged); cost (`UNKNOWN` never 0,
 * `CALCULATED` only with every billed category counted and priced, worst-case cap, cache interval); cache
 * classification from usage rather than from the request flag; and canonical JSON and price lookup (`null` on
 * ambiguity or absence).
 *
 * Needs: a writable temporary directory (through `../support/double.ts`). No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/record/record.test.ts`
 *
 * @module test/h2eval/record/record.test
 */
// SYNTHETIC — OFFLINE. R12: snapshot immutability (overwrite refused; one changed byte detected), journal integrity (gap, reorder,
// edit), ledger sub-ledgers, cost UNKNOWN ≠ 0, cache classification by use, cap arithmetic, price table reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { H2EVAL_SCHEMA, type NormalizedUsageH2, type PrecallSnapshot } from '../../../scripts/h2eval/types.js';
import { sealSnapshot, writeSnapshot, readSnapshot, SnapshotError, snapshotPath } from '../../../scripts/h2eval/record/snapshot.js';
import { openJournal, verifyJournalText, JournalIntegrityError } from '../../../scripts/h2eval/core/journal.js';
import { openLedger, BudgetStop, usdToPico, picoToUsdString } from '../../../scripts/h2eval/core/ledger.js';
import { computeCost, computeCostCap } from '../../../scripts/h2eval/record/cost.js';
import { cacheObservedOf, validateUsage } from '../../../scripts/h2eval/record/usage.js';
import { canon, sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { tmp, prices, MODEL } from '../support/double.js';

function snap(id = 'f'.repeat(64)): PrecallSnapshot {
  return sealSnapshot({
    schema: H2EVAL_SCHEMA.snapshot, snapshotId: 'snap_test', gateUsed: null, condition: null, operationId: id, tsUtc: '2026-11-10T00:00:00.000Z', executorVersion: 'v0', executorCodeSha: 'c'.repeat(40), modelRequested: MODEL, provider: 'anthropic', api: 'anthropic.messages',
    requestBodySha256: '1'.repeat(64), promptSha256: '2'.repeat(64), prefixSha256: 'NOT_APPLICABLE', params: { maxTokens: 64, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'standard_only', cacheDirectives: 'NONE', thinking: { mode: 'none' }, cacheTtlRequested: 'NOT_APPLICABLE' },
    counter: { version: 'otk.local_counter.b3@1', L0: 42, status: 'ok', reasons: [], exploratoryFormulaEstimate: null }, estimateStatus: 'ESTIMATED',
    covariates: { task: 'summary', sizeBucket: 'S', structure: 'S1', hasSystem: false, nTurns: 1, family: 'UNKNOWN', L0: 42 }, profile: null, expectedCostUsd: 'UNKNOWN',
    priceSnapshot: { id: 'px', sha256: '3'.repeat(64), capturedUtc: '2026-10-01T00:00:00.000Z' }, costCap: { usd: '1570000000', basis: 'test', inputUpperBoundTokens: 1000, maxOutputTokens: 64, reasoningAllowanceTokens: 0, capBasis: { inputPriceMicro: '1000000', cacheWritePriceUsedMicro: '1250000', cacheWriteTtlUsed: '5m', outputPriceMicro: '5000000', roundedUpToMicroUsd: false } },
    budgetBefore: { provider: 'anthropic', spentUsd: '0', reservedUsd: '0', capUsd: '5000000000000' }, cachePlan: { arm: 'S1', directives: 'NONE', minPrefixTokens: 'UNKNOWN', expectedBehavior: 'single_message', cacheableTokens: 'NOT_APPLICABLE', nonceTokensDeclared: 'NOT_APPLICABLE' },
    maxTokens: 64, forecast: { label: 'NAO_REGISTRADA', premise: 'NO_CACHE_FULL_INPUT_PRICE', inM0: 42, outMax: 64, costMaxOut: 'NAO_REGISTRADA', outMean: 'NAO_REGISTRADA', outLearn: 'NAO_REGISTRADA', costSimple: 'NAO_REGISTRADA', costLearn: 'NAO_REGISTRADA', intervalSimple: 'NAO_REGISTRADA', intervalLearn: 'NAO_REGISTRADA', frozenSha256: 'NAO_REGISTRADA', priceMicroPerMTok: { input: 'UNKNOWN', output: 'UNKNOWN' } },
  });
}

test('R12 snapshot imutável: hash canônico; segunda escrita do mesmo operationId recusada (mesmo conteúdo idêntico); byte alterado ou hash alterado => TAMPERED', () => {
  const dir = tmp('snap'); mkdirSync(path.join(dir, 'snapshots'));
  const s = snap();
  assert.equal(s.snapshotSha256, sha256Canon({ ...s, snapshotSha256: undefined }));
  assert.ok(Object.isFrozen(s));
  writeSnapshot(dir, s);
  assert.throws(() => writeSnapshot(dir, s), (e: SnapshotError) => e.code === 'OVERWRITE_REFUSED');
  assert.throws(() => writeSnapshot(dir, sealSnapshot({ ...s, counter: { ...s.counter, L0: 43 } })), (e: SnapshotError) => e.code === 'OVERWRITE_REFUSED', 'nem com conteúdo novo');
  assert.deepEqual(readSnapshot(dir, s.operationId), s);
  const p = snapshotPath(dir, s.operationId);
  const txt = readFileSync(p, 'utf8');
  writeFileSync(p, txt.replace('"L0":42', '"L0":43'));
  assert.throws(() => readSnapshot(dir, s.operationId), (e: SnapshotError) => e.code === 'TAMPERED');
  writeFileSync(p, txt.replace(s.snapshotSha256, '0'.repeat(64)));
  assert.throws(() => readSnapshot(dir, s.operationId), (e: SnapshotError) => e.code === 'TAMPERED');
  writeFileSync(p, txt + ' ');
  assert.doesNotThrow(() => readSnapshot(dir, s.operationId), 'espaço fora do JSON não muda o objeto canônico');
  // a forged object with a self-consistent hash but a different operationId does not pass as this operation
  writeFileSync(p, JSON.stringify(snap('e'.repeat(64))));
  assert.throws(() => readSnapshot(dir, s.operationId), (e: SnapshotError) => e.code === 'TAMPERED');
});

test('journal: append+hash chain; buraco, reordenação, edição e hash falso são recusados; corpo com texto longo ou multi-linha é recusado', () => {
  const dir = tmp('journal'); const p = path.join(dir, 'journal.jsonl');
  const j = openJournal(p, () => '2026-11-10T00:00:00.000Z');
  j.append('PLANNED', 'a'.repeat(64), { batchId: 'b', n: 1 }); j.append('SENT', 'a'.repeat(64), { requestBodySha256: '1'.repeat(64) }); j.append('SETTLED', 'a'.repeat(64), { usd: '1' });
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  assert.equal(verifyJournalText(lines.join('\n')).length, 3);
  assert.throws(() => verifyJournalText([lines[0], lines[2]].join('\n')), (e: JournalIntegrityError) => e.code === 'seq');
  assert.throws(() => verifyJournalText([lines[1], lines[0], lines[2]].join('\n')), (e: JournalIntegrityError) => e.code === 'seq');
  assert.throws(() => verifyJournalText(lines.map((l) => l.replace('"n":1', '"n":2')).join('\n')), (e: JournalIntegrityError) => e.code === 'hash');
  const forged = JSON.parse(lines[1]!); forged.body = { requestBodySha256: '9'.repeat(64) }; forged.hash = sha256Canon({ ...forged, hash: undefined });
  assert.throws(() => verifyJournalText([lines[0], JSON.stringify(forged), lines[2]].join('\n')), (e: JournalIntegrityError) => e.code === 'chain', 'rehash de uma linha quebra a corrente seguinte');
  assert.throws(() => j.append('PLANNED', 'NONE', { text: 'x'.repeat(300) }), /content is never journaled/);
  assert.throws(() => j.append('PLANNED', 'NONE', { text: 'linha1\nlinha2' }), /content is never journaled/);
  const reopened = openJournal(p); assert.equal(reopened.seq, 3); assert.equal(reopened.lastHash, verifyJournalText(lines.join('\n'))[2]!.hash);
  writeFileSync(p, lines.slice(0, 2).join('\n') + '\n' + lines[2]!.replace('"usd":"1"', '"usd":"2"') + '\n');
  assert.throws(() => openJournal(p), JournalIntegrityError);
});

test('ledger: reserva antes, liquidação <= reserva, sub-ledgers independentes (sem transferência), teto por lote e campanha, UNCERTAIN fica possivelmente cobrado', () => {
  const dir = tmp('ledger');
  const L = openLedger(path.join(dir, 'ledger.jsonl'), { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, batchesUsd: { b1: '0.75' } }, () => '2026-11-10T00:00:00.000Z');
  assert.throws(() => L.reserve('op0', 'openai', 'b1', usdToPico('2.5')), (e: BudgetStop) => e.reason === 'STOP_BUDGET_BATCH', 'lote b1 (0.75 = 25% de 3) não comporta 2.5');
  L.reserve('op1', 'openai', 'b2', usdToPico('0.75')); L.reserve('op1b', 'openai', 'b3', usdToPico('0.75')); L.reserve('op1c', 'openai', 'b4', usdToPico('0.75')); L.reserve('op1d', 'openai', 'b5', usdToPico('0.25'));
  assert.throws(() => L.reserve('op2', 'openai', 'b6', usdToPico('0.6')), (e: BudgetStop) => e.reason === 'STOP_BUDGET_PROVIDER', 'openai cheio (2.5 + 0.6 > 3) mesmo com anthropic vazio');
  assert.throws(() => L.reserve('op1e', 'openai', 'b2', usdToPico('0.01')), (e: BudgetStop) => e.reason === 'STOP_BUDGET_BATCH', 'lote sem teto explícito = 25% do sub-ledger (0.75)');
  assert.throws(() => L.reserve('op3', 'anthropic', 'b1', usdToPico('0.76')), (e: BudgetStop) => e.reason === 'STOP_BUDGET_BATCH', 'lote b1 (0.75) não comporta 0.76');
  L.reserve('op3b', 'anthropic', 'b1', usdToPico('0.4')); L.release('op3b', 'anthropic', 'b1');
  assert.equal(L.pauseThresholdReached('openai', 80), true, '2.5 / 3 = 83% >= 80%');
  assert.equal(L.pauseThresholdReached('anthropic', 80), false);
  const Lx = openLedger(path.join(tmp('ledger-x'), 'ledger.jsonl'), { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, batchesUsd: { big: '2' } });
  assert.throws(() => Lx.reserve('x', 'openai', 'big', usdToPico('0.1')), (e: BudgetStop) => e.reason === 'STOP_BUDGET_BATCH' && e.detail['reason'] === 'batch_cap_above_25pct_of_provider', 'teto de lote acima de 25% do provedor é recusado');
  L.release('op1b', 'openai', 'b3'); L.release('op1c', 'openai', 'b4'); L.release('op1d', 'openai', 'b5');
  // from here: openai has op1 (0.75 reserved in b2)
  L.settle('op1', 'openai', 'b2', usdToPico('0.5'));
  assert.deepEqual([L.state().providers.openai.spentUsd, L.state().providers.openai.reservedUsd], [usdToPico('0.5').toString(), '0']);
  assert.throws(() => L.settle('op9', 'openai', 'b1', 1n), /without reservation/);
  L.reserve('op4', 'google', 'g1', usdToPico('0.75')); L.markUncertain('op4', 'google', 'g1');
  assert.deepEqual([L.state().providers.google.possiblyChargedUsd, L.state().providers.google.reservedUsd], [usdToPico('0.75').toString(), '0']);
  L.reserve('op5a', 'google', 'g2', usdToPico('0.75')); L.reserve('op5b', 'google', 'g3', usdToPico('0.75')); L.reserve('op5c', 'google', 'g4', usdToPico('0.75'));
  assert.throws(() => L.reserve('op5d', 'google', 'g5', usdToPico('0.01')), (e: BudgetStop) => e.reason === 'STOP_BUDGET_PROVIDER', 'google: 0.75 possivelmente cobrado + 3 × 0.75 reservados = 3.00; mais 0.01 estoura');
  L.release('op5a', 'google', 'g2'); L.release('op5b', 'google', 'g3'); L.release('op5c', 'google', 'g4');
  L.reserve('op6', 'anthropic', 'b7', usdToPico('1.25')); L.release('op6', 'anthropic', 'b7');
  assert.equal(L.state().providers.anthropic.reservedUsd, '0');
  const L2 = openLedger(path.join(dir, 'ledger.jsonl'), { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, batchesUsd: { b1: '0.75' } });
  assert.deepEqual(L2.state(), L.state(), 'replay do ledger.jsonl reconstrói o estado');
  L2.reserve('op7', 'anthropic', 'b9', usdToPico('1.25')); L2.reserve('op7b', 'anthropic', 'b10', usdToPico('1.25')); L2.reserve('op7c', 'anthropic', 'b11', usdToPico('1.25')); L2.reserve('op7d', 'anthropic', 'b12', usdToPico('1.2'));
  assert.throws(() => L2.reserve('op8', 'anthropic', 'b13', usdToPico('0.06')), (e: BudgetStop) => e.reason === 'STOP_BUDGET_PROVIDER', 'anthropic: 4.95 + 0.06 > 5');
});

test('ledger: campanha é um teto além dos sub-ledgers', () => {
  const dir = tmp('ledger2');
  const L = openLedger(path.join(dir, 'ledger.jsonl'), { campaignUsd: '1', providersUsd: { anthropic: '5', openai: '3', google: '3' } });
  L.reserve('a', 'anthropic', 'b', usdToPico('0.6'));
  assert.throws(() => L.reserve('b', 'openai', 'c', usdToPico('0.6')), (e: BudgetStop) => e.reason === 'STOP_BUDGET_CAMPAIGN');
  assert.equal(picoToUsdString(usdToPico('1.25')), '1.250000000000');
  assert.throws(() => usdToPico('1,25'), TypeError);
});

test('custo: UNKNOWN nunca vira 0; CALCULATED exige todas as categorias cobradas com contagem numérica e preço; teto pior caso; intervalo de cache', () => {
  const dir = tmp('cost'); const px = prices(dir);
  const cap = computeCostCap(px, { provider: 'anthropic', model: MODEL, api: 'anthropic.messages', inputUpperBoundTokens: 1000, maxOutputTokens: 64, reasoningAllowanceTokens: 0, atUtc: '2026-11-10T00:00:00.000Z' });
  assert.ok(!('error' in cap)); assert.equal(cap.usd, (1000n * 1_250_000n + 64n * 5_000_000n).toString());
  assert.deepEqual([cap.capBasis.cacheWriteTtlUsed, cap.capBasis.cacheWritePriceUsedMicro, cap.reasoningAllowanceTokens, cap.capBasis.roundedUpToMicroUsd], ['5m', '1250000', 0, false]);
  // allowance adds (maxOutput + allowance) × output; 1 024 tokens × 5.00 = 5_120_000_000 pico
  const capA = computeCostCap(px, { provider: 'anthropic', model: MODEL, api: 'anthropic.messages', inputUpperBoundTokens: 1000, maxOutputTokens: 64, reasoningAllowanceTokens: 1024, atUtc: '2026-11-10T00:00:00.000Z' });
  assert.ok(!('error' in capA)); assert.equal(BigInt(capA.usd) - BigInt(cap.usd), 1024n * 5_000_000n);
  // ceil to micro-USD: 3 tokens × 0.10 USD/MTok cache read is not in the cap, but 1 input token × 1.25 = 1_250_000 pico (exact); 1 token × 100_000 would round
  const capR = computeCostCap(prices(tmp('cost3')), { provider: 'anthropic', model: MODEL, api: 'anthropic.messages', inputUpperBoundTokens: 1, maxOutputTokens: 1, reasoningAllowanceTokens: 0, atUtc: '2026-11-10T00:00:00.000Z' });
  assert.ok(!('error' in capR)); assert.equal(BigInt(capR.usd) % 1_000_000n, 0n);
  const gem = computeCostCap(px, { provider: 'anthropic', model: MODEL, api: 'gemini.generate_content', inputUpperBoundTokens: 10, maxOutputTokens: 10, reasoningAllowanceTokens: 0, atUtc: '2026-11-10T00:00:00.000Z' });
  assert.ok('error' in gem && gem.missing.includes('reasoning_allowance_required_for_api'), 'raciocínio separado exige folga explícita > 0');
  const gem2 = computeCostCap(px, { provider: 'anthropic', model: MODEL, api: 'gemini.generate_content', inputUpperBoundTokens: 10, maxOutputTokens: 10, reasoningAllowanceTokens: 2048, atUtc: '2026-11-10T00:00:00.000Z' });
  // 10 × 1.25 + 2058 × 5.00 = 10_302_500_000 pico = 10302.5 micro-USD => ceil 10_303_000_000
  assert.ok(!('error' in gem2)); assert.equal(BigInt(gem2.usd), 10_303_000_000n); assert.equal(gem2.capBasis.roundedUpToMicroUsd, true);
  const missing = computeCostCap(prices(tmp('cost2'), { omit: ['input'] }), { provider: 'anthropic', model: MODEL, api: 'anthropic.messages', inputUpperBoundTokens: 10, maxOutputTokens: 10, reasoningAllowanceTokens: 0, atUtc: '2026-11-10T00:00:00.000Z' });
  assert.ok('error' in missing && missing.missing.includes('input'));
  const u = (over: Partial<NormalizedUsageH2>): NormalizedUsageH2 => validateUsage({ schema: H2EVAL_SCHEMA.usage, inputUncached: 100, cacheRead: 0, cacheWrite5m: 'NOT_APPLICABLE', cacheWrite1h: 'NOT_APPLICABLE', cacheWrite: 0, outputVisible: 10, reasoning: 'NOT_APPLICABLE', imageUnits: 'NOT_APPLICABLE', audioUnits: 'NOT_APPLICABLE', toolTokens: 'NOT_APPLICABLE', U: 100, usageCompleteness: 'COMPLETE', usageSource: 'provider_response', rawUsageSanitized: { input_tokens: 100 }, modelServed: MODEL, serviceTierServed: 'standard', cacheObserved: 'NO_HIT', stopReason: 'end_turn', completion: 'COMPLETE', outputTotal: 10, ...over, ...(over.cacheObserved ? {} : {}) });
  const base = { provider: 'anthropic', model: MODEL, api: 'anthropic.messages' as const, atUtc: '2026-11-10T00:00:00.000Z', capUsd: cap.usd, prefixTokens: 'UNKNOWN' as const, possiblyCharged: false };
  const c1 = computeCost(px, { ...base, usage: u({}) });
  assert.deepEqual([c1.state, c1.usd, c1.capCovered], ['CALCULATED', (100n * 1_000_000n + 10n * 5_000_000n).toString(), true]);
  const c2 = computeCost(px, { ...base, usage: u({ cacheRead: 'UNKNOWN', cacheObserved: 'UNKNOWN', usageCompleteness: 'PARTIAL' }) });
  const cR = computeCost(px, { ...base, usage: u({ reasoning: 7 }) });
  assert.equal(cR.usd, (100n * 1_000_000n + 17n * 5_000_000n).toString(), 'raciocínio (categoria disjunta) cobrado ao preço de saída');
  assert.equal(computeCost(px, { ...base, usage: u({ reasoning: 'UNKNOWN' }) }).usd, 'UNKNOWN', 'raciocínio desconhecido => custo desconhecido');
  assert.deepEqual([c2.state, c2.usd, c2.byCategory['cacheRead']], ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  const c3 = computeCost(px, { ...base, usage: null });
  assert.deepEqual([c3.state, c3.usd, c3.capCovered], ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  const hit = u({ cacheRead: 80, inputUncached: 20, U: 100, cacheObserved: 'HIT' });
  const c4 = computeCost(px, { ...base, usage: hit, prefixTokens: 80 });
  assert.equal(c4.usd, (20n * 1_000_000n + 80n * 100_000n + 10n * 5_000_000n).toString());
  assert.deepEqual([c4.cacheInterval.lowerUsd, c4.cacheInterval.upperUsd, c4.cacheInterval.inInterval], [(80n * 100_000n + 20n * 1_000_000n + 10n * 5_000_000n).toString(), (100n * 1_250_000n + 10n * 5_000_000n).toString(), true]);
});

test('classificação de cache pelo USO, não pela flag; validateUsage recusa tipos errados e cacheObserved incoerente', () => {
  const b = { cacheWrite5m: 'NOT_APPLICABLE' as const, cacheWrite1h: 'NOT_APPLICABLE' as const, usageCompleteness: 'COMPLETE' as const };
  assert.equal(cacheObservedOf({ ...b, cacheRead: 5, cacheWrite: 0 }), 'HIT');
  assert.equal(cacheObservedOf({ ...b, cacheRead: 0, cacheWrite: 7 }), 'CREATION');
  assert.equal(cacheObservedOf({ ...b, cacheRead: 0, cacheWrite: 0 }), 'NO_HIT');
  assert.equal(cacheObservedOf({ ...b, cacheRead: 0, cacheWrite: 'UNKNOWN' }), 'UNKNOWN');
  assert.equal(cacheObservedOf({ ...b, cacheRead: 3, cacheWrite: 'UNKNOWN' }), 'HIT');
  assert.equal(cacheObservedOf({ ...b, cacheRead: 3, cacheWrite: 0, usageCompleteness: 'PARTIAL' }), 'HIT', 'PARTIAL por falta de saída não esconde o cache observado');
  assert.equal(cacheObservedOf({ ...b, cacheRead: 3, cacheWrite: 0, usageCompleteness: 'MISSING' }), 'UNKNOWN');
  const ok: NormalizedUsageH2 = { schema: H2EVAL_SCHEMA.usage, inputUncached: 1, cacheRead: 0, cacheWrite5m: 'NOT_APPLICABLE', cacheWrite1h: 'NOT_APPLICABLE', cacheWrite: 0, outputVisible: 1, reasoning: 'NOT_APPLICABLE', imageUnits: 'NOT_APPLICABLE', audioUnits: 'NOT_APPLICABLE', toolTokens: 'NOT_APPLICABLE', U: 1, usageCompleteness: 'COMPLETE', usageSource: 'provider_response', rawUsageSanitized: {}, modelServed: 'm', serviceTierServed: 'UNKNOWN', cacheObserved: 'NO_HIT', stopReason: 'end_turn', completion: 'COMPLETE', outputTotal: 1 };
  assert.throws(() => validateUsage({ ...ok, inputUncached: -1 as unknown as number }), /inputUncached/);
  assert.throws(() => validateUsage({ ...ok, inputUncached: null as unknown as number }), /inputUncached/);
  assert.throws(() => validateUsage({ ...ok, cacheObserved: 'HIT' }), /cacheObserved/);
  assert.throws(() => validateUsage({ ...ok, rawUsageSanitized: { s: 'texto' as unknown as number } }), /rawUsageSanitized/);
  assert.ok(Object.isFrozen(validateUsage(ok)));
});

test('canon: chaves ordenadas, undefined removido, bigint como string; preço: ambiguidade ou ausência => null', () => {
  assert.equal(canon({ b: 1, a: [2, { d: undefined, c: 3n }] }), '{"a":[2,{"c":"3"}],"b":1}');
  const px = prices(tmp('px'));
  assert.equal(px.micro('anthropic', MODEL, 'input', '2026-11-10T00:00:00.000Z'), 1_000_000n);
  assert.equal(px.micro('anthropic', MODEL, 'input', '2025-01-01T00:00:00.000Z'), null, 'antes de effectiveFrom');
  assert.equal(px.micro('openai', 'x', 'input', '2026-11-10T00:00:00.000Z'), null);
  assert.equal(px.micro('anthropic', MODEL, 'input_cache_write_1h', '2026-11-10T00:00:00.000Z'), null);
});
