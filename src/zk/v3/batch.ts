/**
 * BuildBatchStatementFn for BatchRegistryV3 (D1 §5, D1-G05, R21).
 *
 * Every member is checked off-chain BEFORE the root is built: its EIP-712 signature (always) and,
 * when a proof bundle is given for every member, the Groth16 proof and its public signals. The
 * declared level says which of the two happened. The registry only stores root, cardinality and
 * the declared level; it does not verify N proofs, and nothing may claim that it does.
 *
 * @module src/zk/v3/batch
 */
import { ethers } from 'ethers';
import type { BatchStatement, BuildBatchStatementFn, ChainDomain, ProofAdapter } from '../../types/d1d8/index.js';
import type { KeyRing } from '../../receipt/v3/keyRing.js';
import { merkleRoot, type Bytes32 } from '../../crypto/merkleV3.js';
import { BATCH_TYPES, BATCH_V3_NAME, BATCH_V3_SCHEMA, batchDigest, MEMBER_VALIDATION_CODE, recoverDigestSigner, typedDomain } from './eip712.js';
import { verifyPublicAuthorization, type AuthorizationExpectation } from './publicAuthorization.js';
import { expectedPublicSignals } from './proofAdapter.js';

/**
 * Options of {@link createBatchStatementBuilder}.
 */
export interface BatchBuilderOptions {
  keyRing: KeyRing;
  signer: { keyId: string; wallet: ethers.Signer };
  /** Needed to verify member proofs; without it a batch can only be 'signature_each'. */
  adapter?: ProofAdapter;
  /** Circuit and policy the members must satisfy (same checks as ReceiptRegistryV3). */
  expect: AuthorizationExpectation;
}

/**
 * Leaves of a batch, in member order: each member's authorizationDigest.
 *
 * @param members - Batch members.
 * @returns Their authorization digests, in order.
 */
export function batchLeaves(members: Array<{ auth: { authorizationDigest: string } }>): Bytes32[] {
  return members.map((m) => m.auth.authorizationDigest as Bytes32);
}

/**
 * Creates the function that checks every member and signs a batch statement (Merkle root of the members).
 *
 * The returned function rejects with an `Error` when the domain version is wrong, the batch is empty, a member
 * is rejected, on another chain, duplicated or with a proof that does not verify, or the signing key is not
 * active. `signedAt` is the current time.
 *
 * @param opts - Key ring, signer, optional proof adapter and the expected circuit and policy.
 * @returns The batch statement builder.
 */
export function createBatchStatementBuilder(opts: BatchBuilderOptions): BuildBatchStatementFn {
  return async ({ domain, members }: Parameters<BuildBatchStatementFn>[0]): Promise<BatchStatement> => {
    if (domain.schemaVersion !== BATCH_V3_SCHEMA) throw new Error(`batch domain.schemaVersion must be ${BATCH_V3_SCHEMA}`);
    if (members.length === 0) throw new Error('empty batch');
    const seen = new Set<string>();
    let allProofs = true;
    for (const [i, m] of members.entries()) {
      const r = verifyPublicAuthorization(m.auth, opts.keyRing, opts.expect);
      if (!r.ok) throw new Error(`member ${i}: authorization rejected (${r.reason})`);
      if (m.auth.domain.chainId !== domain.chainId) throw new Error(`member ${i}: other chain`);
      const d = m.auth.authorizationDigest.toLowerCase();
      if (seen.has(d)) throw new Error(`member ${i}: duplicate authorization`);
      seen.add(d);
      if (!m.bundle) { allProofs = false; continue; }
      if (!opts.adapter) throw new Error('proof bundles given but no adapter to verify them');
      const exp = expectedPublicSignals(m.auth);
      if (m.bundle.publicSignals.length !== exp.length || m.bundle.publicSignals.some((s, k) => s !== exp[k])) throw new Error(`member ${i}: proof is for other public signals`);
      if (!(await opts.adapter.verifyLocal(m.bundle))) throw new Error(`member ${i}: proof does not verify`);
    }
    const level = allProofs ? 'signature_and_proof_each' : 'signature_each';
    const epochs = members.map((m) => m.auth.epoch);
    const values = {
      root: merkleRoot(batchLeaves(members)),
      cardinality: BigInt(members.length),
      memberValidation: MEMBER_VALIDATION_CODE[level],
      firstEpoch: epochs.reduce((a, b) => (b < a ? b : a)),
      lastEpoch: epochs.reduce((a, b) => (b > a ? b : a)),
    };
    const entry = opts.keyRing.get(opts.signer.keyId);
    const address = await opts.signer.wallet.getAddress();
    if (!entry || entry.status !== 'active' || entry.address.toLowerCase() !== address.toLowerCase()) throw new Error(`key ${opts.signer.keyId} is not active for the signer`);
    const digest = batchDigest(domain, values);
    const signature = (await opts.signer.wallet.signTypedData(typedDomain(domain, BATCH_V3_NAME), BATCH_TYPES as never, values)) as `0x${string}`;
    if (recoverDigestSigner(digest, signature)?.toLowerCase() !== address.toLowerCase()) throw new Error('batch signature does not recover');
    return {
      domain: { ...domain } as ChainDomain,
      root: values.root,
      cardinality: values.cardinality,
      memberValidation: level,
      firstEpoch: values.firstEpoch,
      lastEpoch: values.lastEpoch,
      signature: {
        schema: 'otk.envelope.v1', domain: 'OTK_BATCH_V1', payloadDigest: digest, alg: 'eip712-secp256k1',
        signer: address as `0x${string}`, keyId: entry.keyId, signature, signedAt: new Date().toISOString(),
      },
    };
  };
}
