/**
 * OVERNIGHT 20261005 (Phase 10) — reconciliation of OTK-recorded usage/cost with a provider's
 * financial statement (usage/cost export, cost report, billing export).
 *
 * Vocabulary (kept strict on purpose):
 *  - "statement" = what the PROVIDER exported (CSV/JSON). It may be a usage report (tokens, no money),
 *    a cost report (money, often no tokens) or a billing export (both). It is never called an invoice
 *    here unless the provider document itself is an invoice.
 *  - "OTK record" = what OTK measured and priced for one operation (confirmed money, scale 10^12).
 *    The historical computed cost of the pilots is an OTK record, never a provider statement.
 *
 * Money is always a bigint with an explicit decimal scale (real value = units / scale, scale = 10^k).
 * Floats never carry money: decimal lexemes are parsed exactly (src/reconciliation/decimal.ts).
 *
 * @module reconciliation/types
 */

/**
 * Providers supported by reconciliation.
 */
export type ReconProvider = 'anthropic' | 'openai' | 'gemini';
/**
 * All {@link ReconProvider} values, frozen.
 */
export const RECON_PROVIDERS: readonly ReconProvider[] = Object.freeze(['anthropic', 'openai', 'gemini']);

/** ISO-8601 UTC instant with milliseconds, e.g. 2026-10-03T22:10:17.717Z. */
export type IsoUtc = string;

/**
 * Statement-side usage categories. 'other' = a recognized non-token cost (web search, file search,
 * code execution, storage...) that OTK does not meter; 'unknown' = the row could not be interpreted.
 */
export type UsageCategory = 'input' | 'output' | 'cache_read' | 'cache_write' | 'thinking' | 'other' | 'unknown';
/**
 * All {@link UsageCategory} values, frozen.
 */
export const USAGE_CATEGORIES: readonly UsageCategory[] = Object.freeze(['input', 'output', 'cache_read', 'cache_write', 'thinking', 'other', 'unknown']);

/** Fixed-point amount: value = units / scale; scale is a positive power of ten. */
export interface ScaledAmount {
  units: bigint;
  scale: bigint;
}

/** What a statement line represents. Taxes, credits and adjustments are never usage. */
export type LineKind = 'usage' | 'tax' | 'credit' | 'adjustment';

/** Where the provider-side data came from. FIXTURE = synthetic, built for tests; proves nothing about a provider. */
export type DataOrigin = 'REAL' | 'FIXTURE';

/**
 * How well a statement mapping is backed by official documentation.
 */
export type MappingProvenanceStatus = 'VERIFIED_OFFICIAL_DOC' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED_ASSUMPTION';

/**
 * Where each assumption of a statement mapping comes from.
 */
export interface MappingProvenance {
  status: MappingProvenanceStatus;
  /** Official pages used: URL, access date (YYYY-MM-DD) and what each page covers. */
  sources: Array<{ url: string; accessedOn: string; covers: string }>;
  /** Parts of the mapping that are assumptions (column names, vocabularies, semantics). */
  unverified: string[];
  notes: string;
}

/**
 * One line of a provider statement after import (usage, tax, credit or adjustment).
 */
export interface StatementLine {
  /** Deterministic id: `<mappingId>#<row>[.<sub>]` (row = 1-based record index in the source). */
  lineId: string;
  provider: ReconProvider;
  /** Model exactly as written by the provider (null when the row has none). */
  model: string | null;
  /** Canonical model id resolved through the explicit alias table (null = not resolvable, never guessed). */
  canonicalModel: string | null;
  /** Alias rule used to reach canonicalModel (null when the provider string is already canonical). */
  modelRule: string | null;
  usageCategory: UsageCategory;
  /** Token count (null = the row carries no quantity, e.g. a cost-only report). */
  quantity: bigint | null;
  /** Unit of `quantity` as declared by the provider/mapping (e.g. 'tokens'); null when quantity is null. */
  unit: string | null;
  /** Monetary amount converted to the currency's main unit (USD, not cents); null = no amount in this row. */
  amount: ScaledAmount | null;
  /**
   * Decimal places of precision of `amount` under the rounding policy (lexeme digits, or the
   * mapping's declared precision, or 15 significant digits for binary-float sources). null when amount is null.
   */
  amountPrecisionDecimals: number | null;
  /** Currency code as exported (e.g. `USD`); null when the row has no amount. */
  currency: string | null;
  /** Inclusive start of the period the line covers. */
  periodStart: IsoUtc;
  /** Exclusive end. */
  periodEnd: IsoUtc;
  requestId: string | null;
  /** Project / workspace / API-key identifier as exported (never a secret: ids only). */
  projectOrKey: string | null;
  kind: LineKind;
  isTax: boolean;
  isCredit: boolean;
  /** false = row outside the mapping's scope filter (e.g. another cloud service); kept, never reconciled. */
  inScope: boolean;
  /** Original row/record, values as their source lexemes (strings), for audit. */
  raw: Record<string, string | null>;
  /** Interpretation problems; a line with issues is UNKNOWN unless explicitly recoverable. */
  issues: string[];
}

