/**
 * Public bucket policy for metering_v3 registrations (D2 §4).
 *
 * The public interval is a fixed-width, aligned window of a versioned policy: every usage in the
 * same window publishes the same [min, max]. It is never tuned per receipt (that would reveal the
 * usage) and it never feeds accounting: quotas and billing use the exact private CU.
 *
 * Unlike the legacy helpers in ./bucketing.ts (quantizeToBucket/bucketBounds, kept unchanged for
 * existing callers), the receiptStore path of v2 published `min = usage`; this policy does not.
 *
 * Width 1 000 CU is an experimental candidate, not a promise of indistinguishability: an observer
 * still learns the window index, the hour (epoch) and how many registrations happen.
 */
import { ethers } from 'ethers';
import type { PublicBucket, VersionRef } from '../types/d1d8/index.js';
import { domainDigest } from '../receipt/v3/canonicalEncoding.js';

export interface FixedWidthBucketPolicy {
  /** Unique id of this exact parameter set; the registry stores keccak256(utf8(version)). */
  version: string;
  /** Circuit units per CU (metering_v3 uses micro-CU). */
  unitScale: bigint;
  /** Window width in circuit units. */
  widthUnits: bigint;
}

/** 1 000 CU windows over micro-CU units: [k·10⁹, k·10⁹ + 10⁹ − 1]. */
export const PUBLIC_BUCKET_POLICY_FIXED_1000CU: FixedWidthBucketPolicy = Object.freeze({
  version: 'otk.public_bucket.fixed@1:width=1000CU:unit=microCU',
  unitScale: 1_000_000n,
  widthUnits: 1_000_000_000n,
});

const U64_MAX = (1n << 64n) - 1n;

export function bucketFor(policy: FixedWidthBucketPolicy, usageUnits: bigint): PublicBucket {
  if (policy.widthUnits <= 0n) throw new Error('bucket policy width must be > 0');
  if (usageUnits < 0n) throw new Error('usage must be non-negative');
  const min = (usageUnits / policy.widthUnits) * policy.widthUnits;
  const max = min + policy.widthUnits - 1n;
  if (max > U64_MAX) throw new Error('usage outside the range representable by this bucket policy (2^64 circuit units)');
  return { min, max, policyVersion: policy.version };
}

/** Identity of the policy for FrozenConfigRef.bucketPolicy (digest of its CE1 definition). */
export function bucketPolicyRef(policy: FixedWidthBucketPolicy): VersionRef {
  return { version: policy.version, digest: domainDigest('OTK_BUCKET_POLICY_V1', { ...policy }) };
}

/** bytes32 the registry stores and every authorization carries. */
export function bucketPolicyId(policy: FixedWidthBucketPolicy): `0x${string}` {
  return ethers.keccak256(ethers.toUtf8Bytes(policy.version)) as `0x${string}`;
}
