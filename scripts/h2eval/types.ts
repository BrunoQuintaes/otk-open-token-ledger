/**
 * H2-EVAL executor — shared types (B2: R11 core, R12 record, R13 cache, R14 modal).
 * Contract: docs/_ops/coordination/academic_20261110/runs/B1/CONTRACT_MIN_FOR_EXECUTOR.md (h2eval.contract.min.v0,
 * sha256 89be88ed…) + CONTRACT_MIN_FOR_EXECUTOR_R2.md (v0.1 delta, sha256 d52be4df…, additive) + R08_COMPATIBILITY_MATRIX. Human-readable spec: scripts/h2eval/INTERFACES.md.
 *
 * Rules carried by the types themselves:
 *  - every numeric usage/cost field is `number | 'UNKNOWN' | 'NOT_APPLICABLE'`; absent is never 0;
 *  - money is pico-USD as a decimal string in BigInt (never float);
 *  - nothing here holds prompt or response text: content is addressed by sha256 only.
 * This file only ADDS to the H1 tree (7606bc9b); it imports H1 types and never edits them.
 */
import type { UsageApi, ModelSupport, LocalCountResult } from '../../src/types/d1d8/index.js';

export const H2EVAL_SCHEMA = {
  operation: 'h2eval.operation.v0',
  snapshot: 'h2eval.precall_snapshot.v0',
  usage: 'h2eval.usage.v0',
  cost: 'h2eval.cost.v0',
  journal: 'h2eval.journal.v0',
  ledger: 'h2eval.ledger.v0',
  plan: 'h2eval.plan.v0',
} as const;

export type Hex64 = string;
/** Integer count, or the two honest non-numbers. Never 0 for "absent". */
export type Count = number | 'UNKNOWN' | 'NOT_APPLICABLE';
/** pico-USD (1e-12 USD) as a decimal integer string, e.g. "1234500000000" = 1.2345 USD. */
export type PicoUsd = string;
export const PICO_PER_USD = 1_000_000_000_000n;

export type Provider = 'openai' | 'anthropic' | 'google';
export type Phase = 'PILOT' | 'CONFIRMATORY' | 'EXPLORATORY_MODALITY' | 'COMPARATIVE_PAIRED';
export type Split = 'train' | 'validation' | 'holdout' | 'NONE' | 'COMPARATIVE';
/** R2 item 10: deprecation status of the served model id (R08 §1). */
export type ModelDeprecation = 'DEPRECATED_SHUTDOWN_2027-01-14' | 'LEGACY' | 'ACTIVE' | 'UNKNOWN';
/** R2 item 4: reasoning configuration (R08 §8). Haiku 5.5 adaptive by default; Gemini has no off (minimal); Haiku 4.5 none. */
/** EXEC-ECON C160 (delta v3.1 item 1): 'omit' = NOTHING about reasoning is sent (H-2 (i)); only valid with params.bodyProfile 'H_PARITY'. */
export interface ThinkingParams { mode: 'none' | 'adaptive' | 'manual' | 'minimal' | 'omit'; effort?: string; budgetTokens?: number; thinkingLevel?: string }
/** R2 item 5: cache write TTL requested (the cap always uses the most expensive TTL). */
export type CacheTtlRequested = '5m' | '1h' | 'NOT_APPLICABLE';
export type Task = 'summary' | 'code_fix' | 'analysis' | 'code_gen';
export type SizeBucket = 'S' | 'L';
export type Structure = 'S1' | 'S2' | 'S3';
export type Modality = 'text' | 'image' | 'audio';
export type CacheArm = 'S1' | 'S2_NOHIT' | 'S3_HITATTEMPT';
export type CacheObserved = 'HIT' | 'CREATION' | 'NO_HIT' | 'UNKNOWN';

