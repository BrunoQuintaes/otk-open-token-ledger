/**
 * OpenAI statement importer (CSV/JSON) — thin, mapping-driven wrapper over the generic engine.
 *
 * Admin API costs (money per line_item/day) and usage/completions (tokens per model per bucket) are PARTIALLY_VERIFIED (official cookbook; reference page blocked to direct fetch); the dashboard CSV mapping is an UNVERIFIED template.
 *
 * @module reconciliation/importers/openai
 */
import type { ProviderStatement } from '../types.js';
import { importStatement, StatementImportError } from './engine.js';
import type { ImportOptions } from './engine.js';
import { BUNDLED_MAPPING_IDS, loadMapping } from './mapping.js';
import type { StatementMapping } from './mapping.js';

/**
 * Mapping ID used when the caller does not choose one (Admin API costs, JSON).
 */
export const OPENAI_DEFAULT_MAPPING = 'openai_costs_json';
/**
 * IDs of the bundled OpenAI mappings.
 */
export const OPENAI_MAPPINGS = BUNDLED_MAPPING_IDS.openai;

/**
 * Imports an OpenAI statement with a bundled mapping (by ID or path) or a mapping object.
 *
 * @param bytes - Exact file content; its sha256 becomes the statement's `sourceDigest`.
 * @param mapping - Mapping object, bundled mapping ID, or path to a mapping `.json` file (read from disk).
 * @param opts - Declared data origin, timezone override and aliases.
 * @returns The parsed provider statement.
 * @throws {@link StatementImportError} With code `PROVIDER_MISMATCH` when the mapping is not for OpenAI, or
 *   any import error of `importStatement`.
 * @throws {@link MappingError} When a mapping loaded by ID or path is invalid (file errors propagate as well).
 */
export function importOpenAIStatement(bytes: string | Uint8Array, mapping: StatementMapping | string, opts: ImportOptions): ProviderStatement {
  const m = typeof mapping === 'string' ? loadMapping(mapping) : mapping;
  if (m.provider !== 'openai') throw new StatementImportError('PROVIDER_MISMATCH', `mapping ${m.id} is for ${m.provider}, not openai`);
  return importStatement(bytes, m, opts);
}
