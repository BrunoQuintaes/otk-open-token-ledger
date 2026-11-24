/**
 * Phase 10 reconciliation — OTK side: the REAL pilot ledgers (read-only copies, OTK computed cost, not
 * provider data), the PostgreSQL loader (fake pool), an offline run of the real ledger against a clearly
 * labelled FIXTURE statement, and the CLI (deterministic output, guards for REAL data).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  importProviderStatement, loadOtkFromFixtureJson, loadOtkFromPilotLedger, loadOtkFromPostgres, reconcile, reportDigest, reportJson, reportMarkdown,
} from '../../src/reconciliation/index.js';
import type { OtkLoadResult } from '../../src/reconciliation/index.js';
import { toDecimalString, sumAmounts } from '../../src/reconciliation/decimal.js';
import type { PgQueryable } from '../../src/operations/schema.js';
import { FX, read, table } from './reconciliation_support.js';

const PV = `${FX}/pilot_v3`;
const T_ANTH = table('scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json');
const T_OAI = table('scripts/pilot/price_table_pilot_v3_20261003.json');
const T_GEM = table('scripts/pilot/price_table_pilot_v3_gemini35_20261004.json');
const ledger = (file: string, provider: 'anthropic' | 'openai' | 'gemini', ver: string): OtkLoadResult =>
  loadOtkFromPilotLedger(read(`pilot_v3/${file}`), { sourceName: file, provider, priceTableVersion: ver, tenantId: 'pilot-v3' });
const total = (l: OtkLoadResult) => toDecimalString(sumAmounts(l.records.map((r) => r.confirmedMoney!))!);

describe('REAL pilot ledgers as the OTK side (computed cost, not reconciled with any provider)', () => {
  const a = ledger('real_otk_pilot_v3_anthropic_ledger_20261003.jsonl', 'anthropic', T_ANTH.version);
  const o = ledger('real_otk_pilot_v3_openai_ledger_20261003.jsonl', 'openai', T_OAI.version);
  const g = ledger('real_otk_pilot_v3_gemini_ledger_20261004.jsonl', 'gemini', T_GEM.version);

  it('8 settled calls per provider; the refused Gemini 2.5 reservation is excluded with its reason', () => {
    assert.deepEqual([a.records.length, o.records.length, g.records.length], [8, 8, 8]);
    assert.equal(g.excluded.length, 1);
    assert.match(g.excluded[0]!.reason, /outcome "refused" \(http 404\)/);
    assert.ok(a.records.every((r) => r.provider === 'anthropic' && r.source === 'pilot_ledger'));
  });

  it('computed totals match the audited figures (US$ 0.005420 + 0.0004323 + 0.0016951 = 0.0075474), in exact pico-USD', () => {
    assert.equal(total(a), '0.005420000000');
    assert.equal(total(o), '0.000432300000');
    assert.equal(total(g), '0.001695100000');
    const all = sumAmounts([a, o, g].flatMap((l) => l.records.map((r) => r.confirmedMoney!)))!;
    assert.equal(all.units, 7_547_400_000n);
    const rounded = a.records.filter((r) => r.moneyRoundingHalfUnits > 0n).map((r) => r.notes.find((n) => n.includes('rounded')));
    assert.ok(rounded.length >= 1 && rounded.every((n) => /0\.0008320000000000001|0\.0019130000000000002/.test(n ?? '')), 'float noise in the ledger is rounded and reported');
  });

  it('OpenAI cached call: ledger input is the UNCACHED part; cache read priced separately', () => {
    const cached = o.records.find((r) => r.quantities.some((q) => q.category === 'cache_read' && q.count === 1152n))!;
    assert.deepEqual(cached.quantities.map((q) => [q.category, q.count]), [['cache_read', 1152n], ['cache_write', 0n], ['input', 126n], ['output', 28n]]);
    assert.equal(toDecimalString(cached.confirmedMoney!), '0.000122100000');
  });

  it('each ledger is self-consistent with its frozen price table (no confirmed vs per-category warning)', () => {
    for (const [l, t, p] of [[a, T_ANTH, 'anthropic'], [o, T_OAI, 'openai'], [g, T_GEM, 'gemini']] as const) {
      const r = reconcile({ statements: [], otk: l, priceTables: [t], window: { provider: p, start: '2026-10-03T00:00:00.000Z', end: '2026-10-05T00:00:00.000Z', timezone: 'UTC', tenantId: 'pilot-v3' } });
      assert.ok(!r.warnings.some((w) => /differs from its per-category recomputation/.test(w)), `${p}: ${r.warnings.join(' | ')}`);
      assert.equal(r.providerDataOrigin, 'FIXTURE', 'no provider statement → never labelled REAL');
      assert.ok(r.results.filter((x) => x.level === 'category').every((x) => ['MISSING_PROVIDER', 'MATCH'].includes(x.classification)));
    }
  });

  it('offline run: REAL pilot ledger (OTK side) vs a FIXTURE statement derived from it, clearly labelled', () => {
    const s = importProviderStatement('anthropic', read('fixture_anthropic_cost_report_pilot_window.json'), 'anthropic_cost_report_json', { declaredOrigin: 'FIXTURE' });
    const r = reconcile({ statements: [s], otk: a, priceTables: [T_ANTH], window: { provider: 'anthropic', start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z', timezone: 'UTC', tenantId: 'pilot-v3' } });
    assert.equal(r.providerDataOrigin, 'FIXTURE');
    assert.equal(r.otkSource.kind, 'pilot_ledger');
    assert.equal(r.aggregationLevel, 'aggregate');
    const tot = r.results.find((x) => x.level === 'total')!;
    assert.equal(tot.amount!.otk, '0.005420000000');
    assert.equal(tot.amount!.provider, '0.005420000000');
    const inp = r.results.find((x) => x.level === 'category' && x.key.category === 'input')!;
    assert.equal(inp.classification, 'MODEL_ALIAS', 'ledger model claude-haiku-4-5-20251001 vs statement claude-haiku-4-5');
    assert.equal(inp.otkOperationIds.length, 8);
    const md = reportMarkdown(r, reportDigest(reportJson(r)));
    assert.match(md, /Dados do provedor: FIXTURE \(SINTÉTICO\)/);
    assert.match(md, /DERIVED FROM OTK's own pilot ledger/);
    assert.ok(!/fatura/i.test(md), 'the computed cost is never called an invoice');
  });
});

describe('PostgreSQL loader (fake pool: no database needed)', () => {
  it('reads usage categories with their inclusion rules and the confirmed money axis', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const pool: PgQueryable = {
      async query(text: string, params?: unknown[]) {
        calls.push({ text, params: params ?? [] });
        const rows = [
          {
            operation_id: 'op-1', provider: 'openai', model_requested: 'gpt-4o-mini', provider_request_id: 'req_1', created_at: new Date('2026-10-03T23:59:00Z'), config: {},
            usage: { observedAt: '2026-10-03T23:59:06.692Z', completeness: 'complete', modelReturned: 'gpt-4o-mini-2024-07-18', categories: [
              { name: 'input', count: '1278', inclusion: 'base' }, { name: 'input_cache_read', count: '1152', inclusion: 'subset_of_input' },
              { name: 'output', count: '28', inclusion: 'base' }, { name: 'output_reasoning', count: '0', inclusion: 'subset_of_output' }] },
            money: { state: 'settled', confirmed: { units: '122100000', scale: '1000000000000', currency: 'USD' }, priceTable: { version: 'pilot-v3-x', digest: '0x00' } },
          },
          {
            operation_id: 'op-2', provider: 'openai', model_requested: 'gpt-4o-mini', provider_request_id: null, created_at: '2026-10-03T12:00:00.000Z', config: { priceTable: { version: 'cfg-v' } },
            usage: null, money: { state: 'held_uncertain', confirmed: null, priceTable: null },
          },
        ];
        return { rows: rows as never[], rowCount: rows.length };
      },
    };
    const l = await loadOtkFromPostgres(pool, { tenantId: 't1', provider: 'openai', start: '2026-10-03T00:00:00.000Z', end: '2026-10-04T00:00:00.000Z' });
    assert.deepEqual(calls[0]!.params, ['t1', 'openai', '2026-10-03T00:00:00.000Z', '2026-10-04T00:00:00.000Z']);
    assert.match(calls[0]!.text, /FROM otk_operations o\s+WHERE o.tenant_id = \$1 AND o.provider = \$2/);
    const [r1, r2] = l.records;
    assert.deepEqual(r1!.quantities.map((q) => [q.category, q.count]), [['cache_read', 1152n], ['input', 126n], ['output', 28n], ['thinking', 0n]]);
    assert.equal(r1!.modelReturned, 'gpt-4o-mini-2024-07-18');
    assert.equal(r1!.priceTableVersion, 'pilot-v3-x');
    assert.equal(toDecimalString(r1!.confirmedMoney!), '0.000122100000');
    assert.equal(r1!.observedAt, '2026-10-03T23:59:06.692Z');
    assert.equal(r2!.confirmedMoney, null, 'an unsettled operation has no confirmed money (never 0)');
    assert.equal(r2!.moneyState, 'held_uncertain');
    assert.equal(r2!.priceTableVersion, 'cfg-v');
    assert.ok(r2!.notes.includes('no usage recorded (measurement missing)'));
  });
});

describe('CLI scripts/reconciliation/reconcile.ts', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/reconciliation/reconcile.ts', ...args], { encoding: 'utf8' });
  const base = [
    '--provider=anthropic', '--origin=FIXTURE',
    `--statement=${FX}/fixture_anthropic_cost_report_pilot_window.json`, '--mapping=anthropic_cost_report_json',
    `--otk-ledger=${PV}/real_otk_pilot_v3_anthropic_ledger_20261003.jsonl`, `--ledger-price-table-version=${T_ANTH.version}`,
    '--price-table=scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json',
    '--window-start=2026-10-03T00:00:00Z', '--window-end=2026-10-04T00:00:00Z',
  ];

  it('writes JSON + Markdown + sha256; two runs give identical bytes', () => {
    const d1 = mkdtempSync(join(tmpdir(), 'otk-recon-'));
    const d2 = mkdtempSync(join(tmpdir(), 'otk-recon-'));
    try {
      const r1 = cli([...base, `--out-dir=${d1}`]);
      const r2 = cli([...base, `--out-dir=${d2}`]);
      assert.equal(r1.status, 0, r1.stderr);
      assert.equal(r2.status, 0, r2.stderr);
      const j1 = readFileSync(join(d1, 'reconciliation_anthropic_FIXTURE.json'), 'utf8');
      assert.equal(j1, readFileSync(join(d2, 'reconciliation_anthropic_FIXTURE.json'), 'utf8'));
      assert.equal(readFileSync(join(d1, 'reconciliation_anthropic_FIXTURE.json.sha256'), 'utf8').split(' ')[0], reportDigest(j1));
      const md = readFileSync(join(d1, 'reconciliation_anthropic_FIXTURE.md'), 'utf8');
      assert.match(md, /\| OTK \| PROVIDER \| ABS_DIFF \| REL_DIFF \| EXPLANATION \|/);
      assert.match(r1.stdout, /provider data: FIXTURE/);
    } finally {
      rmSync(d1, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true });
    }
  });

  it('documented FIXTURE scenarios (synthetic statements + synthetic OTK records) reproduce every classification', () => {
    const d = mkdtempSync(join(tmpdir(), 'otk-recon-'));
    const common = ['--origin=FIXTURE', `--price-table=${FX}/fixture_price_table_v1.json`, `--out-dir=${d}`];
    const runs: Array<[string, string[], string]> = [
      ['anthropic', [`--statement=${FX}/fixture_anthropic_cost_report.json`, '--mapping=anthropic_cost_report_json', `--statement=${FX}/fixture_anthropic_usage_report.json`, '--mapping=anthropic_usage_report_json', `--price-table=${FX}/fixture_price_table_v2.json`, '--window-start=2026-10-01T00:00:00Z', '--window-end=2026-10-06T00:00:00Z'], 'CACHE_CATEGORY=2 PRICE_VERSION=2 MISSING_OTK=3 MISSING_PROVIDER=2 UNKNOWN=1'],
      ['openai', [`--statement=${FX}/fixture_openai_costs.json`, '--mapping=openai_costs_json', `--statement=${FX}/fixture_openai_usage_completions.json`, '--mapping=openai_usage_completions_json', '--window-start=2026-10-01T00:00:00Z', '--window-end=2026-10-06T00:00:00Z'], 'ROUNDING=2 TIMING_WINDOW=4 MODEL_ALIAS=3 MISSING_OTK=1 UNKNOWN=1'],
      ['gemini', [`--statement=${FX}/fixture_gemini_reports_daily.csv`, '--mapping=gemini_reports_csv', '--declared-timezone=America/Los_Angeles', '--window-start=2026-10-03T00:00:00Z', '--window-end=2026-10-06T00:00:00Z'], 'MODEL_ALIAS=2'],
    ];
    try {
      for (const [p, args, expected] of runs) {
        const r = cli([`--provider=${p}`, ...common, ...args, `--otk-fixture=${FX}/fixture_otk_records_${p}.json`]);
        assert.equal(r.status, 0, r.stderr);
        for (const part of expected.split(' ')) assert.match(r.stdout, new RegExp(`\\b${part}\\b`), `${p}: ${r.stdout}`);
        assert.match(readFileSync(join(d, `reconciliation_${p}_FIXTURE.md`), 'utf8'), /Lado OTK: SINTÉTICO/);
      }
      const realWithFixtureOtk = cli(['--provider=gemini', '--origin=REAL', `--statement=${FX}/fixture_gemini_reports_daily.csv`, '--mapping=gemini_reports_csv', `--otk-fixture=${FX}/fixture_otk_records_gemini.json`, '--window-start=2026-10-03T00:00:00Z', '--window-end=2026-10-06T00:00:00Z', `--out-dir=${d}`]);
      assert.equal(realWithFixtureOtk.status, 2);
      assert.throws(() => loadOtkFromFixtureJson('{"records":[]}', 'x.json'), /without a "_synthetic" marker/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('guards REAL runs: fixture file names, synthetic markers and unverified mappings are refused', () => {
    const d = mkdtempSync(join(tmpdir(), 'otk-recon-'));
    try {
      const realArgs = base.map((x) => (x === '--origin=FIXTURE' ? '--origin=REAL' : x));
      const named = cli([...realArgs, `--out-dir=${d}`]);
      assert.equal(named.status, 2);
      assert.match(named.stderr, /named as a fixture/);
      const renamed = join(d, 'cost_report_export.json');
      writeFileSync(renamed, read('fixture_anthropic_cost_report_pilot_window.json'));
      const marker = cli([...realArgs.map((x) => (x.startsWith('--statement=') ? `--statement=${renamed}` : x)), `--out-dir=${d}`]);
      assert.equal(marker.status, 3);
      assert.match(marker.stderr, /ORIGIN_CONFLICT/);
      const consoleCsv = join(d, 'console_export.csv');
      writeFileSync(consoleCsv, read('fixture_anthropic_console.csv').split('\n').slice(1).join('\n'));
      const unverified = cli([...realArgs.map((x) => (x.startsWith('--statement=') ? `--statement=${consoleCsv}` : x.startsWith('--mapping=') ? '--mapping=anthropic_console_csv' : x)), '--declared-timezone=UTC', `--out-dir=${d}`]);
      assert.equal(unverified.status, 2);
      assert.match(unverified.stderr, /UNVERIFIED_ASSUMPTION/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