/**
 * A whole provider statement after import, with its provenance and coverage.
 */
export interface ProviderStatement {
  schema: 'otk.provider_statement.v1';
  provider: ReconProvider;
  source: 'csv' | 'json';
  mappingId: string;
  mappingProvenance: MappingProvenance;
  /** sha256 (hex, lowercase) of the exact bytes imported. */
  sourceDigest: string;
  /** Detected/declared origin; a synthetic marker in the file forces FIXTURE. */
  origin: DataOrigin;
  syntheticMarker: string | null;
  /** min(periodStart) .. max(periodEnd) of the lines, ISO UTC, plus the timezone the mapping declared for naive values. */
  period: { start: IsoUtc; end: IsoUtc; declaredTimezone: string };
  /** Currency of the usage lines when uniform; 'MIXED' when not; null when no line has an amount. */
  currency: string | null;
  /**
   * Periods the statement covers (buckets, including empty ones, or the periods of its lines), merged and
   * sorted. An OTK record outside the coverage is "not covered", never "missing at the provider".
   */
  coverage: Array<{ start: IsoUtc; end: IsoUtc }>;
  lines: StatementLine[];
}

/** Half-open reconciliation window [start, end) for one provider. */
export interface ReconciliationWindow {
  provider: ReconProvider;
  start: IsoUtc;
  end: IsoUtc;
  /** Timezone used only to label orphan OTK days (records with no provider period). */
  timezone: string;
  tenantId: string | null;
}

/**
 * Token count of one category in an OTK record.
 */
export interface OtkCategoryQuantity {
  category: UsageCategory;
  /** Tokens (non-negative). */
  count: bigint;
}

/** One OTK operation as seen by reconciliation. */
export interface OtkRecord {
  source: 'postgres' | 'pilot_ledger' | 'fixture';
  tenantId: string | null;
  operationId: string;
  provider: ReconProvider;
  modelRequested: string;
  modelReturned: string | null;
  providerRequestId: string | null;
  /** Quantities in statement categories (input = uncached input; output includes billed thinking). */
  quantities: OtkCategoryQuantity[];
  /** Version of the price table frozen for the operation (null when unknown). */
  priceTableVersion: string | null;
  /** Confirmed money of the operation (null when not settled). */
  confirmedMoney: ScaledAmount | null;
  /** Money state of the operation as recorded (e.g. confirmed); null when unknown. */
  moneyState: string | null;
  /** How confirmedMoney was obtained (e.g. 'otk_operations.money.confirmed'). */
  moneyOrigin: string;
  /** Half-units of the money scale lost when the source value was rounded to scale (0 = exact). */
  moneyRoundingHalfUnits: bigint;
  /** When the operation was observed (ISO UTC); used to place it in a period. */
  observedAt: IsoUtc;
  notes: string[];
}

/**
 * Classification of a reconciliation result. EXACT set (do not extend silently):
 *  MATCH            both sides agree exactly on every comparable dimension;
 *  ROUNDING         quantities agree, amount differs within the declared rounding tolerance;
 *  TIMING_WINDOW    the difference disappears when OTK records within the timing tolerance of a period
 *                   boundary are counted in the adjacent period;
 *  MODEL_ALIAS      agreement obtained only through the explicit alias table (e.g. dated snapshot);
 *  CACHE_CATEGORY   per-category quantities differ but input + cache_read + cache_write agree;
 *  PRICE_VERSION    quantities agree, amount differs, and a price-table version explains it;
 *  MISSING_OTK      the provider bills something OTK has no record of (incl. non-token costs);
 *  MISSING_PROVIDER OTK has records the provider statement does not show;
 *  UNMATCHED        both sides exist but differ without an identified cause;
 *  UNKNOWN          a line/record could not be interpreted (unknown model/category/currency).
 */
