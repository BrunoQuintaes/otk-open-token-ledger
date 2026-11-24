/**
 * Gemini statement importer (CSV/JSON) — thin, mapping-driven wrapper over the generic engine.
 *
 * Cloud Billing standard usage cost export (CSV through the documented query, or NDJSON) is PARTIALLY_VERIFIED: field names are documented, the Gemini SKU wording and units are not; the Reports CSV mapping is an UNVERIFIED template.
 *
 * @module reconciliation/importers/gemini
 */
import type { ProviderStatement } from '../types.js';
import { importStatement, StatementImportError } from './engine.js';
import type { ImportOptions } from './engine.js';
import { BUNDLED_MAPPING_IDS, loadMapping } from './mapping.js';
import type { StatementMapping } from './mapping.js';

export const GEMINI_DEFAULT_MAPPING = 'gemini_billing_export_csv';
export const GEMINI_MAPPINGS = BUNDLED_MAPPING_IDS.gemini;

export function importGeminiStatement(bytes: string | Uint8Array, mapping: StatementMapping | string, opts: ImportOptions): ProviderStatement {
  const m = typeof mapping === 'string' ? loadMapping(mapping) : mapping;
  if (m.provider !== 'gemini') throw new StatementImportError('PROVIDER_MISMATCH', `mapping ${m.id} is for ${m.provider}, not gemini`);
  return importStatement(bytes, m, opts);
}
