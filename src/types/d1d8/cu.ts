/**
 * D1–D8 shared contract — CU and money (D4, D5; producer B, consumers A/C/S4).
 *
 * CU keeps the multiplicative form registered on 15/09 (D5):
 *     CU = (T_entrada + T_saida) × W_modelo × W_provedor
 * with scale and rounding versioned in `formula`. Latency, benefit and price never enter CU.
 * CU (normalization) and Money (commercial price) are separate results.
 *
 * @module src/types/d1d8/cu
 */
import type { Hex32, IsoTime, Money, Scaled, VersionRef } from './common.js';
import type { TokenCategoryName } from './usage.js';

/**
 * Signed weights table, schema v2 (replaces the input/output/latency CWJson shape, which does
 * not express the multiplicative formula). Weights are integers in milli units (1000 = 1.0).
 */
export interface CuWeightsTableV2 {
  schema: 'otk.cu_weights.v2';
  version: string;
  validFrom: IsoTime;
  validUntil: IsoTime;
  /** W_provedor per provider key (lowercase). */
  providerWeightsMilli: Record<string, bigint>;
  /** W_modelo per catalog model key (lowercase). */
  modelWeightsMilli: Record<string, bigint>;
  /** Explicit alias → catalog key map (dated snapshots). Unknown ids are not guessed. */
  aliases: Record<string, string>;
  signedBy: string;
  signature: string;
}

/** Outcome of loading/validating a weights table (D4 §2). Distinguishes the failure causes. */
export type CuWeightsLoadStatus =
  | 'valid'
  | 'missing'
  | 'bad_signature'
  | 'unauthorized_signer'
  | 'expired'
  | 'not_yet_valid'
  | 'malformed'
  | 'source_unavailable_using_snapshot';

/**
 * Outcome of a CU computation; only `computed` carries a value.
 */
export type CuStatus =
  | 'computed'
  /** model/provider has no authorized weight — not 0, not a default constant */
  | 'unsupported_model'
  /** tIn/tOut null (usage missing/partial/invalid) */
  | 'usage_not_computable'
  /** frozen config invalid for the operational profile */
  | 'invalid_config';

/**
 * Result of one CU computation, with the configuration and formula versions used.
 */
export interface CuResult {
  schema: 'otk.cu_result.v1';
  status: CuStatus;
  /** Exact accounting CU (never the public bucket). null unless status === 'computed'. */
  cu: Scaled | null;
  /** Formula id: scale + rounding rule, e.g. 'CU_MODEL_v1' = integer CU, round half up. */
  formula: string;
  weights: VersionRef;
  tIn: bigint | null;
  tOut: bigint | null;
  wModelMilli: bigint | null;
  wProviderMilli: bigint | null;
  /** True when the development profile produced this value (D4 §1). */
  developmentProfile: boolean;
}

/**
 * Outcome of pricing a usage: fully priced, no price found, or only some categories priced.
 */
export type PriceStatus = 'priced' | 'missing_price' | 'partial';

/**
 * Price of one token category of a usage.
 */
export interface PriceLine {
  category: TokenCategoryName;
  count: bigint;
  /**
   * Price per 1,000,000 tokens of this category, as published. v1.1 (request B R-B3): null when no
   * price is published for the category (then amount is null too) — never a zero price.
   */
  unitPricePerMTok: Money | null;
  /** Where the price came from (URL or table id) and when it became effective. */
  source: string;
  effectiveFrom: IsoTime;
  /** null when this line could not be priced (then the quote is 'partial' or 'missing_price'). */
  amount: Money | null;
}

/**
 * Money quote of one usage against one versioned price table.
 */
export interface PriceQuote {
  schema: 'otk.price_quote.v1';
  status: PriceStatus;
  /** Sum of priced lines; null when status is 'missing_price'. Never a silent US$ 0. */
  total: Money | null;
  lines: PriceLine[];
  priceTable: VersionRef;
  /** Instant whose tariff was applied (historical price, D5 §6). */
  pricedAt: IsoTime;
  /**
   * v1.2 (S4, audit ABC-02): id of the versioned category billing policy that decided how
   * categories without their own tariff were treated (never an implicit base-rate inheritance).
   * Omitted in quotes produced before 1.2.
   */
  categoryPolicy?: string;
}

/** Reference to the vector file B maintains (hand-computed; D5 §8). */
export const D1D8_COMMON_VECTORS_PATH = 'test/fixtures/d1d8/common_vectors.json' as const;

/** Digest-bearing pointer used when a receipt embeds its CU/price inputs. */
export interface CuPriceBinding {
  cu: CuResult;
  price: PriceQuote | null;
  /** keccak256 over A's canonical encoding of {cu, price}. */
  digest: Hex32;
}