/** Operation states (contract §1). Journal kinds mirror these transitions. */
export type OperationState =
  | 'PLANNED' | 'PRECALL_SNAPSHOT_COMMITTED' | 'SENT'
  | 'RESPONSE_RECEIVED' | 'ERROR_WITH_USAGE' | 'ERROR_NO_USAGE' | 'TIMEOUT_UNCERTAIN'
  | 'USAGE_PARSED' | 'COST_COMPUTED' | 'RECONCILED'
  | 'ABORTED_BEFORE_SEND' | 'STOP_BUDGET' | 'UNSUPPORTED_FOR_ESTIMATION' | 'NOT_SUPPORTED' | 'UNCERTAIN'
  /** R2 item 11: branch locked until its own GO (Google). Terminal; nothing reserved, nothing sent. */
  | 'NOT_RUN_BRANCH_LOCKED'
  /** C144 (D144-03/05): a gate artifact is missing or not PASS for this model/provider; the batch is skipped, the other arms continue. */
  | 'SKIPPED_GATE';

export type Outcome = 'OK' | 'REFUSED_WITH_USAGE' | 'ERROR_NO_USAGE' | 'TIMEOUT_UNCERTAIN' | 'NOT_SENT';

// ---------------------------------------------------------------------------------------------
// 1. Operation plan (identity; R07/R10 provide the values; never computed from results)
// ---------------------------------------------------------------------------------------------
export interface OperationParams {
  maxTokens: number;
  temperature: number | 'DEFAULT';
  /** Provider-specific reasoning configuration or 'NONE' (e.g. {effort:'low'}, {thinking_level:'minimal'}, {budget_tokens:N}). */
  reasoning: Record<string, string | number | boolean> | 'NONE';
  /** Request-level service tier parameter actually sent, or 'NONE' (R08: openai 'default', anthropic 'standard_only', google none). */
  serviceTier: string | 'NONE';
  /** Cache directives actually sent (e.g. anthropic cache_control, openai prompt_cache_key) or 'NONE'. */
  cacheDirectives: Record<string, string | number | boolean> | 'NONE';
  /** R2 item 3 (optional alias of serviceTier for the contract field name). */
  serviceTierRequested?: string | 'NONE';
  /** R2 item 4 (mandatory before R15). */
  thinking: ThinkingParams;
  /** R2 item 5 (mandatory before R15). */
  cacheTtlRequested: CacheTtlRequested;
  /** EXEC-ECON C160 (delta v3.1 items 1, 2, 10): 'H_PARITY' = the body of the H path (BOT-02 clients, protocol §2.1); absent = unchanged legacy bodies. */
  bodyProfile?: 'H_PARITY';
}

export interface OperationPlan {
  schema: typeof H2EVAL_SCHEMA.plan;
  studyId: string;
  protocolHash: Hex64;
  manifestSha256: Hex64;
  batchId: string;
  phase: Phase;
  cellId: string;
  groupId: string;
  promptId: string;
  rep: number;
  variant: string;
  /** VNEXT-F (R17-V-7): SC1 condition of this operation (e.g. OFF1024 | ON1024 | ON256); part of the cellId, hence of the operationId. */
  condition?: string;
  /** VNEXT-F (R17-V-8): this operation is the P1 probe (runs alone; the batch pauses until a signed P1 gate exists). */
  probe?: 'P1';
  split: Split;
  provider: Provider;
  api: UsageApi;
  endpoint: string;
  modelRequested: string;
  task: Task;
  sizeBucket: SizeBucket;
  structure: Structure;
  modality: Modality;
  plannedCacheArm: CacheArm;
  /** Content is addressed by hash; the executor resolves it through a ContentStore (never inline here). */
  promptSha256: Hex64;
  /** Stable prefix hash for S2/S3 (NOT_APPLICABLE for S1). */
  prefixSha256: Hex64 | 'NOT_APPLICABLE';
  /** Nonce only for S2_NOHIT (unique per call). */
  nonce: string | 'NOT_APPLICABLE';
  params: OperationParams;
  /** EXEC-ECON C160 (delta v3.1 item 4): the study plan's opId IS the operationId (hex64); absent = derived (contract §0.4). */
  opId?: Hex64;
  /** EXEC-ECON C160 (delta v3.1 item 11): position in the CRONOGRAMA (journaled with PLANNED; the order guard reads it). */
  econSeq?: number;
}

