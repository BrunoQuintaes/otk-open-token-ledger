/**
 * Receipt Types for OTK zk-Metering
 *
 * Implements Dual Receipt Model (ADR-0003):
 * - RawReceipt: full provider event data (off-chain, signed)
 * - ZKReceipt: minimal proof-compatible receipt (on-chain, proven)
 */

/**
 * Raw Receipt (off-chain, signed)
 *
 * Full fidelity provider metering event with all metadata.
 * Must be signed for authenticity (ECDSA signature).
 * Stored off-chain (jsonl/log/DB).
 */
export interface RawReceipt {
  /** Provider identifier (normalized: 'openai', 'anthropic', 'gemini', etc.) */
  provider: string;

  /** Model identifier (e.g., 'gpt-4', 'claude-opus-4', 'gemini-2.0-flash') */
  model: string;

  /** Input tokens consumed */
  inputTokens: number;

  /** Output tokens generated */
  outputTokens: number;

  /** Cost units (normalized cost for ZK usage field) */
  costUnits: number;

  /** Request latency in milliseconds */
  latencyMs: number;

  /** Unix timestamp (seconds) */
  timestamp: number;

  /** Unique request identifier */
  requestId: string;

  /** User identifier (pseudonymous ID for circuit) */
  userId: bigint;

  /** Anti-replay nonce (monotonic per user) */
  nonce: bigint;

  /**
   * Tenant identifier (ADR-0204 — multi-tenant isolation).
   * Optional for backward compatibility with v1 academic slice.
   * Required in enterprise deployments via Proxy.
   */
  tenantId?: string;

  /**
   * CU weights version active at ingestion time (ADR-0203 STARTUP.S0).
   * Stamped from cwRuntime at POST /receipts. 'static' when no CW JSON loaded.
   * Included in canonicalHash() binding — auditors can reconstruct the weight regime.
   */
  cwVersion?: string;

  /** Optional session/context metadata */
  metadata?: {
    sessionId?: string;
    endpoint?: string;
    tags?: string[];
  };
}

/**
 * ZK Receipt (on-chain, proven)
 *
 * Minimal receipt compatible with metering_v1.circom circuit.
 * Verified via Groth16 verifier on-chain.
 */
export interface ZKReceipt {
  /** Poseidon commitment: hash(userId, usage, nonce, epoch) */
  commitment: bigint;

  /** Time epoch (derived from timestamp / EPOCH_WINDOW_SECONDS) */
  epoch: bigint;

  /** Maximum allowed usage for this epoch (public constraint) */
  maxUsage: bigint;

  /** Groth16 proof components (a, b, c from snarkjs) */
  proof: {
    pi_a: [bigint, bigint];
    pi_b: [[bigint, bigint], [bigint, bigint]];
    pi_c: [bigint, bigint];
  };
}

/**
 * Signature for RawReceipt
 *
 * ECDSA signature over canonical hash of raw receipt.
 * Provides authenticity without requiring ZK proof of all fields.
 */
export interface ReceiptSignature {
  /** Canonical hash of raw receipt (keccak256) */
  rawHash: string;

  /** ECDSA recovery id (0 or 1, +27 for legacy Ethereum) */
  v: number;

  /** ECDSA signature component r */
  r: string;

  /** ECDSA signature component s */
  s: string;

  /** Signer address (recovered from signature) */
  signer: string;
}

/**
 * Dual Receipt (Hybrid MVP)
 *
 * Combines raw receipt (full data + signature) with ZK receipt (minimal + proof).
 * This is the canonical structure for U8.5+ receipt submissions.
 */
export interface DualReceipt {
  /** Full provider event data */
  raw: RawReceipt;

  /** ECDSA signature over raw receipt */
  signature: ReceiptSignature;

  /** ZK-proven minimal receipt */
  zk: ZKReceipt;
}

