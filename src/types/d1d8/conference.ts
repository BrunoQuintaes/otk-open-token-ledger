/**
 * D1–D8 shared contract — auxiliary conference report (D3 §2–4, D4 §7–8, D8; producer B for the
 * computation, A for signing, C for persistence/runtime).
 *
 * The report is a private, versioned statement BY THE OPERATOR about a local recount. Its
 * signature proves integrity/origin of the report, not correctness of the counter, and never
 * becomes a provider signature (D3 resultado exigido).
 *
 * @module src/types/d1d8/conference
 */
import type { Hex32, IsoTime, OperationKey } from './common.js';
import type { SupportLevel, TokenCategoryName, TokenizerIdentity } from './usage.js';

/**
 * unsupported = no counter for this api/model (catalog says so);
 * incomplete  = counter ran but did not cover every category/part (tools, images, cut stream);
 * unavailable = counter failed or had no content in memory (auxiliary failure, D4 §7);
 * observed    = local counts exist but provider usage is missing/partial, so no comparison;
 * compared    = local and provider counts compared for the covered categories.
 * Only 'compared' may carry a divergence verdict. Nothing else reads as "no divergence".
 */
export type ConferenceState = 'unsupported' | 'incomplete' | 'unavailable' | 'observed' | 'compared';

/**
 * Verdict of a report; only state `compared` may carry `within_threshold` or `divergent`.
 */
export type ConferenceVerdict = 'within_threshold' | 'divergent' | 'not_applicable';

/**
 * Comparison of the local count with the provider count for one token category (tokens).
 */
export interface CategoryComparison {
  category: TokenCategoryName;
  provider: bigint | null;
  local: bigint | null;
  /** provider − local; null unless both sides exist. */
  absoluteDelta: bigint | null;
  /**
   * |delta| / provider, as a decimal string with fixed digits. null when provider is 0 or absent:
   * an absolute error with provider 0 is still reported through absoluteDelta (D4 §8).
   */
  relativeDelta: string | null;
  /**
   * v1.2 (OVERNIGHT 20261005, Phase 8): expectation of the provider count derived from the RAW local count by a
   * compatible calibrated profile, reported next to the raw numbers (which are never overwritten). Present only
   * when such a profile covered this category; omit the key otherwise (CE1 refuses undefined).
   */
  adjusted?: AdjustedComparison;
}

/**
 * Comparison after applying a compatible calibration profile; raw numbers are kept beside it.
 */
export interface AdjustedComparison {
  /** Expected provider count = profile adjustment applied to `local` (integer, ≥ 0). */
  expected: bigint;
  /** provider − expected. */
  absoluteDelta: bigint;
  /** |provider − expected| / provider with the same fixed-digit rule as relativeDelta; null when provider is 0. */
  relativeDelta: string | null;
}

/** Outcome of selecting a calibration profile for the conference (see src/tokenization/calibrationProfile.ts). */
export type CalibrationState = 'COMPATIBLE' | 'ABSENT' | 'CORRUPT' | 'INCOMPATIBLE' | 'NOT_CALIBRATED';

/**
 * v1.2 (Phase 8): which calibration profile the conference looked for and what it found. Only COMPATIBLE means
 * the threshold is calibrated (then threshold.calibrationVersion = profileId). Every other state is an explicit
 * not-calibrated outcome; the threshold is the heuristic one.
 */
export interface ConferenceCalibrationRecord {
  state: CalibrationState;
  /** Profile id found for (provider, api, model), when one was found and could be parsed. */
  profileId: string | null;
  /** evidenceHash of that profile (integrity digest of its body, not a signature). */
  evidenceHash: Hex32 | null;
  /** Machine reason for any state other than COMPATIBLE (never content). */
  reason: string | null;
}

/**
 * Divergence threshold: an absolute gap in tokens and an optional relative gap (6-decimal string).
 */
export interface ConferenceThreshold {
  absoluteTokens: bigint;
  relative: string | null;
  /** null when no calibration exists — then `calibrated` is false and the limits are heuristic. */
  calibrationVersion: string | null;
  calibrated: boolean;
}

/**
 * Auxiliary conference report `otk.conference.v1`, signed by the operator in a separate envelope.
 */
export interface ConferenceReport {
  schema: 'otk.conference.v1';
  key: OperationKey;
  /** Digest of the private receipt this report belongs to (swap between receipts is rejected). */
  receiptDigest: Hex32;
  tokenizer: TokenizerIdentity | null;
  /**
   * v1.1 (request B R-B1): catalog support level of the tokenizer used, so a reader can tell an exact
   * tokenizer from a generic_fallback approximation, and the catalog version that decided it. Part of
   * the signed payload (A's CE1 digest covers the whole object). Omit the key when unknown; never
   * set it to undefined (CE1 refuses undefined).
   */
  support?: SupportLevel;
  catalogVersion?: string;
  /**
   * v1.2 (Phase 8): calibration profile selection used for this report. Omitted by producers without a profile
   * selector, so reports signed before Phase 8 keep their bytes and digests.
   */
  calibration?: ConferenceCalibrationRecord;
  coveredCategories: TokenCategoryName[];
  uncoveredCategories: TokenCategoryName[];
  comparisons: CategoryComparison[];
  threshold: ConferenceThreshold;
  state: ConferenceState;
  verdict: ConferenceVerdict;
  /** Counter implementation id + version (B), so the run can be reproduced. */
  counterVersion: string;
  createdAt: IsoTime;
}
