/**
 * Egress gate. OFFLINE mode: an injected local double (no socket). REAL mode: requires BOTH an explicit flag in the configuration
 * AND a valid GO file (h2eval.go.v1, R17_GO_TEMPLATE.md: one provider, one batch, exact executor version/codeSha, ratified
 * pre-registration hash, window ≤ 24 h, human signature, self digest) AND none of the forbidden environment variables (R16); the credential is read from process.env.<credentialEnvVar> at send time only, injected into the request
 * header, and never returned, stored or logged. Host must be in the adapter's official hosts AND the core allowlist.
 * redirect: 'error'; no retries. In tests REAL is unreachable: no GO file is ever written and no fetch is ever reached.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { BuiltRequest, Provider } from '../types.js';
import { sha256Canon } from './canon.js';
import { capsAreAllowedFor, capsAreAllowedProfile, usdToPico } from './ledger.js';
import { checkEnvFileLocation, readEnvFileVar, EnvFileRefused, type EnvFileChecks } from './envFile.js';
import { providerRequestIdFromResponse, wireBody, type InstrumentedValue } from './requestInstrumentation.js';

export const DEFAULT_SEND_TIMEOUT_MS = 120_000;
export class EgressTimeout extends Error { constructor(public readonly ms: number) { super(`egress timeout after ${ms} ms`); this.name = 'EgressTimeout'; } }
/** R15-M5: bound every send (double or fetch) by a timeout; the runner classifies the rejection as TIMEOUT_UNCERTAIN (reservation kept). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new EgressTimeout(ms)), ms); });
  return Promise.race([p, timer]).finally(() => { if (t) clearTimeout(t); }) as Promise<T>;
}

export type ExecutorMode = 'OFFLINE' | 'REAL';
export interface EgressResponse { httpStatus: number; body: unknown; /** E1‴ R-INST (REAL only): provider request id read from the allow-listed response header, or NOT_AVAILABLE + reason. Never affects the result. */ providerRequestId?: InstrumentedValue }
/** The double in OFFLINE mode (or a real fetch wrapper in REAL mode). Receives the request WITHOUT the credential. */
export type EgressDouble = (req: BuiltRequest) => Promise<EgressResponse>;

/** Environment variable NAMES aligned with R16 (H2EVAL_ENV.example). Values are never read outside `send` in REAL mode. */
export const H2EVAL_ENV_NAMES = Object.freeze({
  credentials: Object.freeze({ anthropic: 'H2EVAL_ANTHROPIC_API_KEY', openai: 'H2EVAL_OPENAI_API_KEY', google: 'H2EVAL_GOOGLE_API_KEY' }) as Readonly<Record<Provider, string>>,
  goFile: 'H2EVAL_GO_FILE', batchDir: 'H2EVAL_BATCH_DIR', stopFile: 'H2EVAL_STOP_FILE', budgetCampaignUsd: 'H2EVAL_BUDGET_CAMPAIGN_USD',
  /** PATH (not secret) of the credential file read by `core/envFile.ts` only in REAL mode after the GO preflight (R16 gap). */
  envFile: 'H2EVAL_ENV_FILE',
  /** Presence of any of these in the executor process ⇒ refuse (mixing with the Bot / D-ANTH-10 / a proxy). */
  /** CYCLE2-A (proposal): SSLKEYLOGFILE (TLS session secrets to a file/device) and NODE_TLS_REJECT_UNAUTHORIZED (would disable verification) are refused too. */
  forbidden: Object.freeze(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'SSLKEYLOGFILE', 'NODE_TLS_REJECT_UNAUTHORIZED']),
  /** VNEXT-4 (C151 item 4): the documented LAUNCH environment (runs/R17_REAL/RESUME/launch_env.sh): REAL refuses any other variable NAME (case-insensitive) besides H2EVAL_*. Names only; values are never read here. */
  launchAllowlist: Object.freeze(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'NODE_EXTRA_CA_CERTS', 'PWD', 'SHLVL', '_', 'OLDPWD', 'HOME', 'LANG', 'LC_ALL', 'TZ', /* VNEXT-F (R17-V-4): Git Bash injects MSYSTEM even under `env -i`; the probe and the executor must be launched from the SAME shell (Git Bash + launch_env.sh) */ 'MSYSTEM']),
});

