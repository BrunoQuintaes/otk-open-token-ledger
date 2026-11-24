/**
 * Phase 10 reconciliation — mapping-driven importers. All statements here are SYNTHETIC fixtures.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import {
  BUNDLED_MAPPING_IDS, importProviderStatement, loadMapping, MAPPINGS_DIR, StatementImportError,
} from '../../src/reconciliation/index.js';
import { importAnthropicStatement } from '../../src/reconciliation/importers/anthropic.js';
import { toDecimalString } from '../../src/reconciliation/decimal.js';
import type { StatementLine } from '../../src/reconciliation/types.js';
import { read } from './reconciliation_support.js';

const F = { declaredOrigin: 'FIXTURE' as const };
const usd = (l: StatementLine) => (l.amount ? toDecimalString(l.amount) : null);

describe('bundled mappings', () => {
  it('every mapping file validates and is listed; provenance is explicit', () => {
    const files = readdirSync(MAPPINGS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
    const listed = Object.values(BUNDLED_MAPPING_IDS).flat().sort();
    assert.deepEqual(files, listed);
    const status = Object.fromEntries(listed.map((id) => [id, loadMapping(id).provenance.status]));
    assert.deepEqual(status, {
      anthropic_console_csv: 'UNVERIFIED_ASSUMPTION',
      anthropic_cost_report_json: 'VERIFIED_OFFICIAL_DOC',
      anthropic_usage_report_json: 'VERIFIED_OFFICIAL_DOC',
      gemini_billing_export_csv: 'PARTIALLY_VERIFIED',
      gemini_billing_export_ndjson: 'PARTIALLY_VERIFIED',
      gemini_reports_csv: 'UNVERIFIED_ASSUMPTION',
      openai_costs_json: 'PARTIALLY_VERIFIED',
      openai_dashboard_csv: 'UNVERIFIED_ASSUMPTION',
      openai_usage_completions_json: 'PARTIALLY_VERIFIED',
    });
    for (const id of listed) {
      const m = loadMapping(id);
      for (const s of m.provenance.sources) assert.equal(s.accessedOn, '2026-10-06', `${id} source date`);
      if (m.provenance.status !== 'VERIFIED_OFFICIAL_DOC') assert.ok(m.provenance.unverified.length > 0, `${id} must list what is unverified`);
    }
  });

  it('a mapping of another provider is refused by the provider importer', () => {
    assert.throws(() => importAnthropicStatement(read('fixture_openai_costs.json'), 'openai_costs_json', F), (e: unknown) => e instanceof StatementImportError && e.code === 'PROVIDER_MISMATCH');
  });
});

describe('Anthropic importers (Admin API JSON, verified shape)', () => {
  it('cost_report: cents → USD exactly, token types → categories, non-token cost kept as other, unknown model kept', () => {
    const s = importProviderStatement('anthropic', read('fixture_anthropic_cost_report.json'), 'anthropic_cost_report_json', F);
    assert.equal(s.origin, 'FIXTURE');
    assert.match(s.syntheticMarker ?? '', /SYNTHETIC/);
    assert.equal(s.lines.length, 11);
    assert.equal(s.coverage.length, 1);
    assert.deepEqual(s.coverage[0], { start: '2026-10-01T00:00:00.000Z', end: '2026-10-06T00:00:00.000Z' }, 'the empty 10-05 bucket is still covered');
    const l1 = s.lines[0]!;
    assert.equal(l1.usageCategory, 'input');
    assert.equal(usd(l1), '0.0015');
    assert.equal(l1.amountPrecisionDecimals, 4);
    assert.equal(l1.periodStart, '2026-10-01T00:00:00.000Z');
    const cacheRead = s.lines.find((l) => l.usageCategory === 'cache_read')!;
    assert.equal(usd(cacheRead), '0.00008');
    const web = s.lines.find((l) => l.usageCategory === 'other')!;
    assert.equal(usd(web), '0.010');
    const unk = s.lines.find((l) => l.model === 'claude-mystery-9')!;
    assert.equal(unk.usageCategory, 'unknown');
    assert.match(unk.issues.join(), /not in alias table/);
  });

  it('usage_report: one line per category, no amount, uncached input kept as reported', () => {
    const s = importProviderStatement('anthropic', read('fixture_anthropic_usage_report.json'), 'anthropic_usage_report_json', F);
    const day2 = s.lines.filter((l) => l.periodStart === '2026-10-02T00:00:00.000Z');
    assert.deepEqual(day2.map((l) => [l.usageCategory, l.quantity]), [['input', 200n], ['output', 100n], ['cache_read', 800n], ['cache_write', 0n]]);
    assert.ok(day2.every((l) => l.amount === null && l.unit === 'tokens'));
  });
});

describe('OpenAI importers (Admin API JSON)', () => {
  it('costs: amount.value JSON number kept as lexeme, line_item → model + category, product prefix handled', () => {
    const s = importProviderStatement('openai', read('fixture_openai_costs.json'), 'openai_costs_json', F);
    const tiny = s.lines.find((l) => l.raw['amount.value'] === '1.5e-05')!;
    assert.equal(usd(tiny), '0.000015');
    assert.equal(tiny.canonicalModel, 'gpt-4o-mini');
    const alias = s.lines.find((l) => l.model === 'gpt-4o-mini-2024-07-18' && l.usageCategory === 'input')!;
    assert.equal(alias.canonicalModel, 'gpt-4o-mini');
    assert.match(alias.modelRule ?? '', /dated_snapshot/);
    assert.equal(alias.periodStart, '2026-10-01T00:00:00.000Z');
    assert.equal(s.lines.find((l) => /file search/.test(l.raw['line_item'] ?? ''))!.usageCategory, 'other');
    assert.equal(s.lines.find((l) => l.model === 'mystery-model-x')!.usageCategory, 'unknown');
    assert.ok(s.lines.every((l) => l.currency === 'USD'));
  });

  it('usage/completions: input = input_tokens − input_cached_tokens (documented inclusion)', () => {
    const doc = JSON.parse(read('fixture_openai_usage_completions.json'));
    doc.data[1].results[0].input_cached_tokens = 1034;
    const s = importProviderStatement('openai', JSON.stringify(doc), 'openai_usage_completions_json', F);
    const d2 = s.lines.filter((l) => l.periodStart === '2026-10-02T00:00:00.000Z');
    assert.deepEqual(d2.map((l) => [l.usageCategory, l.quantity]), [['input', 200n], ['cache_read', 1034n], ['output', 567n]]);
  });
});

describe('Gemini importers (Cloud Billing export)', () => {
  it('CSV: tax and credit separated, other service kept out of scope, unknown SKU kept, nothing dropped', () => {
    const s = importProviderStatement('gemini', read('fixture_gemini_billing_export.csv'), 'gemini_billing_export_csv', F);
    assert.equal(s.lines.length, 6, 'one line per source row');
    const kinds = s.lines.map((l) => [l.kind, l.inScope, l.usageCategory]);
    assert.deepEqual(kinds, [['usage', true, 'input'], ['usage', true, 'output'], ['credit', true, 'input'], ['tax', true, 'unknown'], ['usage', true, 'unknown'], ['usage', false, 'other']]);
    assert.equal(s.lines[2]!.isCredit, true);
    assert.equal(usd(s.lines[2]!), '-0.0000282');
    assert.equal(s.lines[3]!.isTax, true);
    assert.equal(s.lines[0]!.quantity, 94n);
    assert.equal(s.lines[0]!.canonicalModel, 'gemini-3.5-flash-lite');
    assert.match(s.lines[5]!.issues.join(), /not recognized as tokens/);
  });

  it('NDJSON: each credits[] element becomes a credit line; float costs read from the lexeme', () => {
    const s = importProviderStatement('gemini', read('fixture_gemini_billing_export.ndjson'), 'gemini_billing_export_ndjson', F);
    assert.equal(s.origin, 'FIXTURE');
    assert.deepEqual(s.lines.map((l) => [l.kind, l.usageCategory, usd(l)]), [['usage', 'input', '0.0000282'], ['credit', 'other', '-0.0000282'], ['usage', 'output', '0.000065']]);
    assert.equal(s.lines[0]!.periodStart, '2026-10-04T03:00:00.000Z');
  });

  it('daily CSV with naive dates: rejected without a declared timezone, imported with one', () => {
    assert.throws(() => importProviderStatement('gemini', read('fixture_gemini_reports_daily.csv'), 'gemini_reports_csv', F), (e: unknown) => e instanceof StatementImportError && e.code === 'AMBIGUOUS_TIMESTAMP');
    const s = importProviderStatement('gemini', read('fixture_gemini_reports_daily.csv'), 'gemini_reports_csv', { ...F, declaredTimezone: 'America/Los_Angeles' });
    assert.equal(s.lines[0]!.periodStart, '2026-10-03T07:00:00.000Z');
    assert.equal(s.lines[0]!.periodEnd, '2026-10-04T07:00:00.000Z');
    assert.equal(s.period.declaredTimezone, 'America/Los_Angeles');
  });
});

describe('import safety', () => {
  it('a header that does not match the mapping is refused with the real header listed (no silent guess)', () => {
    const csv = 'Date,Model,Cost\n2026-10-01,claude-haiku-4-5,0.01\n';
    assert.throws(() => importProviderStatement('anthropic', csv, 'anthropic_console_csv', { declaredOrigin: 'REAL', declaredTimezone: 'UTC' }),
      (e: unknown) => e instanceof StatementImportError && e.code === 'MISSING_COLUMNS' && /"Date","Model","Cost"/.test(e.message));
  });

  it('a synthetic marker forces FIXTURE and conflicts with a REAL declaration', () => {
    assert.throws(() => importProviderStatement('anthropic', read('fixture_anthropic_cost_report.json'), 'anthropic_cost_report_json', { declaredOrigin: 'REAL' }),
      (e: unknown) => e instanceof StatementImportError && e.code === 'ORIGIN_CONFLICT');
    const clean = JSON.parse(read('fixture_anthropic_cost_report.json'));
    delete clean._synthetic;
    assert.equal(importProviderStatement('anthropic', JSON.stringify(clean), 'anthropic_cost_report_json', F).origin, 'FIXTURE', 'declared FIXTURE stays FIXTURE');
  });

  it('UNVERIFIED templates import their fixtures once a timezone is declared', () => {
    const a = importProviderStatement('anthropic', read('fixture_anthropic_console.csv'), 'anthropic_console_csv', { ...F, declaredTimezone: 'UTC' });
    assert.deepEqual(a.lines.map((l) => [l.usageCategory, usd(l)]), [['input', '0.0015'], ['output', '0.0015']]);
    assert.equal(a.mappingProvenance.status, 'UNVERIFIED_ASSUMPTION');
    const o = importProviderStatement('openai', read('fixture_openai_dashboard.csv'), 'openai_dashboard_csv', { ...F, declaredTimezone: 'UTC' });
    assert.deepEqual(o.lines.map((l) => [l.canonicalModel, l.usageCategory]), [['gpt-4o-mini', 'input'], ['gpt-4o-mini', 'output']]);
  });

  it('same bytes and mapping → identical statement and digest', () => {
    const x = importProviderStatement('gemini', read('fixture_gemini_billing_export.csv'), 'gemini_billing_export_csv', F);
    const y = importProviderStatement('gemini', read('fixture_gemini_billing_export.csv'), 'gemini_billing_export_csv', F);
    const ser = (v: unknown) => JSON.stringify(v, (_k, z) => (typeof z === 'bigint' ? z.toString() : z));
    assert.equal(ser(x), ser(y));
    assert.match(x.sourceDigest, /^[0-9a-f]{64}$/);
  });
});
