/**
 * D1–D8 shared contract — module APIs exchanged between fronts (S0 freezes signatures;
 * A/B/C implement them in their own files; C consumes A/B through these types only).
 *
 * C may use explicit test doubles of these contracts in its local tests until S4 wires the real
 * modules. A double must be named *Double* and must not be reachable from a production entry
 * point; S4 rejects any TODO/stub on a mandatory path (02_PROTOCOLO_COMUM.md).
 *
 * @module src/types/d1d8/modules
 */
import type { Hex32, IsoTime, Money, OperationKey, Scaled, VersionRef, ChainDomain } from './common.js';
import type { ModelSupport, NormalizedUsage, UsageApi, UsageOrigin } from './usage.js';
import type { CuResult, CuWeightsLoadStatus, CuWeightsTableV2, PriceQuote } from './cu.js';
import type { ConferenceCalibrationRecord, ConferenceReport, ConferenceThreshold } from './conference.js';
import type { LegacyReceiptFormat, PrivateReceiptV3, SignedEnvelope, VerifyResult } from './receipt.js';
import type { BatchStatement, CommitmentOpening, ProofBundle, PublicAuthorization, PublicBucket } from './publicAuthorization.js';
import type { AdmitResult, DurableOperation, OutboxEffect } from './operation.js';
import type { AttributionStatementV1, OperationAttribution } from './attribution.js';
import type { CuReferenceStatementV1 } from './cuReference.js';

// ───────────────────────────── B: measurement (D4, D5, D8) ─────────────────────────────

/**
 * Context copied into a normalized usage: provider, requested model, origin and observation time.
 */
export interface UsageContext {
  provider: string;
  modelRequested: string;
  origin: UsageOrigin;
  observedAt: IsoTime;
}

/** Parse a non-streaming response body (already JSON-parsed) into NormalizedUsage. */
export type NormalizeUsageFn = (api: UsageApi, responseBody: unknown, ctx: UsageContext) => NormalizedUsage;

/** Incremental SSE usage parser; bounded memory; handles split UTF-8 and cumulative events. */
export interface StreamUsageAccumulator {
  push(chunk: Uint8Array | string): void;
  /** Returns completeness 'partial' or 'missing' when the stream ended without final usage. */
  finish(): NormalizedUsage;
  readonly bytesSeen: number;
}
/**
 * Creates an accumulator that rebuilds usage from a provider SSE stream.
 */
export type CreateStreamUsageAccumulatorFn = (api: UsageApi, ctx: UsageContext, limits: { maxBufferedBytes: number }) => StreamUsageAccumulator;

/**
 * Resolves local tokenizer coverage for a provider, API and model.
 */
export type ResolveModelSupportFn = (provider: string, api: UsageApi, modelRequested: string) => ModelSupport;

/** Validated weights ready for computation (never constructed from silent defaults, D4 §1). */
export interface CuConfig {
  table: CuWeightsTableV2;
  ref: VersionRef;
  formula: string;
  developmentProfile: boolean;
}
/**
 * Loads and checks a signed CU weights table; returns the status and, when usable, the configuration.
 */
export type LoadCuWeightsFn = (raw: unknown, opts: { now: IsoTime; trustedSigners: readonly string[] }) =>
  { status: CuWeightsLoadStatus; config: CuConfig | null };

/**
 * Computes CU for a normalized usage with one configuration.
 */
export type ComputeCuFn = (usage: NormalizedUsage, cfg: CuConfig) => CuResult;

/**
 * Prices a normalized usage with the price table in force at `at`.
 */
export type PriceUsageFn = (usage: NormalizedUsage, at: IsoTime, tableRef: VersionRef) => PriceQuote;

/** Worst-case reservation for a call whose CU is unknown until the provider answers (D7 §8). */
export type EstimateReservationFn = (req: {
  provider: string;
  api: UsageApi;
  modelRequested: string;
  estimatedInputTokens: bigint;
  maxOutputTokens: bigint;
}, cfg: CuConfig, priceTable: VersionRef | null) => { cu: Scaled; money: Money | null; basis: string };

/** Input as assembled for the provider (messages/tools), passed in memory only. */
export interface AssembledInput {
  api: UsageApi;
  /** Opaque structured request body; the counter applies its declared assembly rule. */
  body: unknown;
}

/**
 * Result of the local (auxiliary) counter for one operation.
 */