export type Classification =
  | 'MATCH' | 'ROUNDING' | 'TIMING_WINDOW' | 'MODEL_ALIAS' | 'CACHE_CATEGORY'
  | 'PRICE_VERSION' | 'MISSING_OTK' | 'MISSING_PROVIDER' | 'UNMATCHED' | 'UNKNOWN';
/**
 * All {@link Classification} values in report order, frozen.
 */
export const CLASSIFICATIONS: readonly Classification[] = Object.freeze([
  'MATCH', 'ROUNDING', 'TIMING_WINDOW', 'MODEL_ALIAS', 'CACHE_CATEGORY',
  'PRICE_VERSION', 'MISSING_OTK', 'MISSING_PROVIDER', 'UNMATCHED', 'UNKNOWN',
]);

/** One numeric comparison. Amount values are decimal strings in the currency's main unit. */
export interface Comparison {
  metric: 'tokens' | 'amount';
  currency: string | null;
  otk: string | null;
  provider: string | null;
  /** otk - provider (signed), null when either side is missing. */
  diff: string | null;
  absDiff: string | null;
  /**
   * |otk - provider| / |provider| as a percentage with 6 decimals. Zero rule: both zero → '0.000000%';
   * provider zero and otk non-zero → null (relDiffNote says why); either side missing → null.
   */
  relDiff: string | null;
  relDiffNote: string | null;
}

/**
 * Granularity of a reconciliation result row.
 */
export type ResultLevel = 'request' | 'category' | 'model_period' | 'statement_line' | 'otk_record' | 'total';

/**
 * What a result row refers to; `null` members mean "all" at that level.
 */
export interface ResultKey {
  provider: ReconProvider;
  model: string | null;
  category: UsageCategory | null;
  periodStart: IsoUtc | null;
  periodEnd: IsoUtc | null;
  requestId: string | null;
}

/**
 * One reconciliation result row: what was compared, how it was classified and why.
 */
export interface ReconciliationDifference {
  id: string;
  level: ResultLevel;
  key: ResultKey;
  classification: Classification;
  /** true when the comparable values agree (MATCH, ROUNDING, MODEL_ALIAS with equal values). */
  agrees: boolean;
  quantity: Comparison | null;
  amount: Comparison | null;
  explanation: string;
  providerLineIds: string[];
  otkOperationIds: string[];
}

/** Linkage produced by the matcher (which provider lines were compared with which OTK records, and why). */
export interface ReconciliationMatch {
  groupId: string;
  aggregationLevel: 'per_request' | 'aggregate';
  /** Fields the join used, e.g. ['provider', 'model(alias)', 'period', 'category']. Never amount. */
  joinedOn: string[];
  providerLineIds: string[];
  otkOperationIds: string[];
}

/**
 * Complete reconciliation report for one provider and window; serialized by `report.ts`.
 */
export interface ReconciliationReport {
  schema: 'otk.reconciliation_report.v1';
  provider: ReconProvider;
  /** Origin of the PROVIDER data. 'FIXTURE' whenever any statement is synthetic. */
  providerDataOrigin: DataOrigin;
  window: ReconciliationWindow;
  statements: Array<{
    mappingId: string; provenance: MappingProvenanceStatus; sourceDigest: string; origin: DataOrigin;
    syntheticMarker: string | null; lineCount: number; period: ProviderStatement['period'];
  }>;
  otkSource: { kind: string; description: string; digests: string[]; recordCount: number };
  aggregationLevel: 'per_request' | 'aggregate' | 'none';
  aggregationNote: string;
  roundingPolicy: string;
  aliasTable: string;
  timingToleranceMs: number;
  priceTables: string[];
  results: ReconciliationDifference[];
  matches: ReconciliationMatch[];
  adjustments: Array<{ lineId: string; kind: LineKind; amount: string | null; currency: string | null; description: string }>;
  outOfScope: Array<{ lineId: string; amount: string | null; currency: string | null; description: string }>;
  excluded: Array<{ side: 'provider' | 'otk'; id: string; reason: string }>;
  totals: {
    usage: Comparison | null;
    providerTax: string | null;
    providerCredits: string | null;
    providerAdjustments: string | null;
    /** usage + tax + credits + adjustments of in-scope lines, provider side (currency of the statement). */
    providerNet: string | null;
    currency: string | null;
  };
  counts: Record<Classification, number>;
  warnings: string[];
}
