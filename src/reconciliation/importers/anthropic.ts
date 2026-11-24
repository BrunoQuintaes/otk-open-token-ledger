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

export const ANTHROPIC_DEFAULT_MAPPING = 'anthropic_cost_report_json';
export const ANTHROPIC_MAPPINGS = BUNDLED_MAPPING_IDS.anthropic;

export function importAnthropicStatement(bytes: string | Uint8Array, mapping: StatementMapping | string, opts: ImportOptions): ProviderStatement {
  const m = typeof mapping === 'string' ? loadMapping(mapping) : mapping;
  if (m.provider !== 'anthropic') throw new StatementImportError('PROVIDER_MISMATCH', `mapping ${m.id} is for ${m.provider}, not anthropic`);
  return importStatement(bytes, m, opts);
}
