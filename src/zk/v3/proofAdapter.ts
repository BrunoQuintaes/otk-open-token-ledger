/**
 * ProofAdapter for metering_v3 + ReceiptRegistryV3 (D1 §7, D6-G01/G02).
 *
 * Construction refuses a combination that does not match the artifact manifest: wasm, zkey and
 * vkey bytes are hashed and compared, and the verification key embedded in the zkey must equal
 * the vkey file. A new zkey with an old vkey/verifier therefore fails before any proof is made.
 *
 * Public signals, in this exact order (C never reorders):
 *   [0] commitment  [1] epoch  [2] minUsage  [3] maxUsage
 *
 * ProofBundle.proof is in the Solidity verifier layout (pi_b coordinates swapped per G2 element).
 *
 * Reads the circuit artifacts (wasm, zkey, vkey) from disk once, when the adapter is created.
 *
 * @module src/zk/v3/proofAdapter
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { groth16, zKey } from 'snarkjs';
import type { CommitmentOpening, Hex32, ProofAdapter, ProofBundle, PublicAuthorization } from '../../types/d1d8/index.js';
import { openingValues } from './opening.js';
import { authorizationValues } from './publicAuthorization.js';

/**
 * Public signals of metering_v3, in circuit order.
 */
export const METERING_V3_PUBLIC_SIGNALS = ['commitment', 'epoch', 'minUsage', 'maxUsage'] as const;

/**
 * ABI fragments of the receipt registry v3 used by the operator.
 */
export const REGISTRY_V3_SUBMIT_ABI = [
  'function submitReceipt((bytes32 circuitId, address verifier, uint256 commitment, uint64 epoch, uint64 minUsage, uint64 maxUsage, bytes32 bucketPolicy, bytes32 operationRef) auth, bytes signature, (uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[4] pubSignals) proof) external',
  'function registeredDigest(bytes32 operationRef) view returns (bytes32)',
  'function hashAuthorization((bytes32 circuitId, address verifier, uint256 commitment, uint64 epoch, uint64 minUsage, uint64 maxUsage, bytes32 bucketPolicy, bytes32 operationRef) auth) view returns (bytes32)',
] as const;

/**
 * Paths and expected SHA-256 digests of the metering_v3 artifacts.
 */
export interface ProofArtifactsV3 {
  circuitId: string;
  wasmPath: string;
  zkeyPath: string;
  vkeyPath: string;
  /** sha256 of each file as recorded in the manifest (0x-prefixed hex). */
  expected: { wasm: Hex32; zkey: Hex32; vkey: Hex32 };
}

/**
 * Raised when the circuit artifacts do not match the manifest or each other.
 */
export class ArtifactMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactMismatchError';
  }
}

/**
 * SHA-256 of a file (synchronous read).
 *
 * @param p - File path.
 * @returns `0x`-prefixed hex digest.
 * @throws {Error} When the file cannot be read.
 */
export function sha256File(p: string): Hex32 {
  return ('0x' + createHash('sha256').update(readFileSync(p)).digest('hex')) as Hex32;
}

