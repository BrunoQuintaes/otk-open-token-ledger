/**
 * D1–D8 / S4 — configuration of the durable proxy profile started by the normal entrypoint
 * (src/api/server.ts, OTK_PROXY_ENABLED=1). Composes the REAL modules: front B's measurement
 * (d1d8Ports), front A's crypto/proof (d1d8ProofPorts) and C's runtime. There is no fallback to
 * legacy measurement ports, null crypto or doubles in this profile: missing essential
 * configuration is a startup error with the list of what is missing (fail closed).
 *
 * Required (non-secret config unless noted):
 *   OTK_DB_URL                      PostgreSQL (operations must be durable before the provider)
 *   OTK_SPOOL_DIR, OTK_INSTANCE_ID  local measurement spool + stable unique instance id (D7 §4)
 *   OTK_V3_OPERATOR_KEY (secret)    v3 signing key, through secretsBootstrap
 *   weights: OTK_CU_WEIGHTS_FILE + OTK_CU_WEIGHTS_SIGNERS (+ OTK_CU_WEIGHTS_SNAPSHOT_DIR),
 *            or the explicit OTK_CU_WEIGHTS_PROFILE=development[-<date>] (versioned dev profiles, flagged in every result)
 * Optional:
 *   OTK_PRICE_TABLE_FILES           price tables (first one frozen into new operations)
 *   OTK_MONEY_BOUND_POLICY          strict money bound policy id (default v2; unknown id = startup error)
 *   OTK_V3_OPERATOR_KEY_ID          key id in envelopes (default otk-v3-operator-1)
 *   OTK_V3_DEPLOYMENT_FILE          deploy_v3.js output (chain domain frozen into operations)
 *   OTK_V3_RPC_URL + OTK_V3_SUBMITTER_KEY (secret)  on-chain submission; without them proofs are
 *                                   produced and the submission waits, visible in the outbox
 *   OTK_CALIBRATION_PROFILES_DIR    directory of otk.calibration_profile.v1 files (Phase 8), loaded once here;
 *                                   unset = no profile (every conference records ABSENT, heuristic threshold);
 *                                   set to a missing directory = startup error. Synthetic profiles are refused.
 *
 * Side effects of {@link d1d8ProfileFromEnv}: reads the weights, price, deployment and calibration files,
 * preloads the local tokenizer encodings, and installs the process-wide known-CU calculator used by legacy
 * receipts. Secrets are read only through `src/infra/secretsBootstrap.ts`; their values are never put in the
 * summary or in error messages.
 *
 * @module src/operations/bootstrapD1D8
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCuFromTotals, DEVELOPMENT_PROFILES } from '../providers/d1d8Measurement.js';
import { getV3OperatorKey, getV3SubmitterKey } from '../infra/secretsBootstrap.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables, signedWeightsFromFile, type WeightsSource } from './d1d8Ports.js';
import { createV3Ports, readDeployment } from './d1d8ProofPorts.js';
import { knownCuFromWeights, setKnownCuCalculator } from './knownCu.js';
import { MONEY_BOUND_POLICIES, MONEY_BOUND_POLICY } from './moneyBound.js';
import { operationsOptionsFromEnv, type OperationsRuntimeOptions } from './runtime.js';
import { loadEncoding, type LocalEncoding } from '../tokenization/tokenizerIdentity.js';
import { emptyCalibrationRegistry, loadCalibrationProfilesFromDir, type CalibrationRegistry } from '../tokenization/calibrationProfile.js';
import { existsSync, statSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Startup error listing every missing or invalid setting of the durable profile (all at once, not the first). */
export class D1D8ConfigError extends Error {
  /**
   * Builds the error from the list of problems.
   *
   * @param missing - One human-readable entry per missing or invalid setting (names only, no secret values).
   */
  constructor(readonly missing: string[]) { super(`durable profile not configured: ${missing.join('; ')}`); this.name = 'D1D8ConfigError'; }
}

/** The composed durable profile, ready to start the operations runtime. */
export interface D1D8Profile {
  /** Runtime options with the real measurement, crypto, proof and money-bound policy. */
  options: OperationsRuntimeOptions;
  /** Source of the active CU weights (signed file or a development profile). */
  weights: WeightsSource;
  /** Non-secret startup summary, one human-readable line per component, for the startup log. */
  summary: Record<string, string>;
}

/**
 * Builds the durable proxy profile from environment variables, failing closed when essential configuration
 * is missing.
 *
 * @param dbUrl - PostgreSQL connection URL (already chosen by the caller).
 * @param env - Environment to read (defaults to `process.env`); tests pass their own.
 * @returns The profile; see the file header for the variables read.
 * @throws {@link D1D8ConfigError} When required settings are missing or invalid (all problems listed at once).
 * @throws {Error} When a configured file (weights, prices, deployment, calibration) cannot be read or verified.
 */
