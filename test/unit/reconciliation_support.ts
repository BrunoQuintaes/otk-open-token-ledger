/**
 * Shared helpers for the Phase 10 reconciliation tests. Every OTK record built here is SYNTHETIC
 * (source 'fixture'); the only real OTK data are the pilot ledgers under test/fixtures/reconciliation/pilot_v3.
 */
import { readFileSync } from 'node:fs';
import { parsePriceTableV1 } from '../../src/pricing/priceUsage.js';
import type { PriceTableV1 } from '../../src/pricing/priceUsage.js';
import type { OtkRecord, ReconProvider, ReconciliationWindow, UsageCategory } from '../../src/reconciliation/types.js';
import type { OtkLoadResult } from '../../src/reconciliation/otkSource.js';

export const FX = 'test/fixtures/reconciliation';
export const read = (name: string): string => readFileSync(`${FX}/${name}`, 'utf8');
export const table = (path: string): PriceTableV1 => parsePriceTableV1(JSON.parse(readFileSync(path, 'utf8')));
export const V1 = (): PriceTableV1 => table(`${FX}/fixture_price_table_v1.json`);
export const V2 = (): PriceTableV1 => table(`${FX}/fixture_price_table_v2.json`);

const PRICE_CAT: Partial<Record<UsageCategory, string>> = { input: 'input', output: 'output', cache_read: 'input_cache_read', cache_write: 'input_cache_write' };

/** Synthetic OTK record; confirmed money = Σ count × price of `priceTable` (exact pico-USD). */
export function rec(
  operationId: string, provider: ReconProvider, model: string, observedAt: string,
  q: Partial<Record<UsageCategory, number>>, priceTable: PriceTableV1,
  opts: { returned?: string | null; requestId?: string | null; money?: bigint | null } = {},
): OtkRecord {
  const canon = priceTable.aliases[model] ?? model;
  let money = 0n;
  for (const [c, n] of Object.entries(q) as Array<[UsageCategory, number]>) {
    const pc = PRICE_CAT[c];
    if (!pc || n === 0) continue;
    const e = priceTable.entries.find((x) => x.provider === provider && x.model === canon && x.category === pc);
    if (!e) throw new Error(`no fixture price for ${provider}/${canon}/${pc}`);
    money += BigInt(n) * e.pricePerMTokMicroUsd;
  }
  return {
    source: 'fixture', tenantId: 'fixture-tenant', operationId, provider, modelRequested: model, modelReturned: opts.returned ?? null,
    providerRequestId: opts.requestId ?? null,
    quantities: (Object.entries(q) as Array<[UsageCategory, number]>).map(([category, n]) => ({ category, count: BigInt(n) })).sort((a, b) => a.category.localeCompare(b.category)),
    priceTableVersion: priceTable.version,
    confirmedMoney: opts.money === null ? null : { units: opts.money ?? money, scale: 1_000_000_000_000n },
    moneyState: 'settled', moneyOrigin: 'SYNTHETIC fixture record', moneyRoundingHalfUnits: 0n, observedAt, notes: [],
  };
}

export const load = (records: OtkRecord[]): OtkLoadResult => ({ records, excluded: [], digests: ['synthetic'], description: 'SYNTHETIC fixture OTK records (tests)' });

export const win = (provider: ReconProvider, start: string, end: string, timezone = 'UTC'): ReconciliationWindow => ({ provider, start, end, timezone, tenantId: 'fixture-tenant' });
