/**
 * Shared helpers for the Phase 10 reconciliation tests. Every OTK record built here is SYNTHETIC
 * (source 'fixture'); the only real OTK data are the pilot ledgers under test/fixtures/reconciliation/pilot_v3.
 *
 * Used by `reconciliation_importers.test.ts`, `reconciliation_match.test.ts` and
 * `reconciliation_otk_side.test.ts`. It is not a test file itself. Paths are relative to the repository root,
 * so the tests must be run from there.
 *
 * @module test/unit/reconciliation_support
 */
import { readFileSync } from 'node:fs';
import { parsePriceTableV1 } from '../../src/pricing/priceUsage.js';
import type { PriceTableV1 } from '../../src/pricing/priceUsage.js';
import type { OtkRecord, ReconProvider, ReconciliationWindow, UsageCategory } from '../../src/reconciliation/types.js';
import type { OtkLoadResult } from '../../src/reconciliation/otkSource.js';

/** Fixture directory of the reconciliation tests, relative to the repository root. */
export const FX = 'test/fixtures/reconciliation';
/**
 * Reads one fixture file as UTF-8 text.
 * @param name - File name (or sub-path) inside {@link FX}.
 * @returns The file content.
 * @throws {Error} When the file does not exist (the `readFileSync` error).
 */
export const read = (name: string): string => readFileSync(`${FX}/${name}`, 'utf8');
/**
 * Loads and validates a price table file.
 * @param path - Path of the JSON price table, relative to the repository root.
 * @returns The parsed table.
 * @throws {Error} When the file is missing, is not JSON or fails the price table validation.
 */
export const table = (path: string): PriceTableV1 => parsePriceTableV1(JSON.parse(readFileSync(path, 'utf8')));
/**
 * Fixture price table version 1 (synthetic prices).
 * @returns A freshly parsed table on each call.
 */
export const V1 = (): PriceTableV1 => table(`${FX}/fixture_price_table_v1.json`);
/**
 * Fixture price table version 2 (synthetic prices), used for the price-version classification.
 * @returns A freshly parsed table on each call.
 */
export const V2 = (): PriceTableV1 => table(`${FX}/fixture_price_table_v2.json`);

const PRICE_CAT: Partial<Record<UsageCategory, string>> = { input: 'input', output: 'output', cache_read: 'input_cache_read', cache_write: 'input_cache_write' };

/**
 * Synthetic OTK record; confirmed money = Σ count × price of `priceTable` (exact pico-USD).
 *
 * @param operationId - Operation id of the record.
 * @param provider - Provider of the record.
 * @param model - Requested model; resolved through the table aliases when pricing.
 * @param observedAt - ISO-8601 instant of the usage.
 * @param q - Token count per usage category; zero counts are kept as quantities but not priced.
 * @param priceTable - Table used to price the counts; its version is written on the record.
 * @param opts - Optional returned model and provider request id (default `null`), and `money` to override
 *   the computed amount (in pico-USD) or `null` for a record without confirmed money.
 * @returns A record with source `fixture`, tenant `fixture-tenant` and money state `settled`.
 * @throws {Error} When the table has no price for a counted category of this provider and model.
 */
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

/**
 * Wraps synthetic records as an OTK load result with no exclusions.
 * @param records - Records to return as loaded.
 * @returns The load result, labelled as synthetic.
 */
export const load = (records: OtkRecord[]): OtkLoadResult => ({ records, excluded: [], digests: ['synthetic'], description: 'SYNTHETIC fixture OTK records (tests)' });

/**
 * Reconciliation window for the fixture tenant.
 * @param provider - Provider of the window.
 * @param start - Window start (ISO-8601), as accepted by the reconciliation window.
 * @param end - Window end (ISO-8601).
 * @param timezone - Declared IANA zone of the statement; `UTC` by default.
 * @returns The window object.
 */
export const win = (provider: ReconProvider, start: string, end: string, timezone = 'UTC'): ReconciliationWindow => ({ provider, start, end, timezone, tenantId: 'fixture-tenant' });