/** operationId = sha256(`${protocolHash}:${cellId}:${promptId}:${rep}:${modelRequested}`) (contract §0.4). */
export type OperationId = Hex64;

// ---------------------------------------------------------------------------------------------
// 2. Provider adapter (owned by MET-02, scripts/h2eval/modal/**): pure functions, no I/O
// ---------------------------------------------------------------------------------------------
export interface BuiltRequest {
  /** Absolute URL of the official host (checked by core against the allowlist before egress). */
  url: string;
  method: 'POST';
  /** Headers WITHOUT the credential. Core injects the key header at send time from process.env only. */
  headers: Record<string, string>;
  /** Name of the header that carries the credential (e.g. 'x-api-key', 'authorization', 'x-goog-api-key'). */
  credentialHeader: string;
  /** How the credential value is formatted: 'raw' or 'bearer'. */
  credentialFormat: 'raw' | 'bearer';
  /** Exact JSON body that will be sent; core hashes it (requestBodySha256) before egress. */
  body: unknown;
  /** Text parts of the body for the local counter (assembly otk.assembly.text_parts@1). */
  textParts: string[];
  /** Non-text parts present (image/audio/tools) ⇒ counter 'incomplete' ⇒ UNSUPPORTED_FOR_ESTIMATION. */
  nonTextParts: Array<{ kind: 'image' | 'audio' | 'tool' | 'other'; units: Count; unit: string }>;
}

/** Usage declared by the provider, normalized to the contract categories (§4). All fields Count; never 0 for absent. */
export interface NormalizedUsageH2 {
  schema: typeof H2EVAL_SCHEMA.usage;
  inputUncached: Count;
  cacheRead: Count;
  cacheWrite5m: Count;
  cacheWrite1h: Count;
  /** When the API does not separate TTLs (openai/google): total write; else NOT_APPLICABLE. */
  cacheWrite: Count;
  outputVisible: Count;
  reasoning: Count;
  imageUnits: Count;
  audioUnits: Count;
  toolTokens: Count;
  /** Normalized total input U (contract §4 normalization per API). */
  U: Count;
  usageCompleteness: 'COMPLETE' | 'PARTIAL' | 'MISSING';
  usageSource: 'provider_response';
  /** Only numbers copied from the provider usage object (no strings, no content). */
  rawUsageSanitized: Record<string, number>;
  /** Raw, unnormalized model id as the provider returned it, or 'UNKNOWN'. */
  modelServed: string | 'UNKNOWN';
  /** Raw tier/speed fields as returned (sanitized codes), or 'UNKNOWN'. */
  serviceTierServed: string | 'UNKNOWN';
  /** VNEXT-1 (C151): provider stop/finish reason as returned (identifier), or 'UNKNOWN'. */
  stopReason: string | 'UNKNOWN';
  /** VNEXT-1: completion derived from the provider's own reason, never inferred from counts: TRUNCATED_MAX_TOKENS (anthropic max_tokens | openai length | gemini MAX_TOKENS) counts as NOT completed. */
  completion: 'COMPLETE' | 'TRUNCATED_MAX_TOKENS' | 'REFUSED' | 'OTHER' | 'UNKNOWN';
  /** VNEXT-1: total output tokens as the provider reported (visible + reasoning when both are known). */
  outputTotal: Count;
  cacheObserved: CacheObserved;
  /** R2 item 8 (optional): Gemini promptTokensDetails by modality (TEXT/IMAGE/AUDIO → int). */
  promptTokensDetailsByModality?: Record<string, number>;
  /** R2 item 8 (optional): 'openai_128' when cached_tokens is rounded to multiples of 128. */
  cacheRoundingNote?: 'openai_128' | 'NONE';
  /** R2 item 9 (optional): nonce tokens declared for S2 (implicit-cache providers). */
  nonceTokensDeclared?: Count;
}

