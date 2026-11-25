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

/**
 * Mapping ID used when the caller does not choose one (Cloud Billing export, CSV).
 */
export const GEMINI_DEFAULT_MAPPING = 'gemini_billing_export_csv';
/**
 * IDs of the bundled Gemini mappings.
 */
export const GEMINI_MAPPINGS = BUNDLED_MAPPING_IDS.gemini;

/**
 * Imports a Gemini (Cloud Billing) statement with a bundled mapping (by ID or path) or a mapping object.
 *
 * @param bytes - Exact file content; its sha256 becomes the statement's `sourceDigest`.
 * @param mapping - Mapping object, bundled mapping ID, or path to a mapping `.json` file (read from disk).
 * @param opts - Declared data origin, timezone override and aliases.
 * @returns The parsed provider statement.
 * @throws {@link StatementImportError} With code `PROVIDER_MISMATCH` when the mapping is not for Gemini, or
 *   any import error of `importStatement`.
 * @throws {@link MappingError} When a mapping loaded by ID or path is invalid (file errors propagate as well).
 */
export function importGeminiStatement(bytes: string | Uint8Array, mapping: StatementMapping | string, opts: ImportOptions): ProviderStatement {
  const m = typeof mapping === 'string' ? loadMapping(mapping) : mapping;
  if (m.provider !== 'gemini') throw new StatementImportError('PROVIDER_MISMATCH', `mapping ${m.id} is for ${m.provider}, not gemini`);
  return importStatement(bytes, m, opts);
}
