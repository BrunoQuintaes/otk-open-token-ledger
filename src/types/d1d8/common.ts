/**
 * D1–D8 shared interface contract — common primitives (S0, run 20260930-1625).
 *
 * Owned by S0/S4. Fronts A/B/C consume these types and implement the module contracts in
 * ./modules.ts inside their own files. Changing anything here during the parallel phase goes
 * through a request to the coordinator (control/<role>/REQUEST_*.md), never a direct edit.
 *
 * Wire rule for every type in this folder: bigint fields travel as base-10 strings in JSON,
 * never as JS numbers; absent optional counts stay absent (null), they are never written as 0.
 * The byte-level canonical encoding used for hashing/signing is A's specification, not JSON.
 *
 * @module src/types/d1d8/common
 */

/** 0x-prefixed, lowercase, 32-byte hex string (keccak256 / sha256 digest). */
export type Hex32 = `0x${string}`;

/** 0x-prefixed EVM address (checksummed or lowercase; compare case-insensitively). */
export type Address = `0x${string}`;

/** ISO-8601 UTC timestamp with milliseconds, e.g. 2026-09-30T19:25:11.000Z. */
export type IsoTime = string;

/**
 * Fixed-point amount: real value = units / scale. scale is a positive power of ten.
 * Used for CU (accounting precision) and money. Two amounts are only comparable after
 * conversion to the same scale; a converter that would lose digits must refuse, not round.
 */
export interface Scaled {
  units: bigint;
  scale: bigint;
}

/** Monetary amount. currency is ISO-4217; only 'USD' is in the declared scope. */
export interface Money extends Scaled {
  currency: 'USD';
}

/**
 * Identity of one metered operation. Idempotency is per (tenantId, operationId):
 * the same operationId in two tenants is two unrelated operations (D3 §7, D3-G03/G06).
 */
export interface OperationKey {
  tenantId: string;
  operationId: string;
}

/** Pointer to one versioned artifact (weights table, price table, catalog, circuit...). */
export interface VersionRef {
  /** Human/stable version id as published by its owner, e.g. 'cw-2026-09-30.1'. */
  version: string;
  /** Digest of the exact bytes that were validated and frozen for the operation. */
  digest: Hex32;
}

/**
 * Configuration frozen when an operation is admitted (D4 §3, D7 §1). Later updates never
 * recompute an admitted/historical operation. Every field that influences CU, price, the
 * conference or the public record must be here.
 */
export interface FrozenConfigRef {
  cuWeights: VersionRef;
  /** CU formula id, e.g. 'CU_MODEL_v1' (legacy integer) or B's versioned successor. */
  cuFormula: string;
  priceTable: VersionRef | null;
  modelCatalog: VersionRef;
  /** Public bucket policy (D2 §4). Never used for private accounting. */
  bucketPolicy: VersionRef;
  /** Proof system/circuit identity, e.g. 'metering_v3@<r1cs digest>' (A defines). */
  circuitId: string;
  chain: ChainDomain | null;
  /** Explicit development profile marker (D4 §1). Never true in an operational profile. */
  developmentProfile: boolean;
}

/** Where a public authorization is valid (D1 §3). */
export interface ChainDomain {
  chainId: bigint;
  registry: Address;
  verifier: Address;
  /** Registry schema/version string the contract enforces (A defines the value set). */
  schemaVersion: string;
}

/** Status vocabulary shared by gates/evidence (03_GATES_E_EVIDENCIAS.md). */
export type GateStatus = 'NOT_RUN' | 'RUNNING' | 'PASS' | 'FAIL' | 'BLOCKED_EXTERNAL' | 'NOT_APPLICABLE';

/** Front identifiers used in ownership, requests and evidence. */
export type Role = 'S0' | 'A' | 'B' | 'C' | 'S4' | 'S5';

/** Schema identifiers frozen by S0. A new incompatible shape gets a new id, never a reuse. */
export const D1D8_SCHEMA_IDS = Object.freeze({
  usage: 'otk.usage.v1',
  cuResult: 'otk.cu_result.v1',
  price: 'otk.price_quote.v1',
  conference: 'otk.conference.v1',
  privateReceipt: 'otk.receipt.v3',
  envelope: 'otk.envelope.v1',
  publicAuthorization: 'otk.public_authorization.v1',
  opening: 'otk.opening.v1',
  operation: 'otk.operation.v1',
  outbox: 'otk.outbox_effect.v1',
  cuWeights: 'otk.cu_weights.v2',
  /** v1.4 (OVERNIGHT 20261005, Phase 7): attribution statement bound to a private receipt. */
  attribution: 'otk.attribution.v1',
} as const);

/** Version of this interface contract. Bumped by S0/S4 only, with a new COMMON_SHA. */
export const D1D8_INTERFACES_VERSION = 'd1d8-interfaces-1.4.0' as const;