export interface ParsedRefusal {
  refused: boolean;
  /** Closed code from the adapter (e.g. 'content_filter', 'policy', 'rate_limit', 'schema_error'); never provider text. */
  code: string | 'NONE';
  httpStatus: number | 'UNKNOWN';
  /** True when the refusal/error response still carried a usage object (REFUSED_WITH_USAGE / ERROR_WITH_USAGE). */
  usagePresent: boolean;
}

/**
 * Provider adapter contract. Pure: no network, no fs, no env, no logging. Core calls it in this order:
 *   buildRequest(plan, content) → [core: snapshot, reserve, fsync, egress] → parseRefusal(status, body) → parseUsage(body)
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  readonly api: UsageApi;
  readonly adapterVersion: string;
  /** Official hosts this adapter may talk to (core enforces). */
  readonly officialHosts: readonly string[];
  buildRequest(plan: OperationPlan, content: ResolvedContent): BuiltRequest;
  parseRefusal(httpStatus: number, body: unknown): ParsedRefusal;
  /** VNEXT-2: `ctx.thinkingRequested=false` tells the parser the request disabled thinking (reasoning NOT_APPLICABLE when the detail is absent). */
  parseUsage(body: unknown, ctx?: { thinkingRequested?: boolean; /** E3G4: pedido so-texto do braco (o adaptador recusa outra modalidade) */ textOnly?: boolean }): NormalizedUsageH2;
  /** Model support entry for the local counter (tokenizer identity) — from the H1 catalog, never invented. */
  modelSupport(modelRequested: string): ModelSupport;
  /** R2 item 10 (optional): deprecation status of a served model id, from R08 §1; absent ⇒ 'UNKNOWN'. */
  modelDeprecation?(modelServed: string): ModelDeprecation;
}

/** R2 item 7: exploratory image formula (openai tile / anthropic 28px / gemini rough). NEVER replaces L0. */
export interface ExploratoryFormulaEstimate { tokens: Count; formula: 'openai_tile' | 'anthropic_28px' | 'gemini_rough'; rawInputs: Record<string, number> }

/** Content resolved by hash from the ContentStore (owned by E2E-01 for corpus/dialogues). */
export interface ResolvedContent {
  promptSha256: Hex64;
  /** Messages in a provider-neutral shape; adapters map roles/parts. */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; parts: Array<{ type: 'text'; text: string } | { type: 'image'; mime: string; bytesSha256: Hex64; width: number; height: number; bytesBase64?: string } | { type: 'audio'; mime: string; bytesSha256: Hex64; seconds: number; bytesBase64?: string }> }>;
  /** Stable prefix length in messages for S2/S3 (cache directives apply up to here). */
  prefixMessages: number | 'NOT_APPLICABLE';
}