/**
 * ZK Receipt v2 (on-chain, proven — metering_v2.circom range proof)
 *
 * Extends v1 ZKReceipt with dual bucket bounds (range proof).
 * Verified via MeteringVerifierV2MPC on-chain (MPC ceremony keys).
 *
 * pubSignals canonical order (Groth16 output-first):
 *   [0] commitment        — Poseidon(userId, usage, nonce, epoch)
 *   [1] epoch             — time window
 *   [2] minUsageBucket    — lower bound (inclusive, public)
 *   [3] maxUsageBucket    — upper bound (inclusive, public)
 *
 * @since Wave 5 (W5-5A01 / S6.1)
 */
export interface ZKReceiptV2 {
  /** Poseidon commitment: hash(userId, usage, nonce, epoch) */
  commitment: bigint;

  /** Time epoch (derived from timestamp / EPOCH_WINDOW_SECONDS) */
  epoch: bigint;

  /** Lower usage bucket bound (public — range proof lower constraint) */
  minUsageBucket: bigint;

  /** Upper usage bucket bound (public — range proof upper constraint) */
  maxUsageBucket: bigint;

  /** Groth16 proof components (a, b, c from snarkjs) */
  proof: {
    pi_a: [bigint, bigint];
    pi_b: [[bigint, bigint], [bigint, bigint]];
    pi_c: [bigint, bigint];
  };
}

/**
 * Dual Receipt v2 (Raw + ZKv2 range proof)
 *
 * Canonical structure for ReceiptRegistryV2 submissions.
 *
 * @since Wave 5 (W5-5A01 / S6.1)
 */
export interface DualReceiptV2 {
  /** Full provider event data */
  raw: RawReceipt;

  /** ECDSA signature over raw receipt */
  signature: ReceiptSignature;

  /** ZK range-proof receipt (metering_v2.circom) */
  zk: ZKReceiptV2;
}

/**
 * Compute bucket bounds for a given usage value.
 *
 * Assigns usage to a bucket of size `step` aligned to multiples of `step`.
 * Example: usage=500, step=300 → bucket [301, 600]
 *
 * @param usage   Actual usage value (must fit in bucket)
 * @param step    Bucket width (default 300 CU — matches ADR-0101 example)
 * @returns       { minUsageBucket, maxUsageBucket }
 */
export function deriveBuckets(usage: bigint, step = 300n): { minUsageBucket: bigint; maxUsageBucket: bigint } {
  const bucketIndex = usage / step;               // floor division
  const minUsageBucket = bucketIndex * step + 1n; // lower bound (exclusive-of-zero)
  const maxUsageBucket = (bucketIndex + 1n) * step;
  return { minUsageBucket, maxUsageBucket };
}

/**
 * Binding Constants (Dual Receipt Model)
 *
 * Deterministic mapping from RawReceipt fields to ZK circuit inputs.
 */
export const RECEIPT_CONSTANTS = {
  /** Epoch window in seconds (e.g., 3600 = 1 hour epochs) */
  EPOCH_WINDOW_SECONDS: 3600,

  /** Circuit version (matches metering_v1.circom) */
  CIRCUIT_VERSION: 1,

  /** Signature domain separator (EIP-712 style, for future use) */
  DOMAIN_SEPARATOR: 'OTK-ZK-METERING-V1',
} as const;

/**
 * Derive epoch from timestamp
 *
 * @param timestamp Unix timestamp in seconds
 * @returns Epoch number (floor division by EPOCH_WINDOW_SECONDS)
 */
export function deriveEpoch(timestamp: number): bigint {
  return BigInt(Math.floor(timestamp / RECEIPT_CONSTANTS.EPOCH_WINDOW_SECONDS));
}

/**
 * Derive ZK usage from raw receipt
 *
 * MVP mapping: usage = costUnits
 *
 * @param raw Raw receipt
 * @returns Usage value for ZK circuit
 */
export function deriveUsage(raw: RawReceipt): bigint {
  return BigInt(raw.costUnits);
}
