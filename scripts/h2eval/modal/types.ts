/**
 * H2-EVAL executor: adapters, usage parsers, price table and EX ANTE estimators per provider/modality.
 * Run R14 (C141, block B2). Codes against runs/B1/CONTRACT_MIN_FOR_EXECUTOR.md (h2eval.contract.min.v0)
 * until scripts/h2eval/INTERFACES.md (BOT-02) is published.
 *
 * Rules enforced here:
 *  - a missing number is never zero: every count is `bigint | 'UNKNOWN' | 'NOT_APPLICABLE'`;
 *  - categories are DISJOINT (input without cache, cache read, cache write 5m/1h, visible output, reasoning,
 *    image/audio units when the API reports them, tool tokens);
 *  - no "error" is ever computed against an estimator that does not exist (UNSUPPORTED_FOR_ESTIMATION).
 *
 * This file holds the shared types and constants of the `modal/` layer (adapters, estimators, pricing). Note that
 * counts here are `bigint`, while the core types in `scripts/h2eval/types.ts` use `number`.
 *
 * @module scripts/h2eval/modal/types
 */

/** Version string of the modal layer. */
export const H2EVAL_MODAL_VERSION = 'otk.h2eval.modal.v0@2026-11-10';

/** Token count (`bigint`), or `'UNKNOWN'` / `'NOT_APPLICABLE'`; an absent number is never 0. */
export type Count = bigint | 'UNKNOWN' | 'NOT_APPLICABLE';

/** Provider. */
export type Provider = 'openai' | 'anthropic' | 'google';
/** Provider API supported by the modal adapters. */
export type Api = 'openai.chat_completions' | 'anthropic.messages' | 'gemini.generate_content';
/** Input modality. */
export type Modality = 'text' | 'image' | 'audio';

/** Models of the R07 matrix (IDs exactly as the R08 compatibility matrix lists them). */
export type MatrixModel = 'gpt-4o-mini-2024-07-18' | 'claude-haiku-4-5-20251001' | 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'gemini-3.5-flash-lite'
  /** E3G (C160 BRACO-GO; DR-205): calibration arm models, priced ONLY by the attested arm table (core/e3gArm.ts) */
  | 'gemini-3.1-flash-lite' | 'gpt-6-luna';

/** §4 of the contract: disjoint canonical categories. Unit of imageUnits/audioUnits = provider tokens (the only unit the APIs report). */
export interface CanonicalUsage {
  /** Input tokens not read from or written to the cache. */
  inputUncached: Count;
  /** Input tokens read from the cache. */
  cacheRead: Count;
  /** Anthropic separates 5m/1h; other APIs report at most one write figure (cacheWrite). */
  cacheWrite5m: Count;
  cacheWrite1h: Count;
  cacheWrite: Count;
  /** Output tokens of the visible answer (reasoning excluded). */
  outputVisible: Count;
  /** Reasoning ("thinking") tokens, disjoint from `outputVisible`. */
  reasoning: Count;
  /** Image input tokens when the API reports them separately. */
  imageUnits: Count;
  /** Audio input tokens when the API reports them separately. */
  audioUnits: Count;
  /** Tokens attributed to tool use, when reported. */
  toolTokens: Count;
  /** Totals exactly as the provider reported them (needed for cost when a subdivision is unknown). */
  providerTotals: { inputTotal: Count; outputTotal: Count };
  /** `COMPLETE` when every category is known, `PARTIAL` when some are unknown, `MISSING` when there is no usage. */
  usageCompleteness: 'COMPLETE' | 'PARTIAL' | 'MISSING';
  /** `provider_response` when usage came from the response body, `none` otherwise. */
  usageSource: 'provider_response' | 'none';
  /** Only numbers, copied from the response; never text. */
  rawUsageSanitized: Record<string, number | null>;
  /** Machine-readable notes from the parser. */
  notes: string[];
  /** Contract rev. 2 item 8 (Gemini): usageMetadata.promptTokensDetails by modality (TEXT/IMAGE/AUDIO/VIDEO -> tokens). */
  promptTokensDetailsByModality?: Record<string, number>;
  /** Contract rev. 2 item 8 (OpenAI): cached_tokens are reported rounded down to multiples of 128 (R08 §4). */
  cacheRoundingNote?: 'openai_128';
}