export interface LocalCountResult {
  counts: Array<{ category: import('./usage.js').TokenCategoryName; count: bigint }>;
  covered: Array<import('./usage.js').TokenCategoryName>;
  uncovered: Array<import('./usage.js').TokenCategoryName>;
  status: 'ok' | 'incomplete' | 'failed' | 'unsupported';
  counterVersion: string;
  /** Resource use of the counter itself (D8-G01), measured, never assumed zero. */
  cost: { cpuMicros: bigint | null; peakBufferedBytes: number };
}

/**
 * Local token counter for one operation: observe input, observe output text, then finish once.
 */
export interface LocalCounter {
  observeInput(input: AssembledInput): void;
  observeOutputText(chunk: string): void;
  finish(): LocalCountResult;
}
/**
 * Creates a local counter for one operation.
 */
export type CreateLocalCounterFn = (support: ModelSupport, limits: { maxTextBytes: number }) => LocalCounter;

/**
 * Builds the conference report of one operation (unsigned).
 */
export type BuildConferenceReportFn = (args: {
  key: OperationKey;
  receiptDigest: Hex32;
  usage: NormalizedUsage;
  local: LocalCountResult;
  support: ModelSupport;
  threshold: ConferenceThreshold;
  now: IsoTime;
  /** v1.2 (Phase 8, optional): calibration selected for this conference (record + adjusted expectation). */
  calibration?: ConferenceCalibration;
}) => ConferenceReport;

/**
 * Calibration applied by the conference (Phase 8). `expected` exists only for a COMPATIBLE calibrated profile and
 * returns the adjusted expectation of a category from the raw local count, or null for a category the profile does
 * not cover.
 */
export interface ConferenceCalibration {
  record: ConferenceCalibrationRecord;
  expected?: (category: import('./usage.js').TokenCategoryName, local: bigint) => bigint | null;
}

// ───────────────────────────── A: signatures, commitments, proofs (D1, D2, D3 repr., D6) ───

/**
 * Digests, signatures and verification of private receipts, conference reports and statements.
 */
export interface ReceiptCrypto {
  /** keccak256 over A's canonical encoding of the receipt (spec + cross TS/Solidity vectors). */
  digestReceipt(r: PrivateReceiptV3): Hex32;
  digestConference(rep: ConferenceReport): Hex32;
  signReceipt(r: PrivateReceiptV3): Promise<SignedEnvelope>;
  signConference(rep: ConferenceReport): Promise<SignedEnvelope>;
  verifyReceipt(r: PrivateReceiptV3, env: SignedEnvelope): VerifyResult;
  /** Also checks rep.receiptDigest === digestReceipt(receipt) (swap between receipts rejected). */
  verifyConference(rep: ConferenceReport, env: SignedEnvelope, receipt: PrivateReceiptV3): VerifyResult;
  /** Historical formats verified with their original algorithm, never re-hashed. */
  verifyLegacy(format: LegacyReceiptFormat, payload: unknown, signature: unknown): VerifyResult;
  /** v1.4 (Phase 7): attribution statement, domain OTK_ATTRIBUTION_V1; verify also checks the receipt binding. */
  digestAttribution?(st: AttributionStatementV1): Hex32;
  signAttribution?(st: AttributionStatementV1): Promise<SignedEnvelope>;
  verifyAttribution?(st: AttributionStatementV1, env: SignedEnvelope, receipt: PrivateReceiptV3): VerifyResult;
  /** v1.5 (OVERNIGHT 2): CU-reference statement, domain OTK_CU_REFERENCE_V1; verify also checks the receipt binding. */
  digestCuReference?(st: CuReferenceStatementV1): Hex32;
  signCuReference?(st: CuReferenceStatementV1): Promise<SignedEnvelope>;
  verifyCuReference?(st: CuReferenceStatementV1, env: SignedEnvelope, receipt: PrivateReceiptV3): VerifyResult;
}

/** CSPRNG inside; never deterministic from public data (D2 §2). */
export type NewCommitmentOpeningFn = (key: OperationKey, usage: Scaled, circuitId: string, privateInputs: Record<string, string>) => CommitmentOpening;

/**
 * Builds the public authorization (commitment and bucket, no exact usage) of a signed receipt.
 */
export type BuildPublicAuthorizationFn = (args: {
  receipt: PrivateReceiptV3;
  opening: CommitmentOpening;
  domain: ChainDomain;
  bucket: PublicBucket;
}) => Promise<PublicAuthorization>;

