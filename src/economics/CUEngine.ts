/**
 * CUEngine — Isolated Cost Units Engine (F5 / U1.8)
 *
 * Single-responsibility module: compute Cost Units (CU) from token usage.
 * All arithmetic is bigint — float-free, cross-platform deterministic.
 * ZK-compatible: output CU fits in uint64 (verified by calculateCostUnitsV1).
 *
 * Formula (CU_MODEL_v1):
 *   CU(provider, model, t_in, t_out) = round( (t_in + t_out) × W_m × W_p )
 *   round(x) = floor(x + 0.5) — implemented with integer arithmetic
 *
 * ADR-CU-0001: docs/architecture/adr/ADR-CU-0001-cost-units-economic-justification.md
 * Formal spec: docs/architecture/U1_COST_UNIT_FORMAL_SPEC.md
 *
 * @module CUEngine
 * @since U1.8 (F5) | bucketing U5.3
 */

export type {
  CostUnitsInput as CUInput,
  CUPublishMode,
} from '../pricing/CostUnits.js';

export {
  calculateCostUnitsV1 as computeCostUnits,
  calculateCostUnitsV1Number as computeCostUnitsNumber,
  isProviderSupported,
  isModelSupported,
  getSupportedProviders,
  getSupportedModels,
  PROVIDER_WEIGHTS_INT,
  MODEL_WEIGHTS_INT,
  CU_ERROR,
  CUError,
  bucketCU,
  CU_DEFAULT_BUCKET,
} from '../pricing/CostUnits.js';

import {
  bucketCU,
  CU_DEFAULT_BUCKET,
  CUError,
  CU_ERROR,
  type CostUnitsInput,
  type CUPublishMode,
} from '../pricing/CostUnits.js';

import { type CWJson } from './CUWeightsLoader.js';
import { getActiveStrategy } from './ICUStrategy.js';

// ---------------------------------------------------------------------------
// CU_VERSION — frozen identifier for this computation model
// ---------------------------------------------------------------------------

/** Immutable version tag for CU_MODEL_v1. Used for auditability. */
export const CU_VERSION = 'CU_MODEL_v1' as const;

/** Weight scale factor used internally (1000 = weights stored as integer millis). */
export const CU_WEIGHT_SCALE = 1000n;

// ---------------------------------------------------------------------------
// Engine-level privacy bucketing config (U5.3)
//
// CU_MODE env (raw|bucketed) — primary; falls back to CU_PUBLISH_MODE for
// backward compatibility with existing deployments. Default: 'bucketed'.
//
// CU_BUCKET_SIZE env — positive integer, default 100.
//
// These are resolved once at module load time (deterministic per process).
// ---------------------------------------------------------------------------

function _resolveMode(): CUPublishMode {
  const v = process.env['CU_MODE'] ?? process.env['CU_PUBLISH_MODE'] ?? '';
  return v === 'raw' ? 'raw' : 'bucketed';
}

function _resolveBucketSize(): bigint {
  const v = parseInt(process.env['CU_BUCKET_SIZE'] ?? '', 10);
  if (Number.isFinite(v) && v > 0) return BigInt(v);
  return CU_DEFAULT_BUCKET; // 100n
}

/**
 * Active publish mode for on-chain CU values.
 * Controlled by CU_MODE env (raw|bucketed); falls back to CU_PUBLISH_MODE.
 * Default: 'bucketed'.
 */
export const CU_ENGINE_MODE: CUPublishMode = _resolveMode();

/**
 * Active bucket size for on-chain CU values.
 * Controlled by CU_BUCKET_SIZE env (positive integer); default: 100.
 */
export const CU_ENGINE_BUCKET_SIZE: bigint = _resolveBucketSize();

