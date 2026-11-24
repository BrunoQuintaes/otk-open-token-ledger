/**
 * D1–D8 / S4 — the real measurement ports of the durable runtime: front B's modules
 * (normalization, CU with signed versioned weights, historical prices, worst-case reservation,
 * auxiliary counter and conference report) composed for OperationsRuntime.create. Replaces
 * legacyMeasurementPorts in the delivered entrypoint (src/api/server.ts); the legacy ports stay
 * only for tests that characterise the pre-D1–D8 behaviour.
 *
 * Weights (D4 §1–3): a signed otk.cu_weights.v2 table from OTK_CU_WEIGHTS_FILE, verified against
 * OTK_CU_WEIGHTS_SIGNERS (addresses, not secrets), persisted as a snapshot in
 * OTK_CU_WEIGHTS_SNAPSHOT_DIR so a restart with the source down keeps the same version. Without a
 * valid table activeCuConfig() is null and admissions that depend on measurement are refused
 * (503 cu_config_unavailable). The development profile is explicit only
 * (OTK_CU_WEIGHTS_PROFILE=development) and flagged developmentProfile=true in every result.
 * Prices (D5 §6): immutable otk.price_table.v1 files (OTK_PRICE_TABLE_FILES, comma separated);
 * the first one is frozen into new operations. No table = money null (never US$ 0).
 * Calibration (Phase 8): profiles loaded once at startup (OTK_CALIBRATION_PROFILES_DIR, read in bootstrapD1D8),
 * selected per (provider, api, model) when the conference report is built; HEURISTIC_THRESHOLD_V0 otherwise.
 *
 * @module operations/d1d8Ports
 */
import { readFileSync } from 'node:fs';
import type { CuConfig, FrozenConfigRef, Hex32, UsageApi, VersionRef } from '../types/d1d8/index.js';
import {
  bindPricing, buildConferenceReport, computeCu, createCuWeightsRuntime, createLocalCounter, createPriceTableRegistry,
  developmentCuConfig, developmentProfileConfig, DEVELOPMENT_PROFILES, extractOutputText, HEURISTIC_THRESHOLD_V0, inputTokensUpperBound,
  normalizeUsage, parsePriceTableV1, priceTableRef, resolveModelSupport, MODEL_CATALOG_VERSION,
} from '../providers/d1d8Measurement.js';
// B's accumulator with its 4th (text hooks) argument, outside the frozen 3-argument contract type
import { createStreamUsageAccumulator } from '../providers/usage/streamUsageAccumulator.js';
import { createFileSnapshotStore, createMemorySnapshotStore } from '../economics/cuWeightsRuntimeV2.js';
import type { PriceTableRegistry, PriceTableV1 } from '../pricing/priceUsage.js';
import { canonicalJson, sha256Hex } from './ids.js';
import { warmEncodings } from '../tokenization/tokenizerIdentity.js';
import { emptyCalibrationRegistry, type CalibrationRegistry } from '../tokenization/calibrationProfile.js';
import type { MeasurementPorts } from './measurementPorts.js';

/** What A/S4 freeze next to the measurement configuration (chain destination, circuit, bucket policy). */
export interface FrozenProofConfig {
  circuitId: string;
  bucketPolicy: VersionRef;
  chain: FrozenConfigRef['chain'];
}

export const NO_PROOF_CONFIG: FrozenProofConfig = {
  circuitId: 'none',
  bucketPolicy: { version: 'none', digest: sha256Hex('none') as Hex32 },
  chain: null,
};

export interface WeightsSource {
  active(): CuConfig | null;
  byRef(ref: VersionRef): CuConfig | null;
  label: string;
}

/** Signed weights runtime (B) loaded from a file, with a persisted snapshot. */
export async function signedWeightsFromFile(o: { file: string | null; signers: string[]; snapshotDir: string | null; now?: () => string }): Promise<WeightsSource & { status: string; reason: string | null }> {
  const rt = createCuWeightsRuntime({
    store: o.snapshotDir ? createFileSnapshotStore(o.snapshotDir) : createMemorySnapshotStore(),
    trustedSigners: o.signers,
    now: o.now ?? (() => new Date().toISOString()),
  });
  const st = await rt.refresh(async () => {
    if (!o.file) return { kind: 'unavailable', reason: 'OTK_CU_WEIGHTS_FILE not set' };
    try { return { kind: 'ok', raw: JSON.parse(readFileSync(o.file, 'utf8')) as unknown }; } catch (e) { return { kind: 'unavailable', reason: (e as Error).message }; }
  });
  return {
    label: `signed-weights:${st.status}`,
    status: st.status,
    reason: st.reason,
    active: () => rt.active(),
    byRef: (ref) => rt.byRef(ref)?.config ?? null,
  };
}