/**
 * Adapter between a public authorization and one proof circuit / contract call.
 */
export interface ProofAdapter {
  readonly circuitId: string;
  /** Witness input for the circuit; replaces the input assembly now inside ProverDaemon. */
  buildWitnessInput(opening: CommitmentOpening, auth: PublicAuthorization): Record<string, string | string[]>;
  prove(input: Record<string, string | string[]>): Promise<ProofBundle>;
  verifyLocal(bundle: ProofBundle): Promise<boolean>;
  /** Contract call for the registry; C submits it without re-encoding anything. */
  encodeSubmission(auth: PublicAuthorization, bundle: ProofBundle): { abi: string[]; functionName: string; args: unknown[] };
}

/**
 * Builds the batch statement of several public authorizations (each with its proof bundle, or null) for one chain domain.
 */
export type BuildBatchStatementFn = (args: {
  domain: ChainDomain;
  members: Array<{ auth: PublicAuthorization; bundle: ProofBundle | null }>;
}) => Promise<BatchStatement>;

// ───────────────────────────── C: operations and effects (D3 storage, D7) ─────────────────

/**
 * Request to admit a durable operation before the provider is called.
 */
export interface AdmitRequest {
  key: OperationKey;
  requestDigest: Hex32;
  /**
   * v1.4 (OVERNIGHT 20261005, identity across versions): construction of `requestDigest`. Omitted means
   * 'otk.request_digest.v1' (every row admitted before this field existed).
   */
  requestDigestVersion?: 'otk.request_digest.v1' | 'otk.request_digest.v2';
  /**
   * Digests that earlier releases computed for THIS SAME client request (narrow, enumerated
   * representations, e.g. v1 with and without the injected service_tier). A stored operation whose
   * digest is one of these is the same logical operation ('existing'); anything else is 'conflict'.
   * The stored digest is never rewritten.
   */
  equivalentDigests?: Hex32[];
  /**
   * v1.4 (OVERNIGHT 20261005, Phase 7): attribution frozen with the operation in the same transaction. Omitted or
   * all-null = unattributed. Part of the request identity: a retry with another attribution is a conflict.
   */
  attribution?: OperationAttribution;
  /**
   * v1.4 (OVERNIGHT 20261005, F-P1-04): execution lease written in the admitting transaction (owner + duration), so
   * recovery never sees a just-admitted operation without an owner while its process is still starting it.
   */
  lease?: { owner: string; ms: number };
  provider: string;
  api: UsageApi;
  modelRequested: string;
  reservation: DurableOperation['reservation'];
  limits: DurableOperation['limits'];
  config: DurableOperation['config'];
}

/**
 * Durable store of operations.
 */
export interface OperationStore {
  /** Durable before returning 'admitted'; returns 'persistence_unavailable' instead of acking. */
  admit(req: AdmitRequest): Promise<AdmitResult>;
  /** Tenant-scoped read: a key from another tenant is not found (D3-G03). */
  get(key: OperationKey): Promise<DurableOperation | null>;
  /** Compare-and-set on revision; rejects illegal transitions. */
  transition(key: OperationKey, expectedRevision: bigint, patch: Partial<Pick<DurableOperation,
    'execution' | 'measurement' | 'delivery' | 'usage' | 'providerRequestId' | 'cancellation' | 'effects' | 'reservation'>>): Promise<DurableOperation>;
  listIncomplete(opts: { olderThan: IsoTime; limit: number }): Promise<DurableOperation[]>;
}

/**
 * Durable outbox of effects: enqueue (deduplicated), claim with a lease, then complete or fail with an optional retry time.
 */
export interface EffectOutbox {
  enqueue(effect: Omit<OutboxEffect, 'state' | 'attempts' | 'lease' | 'createdAt'>): Promise<'enqueued' | 'duplicate'>;
  claim(owner: string, kinds: OutboxEffect['kind'][], leaseMs: number, limit: number): Promise<OutboxEffect[]>;
  complete(effectId: string, owner: string): Promise<void>;
  fail(effectId: string, owner: string, reason: string, retryAt: IsoTime | null): Promise<void>;
}

/**
 * Durable store of commitment openings (private).
 */
export interface OpeningStore {
  /** Must be durable before the dependent public effect is enqueued (D2 §5). */
  put(opening: CommitmentOpening): Promise<void>;
  get(key: OperationKey): Promise<CommitmentOpening | null>;
}
