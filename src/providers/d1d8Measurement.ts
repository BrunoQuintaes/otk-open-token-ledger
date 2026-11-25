/**
 * Front B entry point for the D1–D8 measurement contract (src/types/d1d8/modules.ts).
 * Each export is checked against the frozen contract type at compile time; C and S4 import
 * from here. Price-dependent functions are factories bound to a registry of immutable tables.
 *
 * Single import point for the measurement functions (usage normalization, stream accumulation, model
 * support, CU weights and computation, pricing, local counting, conference report). Imported by
 * `src/operations/bootstrapD1D8.ts`, `src/operations/d1d8Ports.ts`, `src/operations/measurementPorts.ts`
 * and by tests. It adds no behaviour: each export is the implementation typed with the contract type.
 *
 * @module src/providers/d1d8Measurement
 */
import type {
  BuildConferenceReportFn, ComputeCuFn, CreateLocalCounterFn, CreateStreamUsageAccumulatorFn, EstimateReservationFn,
  LoadCuWeightsFn, NormalizeUsageFn, PriceUsageFn, ResolveModelSupportFn,
} from '../types/d1d8/index.js';
import { normalizeUsage as normalizeUsageImpl } from './usage/normalizeUsage.js';
import { createStreamUsageAccumulator as createStreamUsageAccumulatorImpl } from './usage/streamUsageAccumulator.js';
import { resolveModelSupport as resolveModelSupportImpl } from './catalog/modelCatalog.js';
import { loadCuWeights as loadCuWeightsImpl } from '../economics/cuWeightsV2.js';
import { computeCu as computeCuImpl } from '../economics/computeCu.js';
import { createPriceUsage, type PriceTableRegistry } from '../pricing/priceUsage.js';
import { createEstimateReservation } from '../pricing/reservation.js';
import { createLocalCounter as createLocalCounterImpl } from '../tokenization/localCounter.js';
import { buildConferenceReport as buildConferenceReportImpl } from '../tokenization/conferenceReport.js';

/**
 * Normalizes a provider usage object; see `src/providers/usage/normalizeUsage.ts`.
 */
export const normalizeUsage: NormalizeUsageFn = normalizeUsageImpl;
/**
 * Creates a stream usage accumulator; see `src/providers/usage/streamUsageAccumulator.ts`.
 */
export const createStreamUsageAccumulator: CreateStreamUsageAccumulatorFn = createStreamUsageAccumulatorImpl;
/**
 * Resolves local tokenizer coverage for a model; see `src/providers/catalog/modelCatalog.ts`.
 */
export const resolveModelSupport: ResolveModelSupportFn = resolveModelSupportImpl;
/**
 * Loads and checks a CU weights table; see `src/economics/cuWeightsV2.ts`.
 */
export const loadCuWeights: LoadCuWeightsFn = loadCuWeightsImpl;
/**
 * Computes CU for a normalized usage with a weights configuration; see `src/economics/computeCu.ts`.
 *
 * @param usage - Normalized usage.
 * @param cfg - CU configuration (weights and formula).
 * @returns The CU result from `computeCu`.
 */
export const computeCu: ComputeCuFn = (usage, cfg) => computeCuImpl(usage, cfg);
/**
 * Creates the local (auxiliary) token counter; see `src/tokenization/localCounter.ts`.
 */
export const createLocalCounter: CreateLocalCounterFn = createLocalCounterImpl;
/**
 * Builds the report that compares local counts with the provider's reported usage; see
 * `src/tokenization/conferenceReport.ts`.
 */
export const buildConferenceReport: BuildConferenceReportFn = buildConferenceReportImpl;

/**
 * Binds the price-dependent functions to one registry of immutable price tables.
 *
 * @param registry - Price tables to use; it is captured, not copied.
 * @returns `priceUsage` (prices a usage) and `estimateReservation` (estimates the amount to reserve
 *   before a call), both reading from `registry`.
 */
export function bindPricing(registry: PriceTableRegistry): { priceUsage: PriceUsageFn; estimateReservation: EstimateReservationFn } {
  return { priceUsage: createPriceUsage(registry), estimateReservation: createEstimateReservation(registry) };
}

export { normalizeUsageDetailed, NORMALIZER_VERSION, T_RULE_ID, categoryCount } from './usage/normalizeUsage.js';
export { MODEL_CATALOG_VERSION } from './catalog/modelCatalog.js';
export {
  CU_FORMULA_EXACT, CU_FORMULA_LEGACY, developmentCuConfig, developmentProfileConfig, DEVELOPMENT_PROFILES, staticTablesAsV2Body, cuWeightsV2Message, cuWeightsV2ToJson,
  cuWeightsV2Ref, DEFAULT_V2_ALIASES,
} from '../economics/cuWeightsV2.js';
export { computeCuFromTotals, scaledToDecimal } from '../economics/computeCu.js';
export { createCuWeightsRuntime } from '../economics/cuWeightsRuntimeV2.js';
export { createPriceTableRegistry, parsePriceTableV1, priceTableRef, type PriceTableV1 } from '../pricing/priceUsage.js';
export { inputTokensUpperBound, ReservationError } from '../pricing/reservation.js';
export { extractInputText, extractOutputText, COUNTER_VERSION } from '../tokenization/localCounter.js';
export { HEURISTIC_THRESHOLD_V0, CONFERENCE_RULE_ID } from '../tokenization/conferenceReport.js';