export interface ContentStore {
  get(sha256: Hex64): Promise<ResolvedContent>;
  /** Binary parts (image/audio) by hash; never logged. */
  getBytes(sha256: Hex64): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------------------------
// 3. Pre-call snapshot (R12; immutable; hashed and fsynced BEFORE egress)
// ---------------------------------------------------------------------------------------------
export type EstimateStatus = 'ESTIMATED' | 'UNSUPPORTED_FOR_ESTIMATION';

export interface PrecallSnapshot {
  schema: typeof H2EVAL_SCHEMA.snapshot;
  snapshotId: string;
  operationId: OperationId;
  tsUtc: string;
  executorVersion: string;
  executorCodeSha: string;
  modelRequested: string;
  provider: Provider;
  api: UsageApi;
  requestBodySha256: Hex64;
  promptSha256: Hex64;
  prefixSha256: Hex64 | 'NOT_APPLICABLE';
  params: OperationParams;
  counter: { version: string; L0: Count; status: LocalCountResult['status']; reasons: string[]; exploratoryFormulaEstimate: ExploratoryFormulaEstimate | null };
  estimateStatus: EstimateStatus;
  covariates: { task: Task; sizeBucket: SizeBucket; structure: Structure; hasSystem: boolean; nTurns: number; family: string | 'UNKNOWN'; L0: Count };
  profile: { method: 'M0' | 'M1' | 'M1S' | 'M2'; profileId: string; paramsSha256: Hex64; trainedOn: string } | null;
  /** Point expectation of cost from the estimator (ESTIMATED) or 'UNKNOWN'. Never used as the cap. */
  expectedCostUsd: PicoUsd | 'UNKNOWN';
  priceSnapshot: { id: string; sha256: Hex64; capturedUtc: string };
  costCap: CostCap;
  budgetBefore: { provider: Provider; spentUsd: PicoUsd; reservedUsd: PicoUsd; capUsd: PicoUsd };
  cachePlan: { arm: CacheArm; directives: OperationParams['cacheDirectives']; minPrefixTokens: number | 'UNKNOWN'; expectedBehavior: string; /** E3: local estimate of the stable-prefix tokens (cacheable), or UNKNOWN */ cacheableTokens: Count; /** E3 / R2 item 9: tokens the S2 nonce adds (local estimate), NOT_APPLICABLE outside S2 */ nonceTokensDeclared: Count };
  /** E1 (R10 R3 §5.5): output ceiling of the request, copied from the plan. */
  maxTokens: number;
  /** VNEXT-F (R17-V-7): SC1 condition (null outside a conditions design). */
  condition: string | null;
  /** E1: ex-ante forecast block (record/forecast.ts); fields without a frozen table are 'NAO_REGISTRADA' forever. */
  forecast: import('./record/forecast.js').ForecastRecord;
  /** R15-D-1: the gate artifact (TRAIN_FROZEN / VALIDATION_SELECTED) revalidated WHOLE for this operation, by file name and sha256; null for train/comparative/pilot. */
  gateUsed: { block: string; file: string; sha256: Hex64 } | null;
  /** sha256 of the canonical JSON of this object WITHOUT snapshotSha256; recomputed on read; mismatch = tamper. */
  snapshotSha256: Hex64;
}

// ---------------------------------------------------------------------------------------------
// 4. Post-call record (R12)
// ---------------------------------------------------------------------------------------------
/** EXEC-ECON delta 6: 'UPPER_BOUND' = settled by a declared upper bound (gpt-6-luna without cache_write_tokens, ECON only); never presented as CALCULATED. */
export type CostState = 'CALCULATED' | 'ESTIMATED' | 'UNKNOWN' | 'UPPER_BOUND';

export interface CostTable {
  schema: typeof H2EVAL_SCHEMA.cost;
  usd: PicoUsd | 'UNKNOWN';
  state: CostState;
  byCategory: Record<string, PicoUsd | 'UNKNOWN' | 'NOT_APPLICABLE'>;
  priceSnapshotSha256: Hex64;
  /** costTable ≤ costCap; false ⇒ global STOP (safety failure). */
  capCovered: boolean | 'UNKNOWN';
  cacheInterval: { lowerUsd: PicoUsd | 'UNKNOWN'; upperUsd: PicoUsd | 'UNKNOWN'; inInterval: boolean | 'UNKNOWN' };
  billing: { state: 'NOT_AVAILABLE' | 'PENDING' | 'RECONCILED'; observedUsd: PicoUsd | null; source: string | null; tolerance: string | null };
  possiblyCharged: boolean;
}

/** R2 item 6: cap = inputUpperBound × max(input, cache write at the most expensive TTL) + (maxOutput + reasoningAllowance) × output, rounded UP to micro-USD. */
export interface CostCap {
  usd: PicoUsd;
  basis: string;
  inputUpperBoundTokens: number;
  maxOutputTokens: number;
  reasoningAllowanceTokens: number;
  capBasis: { inputPriceMicro: string; cacheWritePriceUsedMicro: string; cacheWriteTtlUsed: '5m' | '1h' | 'NONE'; outputPriceMicro: string; roundedUpToMicroUsd: boolean };
}

export interface PostcallRecord {
  operationId: OperationId;
  outcome: Outcome;
  /** R2 item 10. */
  modelDeprecation: ModelDeprecation;
  /** R10 R2 §5.3: served model outside the pre-registered accepted set ⇒ EXCL_MODEL_MISMATCH (recorded, never silently dropped). */
  exclusion: 'NONE' | 'EXCL_MODEL_MISMATCH';
  httpStatus: number | 'UNKNOWN';
  refusal: ParsedRefusal | null;
  usage: NormalizedUsageH2 | null;
  /** Response text is stored by hash in content/, never here. */
  responseSha256: Hex64 | 'UNKNOWN';
  cost: CostTable;
  tsSentUtc: string;
  tsReceivedUtc: string | 'UNKNOWN';
  latencyMs: number | 'UNKNOWN';
  finalState: OperationState;
  /** VNEXT-1 (C151): the provider's stop reason and the derived completion, copied from the usage (UNKNOWN when there was no response). */
  stopReason: string | 'UNKNOWN';
  completion: 'COMPLETE' | 'TRUNCATED_MAX_TOKENS' | 'REFUSED' | 'OTHER' | 'UNKNOWN';
}

// ---------------------------------------------------------------------------------------------
// 5. Journal (append-only, fsync before egress) and budget ledger
// ---------------------------------------------------------------------------------------------
export type JournalKind =
  | 'PLANNED' | 'PRECALL_SNAPSHOT_COMMITTED' | 'RESERVED' | 'SENT'
  | 'RESPONSE_RECEIVED' | 'ERROR_WITH_USAGE' | 'ERROR_NO_USAGE' | 'TIMEOUT_UNCERTAIN'
  | 'USAGE_PARSED' | 'COST_COMPUTED' | 'SETTLED' | 'RECONCILED'
  | 'ABORTED_BEFORE_SEND' | 'STOP_BUDGET' | 'STOP_GLOBAL' | 'UNSUPPORTED_FOR_ESTIMATION' | 'NOT_SUPPORTED' | 'UNCERTAIN_ISOLATED' | 'REPLAY_SKIPPED'
  | 'NOT_RUN_BRANCH_LOCKED' | 'PAUSE_REVIEW'
  /** R15-M4: signed acknowledgement of the 80 % pause (identity from the GO in REAL mode). R15-M1: replay refused because the plan differs from the PLANNED line. */
  | 'PAUSE_ACK' | 'REPLAY_PLAN_MISMATCH'
  /** C144 D144-06: 80 % crossed with a signed pre-authorisation and every future reservation of the scope fits the sub-ledger. D144-04: attempts budget of the GO exhausted. */
  | 'PAUSE_PREAUTHORIZED' | 'SKIPPED_GATE'
  /** CYCLE2-B (proposal): campaign-journal line of the credential-less connectivity probe (TLS issuer/fingerprint, HTTP 401, env fingerprint). */
  | 'PREFLIGHT_CONNECTIVITY'
  /** C158 cycle 2: HUMAN acknowledgement of one uncertain operation (never resent); it only releases the NEXT operations of the batch. */
  | 'UNCERTAIN_ACKNOWLEDGED'
  /** C158: the first operation of a probe region is a probe (STARTED before the reservation, RESULT with the measurement and the verdict after the settlement). */
  | 'MODEL_PROBE_STARTED' | 'MODEL_PROBE_RESULT';

export interface JournalLine {
  schema: typeof H2EVAL_SCHEMA.journal;
  seq: number;
  tsUtc: string;
  kind: JournalKind;
  operationId: OperationId | 'NONE';
  /** Kind-specific payload: ids, hashes, counts, pico-USD; never text, never credentials. */
  body: Record<string, unknown>;
  prevHash: Hex64;
  hash: Hex64;
}

export interface LedgerState {
  schema: typeof H2EVAL_SCHEMA.ledger;
  campaignCapUsd: PicoUsd;
  providers: Record<Provider, { capUsd: PicoUsd; spentUsd: PicoUsd; reservedUsd: PicoUsd; possiblyChargedUsd: PicoUsd; /** VNEXT-5: committed amount inherited from a previous study (counts against the cap; never released) */ inheritedUsd: PicoUsd; operations: number }>;
  /** Per-batch sub-cap (R10 §7.3) when configured. */
  batches: Record<string, { capUsd: PicoUsd; spentUsd: PicoUsd; reservedUsd: PicoUsd }>;
}

export type StopReason =
  | 'STOP_FILE' | 'STOP_BUDGET_PROVIDER' | 'STOP_BUDGET_BATCH' | 'STOP_BUDGET_CAMPAIGN' | 'STOP_BUDGET_OPERATION'
  | 'STOP_CAP_VIOLATION' | 'STOP_PRICE_UNKNOWN' | 'STOP_PERSISTENCE' | 'STOP_UNCERTAIN' | 'STOP_WATCHDOG' | 'STOP_CONSECUTIVE_FAILURES'
  /** R2 item 12: 80% of a provider sub-ledger reached ⇒ pause for human review (needs an explicit ack to continue). */
  | 'PAUSE_REVIEW_AT_80PCT'
  /** R2 item 12: batch ≤ 60 calls, one model per batch. */
  | 'STOP_BATCH_SIZE' | 'STOP_BATCH_MODEL_MIX'
  /** R15-M1: a known operationId replayed with a different promptSha256 / body / cache arm (aborted, never sent). */
  | 'STOP_REPLAY_PLAN_MISMATCH'
  /** C144 D144-04: the GO's maxAttempts (never above 1 446 including the pilot) is exhausted. */
  | 'STOP_MAX_ATTEMPTS'
  /** VNEXT-8 (R4 stops): provider stop reason absent in a response; HTTP 400 to a request with thinking disabled. */
  | 'STOP_STOP_REASON_MISSING' | 'STOP_THINKING_DISABLED_REJECTED'
  /** E3G (C160 BRACO-GO): arm Google/OpenAI only. Price not attested / ledger not the per-provider arm profile / tier not fixed in the request (all PRE-SEND, nothing reserved); served tier not Standard (after the response, latching; cost UNKNOWN, possibly charged). */
  | 'STOP_ARM_PRICE_NOT_ATTESTED' | 'STOP_ARM_LEDGER' | 'STOP_ARM_TIER_NOT_FIXED' | 'STOP_TIER_NOT_STANDARD'
  /** EXEC-ECON C160: order/prefix guard of the CRONOGRAMA consumer (item 11) */
  | 'STOP_ECON_ORDER'
  /** EXEC-ECON C160 delta 2: the ECON GO (h2eval.go.econ.v1) does not cover this attempt (expired, changed, out of scope, attempts exhausted).
   *  A PAUSE (journaled PAUSE_REVIEW, not terminal): nothing reserved or sent, and the SAME attempt runs first under a new valid GO (prefix kept). */
  | 'PAUSE_ECON_GO'
  /** EXEC-ECON C160 delta 5 (R-D4): any other pre-send refusal of the egress in the ECON study (credential/env/host...) — same non-terminal pause semantics. */
  | 'PAUSE_ECON_EGRESS'
  /** VNEXT-F (R17-V-8): after the P1 probe the series pauses until gates/P1_<model>.json exists (HALT_ALL); a FAIL verdict stops it. */
  | 'PAUSE_PROBE_GATE' | 'STOP_PROBE_FAILED'
  /** C158 §3 (G7): the input MEASURED by the provider exceeded the input upper bound of the reservation. Blocking: no further operation is sent (the batch halts; the latch survives a restart). */
  | 'STOP_INPUT_ABOVE_RESERVATION'
  /** C158 §3.2: the planned input reservation is below the configured conservative reserve policy (or the policy cannot be evaluated): refused BEFORE anything is reserved or sent. */
  | 'STOP_INPUT_RESERVE_POLICY'
  /** C158: the automatic probe of a new model / unmeasured length region failed (or could not be judged / was left unresolved): blocking, no retry, the batch halts. */
  | 'STOP_MODEL_PROBE_FAILED';

export interface RunnerResult {
  operationId: OperationId;
  state: OperationState;
  stop: StopReason | null;
  replayed: boolean;
}