function canonicalJson(x: unknown): string {
  return JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

type SnarkProof = { pi_a: string[]; pi_b: string[][]; pi_c: string[]; protocol: string; curve: string };

function toSolidity(p: SnarkProof): ProofBundle['proof'] {
  return {
    a: [p.pi_a[0]!, p.pi_a[1]!],
    b: [[p.pi_b[0]![1]!, p.pi_b[0]![0]!], [p.pi_b[1]![1]!, p.pi_b[1]![0]!]],
    c: [p.pi_c[0]!, p.pi_c[1]!],
  };
}

function fromSolidity(p: ProofBundle['proof']): SnarkProof {
  return {
    pi_a: [p.a[0], p.a[1], '1'],
    pi_b: [[p.b[0][1], p.b[0][0]], [p.b[1][1], p.b[1][0]], ['1', '0']],
    pi_c: [p.c[0], p.c[1], '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}

/**
 * D1-G04: after a submission timeout, read `registeredDigest(auth.operationRef)` and classify it
 * instead of sending again. 'registered_same' = this exact authorization is on chain (done, no new
 * transaction); 'registered_conflict' = another authorization used this operationRef (stop, alert);
 * 'not_registered' = safe to (re)submit the same calldata.
 *
 * @param onChainDigest - Value of `registeredDigest(operationRef)` read from the chain.
 * @param auth - Authorization that was submitted.
 * @returns The classification.
 */
export function classifyRegistration(onChainDigest: string, auth: PublicAuthorization): 'not_registered' | 'registered_same' | 'registered_conflict' {
  if (/^0x0{64}$/i.test(onChainDigest)) return 'not_registered';
  return onChainDigest.toLowerCase() === auth.authorizationDigest.toLowerCase() ? 'registered_same' : 'registered_conflict';
}

/**
 * Public signals the circuit must output for this authorization.
 *
 * @param auth - Public authorization.
 * @returns commitment, epoch, minUsage and maxUsage as decimal strings.
 */
export function expectedPublicSignals(auth: PublicAuthorization): string[] {
  return [auth.commitment, auth.epoch.toString(), auth.bucket.min.toString(), auth.bucket.max.toString()];
}

const sha256Bytes = (b: Uint8Array): Hex32 => ('0x' + createHash('sha256').update(b).digest('hex')) as Hex32;

/**
 * Creates the metering_v3 proof adapter after checking the artifacts.
 *
 * @param a - Artifact paths and expected digests.
 * @returns The adapter, with the measured artifact digests.
 * @throws {@link ArtifactMismatchError} When a digest differs from the manifest, the zkey's verification key differs
 *   from the vkey file, or the number of public signals is not 4 (rejected promise); file errors propagate.
 */
export async function createProofAdapterV3(a: ProofArtifactsV3): Promise<ProofAdapter & { readonly artifacts: ProofBundle['artifacts'] }> {
  // Bytes are read ONCE: the hashed bytes are the bytes used to prove (no later file swap).
  const wasmBytes = new Uint8Array(readFileSync(a.wasmPath));
  const zkeyBytes = new Uint8Array(readFileSync(a.zkeyPath));
  const vkeyBytes = readFileSync(a.vkeyPath);
  const actual = { wasm: sha256Bytes(wasmBytes), zkey: sha256Bytes(zkeyBytes), vkey: sha256Bytes(vkeyBytes) };
  const mem = (data: Uint8Array) => ({ type: 'mem', data: new Uint8Array(data) });
  for (const k of ['wasm', 'zkey', 'vkey'] as const) {
    if (actual[k].toLowerCase() !== a.expected[k].toLowerCase()) {
      throw new ArtifactMismatchError(`${k} sha256 ${actual[k]} differs from manifest ${a.expected[k]}`);
    }
  }
  const vkey = JSON.parse(vkeyBytes.toString('utf8'));
  const embedded = await zKey.exportVerificationKey(mem(zkeyBytes));
  if (canonicalJson(embedded) !== canonicalJson(vkey)) throw new ArtifactMismatchError('verification key embedded in zkey differs from vkey file');
  if (vkey.nPublic !== METERING_V3_PUBLIC_SIGNALS.length) throw new ArtifactMismatchError(`vkey nPublic ${vkey.nPublic} != ${METERING_V3_PUBLIC_SIGNALS.length}`);

  const circuitId = a.circuitId;
  const artifacts = actual;

  return {
    circuitId,
    artifacts,

    buildWitnessInput(opening: CommitmentOpening, auth: PublicAuthorization) {
      if (opening.circuitId !== circuitId || auth.circuitId !== circuitId) throw new ArtifactMismatchError('opening/authorization circuit differs from adapter');
      if (opening.key.tenantId === '' || opening.key.operationId === '') throw new Error('opening key incomplete');
      const v = openingValues(opening);
      if (v.epoch !== auth.epoch) throw new Error('opening epoch differs from authorization');
      if (v.usage < auth.bucket.min || v.usage > auth.bucket.max) throw new Error('usage outside the authorized bucket');
      return {
        usage: v.usage.toString(),
        blinding: v.blinding.toString(),
        userRef: v.userRef.toString(),
        epoch: auth.epoch.toString(),
        minUsage: auth.bucket.min.toString(),
        maxUsage: auth.bucket.max.toString(),
      };
    },

    async prove(input) {
      const { proof, publicSignals } = await groth16.fullProve(input, mem(wasmBytes), mem(zkeyBytes));
      return { circuitId, proof: toSolidity(proof as SnarkProof), publicSignals: (publicSignals as unknown[]).map(String), artifacts };
    },

    async verifyLocal(bundle) {
      if (bundle.circuitId !== circuitId) return false;
      if (bundle.artifacts.vkey.toLowerCase() !== artifacts.vkey.toLowerCase()) return false;
      if (bundle.publicSignals.length !== METERING_V3_PUBLIC_SIGNALS.length) return false;
      return (await groth16.verify(vkey, bundle.publicSignals, fromSolidity(bundle.proof))) === true;
    },

    encodeSubmission(auth, bundle) {
      if (bundle.circuitId !== circuitId || auth.circuitId !== circuitId) throw new ArtifactMismatchError('bundle/authorization circuit differs from adapter');
      if (bundle.artifacts.vkey.toLowerCase() !== artifacts.vkey.toLowerCase()) throw new ArtifactMismatchError('bundle produced with another verification key');
      const exp = expectedPublicSignals(auth);
      if (bundle.publicSignals.length !== exp.length || bundle.publicSignals.some((s, i) => s !== exp[i])) {
        throw new Error('proof public signals do not match the authorization (commitment, epoch, minUsage, maxUsage)');
      }
      const v = authorizationValues(auth);
      return {
        abi: [...REGISTRY_V3_SUBMIT_ABI],
        functionName: 'submitReceipt',
        args: [
          { circuitId: v.circuitId, verifier: v.verifier, commitment: v.commitment, epoch: v.epoch, minUsage: v.minUsage, maxUsage: v.maxUsage, bucketPolicy: v.bucketPolicy, operationRef: v.operationRef },
          auth.signature.signature,
          { a: bundle.proof.a, b: bundle.proof.b, c: bundle.proof.c, pubSignals: bundle.publicSignals },
        ],
      };
    },
  };
}