/**
 * Explicit development profile (static tables, flagged): never chosen silently. `profile` names a versioned
 * development profile (DEVELOPMENT_PROFILES; default the historical `development`). byRef resolves every
 * published development profile, so operations admitted under an earlier one keep resolving their weights.
 */
export function developmentWeights(profile = 'development'): WeightsSource {
  const spec = Object.hasOwn(DEVELOPMENT_PROFILES, profile) ? DEVELOPMENT_PROFILES[profile]! : null;
  if (!spec) throw new Error(`unknown development weights profile '${profile}' (known: ${Object.keys(DEVELOPMENT_PROFILES).join(', ')})`);
  const cfg = profile === 'development' ? developmentCuConfig() : developmentProfileConfig(spec);
  const all = Object.values(DEVELOPMENT_PROFILES).map((s) => developmentProfileConfig(s));
  return {
    label: profile === 'development' ? 'development-profile-weights' : `development-profile-weights:${profile}`,
    active: () => cfg,
    byRef: (ref) => all.find((c) => ref.digest === c.ref.digest && ref.version === c.ref.version) ?? null,
  };
}

export function loadPriceTables(files: string[]): { registry: PriceTableRegistry; tables: PriceTableV1[]; active: VersionRef | null } {
  const tables = files.map((f) => parsePriceTableV1(JSON.parse(readFileSync(f, 'utf8'))));
  const registry = createPriceTableRegistry(tables);
  return { registry, tables, active: tables[0] ? priceTableRef(tables[0]) : null };
}

/** APIs whose usage B normalizes (text scope, D5 §2); streams supported for all of them. */
const SUPPORTED: ReadonlySet<UsageApi> = new Set<UsageApi>([
  'openai.chat_completions', 'openai.responses', 'anthropic.messages', 'gemini.generate_content',
  'deepseek.chat_completions', 'mistral.chat_completions', 'cohere.chat',
]);

export function d1d8MeasurementPorts(o: {
  weights: WeightsSource;
  prices: { registry: PriceTableRegistry; active: VersionRef | null };
  proofConfig?: FrozenProofConfig;
  /**
   * Phase 8: calibration profiles loaded at startup (bootstrap: OTK_CALIBRATION_PROFILES_DIR). Default: an empty
   * registry, so every conference records ABSENT and keeps the heuristic threshold.
   */
  calibration?: CalibrationRegistry;
}): MeasurementPorts {
  const pricing = bindPricing(o.prices.registry);
  const proof = o.proofConfig ?? NO_PROOF_CONFIG;
  const calibration = o.calibration ?? emptyCalibrationRegistry();
  return {
    label: `d1d8-measurement(B)+${o.weights.label}`,
    activeCuConfig: () => o.weights.active(),
    frozenConfig: (c) => ({
      cuWeights: c.ref, cuFormula: c.formula, priceTable: o.prices.active,
      modelCatalog: { version: MODEL_CATALOG_VERSION, digest: sha256Hex(canonicalJson(MODEL_CATALOG_VERSION)) as Hex32 },
      bucketPolicy: proof.bucketPolicy, circuitId: proof.circuitId, chain: proof.chain,
      developmentProfile: c.developmentProfile,
    }),
    normalizeUsage,
    createStreamUsageAccumulator: (api, ctx, limits) => createStreamUsageAccumulator(api, ctx, limits),
    computeCu: (usage, cfg) => computeCu(usage, cfg),
    estimateReservation: pricing.estimateReservation,
    supportsApi: (api) => SUPPORTED.has(api),
    // B's bound covers inline text only; anything fetched by reference has no byte bound
    inputBoundable: () => false,
    // inputTokensUpperBound returns null for non-text bodies: no bound → reservation refused
    estimateInputTokens: (api, body) => {
      const b = inputTokensUpperBound(api, body);
      if (b === null) throw new RangeError('input has non-text parts: no upper bound for the reservation');
      return b;
    },
    priceUsage: pricing.priceUsage,
    resolveModelSupport,
    createLocalCounter: (support, limits) => createLocalCounter(support, limits),
    warmUp: () => warmEncodings(),
    buildConferenceReport,
    conferenceThreshold: HEURISTIC_THRESHOLD_V0,
    selectCalibration: (support, counterVersion) => calibration.select(support, counterVersion),
    streamTextHooks: (h) => ({ create: (api, ctx, limits) => createStreamUsageAccumulator(api, ctx, limits, { onTextDelta: h.onTextDelta, onNonTextOutput: h.onNonTextOutput }) }),
    extractOutputText,
    cuConfigByRef: (ref) => o.weights.byRef(ref),
  };
}