/**
 * CYCLE2-A (proposal, incident R17-001): classify a send failure by the NON-SECRET error code of the cause (undici/Node: `e.cause.code` or
 * `e.code`, e.g. UNABLE_TO_VERIFY_LEAF_SIGNATURE, ECONNREFUSED, ENOTFOUND). Only an upper-case identifier is kept; any message text (may carry
 * a URL or a host) is dropped. `phaseHint` is DERIVED from the protocol layer the code belongs to (a certificate-verification code can only be
 * raised during the TLS handshake, before any HTTP byte is written; a DNS code before any connection). It is a forensic hint, NOT an
 * observation of the socket: the native fetch does not expose whether bytes were written, so the operation stays UNCERTAIN / possiblyCharged
 * and the ledger treatment is unchanged. A provable NOT_SENT_PRECONNECT state would need an instrumented transport (see CYCLE2_PROPOSAL.md).
 */
export type SendFailurePhaseHint = 'tls' | 'dns' | 'connect' | 'timeout' | 'unknown';
export interface SendFailureClass { causeCode: string; phaseHint: SendFailurePhaseHint }
const TLS_CODES: ReadonlySet<string> = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'HOSTNAME_MISMATCH', 'ERR_SSL_WRONG_VERSION_NUMBER', 'EPROTO']);
const DNS_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA']);
const CONNECT_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENETDOWN']);
export function classifySendFailure(e: unknown): SendFailureClass {
  if (e instanceof EgressTimeout) return { causeCode: 'TIMEOUT', phaseHint: 'timeout' };
  const pick = (v: unknown): string | null => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(v) ? v : null);
  const err = e as { code?: unknown; cause?: { code?: unknown; name?: unknown } | null; name?: unknown } | null;
  const code = pick(err?.cause?.code) ?? pick(err?.code) ?? (err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError' ? 'TIMEOUT' : null) ?? 'UNKNOWN';
  const phaseHint: SendFailurePhaseHint = code === 'TIMEOUT' ? 'timeout' : TLS_CODES.has(code) ? 'tls' : DNS_CODES.has(code) ? 'dns' : CONNECT_CODES.has(code) ? 'connect' : 'unknown';
  return { causeCode: code, phaseHint };
}

/** GO file (R17_GO_TEMPLATE.md §1). Validated field by field; any `<placeholder>` left in the text ⇒ invalid. */
export interface GoFileV1 {
  schema: 'h2eval.go.v1'; campaign: string; phase: string; provider: Provider; modelIds: string[]; modelDeprecationAck: string | null;
  batch: { batchId: string; maxCalls: number; oneModelPerBatch: boolean };
  caps: { perOperation: string; perBatchUsd: string | number; perProviderSubLedgerUsd: string | number; globalCampaignUsd: number; pauseAtFractionOfSubLedger: number };
  executor: { version: string; codeSha: string; adapterVersions: Record<string, string> };
  preregistration: { file: string; sha256: string; ratifiedUtc: string };
  accountPreflight: Record<string, unknown>;
  window: { notBeforeUtc: string; expiresUtc: string };
  stops: string[]; signedBy: string; signatureStatement: string; goDigestSha256: string;
  /** R15-M4 (optional): signed acknowledgement that the batch may continue past 80 % of the provider sub-ledger. */
  pauseAck80pct?: { acknowledgedBy: string; atUtc: string };
}
/** C144 D144-05: multi-batch GO. One study plan, an EXPLICIT finite list of batchIds (never a wildcard), caps equal to the effective
 * aggregated ledger (11 / 5 / 3 / 3), maxAttempts <= planned operations in scope and never > 1446, a UTC window, one single-use nonce per
 * batch (anti-replay, enforced by the campaign nonce registry), signed by a human; G17 per model is required for campaign batches (gate
 * artifacts in <campaignDir>/gates). It never dispenses the split gates (TRAIN_FROZEN / VALIDATION_SELECTED). */
