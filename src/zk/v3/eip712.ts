/**
 * EIP-712 types shared byte-for-byte with tools/hardhat/contracts/v3/*.sol (D1-G01).
 * Any change here is a new schemaVersion and a new contract; never edit in place.
 *
 * @module src/zk/v3/eip712
 */
import { ethers } from 'ethers';
import type { ChainDomain, Hex32 } from '../../types/d1d8/index.js';

/**
 * EIP-712 domain name of the receipt registry v3.
 */
export const REGISTRY_V3_NAME = 'OTK ReceiptRegistryV3';
/**
 * Schema version (EIP-712 domain version) of the receipt registry v3.
 */
export const REGISTRY_V3_SCHEMA = 'otk.registry.v3';
/**
 * EIP-712 domain name of the batch registry v3.
 */
export const BATCH_V3_NAME = 'OTK BatchRegistryV3';
/**
 * Schema version (EIP-712 domain version) of the batch registry v3.
 */
export const BATCH_V3_SCHEMA = 'otk.batch.v3';

/**
 * EIP-712 type of a public authorization (field order is part of the signature).
 */
export const AUTHORIZATION_TYPES = {
  Authorization: [
    { name: 'circuitId', type: 'bytes32' },
    { name: 'verifier', type: 'address' },
    { name: 'commitment', type: 'uint256' },
    { name: 'epoch', type: 'uint64' },
    { name: 'minUsage', type: 'uint64' },
    { name: 'maxUsage', type: 'uint64' },
    { name: 'bucketPolicy', type: 'bytes32' },
    { name: 'operationRef', type: 'bytes32' },
  ],
} as const;

/**
 * EIP-712 type of a batch statement.
 */
export const BATCH_TYPES = {
  BatchStatement: [
    { name: 'root', type: 'bytes32' },
    { name: 'cardinality', type: 'uint64' },
    { name: 'memberValidation', type: 'uint8' },
    { name: 'firstEpoch', type: 'uint64' },
    { name: 'lastEpoch', type: 'uint64' },
  ],
} as const;

/** Order of PublicAuthorization.fields and of the Solidity struct. */
export const AUTHORIZATION_FIELD_ORDER = AUTHORIZATION_TYPES.Authorization.map((f) => f.name);

/**
 * Values of the EIP-712 Authorization struct.
 */
export interface AuthorizationValues {
  circuitId: Hex32;
  verifier: string;
  commitment: bigint;
  epoch: bigint;
  minUsage: bigint;
  maxUsage: bigint;
  bucketPolicy: Hex32;
  operationRef: Hex32;
}

/**
 * Values of the EIP-712 BatchStatement struct.
 */
export interface BatchValues {
  root: Hex32;
  cardinality: bigint;
  memberValidation: number;
  firstEpoch: bigint;
  lastEpoch: bigint;
}

/**
 * On-chain code of the member validation level declared by a batch.
 */
export const MEMBER_VALIDATION_CODE = { none_declared: 0, signature_each: 1, signature_and_proof_each: 2 } as const;

/**
 * EIP-712 domain for a chain domain and contract name.
 *
 * @param d - Chain ID, registry address and schema version.
 * @param name - Contract domain name.
 * @returns The typed-data domain.
 */
export function typedDomain(d: ChainDomain, name: string): ethers.TypedDataDomain {
  return { name, version: d.schemaVersion, chainId: d.chainId, verifyingContract: d.registry };
}

/**
 * Hash of a circuit ID as stored in the Authorization struct.
 *
 * @param circuitId - Circuit ID text.
 * @returns keccak256 of its UTF-8 bytes.
 */
export function circuitIdHash(circuitId: string): Hex32 {
  return ethers.keccak256(ethers.toUtf8Bytes(circuitId)) as Hex32;
}

/**
 * EIP-712 digest of a public authorization.
 *
 * @param d - Chain domain.
 * @param v - Authorization values.
 * @returns The digest the operator signs and the registry recomputes.
 */
export function authorizationDigest(d: ChainDomain, v: AuthorizationValues): Hex32 {
  return ethers.TypedDataEncoder.hash(typedDomain(d, REGISTRY_V3_NAME), AUTHORIZATION_TYPES as never, v) as Hex32;
}

/**
 * EIP-712 digest of a batch statement.
 *
 * @param d - Chain domain.
 * @param v - Batch values.
 * @returns The digest.
 */
export function batchDigest(d: ChainDomain, v: BatchValues): Hex32 {
  return ethers.TypedDataEncoder.hash(typedDomain(d, BATCH_V3_NAME), BATCH_TYPES as never, v) as Hex32;
}

/**
 * Recovers the signer of an EIP-712 digest; null if the signature is unparsable or high-s.
 *
 * @param digest - 32-byte digest.
 * @param signature - 65-byte signature (hex).
 * @returns The recovered address (checksummed), or `null`.
 */
export function recoverDigestSigner(digest: string, signature: string): string | null {
  try {
    const sig = ethers.Signature.from(signature);
    // The registry rejects high-s signatures; mirror it so off-chain checks never accept more.
    if (BigInt(sig.s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n) return null;
    return ethers.recoverAddress(digest, sig);
  } catch {
    return null;
  }
}
