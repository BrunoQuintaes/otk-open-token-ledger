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
 * This file reads no environment variable itself: `bootstrapD1D8.ts` reads them and passes paths and lists in.
 * It does read the weights and price-table files given to it (synchronously, at startup).
 *
 * @module src/operations/d1d8Ports
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

/** Placeholder proof configuration when no proof/chain is configured: circuit `none`, no chain destination. */
export const NO_PROOF_CONFIG: FrozenProofConfig = {
  circuitId: 'none',
  bucketPolicy: { version: 'none', digest: sha256Hex('none') as Hex32 },
  chain: null,
};

/** Source of CU weight tables: the active one for new operations, and lookup by version for old ones. */
export interface WeightsSource {
  /**
   * The weights for new admissions.
   *
   * @returns The active configuration, or `null` when no valid table is loaded (admissions are then refused).
   */
  active(): CuConfig | null;
  /**
   * Resolves the weights an operation was admitted with.
   *
   * @param ref - Version and digest frozen into the operation.
   * @returns The matching configuration, or `null` when unknown.
   */
  byRef(ref: VersionRef): CuConfig | null;
  /** Short non-secret label for logs and the startup summary. */
  label: string;
}

/**
 * Signed weights runtime (B) loaded from a file, with a persisted snapshot.
 *
 * Never throws for a missing or unreadable file: the result then has a non-ok `status`, a `reason`, and
 * `active()` falls back to the persisted snapshot while it is still valid (else `null`).
 *
 * @param o - Weights file path, trusted signer addresses, snapshot directory (`null` = memory only) and an
 *   optional clock returning ISO time.
 * @returns The weights source plus the refresh status and reason.
 */
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
 *
 * @param profile - Development profile name.
 * @returns A static weights source flagged as development.
 * @throws {Error} When the profile name is unknown.
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

/**
 * Reads and parses price-table files; the first file becomes the table frozen into new operations.
 *
 * @param files - Paths of `otk.price_table.v1` JSON files, in priority order (may be empty).
 * @returns The registry, the parsed tables and the active table reference (`null` when no file is given).
 * @throws {Error} When a file cannot be read, is not JSON, or is not a valid price table.
 */
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

/**
 * Composes the measurement ports used by the durable runtime from the weights, prices, proof configuration
 * and calibration profiles.
 *
 * @param o - The configured components.
 * @returns The ports. Its `estimateInputTokens` throws `RangeError` for inputs with non-text parts (the
 *   reservation is then refused).
 */
export function d1d8MeasurementPorts(o: {
  weights: WeightsSource;
  prices: { registry: PriceTableRegistry; active: VersionRef | null };
  /** Frozen into each operation; default {@link NO_PROOF_CONFIG}. */
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