/** Outcome of a parsed response. */
export type Outcome =
  | 'OK'
  | 'REFUSED_WITH_USAGE'
  | 'ERROR_WITH_USAGE'
  | 'ERROR_NO_USAGE'
  | 'INCOMPLETE_UNEXPECTED_CONTENT';

/** Terms that change the price (R08 §2). Anything not on the standard list makes the cost UNKNOWN. */
export interface PricingTermsObserved {
  serviceTier: string | null;
  inferenceGeo: string | null;
  speed: string | null;
  /** true only when every observed term is the standard one for this API */
  standard: boolean;
  nonStandardReasons: string[];
}

/** Result of parsing one provider response: outcome, served model, usage, pricing terms and stop information. */
export interface ParsedResponse {
  api: Api;
  outcome: Outcome;
  httpStatus: number;
  /** Raw, never normalized (contract §2). 'UNKNOWN' when the body has no model field. */
  modelServed: string | 'UNKNOWN';
  usage: CanonicalUsage;
  pricingTerms: PricingTermsObserved;
  /** Machine codes: refusal_block, finish_reason_content_filter, tool_calls, audio_output, block_reason, ... */
  flags: string[];
  /** Provider error code/type when present (no message text). */
  errorCode: string | null;
  /** VNEXT-1 (C151): the provider's stop/finish reason exactly as returned (identifier only; anthropic stop_reason, openai finish_reason, gemini finishReason), or 'UNKNOWN'. */
  stopReason: string | 'UNKNOWN';
  /** VNEXT-1: true when the provider says the output hit the token ceiling (max_tokens | length | MAX_TOKENS); 'UNKNOWN' when the reason is absent. */
  truncated: boolean | 'UNKNOWN';
}

/** Request built by a modal adapter: route, JSON body and the price-relevant parameters, without host or credential. */
export interface RequestEnvelope {
  provider: Provider;
  api: Api;
  model: MatrixModel;
  method: 'POST';
  /** Path only; host and credentials belong to the runner (never here). */
  path: string;
  body: Record<string, unknown>;
  /** The parameters that fix the price, spelled out for the journal (contract §2 `params`). */
  params: {
    maxOutputTokens: number;
    temperature: 'DEFAULT' | number;
    reasoning: string;
    serviceTier: string;
    stream: false;
    cacheDirectives: string;
  };
  /** Flags the parser needs (e.g. whether the request carried images). */
  requestModalities: Modality[];
}

/** Status of an ex-ante estimate: exact estimate, upper bound only, or no estimator for this input. */
export type EstimateStatus = 'ESTIMATED' | 'ESTIMATED_UPPER_BOUND' | 'UNSUPPORTED_FOR_ESTIMATION';

/** Ex-ante (before the call) input token estimate for one modality, with its source and citation. */
export interface ExAnteEstimate {
  status: EstimateStatus;
  modality: Modality;
  /** null unless status is ESTIMATED / ESTIMATED_UPPER_BOUND */
  tokens: bigint | null;
  estimatorId: string;
  /** EXISTENTE = OTK local counter; EXPERIMENTAL = new estimator from a published official formula; NONE = no estimator */
  label: 'EXISTENTE' | 'EXPERIMENTAL' | 'NONE';
  /** Verbatim citation of the official formula + archived file and sha256 (R08 official_docs). */
  citation: string | null;
  reasons: string[];
  /** For text: counter version, tokenizer identity and support level (so a calibration can be attached later). */
  counter?: { version: string; encoding: string | null; support: string; exact: boolean };
}

/**
 * Tells whether a count is a number.
 *
 * @param c - Count.
 * @returns `true` when `c` is a `bigint` (not `'UNKNOWN'` or `'NOT_APPLICABLE'`).
 */
export const isKnown = (c: Count): c is bigint => typeof c === 'bigint';
