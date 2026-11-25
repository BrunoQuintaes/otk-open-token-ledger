/**
 * BuildPublicAuthorizationFn for ReceiptRegistryV3 (D1 §2–4, D2).
 *
 * The authorization is the ONLY thing the operator signs for the public registry. Its digest is
 * EIP-712 over exactly the arguments the contract receives, so the contract recomputes it (R16):
 * a legitimate signature cannot authorize other values, another contract, chain or version.
 *
 * Before signing, the private side is cross-checked: same operation key, same circuit as the
 * frozen config, opening usage equal to the receipt's exact CU, epoch from admittedAt, userRef,
 * policy window, and receipt.publicCommitment equal to the opening's commitment. Any mismatch
 * throws: a public record is never produced for data that does not match its private receipt.
 *
 * @module src/zk/v3/publicAuthorization
 */
import { ethers } from 'ethers';
import type {
  BuildPublicAuthorizationFn, ChainDomain, CommitmentOpening, PrivateReceiptV3, PublicAuthorization, PublicBucket, VerifyResult,
} from '../../types/d1d8/index.js';
import type { KeyRing } from '../../receipt/v3/keyRing.js';
import { bucketFor, bucketPolicyId, bucketPolicyRef, type FixedWidthBucketPolicy } from '../../privacy/publicBucketPolicy.js';
import {
  AUTHORIZATION_FIELD_ORDER, authorizationDigest, circuitIdHash, recoverDigestSigner, REGISTRY_V3_NAME, REGISTRY_V3_SCHEMA,
  typedDomain, AUTHORIZATION_TYPES, type AuthorizationValues,
} from './eip712.js';
import { commitmentOf, epochOf, openingValues, operationRefOf, usageToCircuitUnits } from './opening.js';

/**
 * Raised when the private data does not match what a public authorization would state.
 */
export class AuthorizationBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationBindingError';
  }
}

/**
 * Options of {@link createPublicAuthorizationBuilder}.
 */
export interface PublicAuthorizationBuilderOptions {
  keyRing: KeyRing;
  signer: { keyId: string; wallet: ethers.Signer };
  policy: FixedWidthBucketPolicy;
  /** Circuit this builder produces authorizations for (must match receipt.config.circuitId). */
  circuitId: string;
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new AuthorizationBindingError(msg);
}

function sameBucket(a: PublicBucket, b: PublicBucket): boolean {
  return a.min === b.min && a.max === b.max && a.policyVersion === b.policyVersion;
}

/**
 * Window the policy assigns to a receipt's exact usage (what C passes as `bucket`).
 *
 * @param receipt - Private receipt with computed CU.
 * @param policy - Bucket policy.
 * @returns The public bucket containing the receipt's usage.
 * @throws {@link AuthorizationBindingError} When the receipt's CU is not computed.
 */
export function bucketForReceipt(receipt: PrivateReceiptV3, policy: FixedWidthBucketPolicy): PublicBucket {
  if (receipt.cu.status !== 'computed' || !receipt.cu.cu) throw new AuthorizationBindingError(`receipt CU not computed (${receipt.cu.status})`);
  return bucketFor(policy, usageToCircuitUnits(receipt.cu.cu));
}

/**
 * Values of PublicAuthorization.fields as the EIP-712 struct.
 *
 * @param auth - Public authorization.
 * @returns The typed values.
 * @throws {@link AuthorizationBindingError} When the fields are not in the struct order.
 */
export function authorizationValues(auth: PublicAuthorization): AuthorizationValues {
  const f = new Map(auth.fields.map((x) => [x.name, x.value]));
  check(auth.fields.length === AUTHORIZATION_FIELD_ORDER.length && AUTHORIZATION_FIELD_ORDER.every((n, i) => auth.fields[i]?.name === n), 'fields must follow the Authorization struct order');
  return {
    circuitId: f.get('circuitId') as `0x${string}`,
    verifier: f.get('verifier')!,
    commitment: BigInt(f.get('commitment')!),
    epoch: BigInt(f.get('epoch')!),
    minUsage: BigInt(f.get('minUsage')!),
    maxUsage: BigInt(f.get('maxUsage')!),
    bucketPolicy: f.get('bucketPolicy') as `0x${string}`,
    operationRef: f.get('operationRef') as `0x${string}`,
  };
}

