/**
 * Front B entry point for the D1–D8 measurement contract (src/types/d1d8/modules.ts).
 * Each export is checked against the frozen contract type at compile time; C and S4 import
 * from here. Price-dependent functions are factories bound to a registry of immutable tables.
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

export const normalizeUsage: NormalizeUsageFn = normalizeUsageImpl;
export const createStreamUsageAccumulator: CreateStreamUsageAccumulatorFn = createStreamUsageAccumulatorImpl;
export const resolveModelSupport: ResolveModelSupportFn = resolveModelSupportImpl;
export const loadCuWeights: LoadCuWeightsFn = loadCuWeightsImpl;
export const computeCu: ComputeCuFn = (usage, cfg) => computeCuImpl(usage, cfg);
export const createLocalCounter: CreateLocalCounterFn = createLocalCounterImpl;
export const buildConferenceReport: BuildConferenceReportFn = buildConferenceReportImpl;

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