export interface GoFileMultiV1 {
  schema: 'h2eval.go.multi.v1'; campaign: string; preregistrationSha256: string; executorCodeSha: string; planProtocolHash: string;
  batchIds: string[]; providers: Provider[]; modelIds: string[];
  caps: { perProviderSubLedgerUsd: Record<Provider, string | number>; globalCampaignUsd: string | number; pauseAtFractionOfSubLedger: number };
  maxAttempts: number; window: { notBeforeUtc: string; notAfterUtc: string }; nonces: Record<string, string>;
  pauseAck80pct?: Partial<Record<Provider, { acknowledgedBy: string; atUtc: string }>>;
  preAuthorizeTo100pct?: Partial<Record<Provider, { acknowledgedBy: string; atUtc: string }>>;
  requiresG17ForCampaignBatches: true; stops: string[]; signedBy: string; signatureStatement: string; goDigestSha256: string;
  /** VNEXT-3 R15-G-1: sha256 of <campaignDir>/CAMPAIGN_IDENTITY.json — the GO is bound to ONE campaign directory identity. */
  campaignIdentitySha256: string;
  /** VNEXT-3 R15-G-3 (optional): protocolHash of the pilot whose G17 artifacts qualify this GO's campaign batches; must equal the CLI value when both are given. */
  pilotProtocolHash?: string;
  /** VNEXT-F (R17-V-1): canonical absolute path of the ONE campaign directory (forward slashes; compared case-insensitively on Windows); a byte copy elsewhere is refused. */
  campaignDirCanonical: string;
  /** VNEXT-F (R17-V-2): digest of <campaignDir>/LEDGER_OPENING.json this GO authorises, or the literal 'none' (then an opening file is refused). */
  ledgerOpeningDigestSha256: string;
}
export const GO_MULTI_MAX_ATTEMPTS = 1446;
export const GO_MULTI_MAX_WINDOW_MS = 72 * 3600 * 1000;
export interface GoMultiContext { campaign: string; preregistrationSha256: string | undefined; executorCodeSha: string; treeClean: boolean | null; planProtocolHash: string; planBatchIds: readonly string[]; plannedOpsInScope: (batchIds: readonly string[]) => number; ledgerCaps: { campaignUsd: string; providersUsd: Record<Provider, string> }; nowMs: number; /** VNEXT-3 R15-G-1: identity of the campaign directory the executor is about to use (null = not initialised) */ campaignIdentitySha256: string | null; /** VNEXT-F (R17-V-1): canonical path of that directory (null = pure validation without a directory) */ campaignDirCanonical: string | null }