// ---------------------------------------------------------------------------
// computePublishedCU — raw CU + privacy bucketing applied (the on-chain value)
//
// Bucketing rule: round-half-up to nearest multiple of CU_ENGINE_BUCKET_SIZE.
//
// Examples (bucketSize=100):
//   237 → 200  (closer to 200 than 300; distance 37 vs 63)
//   250 → 300  (tie rounds up)
//   100 → 100  (already a multiple)
//     0 →   0  (zero stays zero)
// ---------------------------------------------------------------------------

/**
 * Compute Cost Units and apply privacy bucketing for on-chain publication.
 *
 * This is the canonical function to use when building receipts destined
 * for on-chain submission. It applies the engine-level bucketing policy
 * configured via CU_MODE and CU_BUCKET_SIZE environment variables.
 *
 * @returns Published CU (bigint) — the value stored on-chain.
 */
export function computePublishedCU(input: CostUnitsInput): bigint {
  const raw = getActiveStrategy().compute(input);
  return CU_ENGINE_MODE === 'raw' ? raw : bucketCU(raw, CU_ENGINE_BUCKET_SIZE);
}

/**
 * Compute published Cost Units and return as Number (for receipt fields).
 *
 * Suitable for `RawReceipt.costUnits` and adapter `NormalizedUsageEvent.costUnits`.
 * Throws CUError if value exceeds Number.MAX_SAFE_INTEGER.
 */
export function computePublishedCUNumber(input: CostUnitsInput): number {
  const cu = computePublishedCU(input);
  if (cu > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CUError(
      CU_ERROR.UINT64_OVERFLOW,
      `Published CU value ${cu} exceeds MAX_SAFE_INTEGER`
    );
  }
  return Number(cu);
}

// ---------------------------------------------------------------------------
// Dynamic CU computation — ADR-0203 Phase 1 (retired by D5 / S0-F01)
//
// The v1 CW JSON stores inputWeight/outputWeight/latencyWeight per model. The former body
// computed round((tIn × inputWeight + tOut × outputWeight) / 1000): a weighted sum, not the
// multiplicative formula preserved by D5, and it silently fell back to the static constants
// for any provider/model missing from the table (contrary to D4 §1). It had no runtime caller
// (only test/unit/CUEngine_dynamic.test.ts). Weighted tables are now refused; dynamic weights
// use otk.cu_weights.v2 through src/economics/cuWeightsV2.ts + computeCu.ts.
// ---------------------------------------------------------------------------

/** Error code raised when a v1 (weighted-sum) CW table is passed for CU computation. */
export const CU_WEIGHTS_V1_REJECTED = 'CU_WEIGHTS_V1_REJECTED' as const;

/**
 * @deprecated D5/S0-F01. With `cwJson = null` it returns the static computePublishedCU()
 * (unchanged). A v1 table is refused with CUError(CU_WEIGHTS_V1_REJECTED) instead of being
 * applied as a weighted sum or silently replaced by static constants. Use computeCu() with a
 * validated CuConfig (loadCuWeights / createCuWeightsRuntime).
 */
export function computePublishedCUWithCW(
  input: CostUnitsInput,
  cwJson: CWJson | null,
): bigint {
  if (!cwJson) return computePublishedCU(input);
  throw new CUError(
    CU_WEIGHTS_V1_REJECTED,
    `CW table ${cwJson.version} uses the v1 input/output/latency schema (weighted sum, S0-F01); ` +
    'use an otk.cu_weights.v2 table with computeCu() — src/economics/computeCu.ts',
  );
}

/**
 * Number variant of computePublishedCUWithCW.
 * Suitable for RawReceipt.costUnits when dynamic governance is active.
 */
export function computePublishedCUWithCWNumber(
  input: CostUnitsInput,
  cwJson: CWJson | null,
): number {
  const cu = computePublishedCUWithCW(input, cwJson);
  if (cu > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CUError(CU_ERROR.UINT64_OVERFLOW, `Dynamic CU value ${cu} exceeds MAX_SAFE_INTEGER`);
  }
  return Number(cu);
}
