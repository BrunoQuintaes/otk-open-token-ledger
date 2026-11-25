/**
 * Column/field mapping configuration for provider statement importers.
 *
 * Export formats change and some are not documented field by field, so the importers never hard-code
 * column names: each one reads a mapping file (./mappings/*.json) that states what it assumes and where
 * each assumption comes from (provenance: official doc URL + access date, or UNVERIFIED_ASSUMPTION).
 *
 * Field references:
 *  - CSV: the column name exactly as in the header;
 *  - JSON: a dot path relative to the record; in bucketed JSON, '$bucket.<path>' reads the bucket.
 *
 * @module reconciliation/importers/mapping
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LineKind, MappingProvenance, ReconProvider, UsageCategory } from '../types.js';
import { RECON_PROVIDERS, USAGE_CATEGORIES } from '../types.js';
import { assertTimezone } from '../time.js';

/**
 * Where the records live in the exported file and how they are split.
 */
export type MappingRecords =
  | { kind: 'csv_rows'; delimiter: string }
  | { kind: 'json_buckets'; bucketsPath: string; resultsPath: string }
  | { kind: 'json_array'; rowsPath: string | null }
  | { kind: 'ndjson' };

/**
 * Assigns a usage category when `field` equals `equals` or matches `pattern` (exactly one of the two is set).
 */
export interface CategoryRule { field: string; equals?: string; pattern?: string; flags?: string; category: UsageCategory }
/**
 * Assigns a line kind (usage, tax, credit, adjustment) when `field` equals `equals` or matches `pattern`.
 */
export interface KindRule { field: string; equals?: string; pattern?: string; flags?: string; kind: LineKind }

/**
 * Declarative description of one provider export format, with provenance for each assumption.
 */
export interface StatementMapping {
  schema: 'otk.reconciliation_mapping.v1';
  id: string;
  provider: ReconProvider;
  format: 'csv' | 'json' | 'ndjson';
  describes: string;
  provenance: MappingProvenance;
  records: MappingRecords;
  timestamps: { format: 'auto' | 'unix_seconds'; declaredTimezone: string | null; note: string };
  period: { start: string; end: string } | { day: string };
  model: { field: string; regex?: string; group?: number } | { fromDescription: string } | null;
  category: { rules: CategoryRule[]; fallback: UsageCategory } | null;
  /** Usage reports: one line per listed category, quantity from the given field, no amount. */
  expand: Array<{ category: UsageCategory; quantityField: string }> | null;
  /** With expand: categories whose quantity the provider ALSO counts inside its input total. */
  subtractFromInput: UsageCategory[];
  quantity: { field: string; unit: string; unitField: string | null; allowedUnits: string[] | null } | null;
  /**
   * divisor: power of ten that converts the exported unit to the currency's main unit ('100' = cents).
   * binaryFloat: the value was serialized from a binary float (precision = 15 significant digits).
   * precisionDecimals: declared display precision (overrides the lexeme digits), e.g. 2 for cents.
   */
  amount: { field: string; divisor: string; binaryFloat: boolean; precisionDecimals: number | null } | null;
  currency: { field: string } | { constant: string } | null;
  requestId: { field: string } | null;
  projectOrKey: string[];
  kind: { rules: KindRule[] };
  scope: { field: string; allowed: string[] } | null;
  credits: { arrayField: string; amountField: string; nameField: string; typeField: string } | null;
  description: string[];
}

/**
 * Raised when a mapping file fails structural validation.
 */
export class MappingError extends Error {
  constructor(message: string) { super(message); this.name = 'MappingError'; }
}

const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

/**
 * Structural validation; throws MappingError with the first problem.
 *
 * @param raw - Parsed mapping JSON.
 * @returns The same object, typed (it is not copied).
 * @throws {@link MappingError} With the first structural problem found.
 * @throws {@link TimestampError} When the declared timezone is unknown.
 * @throws {SyntaxError} When a category or model regular expression does not compile.
 */
