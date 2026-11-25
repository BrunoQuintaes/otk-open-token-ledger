/**
 * Static cross-check vectors for v3 (front A → C/S4). TEST ONLY.
 *
 * Everything here is deterministic on purpose so C and S4 can assert exact values:
 *   - the operator key is derived from a PUBLIC seed string (never use it outside tests);
 *   - the opening's blinding and salt are FIXED constants — an operational opening must come from
 *     newCommitmentOpening (CSPRNG); a fixed blinding is acceptable only inside test vectors.
 *
 * Regenerate: npx tsx test/fixtures/d1d8/a/v3Vectors.ts --write   (checked by d1d8_a_vectors.test.ts)
 *
 * `computeVectors` recomputes, from {@link receiptFixture} and the v3 library in `src/zk/v3`, the receipt and
 * conference digests and signatures, the commitment, the operation reference, the bucket and the signed public
 * authorization. The unit test compares them with `v3_vectors.json`; the Hardhat registry test reads the same JSON.
 * Importing this module has no side effect; only running it with `--write` overwrites `v3_vectors.json` next to it.
 *
 * @module test/fixtures/d1d8/a/v3Vectors
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import type { ChainDomain, CommitmentOpening } from '../../../../src/types/d1d8/index.js';
import {
  bucketForReceipt, commitmentOf, createKeyRing, createPublicAuthorizationBuilder, createReceiptCrypto, digestConferenceV1, digestReceiptV3,
  operationRefOfOpening, PUBLIC_BUCKET_POLICY_FIXED_1000CU, REGISTRY_V3_SCHEMA,
} from '../../../../src/zk/v3/index.js';
import { conferenceFixture, receiptFixture } from './receiptFixture.js';

/** Public seed string; the vector operator's private key is `ethers.id(VECTOR_KEY_SEED)` (TEST ONLY). */
export const VECTOR_KEY_SEED = 'otk-d1d8-a-public-test-vector-key-v1 (TEST ONLY, public seed)';
/** Circuit identifier recorded in the vector receipt, opening and authorization (`metering_v3@sha256:<hex>`). */
export const VECTOR_CIRCUIT_ID = 'metering_v3@sha256:11ae0c5394ace052a71f7f633dadf3fed3284620565908c5bb873065a6a4ec32';
/** Hardhat in-process default deployer: nonce 0 → verifier, nonce 1 → registry (see the Hardhat test). */
export const VECTOR_DOMAIN: ChainDomain = {
  chainId: 31337n,
  registry: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  verifier: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  schemaVersion: REGISTRY_V3_SCHEMA,
};

/**
 * The fixed opening of the vector (TEST ONLY).
 *
 * @param key - Tenant and operation the opening belongs to; copied, not kept by reference.
 * @returns A new opening with usage 640 CU (640_000_000 units at scale 1_000_000) and fixed blinding, user
 *   reference, epoch and salt.
 */
export function vectorOpening(key: { tenantId: string; operationId: string }): CommitmentOpening {
  return {
    schema: 'otk.opening.v1',
    key: { ...key },
    circuitId: VECTOR_CIRCUIT_ID,
    usage: { units: 640_000_000n, scale: 1_000_000n },
    blinding: '1234567890123456789012345678901234567890', // FIXED — test vector only
    privateInputs: { userRef: '42', epoch: '497443', opRefSalt: '987654321987654321987654321' }, // FIXED — test vector only
    createdAt: '2026-09-30T19:00:00.500Z',
  };
}

/**
 * Computes the full v3 cross-check vector set deterministically (fixed key, opening and clock).
 *
 * @returns A JSON-ready object (bigints as decimal strings) with the operator address, chain domain, receipt and
 *   conference digests and signatures, commitment, operation reference, bucket, authorization fields, digest and
 *   signature, and the four public signals `[commitment, epoch, bucketMin, bucketMax]`. Writes nothing.
 */
export async function computeVectors() {
  const wallet = new ethers.Wallet(ethers.id(VECTOR_KEY_SEED));
  const ring = createKeyRing([{ keyId: 'vector-op-1', address: wallet.address as `0x${string}`, status: 'active' }]);
  const rc = createReceiptCrypto({ keyRing: ring, signer: { keyId: 'vector-op-1', wallet }, now: () => new Date('2026-09-30T19:00:03.000Z') });
  const r = receiptFixture({ circuitId: VECTOR_CIRCUIT_ID, cuUnits: 640n, operationId: 'op-vector-1' });
  const opening = vectorOpening(r.key);
  r.publicCommitment = await commitmentOf(opening);
  const receiptEnv = await rc.signReceipt(r);
  const rep = conferenceFixture(digestReceiptV3(r), r.key);
  const conferenceEnv = await rc.signConference(rep);
  const build = createPublicAuthorizationBuilder({ keyRing: ring, signer: { keyId: 'vector-op-1', wallet }, policy: PUBLIC_BUCKET_POLICY_FIXED_1000CU, circuitId: VECTOR_CIRCUIT_ID });
  const auth = await build({ receipt: r, opening, domain: VECTOR_DOMAIN, bucket: bucketForReceipt(r, PUBLIC_BUCKET_POLICY_FIXED_1000CU) });
  return {
    note: 'TEST ONLY. Operator key = ethers.id(seed); fixed blinding/salt. Never use these values operationally.',
    seed: VECTOR_KEY_SEED,
    operatorAddress: wallet.address,
    circuitId: VECTOR_CIRCUIT_ID,
    domain: { ...VECTOR_DOMAIN, chainId: VECTOR_DOMAIN.chainId.toString() },
    receiptDigest: digestReceiptV3(r),
    receiptEnvelopeSignature: receiptEnv.signature,
    conferenceDigest: digestConferenceV1(rep),
    conferenceEnvelopeSignature: conferenceEnv.signature,
    commitment: auth.commitment,
    operationRef: operationRefOfOpening(opening),
    bucket: { min: auth.bucket.min.toString(), max: auth.bucket.max.toString(), policyVersion: auth.bucket.policyVersion },
    authorizationFields: auth.fields,
    authorizationDigest: auth.authorizationDigest,
    authorizationSignature: auth.signature.signature,
    publicSignals: [auth.commitment, auth.epoch.toString(), auth.bucket.min.toString(), auth.bucket.max.toString()],
  };
}

/** Absolute path of the committed vector file `v3_vectors.json`, in the same folder as this module. */
export const VECTORS_PATH = path.join(import.meta.dirname, 'v3_vectors.json');

if (process.argv.includes('--write')) {
  const v = await computeVectors();
  writeFileSync(VECTORS_PATH, JSON.stringify(v, null, 2) + '\n');
  console.log(`wrote ${VECTORS_PATH}`);
}
