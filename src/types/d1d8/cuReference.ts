/**
 * CU reference framework (OVERNIGHT 2, 2026-10-07): contract types.
 *
 * Definition chosen by the author: Cost Unit (CU) = unit of NORMALIZED QUANTITY of AI-service consumption.
 * Tokens and the other usage categories are observed quantities that feed the CU; they are not the CU.
 *
 *   CU_o^(b) = scale × Σ_c q_(o,m,c) × w_(m,c)^(b),   w_(m,c)^(b) = p_(m,c)^(b) / p_ref^(b)
 *
 * o = operation, m = model/service, c = canonical category, b = base period, q = observed quantity,
 * p = official list price of the frozen reference structure (base period), p_ref = normalization reference.
 * The base prices are frozen in a versioned, digest-bearing profile: current prices never enter the CU.
 * Money (current cost) is computed elsewhere (src/pricing/priceUsage.ts) and stays a separate axis.
 *
 * What the weights are NOT: energy, FLOPs, quality, capability, or a forecast of future prices.
 * The historical multiplicative formula (T_in + T_out) × W_model × W_provider is the profile
 * 'development_legacy' (src/economics/computeCu.ts) and is never rewritten retroactively.
 *
 * @module src/types/d1d8/cuReference
 */
import type { Hex32, IsoTime, OperationKey, Scaled } from './common.js';

/** Disjoint categories after decomposition (no token counted twice). */
export type CuCanonicalCategory =
  | 'input_uncached'
  | 'input_cache_read'
  | 'input_cache_write'
  | 'output_visible'
  | 'output_reasoning';

/** One frozen official list price of the reference structure. Integers only: micro-USD per 1M tokens. */
export interface CuReferencePriceEntry {
  provider: string;
  model: string;
  category: CuCanonicalCategory;
  /** Decimal string, micro-USD per 1,000,000 tokens (e.g. "1000000" = US$ 1.00/MTok). */
  priceMicroUsdPerMTok: string;
  /** Which published column the price comes from (e.g. "Standard, short context, cached input"). */
  column: string;
  /** Provenance: official URL, archived copy in the repo, its sha256, the literal line and when it was read. */
  source: { url: string; archivedCopy: string; sha256: string; literal: string; retrievedAt: IsoTime[] };
  note?: string;
}

/**
 * Normalization reference p_ref. Changing it only rescales every CU by the same factor: relative CU between
 * operations does not change. Which one is THE reference is the author's decision (DN-01), not the code's.
 *  - model_category: p_ref = base price of one real (provider, model, category) of the profile;
 *  - abstract_price: p_ref = a fixed abstract price (micro-USD per MTok), not tied to any model.
 */
export type CuReferenceDefinition =
  | { kind: 'model_category'; provider: string; model: string; category: CuCanonicalCategory }
  | { kind: 'abstract_price'; priceMicroUsdPerMTok: string };

/**
 * Whether a CU reference profile is a candidate or the final one.
 */
export type CuReferenceProfileStatus = 'CANDIDATE' | 'FINAL';

/**
 * Versioned CU reference profile: frozen base prices and weights of one base period.
 */
export interface CuReferenceProfileV1 {
  schema: 'otk.cu.reference.v1';
  profileId: string;
  /** Formula id: weights = p/p_ref, sum over canonical categories, exact rational, decimal at 10^-9 half-up. */
  formulaVersion: 'CU_REF_SUM_v1';
  /** Base period of the reference structure, YYYY-MM. */
  basePeriod: string;
  /** Date of the price snapshot used (the retrieval dates of each entry are in its source). */
  snapshotDate: string;
  status: CuReferenceProfileStatus;
  /**
   * null = normalization NOT chosen (DN-01 open). A profile without a reference can be digested, audited and
   * compared, but compute requires an explicit reference passed by the caller and labels the result CANDIDATE.
   */
  referenceDefinition: CuReferenceDefinition | null;
  /**
   * Presentation scale, exact: a positive integer ("1") or a positive fraction ("1/1000"). CU = scale × Σ q × p / p_ref.
   * Final profile 2026-10 (DN-01): "1/1000", i.e. 1 CU = 1 000 reference units (1 000 uncached input tokens of
   * gpt-4o-mini-2024-07-18 at the October-2026 base). The scale never changes relations between operations.
   */
  scale: string;
  /**
   * Weights derived from the frozen prices, w = p / p_ref as irreducible fractions (required in a FINAL profile and
   * checked against the prices by the validator, so a weight can never drift from its documented source).
   */
  derivedWeights?: Array<{ provider: string; model: string; category: CuCanonicalCategory; weight: { numerator: string; denominator: string } }>;
  entries: CuReferencePriceEntry[];
  /** Explicit dated-snapshot aliases → profile model id. Unknown ids are never guessed. */
  aliases: Record<string, string>;
  provenance: { createdAt: IsoTime; createdBy: string; method: string; limitations: string[] };
}

/**
 * Outcome of a CU reference computation; only `computed` carries a value.
 */
export type CuReferenceStatus =
  | 'computed'
  /** usage absent/partial/invalid, or a subset larger than its base */
  | 'usage_not_computable'
  /** the returned (or requested) model is not in the profile: no invented weight */
  | 'model_not_in_profile'
  /** q > 0 in a category the profile has no price for (or an unsupported raw category, e.g. audio) */
  | 'category_not_in_profile'
  /** no normalization reference (profile has none and the caller passed none), or the reference is not in the profile */
  | 'reference_undefined'
  | 'invalid_profile';

/**
 * Result of computing the reference CU of one operation with one profile.
 */
export interface CuReferenceResult {
  schema: 'otk.cu_reference_result.v1';
  status: CuReferenceStatus;
  formulaVersion: 'CU_REF_SUM_v1';
  profileId: string;
  profileDigest: Hex32;
  basePeriod: string;
  /** CANDIDATE when the profile is a candidate or the reference was supplied by the caller (DN-01 open). */
  label: 'CU_REFERENCE_CANDIDATE' | 'CU_REFERENCE_FINAL';
  reference: CuReferenceDefinition | null;
  provider: string;
  /** Profile model id actually used (after explicit alias resolution); null when not found. */
  model: string | null;
  /** Disjoint quantities per canonical category (decimal strings); null when not computable. */
  quantities: Partial<Record<CuCanonicalCategory, string>> | null;
  /** Exact CU as an irreducible fraction (decimal strings); null unless computed. */
  exact: { numerator: string; denominator: string } | null;
  /** Decimal CU at 10^-9, round half up; null unless computed. */
  cu: Scaled | null;
  detail?: string;
}

/**
 * Signed statement binding a CU-reference result to one private receipt v3 (domain OTK_CU_REFERENCE_V1).
 * Carries cuFormulaVersion, cuReferenceProfileId, basePeriod and profileDigest without touching the receipt v3
 * schema (legacy receipts stay byte-identical). kind 'analytical_recomputation' = the same computation applied
 * later to an existing receipt: it NEVER replaces the original receipt or its legacy CU.
 */
export interface CuReferenceStatementV1 {
  schema: 'otk.cu_reference_statement.v1';
  key: OperationKey;
  receiptDigest: Hex32;
  kind: 'issued_with_operation' | 'analytical_recomputation';
  cuFormulaVersion: 'CU_REF_SUM_v1';
  cuReferenceProfileId: string;
  basePeriod: string;
  profileDigest: Hex32;
  label: CuReferenceResult['label'];
  reference: CuReferenceDefinition | null;
  quantities: Record<string, string>;
  exact: { numerator: string; denominator: string };
  computedAt: IsoTime;
}