/** What the verifier expects, mirroring the immutables of the registry it targets. */
export interface AuthorizationExpectation {
  circuitId: string;
  policy: FixedWidthBucketPolicy;
}

/**
 * Off-chain check of a PublicAuthorization. Mirrors ReceiptRegistryV3.submitReceipt (except the
 * proof and the on-chain replay state): fields consistent with the typed values, digest recomputed,
 * signature recovered to an ACTIVE key of the ring and equal to the envelope's signer/keyId, circuit
 * and bucket policy as expected, window aligned and exactly one policy width wide. Authorizations of
 * retired keys are not accepted here; their historical validity is the on-chain registration.
 *
 * @param auth - Authorization to check.
 * @param keyRing - Operator keys.
 * @param expect - Expected circuit and bucket policy.
 * @returns `ok` with the signer, or the failure reason; never throws.
 */
export function verifyPublicAuthorization(auth: PublicAuthorization, keyRing: KeyRing, expect: AuthorizationExpectation): VerifyResult {
  let v: AuthorizationValues;
  try { v = authorizationValues(auth); } catch (e) { return { ok: false, reason: 'malformed', detail: (e as Error).message }; }
  if (auth.schema !== 'otk.public_authorization.v1' || auth.domain.schemaVersion !== REGISTRY_V3_SCHEMA) return { ok: false, reason: 'unsupported_version' };
  if (auth.signature?.domain !== 'OTK_PUBLIC_AUTHORIZATION_V1') return { ok: false, reason: 'wrong_domain' };
  if (auth.signature.alg !== 'eip712-secp256k1') return { ok: false, reason: 'unsupported_version', detail: 'alg' };
  if (v.commitment.toString() !== auth.commitment || v.epoch !== auth.epoch || v.minUsage !== auth.bucket.min || v.maxUsage !== auth.bucket.max
    || v.operationRef !== auth.operationRef || v.verifier.toLowerCase() !== auth.domain.verifier.toLowerCase()
    || v.circuitId !== circuitIdHash(auth.circuitId) || auth.replayKey !== auth.operationRef) {
    return { ok: false, reason: 'binding_mismatch', detail: 'typed fields differ from the authorization summary' };
  }
  if (auth.circuitId !== expect.circuitId) return { ok: false, reason: 'binding_mismatch', detail: 'circuit differs from the expected one' };
  if (v.bucketPolicy !== bucketPolicyId(expect.policy) || auth.bucket.policyVersion !== expect.policy.version) return { ok: false, reason: 'binding_mismatch', detail: 'bucket policy differs' };
  if (v.minUsage % expect.policy.widthUnits !== 0n || v.maxUsage !== v.minUsage + expect.policy.widthUnits - 1n) return { ok: false, reason: 'binding_mismatch', detail: 'window not aligned / not one policy width' };
  const digest = authorizationDigest(auth.domain, v);
  if (digest !== auth.authorizationDigest || auth.signature.payloadDigest !== digest) return { ok: false, reason: 'digest_mismatch' };
  const recovered = recoverDigestSigner(digest, auth.signature.signature);
  if (!recovered) return { ok: false, reason: 'bad_signature' };
  const entry = keyRing.byAddress(recovered);
  if (!entry) return { ok: false, reason: 'unauthorized_signer' };
  if (entry.status !== 'active') return { ok: false, reason: 'revoked_key', detail: `${entry.keyId} is ${entry.status}` };
  if (String(auth.signature.signer).toLowerCase() !== recovered.toLowerCase() || auth.signature.keyId !== entry.keyId) {
    return { ok: false, reason: 'binding_mismatch', detail: 'envelope signer/keyId differ from the recovered key' };
  }
  return { ok: true, signer: entry.address, keyId: entry.keyId };
}

/**
 * Creates the function that cross-checks a receipt and its opening and signs the public authorization.
 *
 * The returned function rejects with {@link AuthorizationBindingError} on any mismatch listed in the file header,
 * or when the signing key is not active for the wallet. `signedAt` is the current time.
 *
 * @param opts - Key ring, signer, bucket policy and circuit ID.
 * @returns The authorization builder.
 */
