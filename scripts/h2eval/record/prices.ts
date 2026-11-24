/**
 * Price table reader (schema otk.price_table.v1, same as scripts/pilot/price_table_*.json of the H1; read-only, never edited).
 * Prices are micro-USD per MTok as decimal strings; pico-USD cost of N tokens = N × micro (exact integer).
 * Missing price for a needed category => null (callers turn that into STOP_PRICE_UNKNOWN / cost UNKNOWN; never 0).
 */
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../core/canon.js';

export type PriceCategory = 'input' | 'output' | 'input_cache_read' | 'input_cache_write' | 'input_cache_write_1h' | 'output_reasoning' | 'input_audio' | 'input_image';

export interface PriceEntry { provider: string; model: string; category: string; pricePerMTokMicroUsd: string; effectiveFrom: string; effectiveUntil: string | null; source?: string }
export interface PriceTable {
  id: string; sha256: string; capturedUtc: string; schema: string; currency: string;
  /** micro-USD per MTok (BigInt) or null when the category is not priced for that model at `atUtc`. `promptTokensHint` selects the
   * tier of tables priced by prompt length (ignored by flat tables); callers pass the input upper bound (cap) or the observed U (cost). */
  micro(provider: string, model: string, category: PriceCategory, atUtc: string, promptTokensHint?: number): bigint | null;
  entries: readonly PriceEntry[];
}

export function loadPriceTable(path: string): PriceTable {
  const raw = readFileSync(path);
  const j = JSON.parse(raw.toString('utf8')) as { schema: string; version: string; currency: string; entries: PriceEntry[]; capturedUtc?: string };
  if (j.schema !== 'otk.price_table.v1' || !Array.isArray(j.entries)) throw new TypeError('price table: unexpected schema');
  if (j.currency !== 'USD') throw new TypeError('price table: currency must be USD');
  const sha256 = sha256Hex(raw);
  const capturedUtc = j.capturedUtc ?? j.entries.map((e) => e.effectiveFrom).sort().at(-1) ?? 'UNKNOWN';
  const micro = (provider: string, model: string, category: PriceCategory, atUtc: string): bigint | null => {
    const t = Date.parse(atUtc);
    const hits = j.entries.filter((e) => e.provider === provider && e.model === model && e.category === category && Date.parse(e.effectiveFrom) <= t && (e.effectiveUntil === null || Date.parse(e.effectiveUntil) > t));
    if (hits.length !== 1) return null; // ambiguous or absent: unknown, never guessed
    if (!/^\d+$/.test(hits[0]!.pricePerMTokMicroUsd)) return null;
    return BigInt(hits[0]!.pricePerMTokMicroUsd);
  };
  return { id: j.version, sha256, capturedUtc, schema: j.schema, currency: j.currency, micro, entries: Object.freeze(j.entries.map((e) => Object.freeze({ ...e }))) };
}
