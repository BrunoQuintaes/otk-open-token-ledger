/**
 * SignatureManager — ECDSA Signing for Raw Receipts
 *
 * Provides cryptographic authentication for RawReceipts using ECDSA signatures.
 * Implements canonical serialization + keccak256 hashing + ethers.js signing.
 *
 * Part of Dual Receipt Model (ADR-0003).
 *
 * Used by the SDK (`src/sdk/OTKSDK.ts`), the receipt-v3 crypto helpers and the benchmark/demo scripts.
 * It also re-exports the V1 canonical-receipt encoder for callers that import from here. It reads no
 * environment variables and holds no key: the caller passes the signer. It signs the legacy raw-receipt
 * hash only; it does not build or sign canonical V2/V3 receipts.
 *
 * @module src/metering/SignatureManager
 */

import { ethers } from 'ethers';
import type { RawReceipt, ReceiptSignature } from '../types/receipt.js';
// U2.4: V1 encoder (non-breaking — V0 is still the default for existing code)
export type { CanonicalReceiptV1 } from '../receipt/canonicalReceiptV1.js';
export { hashCanonicalReceiptV1, encodeCanonicalReceiptV1Bytes } from '../receipt/canonicalReceiptV1.js';

/**
 * Canonical hash of RawReceipt
 *
 * Deterministic serialization order for signature stability:
 * - All fields in fixed order (alphabetical by field name)
 * - BigInt values as hex strings (0x-prefixed)
 * - Nested objects flattened or excluded (metadata is optional)
 *
 * Pure: the input is not mutated. Changing the field list or order changes every hash and breaks
 * verification of receipts signed before the change.
 *
 * @param raw - Raw receipt to hash
 * @returns Keccak256 hash (0x-prefixed hex string)
 */
export function canonicalHash(raw: RawReceipt): string {
  // Serialize in deterministic order (field name alphabetical)
  const parts = [
    `costUnits:${raw.costUnits}`,
    `cwVersion:${raw.cwVersion ?? 'none'}`,
    `inputTokens:${raw.inputTokens}`,
    `latencyMs:${raw.latencyMs}`,
    `model:${raw.model}`,
    `nonce:${raw.nonce.toString()}`,
    `outputTokens:${raw.outputTokens}`,
    `provider:${raw.provider}`,
    `requestId:${raw.requestId}`,
    `timestamp:${raw.timestamp}`,
    `userId:${raw.userId.toString()}`,
  ];

  // Join with separator (newline for readability in debugging)
  const canonical = parts.join('\n');

  // Keccak256 hash (Ethereum-compatible)
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}

/**
 * Sign a RawReceipt
 *
 * Signs the 32-byte canonical hash as an EIP-191 personal message (see the note in the body).
 *
 * @param raw - Raw receipt to sign
 * @param signer - Ethers.js Wallet or Signer instance
 * @returns Receipt signature with v, r, s components
 * @throws {Error} When the signer cannot sign or report its address (errors from ethers propagate).
 */
export async function sign(
  raw: RawReceipt,
  signer: ethers.Wallet | ethers.Signer
): Promise<ReceiptSignature> {
  // Compute canonical hash
  const rawHash = canonicalHash(raw);

  // Sign the hash (ethers.js handles message hashing internally)
  // IMPORTANT: We use signMessage which prepends "\x19Ethereum Signed Message:\n32"
  // For on-chain verification, Registry must use ECDSA.recover with same prefix
  const rawHashBytes = ethers.getBytes(rawHash);
  const signature = await signer.signMessage(rawHashBytes);

  // Parse signature into v, r, s components
  const sig = ethers.Signature.from(signature);

  // Get signer address
  const signerAddress = await signer.getAddress();

  return {
    rawHash,
    v: sig.v,
    r: sig.r,
    s: sig.s,
    signer: signerAddress,
  };
}

/**
 * Verify a RawReceipt signature
 *
 * Never throws: any parsing or recovery error is logged to the console and returns `false`.
 * Address comparison is case-insensitive.
 *
 * @param raw - Raw receipt (must match the signed data)
 * @param signature - Signature to verify
 * @param expectedSigner - Expected signer address (optional; if provided, must match)
 * @returns True if signature is valid and matches expectedSigner (if provided)
 */
export function verify(
  raw: RawReceipt,
  signature: ReceiptSignature,
  expectedSigner?: string
): boolean {
  try {
    // Recompute canonical hash
    const computedHash = canonicalHash(raw);

    // Hash must match signature's rawHash
    if (computedHash !== signature.rawHash) {
      return false;
    }

    // Recover signer from signature
    const rawHashBytes = ethers.getBytes(signature.rawHash);
    const recoveredAddress = ethers.recoverAddress(
      ethers.hashMessage(rawHashBytes),
      {
        r: signature.r,
        s: signature.s,
        v: signature.v,
      }
    );

    // Verify recovered address matches signature.signer
    if (recoveredAddress.toLowerCase() !== signature.signer.toLowerCase()) {
      return false;
    }

    // If expectedSigner provided, must match
    if (expectedSigner) {
      return recoveredAddress.toLowerCase() === expectedSigner.toLowerCase();
    }

    return true;
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Create a deterministic test signer (ONLY for testing, NOT for production)
 *
 * The private key is keccak256 of the seed, so anyone who knows the seed knows the key.
 *
 * @param seed - Deterministic seed string
 * @returns Ethers.js Wallet instance
 */
export function createTestSigner(seed: string): ethers.Wallet {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(seed));
  return new ethers.Wallet(hash);
}