/** Pure validator of a multi-batch GO. Returns null when valid, else the first failing code (no value echoed). */
export function validateGoMultiV1(text: string, ctx: GoMultiContext): string | null {
  if (/<[^<>\n]{1,120}>/.test(text)) return 'GO_PLACEHOLDER_LEFT';
  let go: GoFileMultiV1; try { go = JSON.parse(text) as GoFileMultiV1; } catch { return 'GO_FILE_INVALID'; }
  if (!go || typeof go !== 'object' || go.schema !== 'h2eval.go.multi.v1') return 'GO_SCHEMA';
  if (go.campaign !== ctx.campaign) return 'GO_CAMPAIGN_MISMATCH';
  if (!ctx.preregistrationSha256) return 'GO_PREREG_UNCONFIGURED';
  if (!/^[0-9a-f]{64}$/.test(go.preregistrationSha256 ?? '') || go.preregistrationSha256 !== ctx.preregistrationSha256) return 'GO_PREREG_MISMATCH';
  if (go.executorCodeSha !== ctx.executorCodeSha) return 'GO_EXECUTOR_MISMATCH';
  if (ctx.treeClean === false) return 'GO_EXECUTOR_TREE_DIRTY';
  if (go.planProtocolHash !== ctx.planProtocolHash) return 'GO_PLAN_MISMATCH';
  if (!/^[0-9a-f]{64}$/.test(go.campaignIdentitySha256 ?? '')) return 'GO_CAMPAIGN_IDENTITY_INVALID';
  if (ctx.campaignIdentitySha256 === null) return 'GO_CAMPAIGN_IDENTITY_MISSING';
  if (go.campaignIdentitySha256 !== ctx.campaignIdentitySha256) return 'GO_CAMPAIGN_IDENTITY_MISMATCH';
  if (go.pilotProtocolHash !== undefined && !/^[0-9a-f]{64}$/.test(go.pilotProtocolHash)) return 'GO_PILOT_HASH_INVALID';
  if (typeof go.campaignDirCanonical !== 'string' || go.campaignDirCanonical.length < 2) return 'GO_CAMPAIGN_DIR_INVALID';
  if (ctx.campaignDirCanonical !== null && go.campaignDirCanonical.toLowerCase() !== ctx.campaignDirCanonical.toLowerCase()) return 'GO_CAMPAIGN_DIR_MISMATCH';
  if (go.ledgerOpeningDigestSha256 !== 'none' && !/^[0-9a-f]{64}$/.test(go.ledgerOpeningDigestSha256 ?? '')) return 'GO_LEDGER_OPENING_INVALID';
  if (!Array.isArray(go.batchIds) || go.batchIds.length === 0 || go.batchIds.some((b) => typeof b !== 'string' || /[*?]|^all$/i.test(b)) || new Set(go.batchIds).size !== go.batchIds.length) return 'GO_BATCHIDS_INVALID';
  if (go.batchIds.some((b) => !ctx.planBatchIds.includes(b))) return 'GO_BATCH_NOT_IN_PLAN';
  if (!Array.isArray(go.providers) || !go.providers.length || !Array.isArray(go.modelIds) || !go.modelIds.length) return 'GO_SCOPE_INVALID';
  if (!go.caps || go.caps.pauseAtFractionOfSubLedger !== 0.8) return 'GO_CAPS';
  let effCampaign: bigint; try { effCampaign = usdToPico(ctx.ledgerCaps.campaignUsd); } catch { return 'GO_CAPS_MISMATCH'; }
  if (picoOf(go.caps.globalCampaignUsd) !== effCampaign) return 'GO_CAPS_MISMATCH';
  for (const p of ['anthropic', 'openai', 'google'] as const) { let eff: bigint; try { eff = usdToPico(ctx.ledgerCaps.providersUsd[p]); } catch { return 'GO_CAPS_MISMATCH'; } if (picoOf(go.caps.perProviderSubLedgerUsd?.[p]) !== eff) return 'GO_CAPS_MISMATCH'; }
  // C158 ciclo 3: GO caps == effective ledger caps == ONE named profile as a whole (default 11/5/3/3 or the ratified ciclo3_c158 32/32/0/0); a looser or mixed ledger can never be covered by a GO
  if (!capsAreAllowedProfile(effCampaign, { anthropic: usdToPico(ctx.ledgerCaps.providersUsd.anthropic), openai: usdToPico(ctx.ledgerCaps.providersUsd.openai), google: usdToPico(ctx.ledgerCaps.providersUsd.google) })) return 'GO_CAPS_MISMATCH';
  const planned = ctx.plannedOpsInScope(go.batchIds);
  if (!Number.isInteger(go.maxAttempts) || go.maxAttempts < 1 || go.maxAttempts > GO_MULTI_MAX_ATTEMPTS || go.maxAttempts > planned) return 'GO_MAX_ATTEMPTS';
  if (!go.window) return 'GO_WINDOW';
  const nb = Date.parse(go.window.notBeforeUtc); const na = Date.parse(go.window.notAfterUtc);
  if (!Number.isFinite(nb) || !Number.isFinite(na) || nb > ctx.nowMs) return 'GO_NOT_YET_VALID';
  if (na <= ctx.nowMs) return 'GO_EXPIRED';
  if (na - nb > GO_MULTI_MAX_WINDOW_MS) return 'GO_WINDOW_TOO_LONG';
  if (!go.nonces || typeof go.nonces !== 'object') return 'GO_NONCES_MISSING';
  const nonceValues = go.batchIds.map((b) => go.nonces[b]);
  if (nonceValues.some((n) => typeof n !== 'string' || !/^[0-9a-f]{16,64}$/.test(n)) || new Set(nonceValues).size !== nonceValues.length) return 'GO_NONCES_INVALID';
  if (go.requiresG17ForCampaignBatches !== true) return 'GO_G17_REQUIREMENT_MISSING';
  if (!Array.isArray(go.stops) || GO_REQUIRED_STOPS.some((s) => !go.stops.includes(s))) return 'GO_STOPS_INCOMPLETE';
  for (const k of ['pauseAck80pct', 'preAuthorizeTo100pct'] as const) { const m = go[k]; if (m !== undefined) { if (typeof m !== 'object' || m === null) return 'GO_PAUSE_ACK_INVALID'; for (const v of Object.values(m)) if (!v || !/^human:\S.*$/.test(String(v.acknowledgedBy))) return 'GO_PAUSE_ACK_INVALID'; } }
  if (typeof go.signedBy !== 'string' || !/^human:\S.*$/.test(go.signedBy)) return 'GO_UNSIGNED';
  if (typeof go.signatureStatement !== 'string' || go.signatureStatement.length < 20) return 'GO_UNSIGNED';
  const { goDigestSha256, ...rest } = go;
  if (typeof goDigestSha256 !== 'string' || sha256Canon(rest) !== goDigestSha256) return 'GO_DIGEST_MISMATCH';
  return null;
}