export function validateMapping(raw: unknown): StatementMapping {
  const m = raw as StatementMapping;
  const fail = (msg: string): never => { throw new MappingError(`mapping ${(m && (m as { id?: string }).id) ?? '?'}: ${msg}`); };
  if (!m || typeof m !== 'object') fail('not an object');
  if (m.schema !== 'otk.reconciliation_mapping.v1') fail('schema must be otk.reconciliation_mapping.v1');
  if (!isStr(m.id) || !/^[a-z0-9_]+$/.test(m.id)) fail('id must match [a-z0-9_]+');
  if (!RECON_PROVIDERS.includes(m.provider)) fail(`unknown provider ${String(m.provider)}`);
  if (!['csv', 'json', 'ndjson'].includes(m.format)) fail('format');
  const p = m.provenance;
  if (!p || !['VERIFIED_OFFICIAL_DOC', 'PARTIALLY_VERIFIED', 'UNVERIFIED_ASSUMPTION'].includes(p.status)) fail('provenance.status');
  if (!Array.isArray(p.sources) || !Array.isArray(p.unverified) || typeof p.notes !== 'string') fail('provenance shape');
  if (p.status !== 'UNVERIFIED_ASSUMPTION' && p.sources.length === 0) fail('verified provenance needs at least one source');
  for (const s of p.sources) if (!isStr(s.url) || !/^\d{4}-\d{2}-\d{2}$/.test(s.accessedOn) || !isStr(s.covers)) fail('provenance source needs url, accessedOn (YYYY-MM-DD), covers');
  if (p.status === 'VERIFIED_OFFICIAL_DOC' && p.unverified.length > 0) fail('VERIFIED_OFFICIAL_DOC cannot list unverified parts (use PARTIALLY_VERIFIED)');
  const r = m.records;
  if (!r || !['csv_rows', 'json_buckets', 'json_array', 'ndjson'].includes(r.kind)) fail('records.kind');
  if ((r.kind === 'csv_rows') !== (m.format === 'csv')) fail('csv format needs records.kind csv_rows');
  if (r.kind === 'ndjson' && m.format !== 'ndjson') fail('ndjson records need format ndjson');
  if (!m.timestamps || !['auto', 'unix_seconds'].includes(m.timestamps.format)) fail('timestamps.format');
  if (m.timestamps.declaredTimezone !== null) assertTimezone(m.timestamps.declaredTimezone);
  if (!m.period || (!('day' in m.period) && !(isStr((m.period as { start: string }).start) && isStr((m.period as { end: string }).end)))) fail('period');
  const cats = new Set<string>(USAGE_CATEGORIES);
  if (m.expand !== null) {
    if (!Array.isArray(m.expand) || m.expand.length === 0) fail('expand must be null or a non-empty array');
    for (const e of m.expand) if (!cats.has(e.category) || !isStr(e.quantityField)) fail('expand entry');
    if (m.category !== null) fail('expand and category are exclusive');
    if (m.amount !== null) fail('expand lines carry no amount');
  } else {
    if (!m.category || !Array.isArray(m.category.rules) || !cats.has(m.category.fallback)) fail('category');
    for (const c of m.category!.rules) {
      if (!isStr(c.field) || !cats.has(c.category) || (c.equals === undefined) === (c.pattern === undefined)) fail('category rule needs field, category and exactly one of equals/pattern');
      if (c.pattern !== undefined) new RegExp(c.pattern, c.flags ?? '');
    }
  }
  if (!Array.isArray(m.subtractFromInput)) fail('subtractFromInput must be an array');
  if (m.subtractFromInput.length > 0 && m.expand === null) fail('subtractFromInput requires expand');
  if (m.amount !== null) {
    if (!isStr(m.amount.field) || !/^10*$/.test(m.amount.divisor) || typeof m.amount.binaryFloat !== 'boolean') fail('amount');
    if (m.amount.precisionDecimals !== null && (!Number.isInteger(m.amount.precisionDecimals) || m.amount.precisionDecimals < 0)) fail('amount.precisionDecimals');
  }
  if (!Array.isArray(m.projectOrKey) || !Array.isArray(m.description)) fail('projectOrKey/description must be arrays');
  if (!m.kind || !Array.isArray(m.kind.rules)) fail('kind.rules');
  for (const k of m.kind.rules) if (!['usage', 'tax', 'credit', 'adjustment'].includes(k.kind) || (k.equals === undefined) === (k.pattern === undefined)) fail('kind rule');
  if (m.credits !== null && m.format === 'csv') fail('credits arrays exist only in JSON/NDJSON');
  if (m.model !== null && 'regex' in m.model && m.model.regex !== undefined) new RegExp(m.model.regex);
  return m;
}

/**
 * Every field the mapping reads (used to check a CSV header before importing).
 *
 * @param m - A validated mapping.
 * @returns Sorted, de-duplicated field names (bucket-level `$bucket.` fields excluded).
 */
export function referencedFields(m: StatementMapping): string[] {
  const f = new Set<string>();
  if ('day' in m.period) f.add(m.period.day); else { f.add(m.period.start); f.add(m.period.end); }
  if (m.model) f.add('fromDescription' in m.model ? m.model.fromDescription : m.model.field);
  for (const r of m.category?.rules ?? []) f.add(r.field);
  for (const e of m.expand ?? []) f.add(e.quantityField);
  if (m.quantity) { f.add(m.quantity.field); if (m.quantity.unitField) f.add(m.quantity.unitField); }
  if (m.amount) f.add(m.amount.field);
  if (m.currency && 'field' in m.currency) f.add(m.currency.field);
  if (m.requestId) f.add(m.requestId.field);
  for (const x of m.projectOrKey) f.add(x);
  for (const k of m.kind.rules) f.add(k.field);
  if (m.scope) f.add(m.scope.field);
  for (const d of m.description) f.add(d);
  return [...f].filter((x) => !x.startsWith('$bucket.')).sort();
}

/**
 * Folder of the bundled mapping files (`mappings/` next to this module).
 */
export const MAPPINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'mappings');

/**
 * Load a bundled mapping by id, or a mapping file by path (a value ending in .json).
 *
 * Reads the file from disk synchronously.
 *
 * @param idOrPath - Bundled mapping ID (file `MAPPINGS_DIR/<id>.json`), or a path ending in `.json`.
 * @returns The validated mapping.
 * @throws {Error} When the file cannot be read or is not JSON, plus the errors of {@link validateMapping}.
 */
export function loadMapping(idOrPath: string): StatementMapping {
  const path = idOrPath.endsWith('.json') ? idOrPath : join(MAPPINGS_DIR, `${idOrPath}.json`);
  return validateMapping(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * IDs of the mapping files bundled for each provider.
 */
export const BUNDLED_MAPPING_IDS: Readonly<Record<ReconProvider, readonly string[]>> = Object.freeze({
  anthropic: ['anthropic_cost_report_json', 'anthropic_usage_report_json', 'anthropic_console_csv'],
  openai: ['openai_costs_json', 'openai_usage_completions_json', 'openai_dashboard_csv'],
  gemini: ['gemini_billing_export_csv', 'gemini_billing_export_ndjson', 'gemini_reports_csv'],
});