export function createPublicAuthorizationBuilder(opts: PublicAuthorizationBuilderOptions): BuildPublicAuthorizationFn {
  const policyRef = bucketPolicyRef(opts.policy);
  return async ({ receipt, opening, domain, bucket }: { receipt: PrivateReceiptV3; opening: CommitmentOpening; domain: ChainDomain; bucket: PublicBucket }) => {
    check(domain.schemaVersion === REGISTRY_V3_SCHEMA, `domain.schemaVersion must be ${REGISTRY_V3_SCHEMA}`);
    check(/^0x[0-9a-fA-F]{40}$/.test(domain.registry) && /^0x[0-9a-fA-F]{40}$/.test(domain.verifier), 'domain registry/verifier must be addresses');
    check(BigInt(domain.registry) !== 0n && BigInt(domain.verifier) !== 0n, 'zero address in domain');
    check(receipt.schema === 'otk.receipt.v3' && receipt.contentDigests === null, 'receipt must be otk.receipt.v3 without content digests');
    check(opening.key.tenantId === receipt.key.tenantId && opening.key.operationId === receipt.key.operationId, 'opening belongs to another operation');
    check(opening.circuitId === opts.circuitId && receipt.config.circuitId === opts.circuitId, 'circuit of opening/receipt config differs from this builder (explicit version selection)');
    check(receipt.config.bucketPolicy.version === policyRef.version && receipt.config.bucketPolicy.digest === policyRef.digest, 'receipt frozen bucket policy differs');
    const ov = openingValues(opening);
    const expectedBucket = bucketForReceipt(receipt, opts.policy);
    check(ov.usage === usageToCircuitUnits(receipt.cu.cu!), 'opening usage differs from receipt exact CU');
    check(ov.userRef.toString() === receipt.userRef, 'opening userRef differs from receipt');
    check(ov.epoch === epochOf(receipt.timing.admittedAt), 'opening epoch differs from receipt admittedAt hour');
    check(sameBucket(bucket, expectedBucket), 'bucket is not the policy window of this usage');
    const commitment = await commitmentOf(opening);
    check(receipt.publicCommitment === commitment, 'receipt.publicCommitment must equal the opening commitment');

    const operationRef = operationRefOf(opening.key, ov.salt);
    const values: AuthorizationValues = {
      circuitId: circuitIdHash(opts.circuitId),
      verifier: ethers.getAddress(domain.verifier),
      commitment: BigInt(commitment),
      epoch: ov.epoch,
      minUsage: bucket.min,
      maxUsage: bucket.max,
      bucketPolicy: bucketPolicyId(opts.policy),
      operationRef,
    };
    const digest = authorizationDigest(domain, values);

    const entry = opts.keyRing.get(opts.signer.keyId);
    const signerAddress = await opts.signer.wallet.getAddress();
    check(!!entry && entry.status === 'active' && entry.address.toLowerCase() === signerAddress.toLowerCase(), `key ${opts.signer.keyId} is not an active key of the signer wallet`);
    const signature = (await opts.signer.wallet.signTypedData(typedDomain(domain, REGISTRY_V3_NAME), AUTHORIZATION_TYPES as never, values)) as `0x${string}`;
    check(recoverDigestSigner(digest, signature)?.toLowerCase() === signerAddress.toLowerCase(), 'signature does not recover to the signer (high-s or encoder mismatch)');

    return {
      schema: 'otk.public_authorization.v1',
      domain: { ...domain },
      circuitId: opts.circuitId,
      commitment,
      epoch: ov.epoch,
      bucket: { ...bucket },
      operationRef,
      replayKey: operationRef,
      fields: AUTHORIZATION_FIELD_ORDER.map((name) => ({ name, value: String(values[name as keyof AuthorizationValues]) })),
      authorizationDigest: digest,
      signature: {
        schema: 'otk.envelope.v1', domain: 'OTK_PUBLIC_AUTHORIZATION_V1', payloadDigest: digest, alg: 'eip712-secp256k1',
        signer: signerAddress as `0x${string}`, keyId: entry!.keyId, signature, signedAt: new Date().toISOString(),
      },
    };
  };
}