export async function d1d8ProfileFromEnv(dbUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<D1D8Profile> {
  const missing: string[] = [];
  const base = operationsOptionsFromEnv(dbUrl);
  if (!env['OTK_SPOOL_DIR']) missing.push('OTK_SPOOL_DIR (measurement spool for PostgreSQL outages)');
  if (!env['OTK_INSTANCE_ID']) missing.push('OTK_INSTANCE_ID (stable unique id of this instance)');
  const operatorKey = getV3OperatorKey();
  if (!operatorKey) missing.push('OTK_V3_OPERATOR_KEY (v3 signing key)');
  // 'development' (historical) or a later versioned development profile (DEVELOPMENT_PROFILES, DL-09)
  const devProfile = env['OTK_CU_WEIGHTS_PROFILE'];
  const devWeights = devProfile !== undefined && devProfile.startsWith('development');
  if (devWeights && !Object.hasOwn(DEVELOPMENT_PROFILES, devProfile)) missing.push(`OTK_CU_WEIGHTS_PROFILE (unknown development profile '${devProfile}'; known: ${Object.keys(DEVELOPMENT_PROFILES).join(', ')})`);
  if (!devWeights && (!env['OTK_CU_WEIGHTS_FILE'] || !env['OTK_CU_WEIGHTS_SIGNERS'])) {
    missing.push('OTK_CU_WEIGHTS_FILE + OTK_CU_WEIGHTS_SIGNERS (signed weights) or OTK_CU_WEIGHTS_PROFILE=development');
  }
  // unset → default policy; set (even blank) → it must name a published policy exactly
  const policyRaw = env['OTK_MONEY_BOUND_POLICY'];
  const policyId = policyRaw?.trim();
  const moneyBoundPolicy = policyRaw === undefined ? MONEY_BOUND_POLICY
    : policyId && Object.hasOwn(MONEY_BOUND_POLICIES, policyId) ? MONEY_BOUND_POLICIES[policyId] : undefined;
  if (!moneyBoundPolicy) missing.push(`OTK_MONEY_BOUND_POLICY (unknown policy '${policyId ?? ''}'; known: ${Object.keys(MONEY_BOUND_POLICIES).join(', ')})`);
  // Phase 8: calibration profiles, read from files once at startup so a restart reproduces the same selection
  const calDir = env['OTK_CALIBRATION_PROFILES_DIR']?.trim() || null;
  if (calDir && !(existsSync(calDir) && statSync(calDir).isDirectory())) missing.push(`OTK_CALIBRATION_PROFILES_DIR (not a directory: '${calDir}')`);
  if (missing.length > 0) throw new D1D8ConfigError(missing);
  const calibration: CalibrationRegistry = calDir ? loadCalibrationProfilesFromDir(calDir) : emptyCalibrationRegistry();

  const weights: WeightsSource = devWeights ? developmentWeights(devProfile) : await signedWeightsFromFile({
    file: env['OTK_CU_WEIGHTS_FILE'] ?? null,
    signers: (env['OTK_CU_WEIGHTS_SIGNERS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    snapshotDir: env['OTK_CU_WEIGHTS_SNAPSHOT_DIR'] || null,
  });
  const priceFiles = (env['OTK_PRICE_TABLE_FILES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const prices = loadPriceTables(priceFiles);
  const deployment = env['OTK_V3_DEPLOYMENT_FILE'] ? readDeployment(env['OTK_V3_DEPLOYMENT_FILE']) : null;
  const v3 = await createV3Ports({
    root: ROOT, operatorKey: operatorKey!, operatorKeyId: env['OTK_V3_OPERATOR_KEY_ID'] || 'otk-v3-operator-1',
    deployment, rpcUrl: env['OTK_V3_RPC_URL'] || null, submitterKey: getV3SubmitterKey() ?? null,
  });
  const measurement = d1d8MeasurementPorts({ weights, prices, proofConfig: v3.proofConfig, calibration });
  // FPS5-F01: the local counter's encodings load synchronously (~1 s each cold); load them here, before the
  // gateway serves, so the first request does not block the event loop while it holds an execution lease
  const warmed: string[] = [];
  for (const e of ['o200k_base', 'cl100k_base'] as LocalEncoding[]) { try { loadEncoding(e); warmed.push(e); } catch { /* counter reports tokenizer_load_failed per request */ } }
  // legacy integer receipts (POST /receipts, legacy proxy path) use the same signed weights (S0-F01b)
  setKnownCuCalculator(knownCuFromWeights(() => weights.active(), computeCuFromTotals));
  return {
    weights,
    options: { ...base, measurement, crypto: v3.crypto, proof: v3.proof, moneyBoundPolicy: moneyBoundPolicy! },
    summary: {
      measurement: measurement.label,
      localCounterEncodings: warmed.length ? `preloaded: ${warmed.join(', ')}` : 'not preloaded (load failed)',
      weights: weights.active() ? `${weights.active()!.ref.version}${weights.active()!.developmentProfile ? ' (development profile)' : ''}` : 'NONE (admissions refused: cu_config_unavailable)',
      priceTable: prices.active ? prices.active.version : 'none (money null; strict-money tenants refused)',
      moneyBoundPolicy: moneyBoundPolicy!.id,
      calibration: calibrationSummaryLine(calibration),
      circuit: v3.proofConfig.circuitId,
      chain: deployment ? `${deployment.domain.chainId}/${deployment.domain.registry}` : 'none (no on-chain effect)',
      submitter: env['OTK_V3_RPC_URL'] && getV3SubmitterKey() ? 'configured' : 'not configured (proofs wait)',
      operator: v3.operatorAddress,
    },
  };
}

/**
 * Startup line about calibration profiles (ids and states only; never content).
 *
 * @param c - The loaded calibration registry.
 * @returns A one-line summary: "no profiles", or the loaded ids plus any corrupt sources with their reason.
 */
export function calibrationSummaryLine(c: CalibrationRegistry): string {
  const s = c.summary();
  if (s.source === 'none') return 'no profiles (OTK_CALIBRATION_PROFILES_DIR unset): conference threshold HEURISTIC, calibrated=false';
  const corrupt = s.corrupt.map((x) => `${x.source}: ${x.reason}`).join('; ');
  return `${s.loaded.length} loaded [${s.loaded.join(', ')}]${s.corrupt.length ? `; ${s.corrupt.length} CORRUPT [${corrupt}]` : ''}`;
}