export const GO_REQUIRED_STOPS = Object.freeze(['STOP_FILE', 'STOP_BUDGET', 'STOP_CAP_VIOLATION', 'STOP_PRICE_UNKNOWN', 'STOP_PERSISTENCE', 'STOP_UNCERTAIN', 'no retry', 'no fallback', 'concurrency 1']);
export const GO_MAX_WINDOW_MS = 24 * 3600 * 1000;

/** What the GO must match for THIS operation (from the plan and the executor), never from the GO itself. */
export interface GoContext {
  provider: Provider; phase: string; modelRequested: string; batchId: string; executorVersion: string; executorCodeSha: string; preregistrationSha256: string | undefined; campaign: string; nowMs: number;
  /** R15-A1: the EFFECTIVE caps of the ledger this executor runs with; the GO must state exactly these (and they must be the defaults). */
  ledgerCaps: { campaignUsd: string; providerUsd: string };
  /** R15-A1: effective batch cap (when the ledger has one): the GO's perBatchUsd must equal it. */
  batchCapUsd?: string;
}
const picoOf = (v: unknown): bigint | null => { try { return typeof v === 'number' || typeof v === 'string' ? usdToPico(String(v)) : null; } catch { return null; } };

/** Pure validator of a GO file text. Returns null when valid, else the first failing code (no value from the GO is echoed). */
export function validateGoV1(text: string, ctx: GoContext): string | null {
  if (/<[^<>\n]{1,120}>/.test(text)) return 'GO_PLACEHOLDER_LEFT';
  let go: GoFileV1; try { go = JSON.parse(text) as GoFileV1; } catch { return 'GO_FILE_INVALID'; }
  if (!go || typeof go !== 'object' || go.schema !== 'h2eval.go.v1') return 'GO_SCHEMA';
  if (go.campaign !== ctx.campaign) return 'GO_CAMPAIGN_MISMATCH';
  if (go.phase !== ctx.phase) return 'GO_PHASE_MISMATCH';
  if (go.provider !== ctx.provider) return 'GO_PROVIDER_MISMATCH';
  if (!Array.isArray(go.modelIds) || !go.modelIds.includes(ctx.modelRequested)) return 'GO_MODEL_NOT_LISTED';
  if (!go.batch || go.batch.batchId !== ctx.batchId) return 'GO_BATCH_MISMATCH';
  if (!Number.isInteger(go.batch.maxCalls) || go.batch.maxCalls < 1 || go.batch.maxCalls > 60 || go.batch.oneModelPerBatch !== true) return 'GO_BATCH_RULES';
  if (!go.caps || go.caps.pauseAtFractionOfSubLedger !== 0.8) return 'GO_CAPS';
  // R15-A1: GO caps == effective ledger caps == campaign defaults (11 / 5 / 3 / 3); a looser ledger can never be covered by a GO
  const goCampaign = picoOf(go.caps.globalCampaignUsd); const goProvider = picoOf(go.caps.perProviderSubLedgerUsd);
  let effCampaign: bigint; let effProvider: bigint; try { effCampaign = usdToPico(ctx.ledgerCaps.campaignUsd); effProvider = usdToPico(ctx.ledgerCaps.providerUsd); } catch { return 'GO_CAPS_MISMATCH'; }
  if (goCampaign === null || goProvider === null || goCampaign !== effCampaign || goProvider !== effProvider) return 'GO_CAPS_MISMATCH';
  if (!capsAreAllowedFor(effCampaign, ctx.provider, effProvider)) return 'GO_CAPS_MISMATCH';
  if (ctx.batchCapUsd !== undefined) { const goBatch = picoOf(go.caps.perBatchUsd); if (goBatch === null || goBatch !== usdToPico(ctx.batchCapUsd)) return 'GO_CAPS_MISMATCH'; }
  if (go.pauseAck80pct !== undefined && (typeof go.pauseAck80pct !== 'object' || go.pauseAck80pct === null || !/^human:\S.*$/.test(String(go.pauseAck80pct.acknowledgedBy)))) return 'GO_PAUSE_ACK_INVALID';
  if (!go.executor || go.executor.version !== ctx.executorVersion || go.executor.codeSha !== ctx.executorCodeSha) return 'GO_EXECUTOR_MISMATCH';
  if (!ctx.preregistrationSha256) return 'GO_PREREG_UNCONFIGURED';
  if (!go.preregistration || !/^[0-9a-f]{64}$/.test(go.preregistration.sha256 ?? '') || go.preregistration.sha256 !== ctx.preregistrationSha256) return 'GO_PREREG_MISMATCH';
  if (!go.window) return 'GO_WINDOW';
  const nb = Date.parse(go.window.notBeforeUtc); const exp = Date.parse(go.window.expiresUtc);
  if (!Number.isFinite(nb) || !Number.isFinite(exp) || nb > ctx.nowMs) return 'GO_NOT_YET_VALID';
  if (exp <= ctx.nowMs) return 'GO_EXPIRED';
  if (exp - ctx.nowMs > GO_MAX_WINDOW_MS) return 'GO_WINDOW_TOO_LONG';
  if (!Array.isArray(go.stops) || GO_REQUIRED_STOPS.some((s) => !go.stops.includes(s))) return 'GO_STOPS_INCOMPLETE';
  if (typeof go.signedBy !== 'string' || !/^human:\S.*$/.test(go.signedBy)) return 'GO_UNSIGNED';
  if (typeof go.signatureStatement !== 'string' || go.signatureStatement.length < 20) return 'GO_UNSIGNED';
  const { goDigestSha256, ...rest } = go;
  if (typeof goDigestSha256 !== 'string' || sha256Canon(rest) !== goDigestSha256) return 'GO_DIGEST_MISMATCH';
  return null;
}

