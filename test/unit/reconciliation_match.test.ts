/**
 * Phase 10 reconciliation — matcher classifications, timezone boundary, no amount-only matching,
 * aggregation awareness and idempotence. Provider statements are SYNTHETIC fixtures; OTK records are
 * SYNTHETIC (source 'fixture').
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importProviderStatement, reconcile, reportDigest, reportJson, reportMarkdown, validateMapping } from '../../src/reconciliation/index.js';
import type { Classification, OtkRecord, ReconciliationReport, UsageCategory } from '../../src/reconciliation/index.js';
import { load, read, rec, V1, V2, win } from './reconciliation_support.js';

const F = { declaredOrigin: 'FIXTURE' as const };
const H = 'claude-haiku-4-5';
const M = 'gpt-4o-mini';
const G = 'gemini-3.5-flash-lite';
const z = { cache_read: 0, cache_write: 0 };

const cls = (r: ReconciliationReport, day: string, cat: UsageCategory): Classification | undefined =>
  r.results.find((x) => (x.level === 'category' || x.level === 'request') && x.key.category === cat && (x.key.periodStart ?? '').startsWith(day))?.classification;

function anthropicRun(records: OtkRecord[], opts: { v2?: boolean; usage?: boolean } = {}): ReconciliationReport {
  const st = [importProviderStatement('anthropic', read('fixture_anthropic_cost_report.json'), 'anthropic_cost_report_json', F)];
  if (opts.usage !== false) st.push(importProviderStatement('anthropic', read('fixture_anthropic_usage_report.json'), 'anthropic_usage_report_json', F));
  return reconcile({ statements: st, otk: load(records), window: win('anthropic', '2026-10-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z'), priceTables: opts.v2 === false ? [V1()] : [V1(), V2()] });
}
const anthropicRecords = (): OtkRecord[] => {
  const v1 = V1();
  return [
    rec('A1', 'anthropic', H, '2026-10-01T10:00:00.000Z', { input: 1000, output: 200, ...z }, v1, { returned: 'claude-haiku-4-5-20251001' }),
    rec('A2', 'anthropic', H, '2026-10-01T15:00:00.000Z', { input: 500, output: 100, ...z }, v1),
    rec('C1', 'anthropic', H, '2026-10-02T12:00:00.000Z', { input: 1000, output: 100, ...z }, v1),
    rec('P1', 'anthropic', H, '2026-10-03T09:00:00.000Z', { input: 2000, output: 400, ...z }, v1),
    rec('M1', 'anthropic', H, '2026-10-05T08:00:00.000Z', { input: 300, output: 50, ...z }, v1),
  ];
};

function openaiRun(records: OtkRecord[], timingToleranceMs?: number): ReconciliationReport {
  const st = [
    importProviderStatement('openai', read('fixture_openai_costs.json'), 'openai_costs_json', F),
    importProviderStatement('openai', read('fixture_openai_usage_completions.json'), 'openai_usage_completions_json', F),
  ];
  return reconcile({ statements: st, otk: load(records), window: win('openai', '2026-10-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z'), priceTables: [V1()], ...(timingToleranceMs !== undefined ? { timingToleranceMs } : {}) });
}
const openaiRecords = (): OtkRecord[] => {
  const v1 = V1();
  return [
    rec('O1', 'openai', M, '2026-10-01T12:00:00.000Z', { input: 1000, output: 500, cache_read: 0 }, v1),
    rec('O2', 'openai', M, '2026-10-02T12:00:00.000Z', { input: 1234, output: 567, cache_read: 0 }, v1),
    rec('O3', 'openai', M, '2026-10-03T23:59:59.900Z', { input: 100, output: 10, cache_read: 0 }, v1),
  ];
};

describe('classifications (each one exercised by a synthetic fixture)', () => {
  it('Anthropic: MATCH, CACHE_CATEGORY, PRICE_VERSION, MISSING_OTK, MISSING_PROVIDER, UNKNOWN, non-token MISSING_OTK', () => {
    const r = anthropicRun(anthropicRecords());
    assert.equal(r.providerDataOrigin, 'FIXTURE');
    assert.equal(cls(r, '2026-10-01', 'input'), 'MATCH');
    assert.equal(cls(r, '2026-10-01', 'output'), 'MATCH');
    assert.equal(cls(r, '2026-10-02', 'input'), 'CACHE_CATEGORY');
    assert.equal(cls(r, '2026-10-02', 'cache_read'), 'CACHE_CATEGORY');
    assert.equal(cls(r, '2026-10-02', 'output'), 'MATCH');
    assert.equal(cls(r, '2026-10-03', 'input'), 'PRICE_VERSION');
    assert.equal(cls(r, '2026-10-03', 'output'), 'PRICE_VERSION');
    assert.match(r.results.find((x) => x.level === 'category' && x.classification === 'PRICE_VERSION')!.explanation, /fixture-prices-v2.*OTK priced with fixture-prices-v1/);
    assert.equal(cls(r, '2026-10-04', 'input'), 'MISSING_OTK');
    assert.equal(cls(r, '2026-10-05', 'input'), 'MISSING_PROVIDER');
    assert.equal(cls(r, '2026-10-05', 'output'), 'MISSING_PROVIDER');
    const web = r.results.find((x) => x.level === 'statement_line' && x.key.category === 'other')!;
    assert.equal(web.classification, 'MISSING_OTK');
    assert.match(web.explanation, /OTK does not meter it/);
    assert.equal(r.results.find((x) => x.key.model === 'claude-mystery-9')!.classification, 'UNKNOWN');
    const mp = r.results.filter((x) => x.level === 'model_period').map((x) => x.classification);
    assert.deepEqual(mp, ['MATCH', 'CACHE_CATEGORY', 'PRICE_VERSION', 'MISSING_OTK', 'MISSING_PROVIDER']);
  });

  it('PRICE_VERSION needs evidence: without the other table loaded the same row is UNMATCHED', () => {
    const r = anthropicRun(anthropicRecords(), { v2: false });
    assert.equal(cls(r, '2026-10-03', 'input'), 'UNMATCHED');
    assert.match(r.results.find((x) => x.level === 'category' && x.classification === 'UNMATCHED')!.explanation, /no timing, cache-split or price-version explanation/);
  });

  it('UNMATCHED with the zero rule: provider 0 and OTK > 0 has no relative difference', () => {
    const recs = anthropicRecords();
    recs[0] = rec('A1', 'anthropic', H, '2026-10-01T10:00:00.000Z', { input: 1000, output: 200, cache_read: 5, cache_write: 0 }, V1());
    const r = anthropicRun(recs);
    const row = r.results.find((x) => x.level === 'category' && x.key.category === 'cache_read' && x.key.periodStart?.startsWith('2026-10-01'))!;
    assert.equal(row.classification, 'UNMATCHED');
    assert.equal(row.quantity!.relDiff, null);
    assert.match(row.quantity!.relDiffNote ?? '', /provider count is zero/);
  });

  it('OpenAI: MODEL_ALIAS (dated snapshot), ROUNDING (provider amount rounded), TIMING_WINDOW (usage across midnight)', () => {
    const r = openaiRun(openaiRecords());
    assert.equal(cls(r, '2026-10-01', 'input'), 'MODEL_ALIAS');
    assert.equal(cls(r, '2026-10-01', 'output'), 'MODEL_ALIAS');
    assert.match(r.results.find((x) => x.level === 'category' && x.classification === 'MODEL_ALIAS')!.explanation, /gpt-4o-mini-2024-07-18/);
    assert.equal(cls(r, '2026-10-02', 'input'), 'ROUNDING');
    const rounding = r.results.find((x) => x.classification === 'ROUNDING' && x.level === 'category')!;
    assert.equal(rounding.amount!.otk, '0.000185100000');
    assert.equal(rounding.amount!.provider, '0.000200000000');
    assert.equal(cls(r, '2026-10-03', 'input'), 'TIMING_WINDOW');
    assert.equal(cls(r, '2026-10-04', 'input'), 'TIMING_WINDOW');
    assert.equal(cls(r, '2026-10-04', 'output'), 'TIMING_WINDOW');
    assert.match(r.results.find((x) => x.level === 'category' && x.classification === 'TIMING_WINDOW')!.explanation, /O3 observed 2026-10-03T23:59:59.900Z/);
    assert.equal(r.results.find((x) => x.key.model === 'mystery-model-x')!.classification, 'UNKNOWN');
  });

  it('TIMING_WINDOW only within the declared tolerance: with 0 ms the sides stay MISSING', () => {
    const r = openaiRun(openaiRecords(), 0);
    assert.equal(cls(r, '2026-10-03', 'input'), 'MISSING_PROVIDER');
    assert.equal(cls(r, '2026-10-04', 'input'), 'MISSING_OTK');
  });

  it('TIMING_WINDOW at the statement edge only: never into a covered period that shows nothing', () => {
    const v1 = V1();
    const edge = reconcile({
      statements: [importProviderStatement('anthropic', read('fixture_anthropic_cost_report_pilot_window.json'), 'anthropic_cost_report_json', F)],
      otk: load([rec('E1', 'anthropic', H, '2026-10-03T10:00:00.000Z', { input: 3700, output: 344 }, v1), rec('E2', 'anthropic', H, '2026-10-03T23:59:59.500Z', { input: 100, output: 20 }, v1)]),
      window: win('anthropic', '2026-10-03T00:00:00.000Z', '2026-10-04T00:00:00.000Z'), priceTables: [v1],
    });
    assert.equal(cls(edge, '2026-10-03', 'input'), 'TIMING_WINDOW');
    assert.match(edge.results.find((x) => x.level === 'category' && x.classification === 'TIMING_WINDOW')!.explanation, /E2 .* outside the statement periods/);
    const recs = [...anthropicRecords(), rec('E3', 'anthropic', H, '2026-10-04T23:59:59.500Z', { input: 10, output: 2 }, v1)];
    const inside = anthropicRun(recs);
    assert.equal(cls(inside, '2026-10-04', 'input'), 'UNMATCHED', '10-05 is covered (empty bucket): the provider says nothing was billed there');
  });

  it('OTK record with a model outside the alias table is UNKNOWN (never guessed)', () => {
    const recs = [...openaiRecords(), { ...rec('X1', 'openai', M, '2026-10-02T13:00:00.000Z', { input: 1 }, V1()), modelRequested: 'gpt-9-turbo' }];
    const r = openaiRun(recs);
    const row = r.results.find((x) => x.level === 'otk_record')!;
    assert.equal(row.classification, 'UNKNOWN');
    assert.deepEqual(row.otkOperationIds, ['X1']);
  });

  it('Gemini: taxes and credits separated from usage; other services kept out of scope', () => {
    const s = importProviderStatement('gemini', read('fixture_gemini_billing_export.csv'), 'gemini_billing_export_csv', F);
    const v1 = V1();
    const r = reconcile({ statements: [s], otk: load([rec('G1', 'gemini', G, '2026-10-04T03:57:22.000Z', { input: 10, output: 1 }, v1), rec('G2', 'gemini', G, '2026-10-04T03:58:10.000Z', { input: 84, output: 25 }, v1)]), window: win('gemini', '2026-10-03T00:00:00.000Z', '2026-10-06T00:00:00.000Z'), priceTables: [v1] });
    assert.equal(cls(r, '2026-10-04', 'input'), 'MODEL_ALIAS', 'SKU display name joined through the alias table');
    assert.equal(cls(r, '2026-10-04', 'output'), 'MODEL_ALIAS');
    assert.equal(r.totals.providerTax, '0.000012300000');
    assert.equal(r.totals.providerCredits, '-0.000028200000');
    assert.deepEqual(r.adjustments.map((a) => a.kind), ['credit', 'tax']);
    assert.equal(r.outOfScope.length, 1);
    assert.equal(r.results.filter((x) => x.classification === 'UNKNOWN').length, 1);
  });
});

describe('timezone boundary', () => {
  const v1 = V1();
  const recs = () => [rec('G1', 'gemini', G, '2026-10-04T03:57:22.000Z', { input: 10, output: 1 }, v1), rec('G2', 'gemini', G, '2026-10-04T03:58:10.000Z', { input: 84, output: 25 }, v1)];
  const run = (tz: string) => reconcile({
    statements: [importProviderStatement('gemini', read('fixture_gemini_reports_daily.csv'), 'gemini_reports_csv', { ...F, declaredTimezone: tz })],
    otk: load(recs()), window: win('gemini', '2026-10-03T00:00:00.000Z', '2026-10-06T00:00:00.000Z'), priceTables: [v1],
  });

  it('usage at 03:57 UTC on 10-04 belongs to the provider day 10-03 in Pacific time', () => {
    const r = run('America/Los_Angeles');
    assert.equal(cls(r, '2026-10-03T07:00', 'input'), 'MODEL_ALIAS');
    assert.equal(r.results.find((x) => x.level === 'total')!.classification, 'MATCH');
  });

  it('declaring the wrong zone (UTC) moves the day: records are not covered and the provider rows are MISSING_OTK', () => {
    const r = run('UTC');
    assert.equal(cls(r, '2026-10-03T00:00', 'input'), 'MISSING_OTK');
    assert.ok(r.excluded.some((x) => x.id === 'G1' && /outside the periods the statement covers/.test(x.reason)));
  });
});

describe('join rules', () => {
  it('never matches on amount alone: an OTK record with the same amount but another category does not absorb the provider line', () => {
    // provider 10-04: input 1000 tokens = US$ 0.001; OTK 10-04: 800 cache_write tokens × 1.25 USD/MTok = US$ 0.001 (same amount)
    const r = anthropicRun([rec('S1', 'anthropic', H, '2026-10-04T10:00:00.000Z', { cache_write: 800 }, V1())], { usage: false });
    const input = r.results.find((x) => x.level === 'category' && x.key.category === 'input' && x.key.periodStart?.startsWith('2026-10-04'))!;
    assert.equal(input.classification, 'MISSING_OTK');
    assert.deepEqual(input.otkOperationIds, []);
    const cw = r.results.find((x) => x.level === 'category' && x.key.category === 'cache_write' && x.key.periodStart?.startsWith('2026-10-04'))!;
    assert.equal(cw.classification, 'MISSING_PROVIDER');
    assert.equal(cw.amount!.otk, '0.001000000000');
    for (const m of r.matches) assert.ok(!m.joinedOn.some((f) => /amount|cost|value/.test(f)), m.joinedOn.join());
  });

  it('aggregate statements: the report states that per-operation matching is impossible', () => {
    const r = anthropicRun(anthropicRecords());
    assert.equal(r.aggregationLevel, 'aggregate');
    assert.match(r.aggregationNote, /per-operation matching is IMPOSSIBLE/);
    const g = r.matches.find((m) => m.groupId.includes('2026-10-01'))!;
    assert.deepEqual(g.otkOperationIds, ['A1', 'A2']);
    assert.equal(g.aggregationLevel, 'aggregate');
  });

  it('per-request statements (every line carries a request id) are matched per request', () => {
    const mapping = validateMapping({
      schema: 'otk.reconciliation_mapping.v1', id: 'synthetic_per_request_csv', provider: 'anthropic', format: 'csv', describes: 'SYNTHETIC per-request export used only by this test',
      provenance: { status: 'UNVERIFIED_ASSUMPTION', sources: [], unverified: ['synthetic test mapping'], notes: 'test only' },
      records: { kind: 'csv_rows', delimiter: ',' }, timestamps: { format: 'auto', declaredTimezone: null, note: '' },
      period: { start: 'start', end: 'end' }, model: { field: 'model' },
      category: { rules: [{ field: 'category', equals: 'input', category: 'input' }, { field: 'category', equals: 'output', category: 'output' }], fallback: 'unknown' },
      expand: null, subtractFromInput: [], quantity: { field: 'tokens', unit: 'tokens', unitField: null, allowedUnits: null },
      amount: { field: 'usd', divisor: '1', binaryFloat: false, precisionDecimals: null }, currency: { constant: 'USD' },
      requestId: { field: 'request_id' }, projectOrKey: [], kind: { rules: [] }, scope: null, credits: null, description: [],
    });
    const csv = '# SYNTHETIC per-request fixture (test only)\nrequest_id,start,end,model,category,tokens,usd\n'
      + 'req_A,2026-10-01T10:00:00Z,2026-10-01T10:00:01Z,claude-haiku-4-5,input,1000,0.001\n'
      + 'req_A,2026-10-01T10:00:00Z,2026-10-01T10:00:01Z,claude-haiku-4-5,output,200,0.001\n'
      + 'req_B,2026-10-01T11:00:00Z,2026-10-01T11:00:01Z,claude-haiku-4-5,input,10,0.00001\n';
    const s = importProviderStatement('anthropic', csv, mapping, F);
    const v1 = V1();
    const r = reconcile({
      statements: [s], priceTables: [v1], window: win('anthropic', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
      otk: load([
        rec('A', 'anthropic', H, '2026-10-01T10:00:00.500Z', { input: 1000, output: 200 }, v1, { requestId: 'req_A' }),
        rec('C', 'anthropic', H, '2026-10-01T10:00:00.700Z', { input: 5 }, v1, { requestId: 'req_C' }),
      ]),
    });
    assert.equal(r.aggregationLevel, 'per_request');
    const byReq = (rid: string, c: UsageCategory) => r.results.find((x) => x.level === 'request' && x.key.requestId === rid && x.key.category === c)?.classification;
    assert.equal(byReq('req_A', 'input'), 'MATCH');
    assert.equal(byReq('req_A', 'output'), 'MATCH');
    assert.equal(byReq('req_B', 'input'), 'MISSING_OTK');
    assert.equal(byReq('req_C', 'input'), 'MISSING_PROVIDER');
    assert.deepEqual(r.matches[0]!.joinedOn, ['provider', 'request_id', 'model', 'category']);
  });

  it('non-USD statements: tokens are compared, money is not converted with a float rate', () => {
    const csv = read('fixture_gemini_billing_export.csv').replace(/,USD,/g, ',BRL,');
    const s = importProviderStatement('gemini', csv, 'gemini_billing_export_csv', F);
    const v1 = V1();
    const r = reconcile({ statements: [s], otk: load([rec('G2', 'gemini', G, '2026-10-04T03:58:10.000Z', { input: 94, output: 26 }, v1)]), window: win('gemini', '2026-10-03T00:00:00.000Z', '2026-10-06T00:00:00.000Z'), priceTables: [v1] });
    const row = r.results.find((x) => x.level === 'category' && x.key.category === 'input')!;
    assert.equal(row.classification, 'MODEL_ALIAS');
    assert.equal(row.amount!.provider, null);
    assert.match(row.explanation, /BRL: amounts not compared/);
    assert.equal(r.totals.usage, null);
    assert.equal(r.totals.currency, 'BRL');
  });
});

describe('idempotence', () => {
  it('same input → same report bytes and digest; record order does not matter', () => {
    const a = reportJson(openaiRun(openaiRecords()));
    const b = reportJson(openaiRun(openaiRecords()));
    const c = reportJson(openaiRun([...openaiRecords()].reverse()));
    assert.equal(a, b);
    assert.equal(reportDigest(a), reportDigest(c));
    const md1 = reportMarkdown(anthropicRun(anthropicRecords()), 'x');
    const md2 = reportMarkdown(anthropicRun(anthropicRecords()), 'x');
    assert.equal(md1, md2);
    assert.match(md1, /FIXTURE \(SINTÉTICO\)/);
    assert.ok(!md1.includes('—'), 'no em dash in the generated report');
  });
});
