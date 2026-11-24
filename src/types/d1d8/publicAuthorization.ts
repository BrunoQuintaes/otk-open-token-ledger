/**
 * D1–D8 shared contract — public authorization, commitment opening and proof adapter
 * (D1, D2, D6; producer A, consumers C for persistence/queue and S4 for Besu).
 *
 * Public side rules (D2): no exact usage, no opening secret, no prompt/completion hash in any
 * public field. The commitment is randomized with a secret blinding value from a CSPRNG
 * (never a nonce, date, requestId or public seed). A fixes the construction, the field-element
 * bounds and the exact public-signal order; this file fixes only what C and S4 exchange.
 */
import type { ChainDomain, Hex32, IsoTime, OperationKey, Scaled } from './common.js';
import type { SignedEnvelope } from './receipt.js';

/** Decimal string of a BN254 scalar-field element (0 ≤ x < r). */
export type FieldElement = string;

/**
 * Private opening of a public commitment. Persisted by C BEFORE the dependent public effect,
 * tenant-scoped, included in backup/restore, never in logs, Git, queues payloads in clear,
 * dead-letter dumps or transactions (D2 §5, D2-G06).
 */
export interface CommitmentOpening {
  schema: 'otk.opening.v1';
  key: OperationKey;
  circuitId: string;
  /** Exact private usage in the circuit's unit (A documents the mapping from CuResult.cu). */
  usage: Scaled;
  /** Secret blinding value; CSPRNG; field element. */
  blinding: FieldElement;
  /** Other private circuit inputs A needs (named; values are field elements). */
  privateInputs: Record<string, FieldElement>;
  createdAt: IsoTime;
}

/** Fixed public interval (D2 §4), from a versioned policy; never tuned per receipt. */
export interface PublicBucket {
  min: bigint;
  max: bigint;
  policyVersion: string;
}

/**
 * What goes on chain for one receipt. `fields` is the exact list of values the contract checks;
 * `authorizationDigest` is recomputable on-chain from those values plus `domain` (fixes R16:
 * the signature is bound to the arguments, not to an arbitrary hash).
 */
export interface PublicAuthorization {
  schema: 'otk.public_authorization.v1';
  domain: ChainDomain;
  circuitId: string;
  commitment: FieldElement;
  epoch: bigint;
  bucket: PublicBucket;
  /** Hiding reference to the operation (A defines; must not expose tenant/operation ids in clear). */
  operationRef: Hex32;
  /** Replay key the contract enforces (A defines scope: per domain + operationRef or commitment). */
  replayKey: Hex32;
  /** Ordered public values as the contract receives them (A documents order and types). */
  fields: Array<{ name: string; value: string }>;
  authorizationDigest: Hex32;
  signature: SignedEnvelope;
}

/** Groth16 proof bundle exactly as the verifier contract consumes it. */
export interface ProofBundle {
  circuitId: string;
  proof: { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] };
  /** In the exact order of the circuit's public signals (A documents; C never reorders). */
  publicSignals: string[];
  /** Artifact identities used: wasm, zkey, vkey digests (D6 manifest). */
  artifacts: { wasm: Hex32; zkey: Hex32; vkey: Hex32 };
}

/** Batch statement signed for a Merkle root (D1 §5): root + cardinality + context. */
export interface BatchStatement {
  domain: ChainDomain;
  root: Hex32;
  cardinality: bigint;
  /** What was validated for each member before building the root (declared level, D1-G05). */
  memberValidation: 'signature_and_proof_each' | 'signature_each' | 'none_declared';
  firstEpoch: bigint;
  lastEpoch: bigint;
  signature: SignedEnvelope;
}