export class EgressRefused extends Error {
  constructor(public readonly code: string) { super(`egress refused: ${code}`); this.name = 'EgressRefused'; }
}
/** EXEC-ECON delta 4 (R-D1): refusal that came from the ECON GO branch only (h2eval.go.econ.v1). Same code; the ECON runner path turns it into a
 *  NON-terminal pause (nothing reserved or sent). Every other refusal (single/multi GO included) stays a plain EgressRefused, unchanged. */
export class EgressGoEconRefused extends EgressRefused { constructor(code: string) { super(code); this.name = 'EgressGoEconRefused'; } }

export interface EgressConfig {
  mode: ExecutorMode;
  /** REAL only: explicit opt-in flag; without it REAL is refused even with a GO file. */
  realFlag?: boolean;
  goFile?: string;
  campaign: string;
  allowedHosts: readonly string[];
  /** Env var names per provider holding the credential (default H2EVAL_ENV_NAMES.credentials; values never leave process.env except into the header). */
  credentialEnvVars?: Partial<Record<Provider, string>>;
  /** REAL only: sha256 of the RATIFIED pre-registration; the GO must carry the same hash. Unset ⇒ REAL unreachable. */
  preregistrationSha256?: string;
  /** C144: when the GO is a multi-batch GO (h2eval.go.multi.v1) the egress needs the plan-level context to validate it per operation. */
  goMulti?: { planProtocolHash: string; planBatchIds: readonly string[]; plannedOpsInScope: (batchIds: readonly string[]) => number; providersUsd: Record<Provider, string>; campaignUsd: string; treeClean: boolean | null; campaignIdentitySha256: string | null; campaignDirCanonical: string | null };
  /** Env var names whose presence refuses REAL egress (default H2EVAL_ENV_NAMES.forbidden). */
  forbiddenEnvVars?: readonly string[];
  /** R15-M5: send timeout (double and fetch); default 120 s. */
  timeoutMs?: number;
  /** R16 gap: PATH of the credential file (H2EVAL_ENV_FILE). Used only when the provider's env var is absent; both present ⇒ CREDENTIAL_SOURCE_AMBIGUOUS. */
  envFile?: string;
  /** Injectable location checks (OFFLINE tests only). */
  envFileChecks?: EnvFileChecks;
  /** OFFLINE: the local double. REAL: optional fetch implementation (default globalThis.fetch). */
  double?: EgressDouble;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** EXEC-ECON C160 delta 3 (DECISOES_MASTER_ECON): validator of the ECON study GO (h2eval.go.econ.v1, scripts/h2eval/econ/goEcon.ts), injected by the
   *  ECON consumer. Absent => an ECON GO is refused (GO_ECON_CONTEXT_MISSING). The single and multi GO branches do not use it. */
  goEcon?: { validate(text: string, ctx: GoContext): { code: string | null; pauseAck: { acknowledgedBy: string; goDigestSha256: string } | null } };
}

