/**
 * RB-055 — Pricing Engine v2 (Tiers + Markup + Margin)
 *
 * Builds on:
 *   - MarginEngine.ts (U3.4) — markup/margin calculation
 *   - CostUnits.ts (U5.2) — CU computation
 *   - ADR-0107 — tier simplification strategy
 *
 * New in v2:
 *   - Tier-based weight resolution (Standard/Advanced/Frontier)
 *   - SLA tier surcharge
 *   - Volume discount brackets
 *
 * All functions are pure — no I/O, no side effects.
 *
 * @module pricing/PricingEngineV2
 * @since RB-055
 */

import { calculateMargin, type MarginResult } from './economics/MarginEngine.js';

// ---------------------------------------------------------------------------
// Tier definitions (ADR-0107)
// ---------------------------------------------------------------------------

export type PricingTier = 'STANDARD' | 'ADVANCED' | 'FRONTIER';

export type TierWeights = {
  inputWeight: number;
  outputWeight: number;
  /** USD per 1000 CU (reference rate for billing conversion) */
  usdPer1kCU: number;
};

export const TIER_WEIGHTS: Record<PricingTier, TierWeights> = {
  STANDARD:  { inputWeight: 0.5, outputWeight: 1.5, usdPer1kCU: 0.50 },
  ADVANCED:  { inputWeight: 1.0, outputWeight: 3.0, usdPer1kCU: 1.00 },
  FRONTIER:  { inputWeight: 2.0, outputWeight: 6.0, usdPer1kCU: 2.50 },
};

/** Canonical model→tier mapping (extend as needed) */
export const MODEL_TIER: Record<string, PricingTier> = {
  // STANDARD
  'gpt-3.5-turbo':    'STANDARD',
  'claude-3-haiku':   'STANDARD',
  'deepseek-chat':    'STANDARD',
  'mistral-7b':       'STANDARD',
  // ADVANCED
  'gpt-4o':           'ADVANCED',
  'claude-3-sonnet':  'ADVANCED',
  'gemini-1.5-pro':   'ADVANCED',
  // FRONTIER
  'gpt-4':            'FRONTIER',
  'claude-3-opus':    'FRONTIER',
  'claude-opus-4':    'FRONTIER',
  'o1-preview':       'FRONTIER',
};

export type SLATier = 'BEST_EFFORT' | 'STANDARD_SLA' | 'PREMIUM_SLA';

export const SLA_SURCHARGE_PCT: Record<SLATier, number> = {
  BEST_EFFORT:   0,
  STANDARD_SLA: 10,
  PREMIUM_SLA:  25,
};

// ---------------------------------------------------------------------------
// Volume discount brackets
// ---------------------------------------------------------------------------

export type VolumeBracket = { minCU: number; discountPct: number };

export const DEFAULT_VOLUME_BRACKETS: VolumeBracket[] = [
  { minCU: 0,          discountPct: 0  },
  { minCU: 1_000_000,  discountPct: 5  },
  { minCU: 10_000_000, discountPct: 10 },
  { minCU: 100_000_000,discountPct: 15 },
];

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Resolve PricingTier for a model (fallback: ADVANCED).
 */
export function resolveModelTier(model: string): PricingTier {
  return MODEL_TIER[model] ?? 'ADVANCED';
}

/**
 * Compute volume discount % for a given total CU.
 */
export function volumeDiscount(
  totalCU: number,
  brackets: VolumeBracket[] = DEFAULT_VOLUME_BRACKETS,
): number {
  let discount = 0;
  for (const b of brackets) {
    if (totalCU >= b.minCU) discount = b.discountPct;
  }
  return discount;
}

export type PricingV2Input = {
  model: string;
  costUnits: number;
  markupPercent?: number;
  slaTier?: SLATier;
  monthlyTotalCU?: number;
  fxRate?: number;
};

export type PricingV2Result = {
  tier: PricingTier;
  slaTier: SLATier;
  costUsd: number;
  markupPercent: number;
  slaPercent: number;
  volumeDiscountPct: number;
  finalPriceUsd: number;
  marginUsd: number;
  marginPercent: number;
  finalPriceBrl?: number;
};

/**
 * Full pricing calculation v2.
 * Pure function — no I/O.
 */
export function computePricingV2(input: PricingV2Input): PricingV2Result {
  const tier = resolveModelTier(input.model);
  const weights = TIER_WEIGHTS[tier];
  const slaTier = input.slaTier ?? 'BEST_EFFORT';
  const slaPercent = SLA_SURCHARGE_PCT[slaTier];
  const markupBase = input.markupPercent ?? 20;
  const totalMarkup = markupBase + slaPercent;

  // Base cost in USD
  const costUsd = (input.costUnits / 1000) * weights.usdPer1kCU;

  // Volume discount
  const discountPct = volumeDiscount(input.monthlyTotalCU ?? 0);
  const discountedCostUsd = costUsd * (1 - discountPct / 100);

  // Margin engine
  const margin: MarginResult = calculateMargin({
    costUsd: discountedCostUsd,
    markupPercent: totalMarkup,
    fxRate: input.fxRate,
  });

  return {
    tier,
    slaTier,
    costUsd: discountedCostUsd,
    markupPercent: totalMarkup,
    slaPercent,
    volumeDiscountPct: discountPct,
    finalPriceUsd: margin.finalPriceUsd,
    marginUsd: margin.marginUsd,
    marginPercent: margin.marginPercent,
    ...(margin.finalPriceBrl !== undefined ? { finalPriceBrl: margin.finalPriceBrl } : {}),
  };
}

// ──────────────────────────────────────────────────────────
// PricingEngineV2 class — margin-aware per-plan pricing (P4.7)
// ──────────────────────────────────────────────────────────

import type { PlanTier } from '../billing/PlanRegistry.js';

export interface PricingResult {
  tier: PlanTier;
  cuUsed: bigint;
  unitPrice: number;
  total: number;
  margin: number;
  marginRate: number;
}

const _PLAN_MARGIN_RATES: Record<PlanTier, number> = {
  FREE: 0.00,
  STARTER: 0.20,
  PRO: 0.35,
};

/** Margin-aware pricing engine for FREE/STARTER/PRO plans (P4.7). */
export class PricingEngineV2 {
  private readonly _unitPrice: number;

  constructor(unitPriceUsd?: number) {
    this._unitPrice = unitPriceUsd
      ?? Number(process.env['OTK_PRICE_PER_CU_USD'] ?? 0.001);
  }

  computeMargin(tier: PlanTier, cuUsed: bigint): PricingResult {
    const marginRate = _PLAN_MARGIN_RATES[tier] ?? 0;
    const total = this._unitPrice * Number(cuUsed);
    return { tier, cuUsed, unitPrice: this._unitPrice, total, margin: total * marginRate, marginRate };
  }

  get unitPrice(): number { return this._unitPrice; }
}
