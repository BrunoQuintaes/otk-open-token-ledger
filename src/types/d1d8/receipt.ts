/**
 * D1–D8 shared contract — private receipt v3 and signature envelope (D1, D3; producer A for the
 * canonical encoding/signature, C for construction in the runtime and persistence).
 *
 * The private receipt carries tenant, configuration and categorized usage and is signed by the
 * operator. It is never published. The public side is ./publicAuthorization.ts.
 * Historical formats (RawReceipt canonicalHash, OTK_RECEIPT_V1, OTK_RECEIPT_V2) keep their own
 * algorithms; they are verified as they were written and never re-hashed with new fields (D3 §5).
 */
import type { Address, Hex32, IsoTime, OperationKey, FrozenConfigRef } from './common.js';
import type { NormalizedUsage } from './usage.js';
import type { CuResult, PriceQuote } from './cu.js';

/** Legacy receipt encodings that must stay verifiable with their original algorithm. */
export type LegacyReceiptFormat =
  /** src/metering/SignatureManager.ts canonicalHash(RawReceipt): alphabetical `k:v` lines */
  | 'raw_receipt_canonical_hash'
  /** src/receipt/canonicalReceiptV1.ts OTK_RECEIPT_V1 0x1f-separated */
  | 'otk_receipt_v1'
  /** src/receipt/canonicalReceiptV2.ts OTK_RECEIPT_V2 (V1 + oracle fields) */
  | 'otk_receipt_v2';

/** Origin and trust level of what the receipt states (D3 §8). */
export type ReceiptSource =
  | 'otk_proxy_observed'
  | 'otk_api_server_computed'
  | 'client_declared'
  | 'legacy_import';

export interface PrivateReceiptV3 {
  schema: 'otk.receipt.v3';
  key: OperationKey;
  source: ReceiptSource;
  provider: string;
  usage: NormalizedUsage;
  cu: CuResult;
  price: PriceQuote | null;
  config: FrozenConfigRef;
  /** Pseudonymous user id inside the tenant, as used by the circuit (decimal string). */
  userRef: string;
  timing: { admittedAt: IsoTime; upstreamStartedAt: IsoTime | null; usageFinalAt: IsoTime | null; latencyMs: bigint | null };
  /** Commitment published for this receipt, when one exists (links private ↔ public, D1 §4). */
  publicCommitment: string | null;
  /**
   * Optional content digests. Absent by default (D2 §6): deterministic hashes of small-domain
   * texts leak; A decides the keyed/hiding construction before any of these is enabled.
   */
  contentDigests: null;
}

/** Signature algorithms the verifier accepts. A may add; never silently swap. */
export type EnvelopeAlgorithm = 'eip191-secp256k1' | 'eip712-secp256k1';

/**
 * Detached signature over one canonical payload. `domain` separates payload kinds so a receipt
 * signature can never be replayed as a conference-report or authorization signature (D3 §3).
 */
export interface SignedEnvelope {
  schema: 'otk.envelope.v1';
  /** v1.4 (OVERNIGHT 20261005): OTK_ATTRIBUTION_V1 for the attribution statement bound to a receipt. */
  /** v1.5 (OVERNIGHT 2): OTK_CU_REFERENCE_V1 for the CU-reference statement bound to a receipt. */
  domain: 'OTK_PRIVATE_RECEIPT_V3' | 'OTK_CONFERENCE_V1' | 'OTK_PUBLIC_AUTHORIZATION_V1' | 'OTK_BATCH_V1' | 'OTK_ATTRIBUTION_V1' | 'OTK_CU_REFERENCE_V1';
  payloadDigest: Hex32;
  alg: EnvelopeAlgorithm;
  signer: Address;
  /** Identifier of the key in the signer registry (rotation/revocation, D1 §3). */
  keyId: string;
  signature: `0x${string}`;
  signedAt: IsoTime;
}

export type VerifyFailure =
  | 'bad_signature'
  | 'unauthorized_signer'
  | 'revoked_key'
  | 'digest_mismatch'
  | 'wrong_domain'
  | 'binding_mismatch'
  | 'unsupported_version'
  | 'malformed';

export type VerifyResult = { ok: true; signer: Address; keyId: string } | { ok: false; reason: VerifyFailure; detail?: string };