function readGo(path: string | undefined, ctx: GoContext, multi: EgressConfig['goMulti'], econ?: EgressConfig['goEcon']): { code: string | null; maxCalls: number | null; pauseAck: { acknowledgedBy: string; goDigestSha256: string } | null; econ?: true } {
  if (!path || !existsSync(path)) return { code: 'GO_FILE_MISSING', maxCalls: null, pauseAck: null };
  let text: string; try { text = readFileSync(path, 'utf8'); } catch { return { code: 'GO_FILE_UNREADABLE', maxCalls: null, pauseAck: null }; }
  let schema = ''; try { schema = String((JSON.parse(text) as { schema?: string }).schema ?? ''); } catch { return { code: 'GO_FILE_INVALID', maxCalls: null, pauseAck: null }; }
  if (schema === 'h2eval.go.multi.v1') {
    if (!multi) return { code: 'GO_MULTI_CONTEXT_MISSING', maxCalls: null, pauseAck: null };
    const code = validateGoMultiV1(text, { campaign: ctx.campaign, preregistrationSha256: ctx.preregistrationSha256, executorCodeSha: ctx.executorCodeSha, treeClean: multi.treeClean, planProtocolHash: multi.planProtocolHash, planBatchIds: multi.planBatchIds, plannedOpsInScope: multi.plannedOpsInScope, ledgerCaps: { campaignUsd: multi.campaignUsd, providersUsd: multi.providersUsd }, nowMs: ctx.nowMs, campaignIdentitySha256: multi.campaignIdentitySha256, campaignDirCanonical: multi.campaignDirCanonical });
    if (code) return { code, maxCalls: null, pauseAck: null };
    const go = JSON.parse(text) as GoFileMultiV1;
    if (!go.batchIds.includes(ctx.batchId)) return { code: 'GO_BATCH_NOT_IN_SCOPE', maxCalls: null, pauseAck: null };
    if (!go.providers.includes(ctx.provider) || !go.modelIds.includes(ctx.modelRequested)) return { code: 'GO_PROVIDER_OR_MODEL_NOT_IN_SCOPE', maxCalls: null, pauseAck: null };
    const pa = go.pauseAck80pct?.[ctx.provider];
    return { code: null, maxCalls: null, pauseAck: pa ? { acknowledgedBy: pa.acknowledgedBy, goDigestSha256: go.goDigestSha256 } : null };
  }
  if (schema === 'h2eval.go.econ.v1') { // EXEC-ECON delta 3: delegated to the injected ECON validator; same contract as the multi branch (no batch maxCalls; pause ack)
    if (!econ) return { code: 'GO_ECON_CONTEXT_MISSING', maxCalls: null, pauseAck: null, econ: true };
    const r = econ.validate(text, ctx);
    return r.code ? { code: r.code, maxCalls: null, pauseAck: null, econ: true } : { code: null, maxCalls: null, pauseAck: r.pauseAck };
  }
  const code = validateGoV1(text, ctx);
  if (code) return { code, maxCalls: null, pauseAck: null };
  const go = JSON.parse(text) as GoFileV1;
  return { code: null, maxCalls: go.batch.maxCalls, pauseAck: go.pauseAck80pct ? { acknowledgedBy: go.pauseAck80pct.acknowledgedBy, goDigestSha256: go.goDigestSha256 } : null };
}

export interface PreflightContext { provider: Provider; phase: string; modelRequested: string; batchId: string; executorVersion: string; executorCodeSha: string; ledgerCaps: { campaignUsd: string; providerUsd: string }; batchCapUsd?: string }
/** `token` (R15-B3) is single-use and bound to this request body: `send` refuses without it. */
export interface PreflightResult { goMaxCalls: number | null; token: string; goPauseAck: { acknowledgedBy: string; goDigestSha256: string } | null }

