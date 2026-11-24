/**
 * OVERNIGHT 20261005 (Phase 10) — reconciliation of OTK usage/cost with provider statements.
 *
 * @module reconciliation
 */
import type { ProviderStatement, ReconProvider } from './types.js';
import type { ImportOptions } from './importers/engine.js';
import type { StatementMapping } from './importers/mapping.js';
import { importAnthropicStatement } from './importers/anthropic.js';
import { importOpenAIStatement } from './importers/openai.js';
import { importGeminiStatement } from './importers/gemini.js';

export * from './types.js';
export { reconcile, ROUNDING_POLICY_ID, DEFAULT_TIMING_TOLERANCE_MS } from './match.js';
export type { ReconcileInput } from './match.js';
export { reportJson, reportMarkdown, reportDigest } from './report.js';
export { loadOtkFromPostgres, loadOtkFromPilotLedger, loadOtkFromFixtureJson, mergeOtkLoads, quantitiesFromNormalizedUsage, providerOfModel } from './otkSource.js';
export type { OtkLoadResult, PilotLedgerOptions } from './otkSource.js';
export { importStatement, StatementImportError, sha256Hex } from './importers/engine.js';
export type { ImportOptions } from './importers/engine.js';
export { loadMapping, validateMapping, BUNDLED_MAPPING_IDS, MappingError, MAPPINGS_DIR } from './importers/mapping.js';
export type { StatementMapping } from './importers/mapping.js';
export { RECON_ALIAS_TABLE_V1, canonicalModel, modelFromDescription } from './aliases.js';

/** Dispatch to the provider importer (each one checks that the mapping belongs to its provider). */
export function importProviderStatement(provider: ReconProvider, bytes: string | Uint8Array, mapping: StatementMapping | string, opts: ImportOptions): ProviderStatement {
  if (provider === 'anthropic') return importAnthropicStatement(bytes, mapping, opts);
  if (provider === 'openai') return importOpenAIStatement(bytes, mapping, opts);
  return importGeminiStatement(bytes, mapping, opts);
}
