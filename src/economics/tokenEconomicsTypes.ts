/**
 * G3 — Token Economics Contract Foundation (RB-073)
 *
 * Formal type contracts separating the three economic layers:
 *
 *   CU layer   — deterministic internal index (bigint, ZK-compatible)
 *                computed from token usage weights; never touches USD
 *   Fiat layer — oracle-sourced USD/BRL snapshot for reporting only
 *   Valuation  — CU × usdPerCU at a fixed reference rate
 *
 * INVARIANT: CU != USD.
 *   CU is a purely internal, cross-provider index (see CUEngine.ts, ADR-CU-0001).
 *   Fiat valuation is always a secondary, oracle-sourced, non-deterministic layer.
 *
 * @module src/economics/tokenEconomicsTypes
 * @since G3
 */

/** Currencies a valuation can be expressed in. */
export type CurrencyCode = 'USD' | 'BRL' | 'EUR';

/**
 * A snapshotted reference rate from an oracle (or fixed-rate placeholder).
 * All fields are injected — no hidden global state.
 */
export type ReferenceRate = {
  /** Currency pair (e.g. 'USD_BRL') */
  pair: string;
  /** Rate value (e.g. 5.10 means 1 USD = 5.10 BRL) */
  rate: number;
  /** Snapshot epoch (unix seconds) — injected for determinism */
  snapshotEpoch: number;
  /**
   * Source tag:
   *   'fixed'    — static in-repo constant (dissertation experiments)
   *   'injected' — caller-provided at runtime
   *   'oracle'   — future: live oracle feed (not implemented)
   */
  source: 'fixed' | 'injected' | 'oracle';
  /** Table version for auditability */
  version: string;
};

/**
 * CU amount paired with its fiat valuation at a reference rate.
 * The CU amount is always authoritative; valuationUsd is derived.
 */
export type OTKTokenValue = {
  /** Internal CU amount (deterministic, ZK-compatible bigint) */
  amountCU: bigint;
  /** USD valuation at reference rate — secondary, non-authoritative */
  valuationUsd: number;
  /** Reference rate used for this valuation */
  referenceRate: ReferenceRate;
  /** Epoch at which this valuation was computed (unix seconds) */
  computedAt: number;
};

/**
 * Policy for converting CU to fiat for reporting.
 * Does NOT affect CU computation — only reporting/governance.
 */
export type ValuationPolicy = {
  /** USD price per 1 CU unit for fiat reporting */
  usdPerCU: number;
  /** Conversion mode */
  mode: 'fixed' | 'oracle';
  /** Version tag for audit trail */
  version: string;
};

/**
 * Default valuation policy — fixed, deterministic, dissertation-safe.
 *
 * 1 CU ≈ 0.000001 USD (1 micro-dollar).
 * At standard weights (W_m=1, W_p=1), 1 token ≈ 1 CU,
 * so 1M tokens ≈ 1 USD — consistent with CostBridge price table order of magnitude.
 */
export const DEFAULT_VALUATION_POLICY: ValuationPolicy = {
  usdPerCU: 0.000_001,
  mode: 'fixed',
  version: '2026-02',
} as const;