/** Decide whether this request may leave the process; returns a sender or throws EgressRefused (before any reservation). */
export function createEgress(cfg: EgressConfig) {
  const now = cfg.now ?? (() => Date.now());
  const credentialVar = (p: Provider): string | undefined => cfg.credentialEnvVars?.[p] ?? H2EVAL_ENV_NAMES.credentials[p];
  const hostOk = (url: string, official: readonly string[]) => { let h: string; try { h = new URL(url).hostname; } catch { return false; } return official.includes(h) && cfg.allowedHosts.includes(h) && new URL(url).protocol === 'https:'; };
  const tokens = new Map<string, { provider: Provider; bodySha256: string }>();
  const issue = (provider: Provider, req: BuiltRequest): string => { const t = randomBytes(16).toString('hex'); tokens.set(t, { provider, bodySha256: sha256Canon(req.body) }); return t; };
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  return {
    mode: cfg.mode,
    /** Pre-flight (called BEFORE snapshot/reserve): everything that can refuse without side effects. */
    preflight(pc: PreflightContext, req: BuiltRequest, officialHosts: readonly string[]): PreflightResult {
      if (!hostOk(req.url, officialHosts)) throw new EgressRefused('HOST_NOT_ALLOWED');
      if (req.headers && Object.keys(req.headers).some((k) => k.toLowerCase() === req.credentialHeader.toLowerCase())) throw new EgressRefused('CREDENTIAL_IN_ADAPTER_HEADERS');
      if (cfg.mode === 'OFFLINE') { if (typeof cfg.double !== 'function') throw new EgressRefused('OFFLINE_DOUBLE_MISSING'); return { goMaxCalls: null, token: issue(pc.provider, req), goPauseAck: null }; }
      if (cfg.realFlag !== true) throw new EgressRefused('REAL_FLAG_MISSING');
      for (const f of cfg.forbiddenEnvVars ?? H2EVAL_ENV_NAMES.forbidden) if (typeof process.env[f] === 'string' && process.env[f] !== '') throw new EgressRefused('FORBIDDEN_ENV_PRESENT');
      const g = readGo(cfg.goFile, { ...pc, campaign: cfg.campaign, preregistrationSha256: cfg.preregistrationSha256, nowMs: now() }, cfg.goMulti, cfg.goEcon); if (g.code) throw g.econ ? new EgressGoEconRefused(g.code) : new EgressRefused(g.code);
      const v = credentialVar(pc.provider); const inEnv = Boolean(v && typeof process.env[v] === 'string' && process.env[v] !== '');
      if (inEnv && cfg.envFile) throw new EgressRefused('CREDENTIAL_SOURCE_AMBIGUOUS');
      if (!inEnv) {
        if (!cfg.envFile) throw new EgressRefused('CREDENTIAL_ENV_MISSING');
        try { checkEnvFileLocation(cfg.envFile, cfg.envFileChecks); } catch (e) { throw new EgressRefused(e instanceof EnvFileRefused ? e.code : 'ENV_FILE_ERROR'); }
      }
      return { goMaxCalls: g.maxCalls, token: issue(pc.provider, req), goPauseAck: g.pauseAck };
    },
    /** Send. Requires the single-use preflight token of THIS body (R15-B3). OFFLINE: double. REAL: fetch with the credential injected at this instant only. Bounded by timeoutMs (R15-M5). */
    async send(provider: Provider, req: BuiltRequest, token: string): Promise<EgressResponse> {
      const t = tokens.get(token); tokens.delete(token);
      if (!t || t.provider !== provider || t.bodySha256 !== sha256Canon(req.body)) throw new EgressRefused('PREFLIGHT_TOKEN_INVALID');
      if (cfg.mode === 'OFFLINE') return withTimeout(cfg.double!(req), timeoutMs);
      if (cfg.realFlag !== true) throw new EgressRefused('REAL_FLAG_MISSING');
      const v = credentialVar(provider)!;
      const fromEnv = typeof process.env[v] === 'string' && process.env[v] !== '';
      if (fromEnv && cfg.envFile) throw new EgressRefused('CREDENTIAL_SOURCE_AMBIGUOUS');
      // the secret lives in this block only: header built, request sent, reference dropped; never assigned to process.env, never logged
      let secret: string;
      if (fromEnv) secret = process.env[v]!;
      else { if (!cfg.envFile) throw new EgressRefused('CREDENTIAL_ENV_MISSING'); try { checkEnvFileLocation(cfg.envFile, cfg.envFileChecks); secret = readEnvFileVar(cfg.envFile, v); } catch (e) { throw new EgressRefused(e instanceof EnvFileRefused ? e.code : 'ENV_FILE_ERROR'); } }
      const headers: Record<string, string> = { ...req.headers, [req.credentialHeader]: req.credentialFormat === 'bearer' ? `Bearer ${secret}` : secret };
      secret = '';
      const f = cfg.fetchImpl ?? globalThis.fetch;
      // E1‴ R-INST: the body string is `wireBody(req)` (= JSON.stringify(req.body), unchanged), so the runner's wireBodySha256 is the hash of these exact bytes
      const r = await withTimeout(f(req.url, { method: 'POST', headers, body: wireBody(req), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }), timeoutMs);
      let body: unknown = null; try { body = await r.json(); } catch { body = null; }
      // E1‴ R-INST: read AFTER the body; only headers.get('request-id') (response), never iterated; never throws (failure ⇒ NOT_AVAILABLE + reason)
      return { httpStatus: r.status, body, providerRequestId: providerRequestIdFromResponse(provider, r) };
    },
  };
}
