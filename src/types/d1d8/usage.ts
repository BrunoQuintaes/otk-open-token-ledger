/**
 * D1–D8 shared contract — normalized usage (D4, D5; producer B, consumers A/C/S4).
 *
 * One NormalizedUsage describes what one provider API reported for one operation, keeping
 * every category separately with its source field and inclusion rule, so totals are never
 * omitted or double-counted (D5-G02) and "absent" never becomes zero (D4-G04).
 *
 * @module src/types/d1d8/usage
 */
import type { Hex32, IsoTime } from './common.js';

/** Provider APIs in the declared text scope (D5 §2). Unsupported ones are explicit, not mapped. */
export type UsageApi =
  | 'openai.chat_completions'
  | 'openai.responses'
  | 'anthropic.messages'
  | 'gemini.generate_content'
  | 'deepseek.chat_completions'
  | 'mistral.chat_completions'
  | 'cohere.chat';

/**
 * Who observed the numbers. Only 'provider_response' and 'provider_stream' are observations of
 * the provider connection by the operator; 'client_declared' and 'legacy_import' stay
 * distinguishable forever (D3 §8, D5 §4). 'local_count' is the auxiliary counter (D8), never usage.
 */
export type UsageOrigin = 'provider_response' | 'provider_stream' | 'client_declared' | 'legacy_import';

/**
 * complete = final usage object received and parsed;
 * partial  = only intermediate/cumulative usage seen (stream cut, cancel) — never billed as final;
 * missing  = no usage object at all (the operation is 'uncertain' for measurement, D7 §3).
 */
export type UsageCompleteness = 'complete' | 'partial' | 'missing';

/** Category names. New names are added by B through a coordinator request. */
export type TokenCategoryName =
  | 'input'
  | 'output'
  | 'input_cache_read'
  | 'input_cache_write'
  | 'output_reasoning'
  | 'input_audio'
  | 'output_audio'
  | 'tool_use_prompt';

/**
 * How a category relates to the base counts as the provider documents it:
 *  - 'base'                : it IS the input or output total reported by the API;
 *  - 'subset_of_input'     : already contained in the input total (e.g. OpenAI cached_tokens);
 *  - 'subset_of_output'    : already contained in the output total (e.g. OpenAI reasoning_tokens);
 *  - 'separate_addend'     : billed/reported outside the base totals (e.g. Anthropic cache_*).
 * B documents the rule per API with the official doc URL + retrieval date (D5 §1).
 */
export type CategoryInclusion = 'base' | 'subset_of_input' | 'subset_of_output' | 'separate_addend';

/**
 * One token category as reported, with its source field and inclusion rule; `count` null = absent or invalid.
 */
export interface TokenCategory {
  name: TokenCategoryName;
  /** null = the provider did not report this category (absent). 0n = reported zero. */
  count: bigint | null;
  inclusion: CategoryInclusion;
  /** Raw field path, e.g. 'usage.prompt_tokens_details.cached_tokens'. */
  sourceField: string;
}

/**
 * v1.1 (request B R-B2): why a value could not be used. Invalid input (negative, NaN, fractional,
 * out of range, inconsistent total) is not the same as intermediate stream usage ('partial').
 */
export interface UsageIssue {
  /**
   * v1.2 (S4): the union also carries the finer kinds B's normalizer already emits, so the issue
   * persisted with the usage is the one produced (no lossy remapping). The 1.1 kinds stay valid.
   */
  kind:
    | 'invalid_value' | 'inconsistent_total' | 'unmapped_field' | 'out_of_range' | 'other'
    | 'usage_absent' | 'base_absent' | 'invalid_type' | 'non_integer' | 'negative' | 'non_finite'
    | 'subset_exceeds_base' | 'derived_from_total' | 'inclusion_unverified';
  /** Raw field path, e.g. 'usage.output_tokens'. */
  field: string;
  detail?: string;
}

/**
 * Normalized usage `otk.usage.v1` of one operation.
 */
export interface NormalizedUsage {
  schema: 'otk.usage.v1';
  api: UsageApi;
  provider: string;
  modelRequested: string;
  /** Model id the provider returned, if any (dated snapshot ids kept verbatim). */
  modelReturned: string | null;
  providerRequestId: string | null;
  origin: UsageOrigin;
  completeness: UsageCompleteness;
  categories: TokenCategory[];
  /**
   * T_entrada / T_saida fed to the multiplicative CU formula (D5): values derived by B's rule
   * `tRule` from `categories`. null when the rule cannot be applied (missing/invalid input);
   * consumers must then treat CU as not computable, never as 0.
   */
  tIn: bigint | null;
  tOut: bigint | null;
  /** Versioned id of the rule that maps categories to tIn/tOut (B defines and documents). */
  tRule: string;
  /** Digest of the canonical JSON of the raw usage object only (never of prompt/response text). */
  rawUsageDigest: Hex32;
  normalizerVersion: string;
  /** v1.1 (R-B2): problems found while normalizing. Omit the key when there are none; never undefined. */
  issues?: UsageIssue[];
  /** Official documentation the normalizer follows for this API (D5 §1). */
  docRef: { url: string; retrievedAt: IsoTime };
  observedAt: IsoTime;
  /**
   * v1.3 (FECHAMENTO_GEMINI_AD): service tier the provider reported for this response (OpenAI `service_tier`,
   * Gemini `usageMetadata.serviceTier`); null = the response did not report it. Present only for APIs that
   * report a tier.
   */
  serviceTier?: string | null;
  /**
   * v1.3: how the generation ended, as reported (Gemini: first candidate's finishReason, or
   * `blocked:<blockReason>` when the prompt was blocked and no candidate was returned; null = not reported).
   * Present only for APIs whose rule maps it. Billing follows the usage, never this field.
   */
  finishReason?: string | null;
}

/** Model/API support as declared by the catalog (D4 §4). 'generic_fallback' is never 'exact'. */
export type SupportLevel = 'exact' | 'alias_known' | 'generic_fallback' | 'unsupported';

/**
 * Local tokenizer coverage of one provider, API and model (from the model catalog).
 */
export interface ModelSupport {
  provider: string;
  api: UsageApi;
  modelRequested: string;
  /** Catalog key actually used (e.g. family entry for a dated alias). */
  catalogKey: string | null;
  support: SupportLevel;
  /** Tokenizer package+version+encoding for the auxiliary counter, null when none applies. */
  tokenizer: TokenizerIdentity | null;
  catalogVersion: string;
}

/** Enough to reproduce a local count in a clean clone (D4 §5, D4-G05). */
export interface TokenizerIdentity {
  /** e.g. 'js-tiktoken' */
  package: string;
  /** exact installed version from the lockfile, e.g. '1.0.21' */
  packageVersion: string;
  /** e.g. 'o200k_base' */
  encoding: string;
  /** digest of the vocabulary/ranks file actually loaded, when obtainable */
  vocabularyDigest: Hex32 | null;
  /** id + version of the message/tool assembly used before tokenizing */
  messageAssembly: { id: string; version: string } | null;
}
