/**
 * EIP-712 types shared byte-for-byte with tools/hardhat/contracts/v3/*.sol (D1-G01).
 * Any change here is a new schemaVersion and a new contract; never edit in place.
 */
import { ethers } from 'ethers';
import type { ChainDomain, Hex32 } from '../../types/d1d8/index.js';

export const REGISTRY_V3_NAME = 'OTK ReceiptRegistryV3';
export const REGISTRY_V3_SCHEMA = 'otk.registry.v3';
export const BATCH_V3_NAME = 'OTK BatchRegistryV3';
export const BATCH_V3_SCHEMA = 'otk.batch.v3';

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

export interface BatchValues {
  root: Hex32;
  cardinality: bigint;
  memberValidation: number;
  firstEpoch: bigint;
  lastEpoch: bigint;
}

export const MEMBER_VALIDATION_CODE = { none_declared: 0, signature_each: 1, signature_and_proof_each: 2 } as const;

export function typedDomain(d: ChainDomain, name: string): ethers.TypedDataDomain {
  return { name, version: d.schemaVersion, chainId: d.chainId, verifyingContract: d.registry };
}

export function circuitIdHash(circuitId: string): Hex32 {
  return ethers.keccak256(ethers.toUtf8Bytes(circuitId)) as Hex32;
}

export function authorizationDigest(d: ChainDomain, v: AuthorizationValues): Hex32 {
  return ethers.TypedDataEncoder.hash(typedDomain(d, REGISTRY_V3_NAME), AUTHORIZATION_TYPES as never, v) as Hex32;
}

export function batchDigest(d: ChainDomain, v: BatchValues): Hex32 {
  return ethers.TypedDataEncoder.hash(typedDomain(d, BATCH_V3_NAME), BATCH_TYPES as never, v) as Hex32;
}

/** Recovers the signer of an EIP-712 digest; null if the signature is unparsable or high-s. */
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
