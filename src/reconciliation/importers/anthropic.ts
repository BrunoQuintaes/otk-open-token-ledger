/**
 * Anthropic statement importer (CSV/JSON) — thin, mapping-driven wrapper over the generic engine.
 *
 * Admin API cost_report (money per model/token type/day, cents as decimal strings) and usage_report/messages (tokens per model per bucket) are VERIFIED against the official docs; the Console CSV mapping is an UNVERIFIED template.
 *
 * @module reconciliation/importers/anthropic
 */
import type { ProviderStatement } from '../types.js';
import { importStatement, StatementImportError } from './engine.js';
import type { ImportOptions } from './engine.js';
import { BUNDLED_MAPPING_IDS, loadMapping } from './mapping.js';
import type { StatementMapping } from './mapping.js';

/**
 * Mapping ID used when the caller does not choose one (Admin API cost report, JSON).
 */
export const ANTHROPIC_DEFAULT_MAPPING = 'anthropic_cost_report_json';
/**
 * IDs of the bundled Anthropic mappings.
 */
export const ANTHROPIC_MAPPINGS = BUNDLED_MAPPING_IDS.anthropic;

/**
 * Imports an Anthropic statement with a bundled mapping (by ID or path) or a mapping object.
 *
 * @param bytes - Exact file content; its sha256 becomes the statement's `sourceDigest`.
 * @param mapping - Mapping object, bundled mapping ID, or path to a mapping `.json` file (read from disk).
 * @param opts - Declared data origin, timezone override and aliases.
 * @returns The parsed provider statement.
 * @throws {@link StatementImportError} With code `PROVIDER_MISMATCH` when the mapping is not for Anthropic, or
 *   any import error of `importStatement`.
 * @throws {@link MappingError} When a mapping loaded by ID or path is invalid (file errors propagate as well).
 */
export function importAnthropicStatement(bytes: string | Uint8Array, mapping: StatementMapping | string, opts: ImportOptions): ProviderStatement {
  const m = typeof mapping === 'string' ? loadMapping(mapping) : mapping;
  if (m.provider !== 'anthropic') throw new StatementImportError('PROVIDER_MISMATCH', `mapping ${m.id} is for ${m.provider}, not anthropic`);
  return importStatement(bytes, m, opts);
}
