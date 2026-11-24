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

export const OPENAI_DEFAULT_MAPPING = 'openai_costs_json';
export const OPENAI_MAPPINGS = BUNDLED_MAPPING_IDS.openai;

export function importOpenAIStatement(bytes: string | Uint8Array, mapping: StatementMapping | string, opts: ImportOptions): ProviderStatement {
  const m = typeof mapping === 'string' ? loadMapping(mapping) : mapping;
  if (m.provider !== 'openai') throw new StatementImportError('PROVIDER_MISMATCH', `mapping ${m.id} is for ${m.provider}, not openai`);
  return importStatement(bytes, m, opts);
}
