/**
 * Worst-case reservation for a call whose usage is unknown until the provider answers
 * (D7 §8–9 via INTERFACES §7; front B computes, C reserves and settles).
 * createEstimateReservation(registry) returns an EstimateReservationFn.
 *
 *   cu    = CU(estimatedInputTokens + maxOutputTokens) with the frozen weights (same formula)
 *   money = estIn × max input-side price + maxOut × max output-side price, over every window
 *           of the frozen price table (independent of the wall clock)
 *
 * estimatedInputTokens must itself be an upper bound: inputTokensUpperBound() gives one for
 * text-only bodies (UTF-8 bytes of the serialized request), under the stated assumption that
 * every provider token covers at least one byte of text (true for byte-level BPE such as
 * tiktoken; assumed, not verified, for the other providers' tokenizers) and that the JSON
 * keys/quotes over-cover per-message template tokens. It returns null when the body has
 * non-text parts, whose token cost bytes cannot bound.
 * maxOutputTokens must bound every output-side category: reasoning/thinking budgets that the
 * provider counts outside its max-output parameter (e.g. a Gemini thinking budget) have to be
 * added by the caller.
 * An auxiliary local count (localCounter.ts) is an estimate, not a bound, and must not be
 * passed here.
 * The bound holds for the REQUESTED model. Final CU/price use the model the provider returns
 * (computeCu.ts); if it returns a heavier/pricier model the final value can exceed this
 * reservation. C must compare the returned model with the reserved one at settlement and treat
 * a mismatch as an explicit over-reservation event (never silently cap).
 */
import type { Money, Scaled, UsageApi, VersionRef } from '../types/d1d8/index.js';
import type { CuConfig } from '../types/d1d8/index.js';
import { cuFromTotals, resolveCuWeights } from '../economics/computeCu.js';
import { AMOUNT_SCALE, type PriceTableRegistry, worstCaseSidePrices } from './priceUsage.js';

export class ReservationError extends Error {
  constructor(readonly code: 'unsupported_model' | 'invalid_request', message: string) {
    super(message);
    this.name = 'ReservationError';
  }
}

export interface ReservationRequest {
  provider: string;
  api: UsageApi;
  modelRequested: string;
  estimatedInputTokens: bigint;
  maxOutputTokens: bigint;
}

export interface ReservationResult {
  cu: Scaled;
  money: Money | null;
  basis: string;
}

export function createEstimateReservation(registry: PriceTableRegistry) {
  return (req: ReservationRequest, cfg: CuConfig, priceTable: VersionRef | null): ReservationResult => {
    if (req.estimatedInputTokens < 0n || req.maxOutputTokens <= 0n) {
      throw new ReservationError('invalid_request', 'estimatedInputTokens must be >= 0 and maxOutputTokens > 0 (an unbounded output has no worst case)');
    }
    const w = resolveCuWeights(cfg, req.provider, req.modelRequested);
    if (w.wModelMilli === null || w.wProviderMilli === null) {
      throw new ReservationError('unsupported_model', `no authorized weight for ${req.provider}/${req.modelRequested}`);
    }
    const cu = cuFromTotals(cfg.formula, req.estimatedInputTokens, req.maxOutputTokens, w.wModelMilli, w.wProviderMilli);
    let money: Money | null = null;
    let moneyBasis = 'money:null(no price table)';
    if (priceTable) {
      const table = registry.get(priceTable);
      const prices = table ? worstCaseSidePrices(table, req.provider, req.modelRequested) : null;
      if (prices) {
        money = { units: req.estimatedInputTokens * prices.input + req.maxOutputTokens * prices.output, scale: AMOUNT_SCALE, currency: 'USD' };
        moneyBasis = `money:estIn×${prices.input}+maxOut×${prices.output} µUSD/MTok (max over table ${priceTable.version})`;
      } else {
        moneyBasis = `money:null(no base price for model in ${priceTable.version})`;
      }
    }
    return {
      cu,
      money,
      basis: `otk.reservation.worst_case@1 (bound for requested model ${req.modelRequested} only); cu:(${req.estimatedInputTokens}+${req.maxOutputTokens})×${w.wModelMilli}×${w.wProviderMilli} ${cfg.formula} weights ${cfg.ref.version}; ${moneyBasis}`,
    };
  };
}

function isTextOnly(value: unknown): boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return true;
  if (Array.isArray(value)) return value.every(isTextOnly);
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const type = typeof o['type'] === 'string' ? (o['type'] as string) : '';
    if (/image|audio|file|document|video|input_image|input_file|input_audio/.test(type)) return false;
    if ('inlineData' in o || 'inline_data' in o || 'fileData' in o || 'file_data' in o || 'image_url' in o || 'input_audio' in o) return false;
    return Object.values(o).every(isTextOnly);
  }
  return false;
}

/** Upper bound of input tokens for a text-only request body; null when it cannot be bounded. */
export function inputTokensUpperBound(api: UsageApi, body: unknown): bigint | null {
  void api;
  if (body === null || typeof body !== 'object' || !isTextOnly(body)) return null;
  return BigInt(Buffer.byteLength(JSON.stringify(body), 'utf8'));
}
