/**
 * D1–D8 / C — explicit TEST DOUBLES of A/B contracts (src/types/d1d8/modules.ts).
 *
 * Only for C's local tests until S4 wires the real modules (A: src/zk/v3, src/receipt/v3;
 * B: src/providers/d1d8Measurement.ts). Never imported by src/**. Their encodings are NOT A's
 * canonical encoding and their numbers are NOT B's formula: a test that passes with a double
 * proves C's plumbing (ordering, persistence, binding checks), not A's or B's correctness.
 *
 * In plain terms: these are stand-ins for the receipt signing and digest module, the CU formula, the local token
 * counter, the conference report builder, the commitment opening generator, the public authorization builder, the
 * proof adapter and the chain submitter, so the durable operation layer (`src/operations`) can be tested without
 * real cryptographic circuits, tokenizers or a chain. Signing uses a random in-memory wallet; nothing is written to
 * disk and nothing goes to the network.
 *
 * @module test/fixtures/d1d8/c/doubles
 */
import { ethers } from 'ethers';
import type {
  BuildConferenceReportFn, CommitmentOpening, ConferenceReport, CuConfig, CuResult, EstimateReservationFn,
  Hex32, LocalCounter, LocalCountResult, NewCommitmentOpeningFn, NormalizedUsage, OperationKey,
  PrivateReceiptV3, ReceiptCrypto, Scaled, SignedEnvelope, VerifyResult,
} from '../../../../src/types/d1d8/index.js';
import { canonicalJson } from '../../../../src/operations/ids.js';

const digestOf = (domain: string, payload: unknown): Hex32 =>
  ethers.keccak256(ethers.toUtf8Bytes(`${domain}\n${canonicalJson(payload)}`)) as Hex32;

/** A {@link ReceiptCrypto} double that also exposes its signer address and key id, so tests can assert them. */
export interface ReceiptCryptoDouble extends ReceiptCrypto { readonly signer: string; readonly keyId: string }

/**
 * Creates a receipt crypto double: keccak256 digests over `domain + "\n" + canonical JSON` and EIP-191 signatures
 * by one wallet with key id `double-key-1`.
 *
 * Verification reports `wrong_domain`, `digest_mismatch`, `bad_signature`, `unauthorized_signer` (any signer other
 * than this wallet) or, for a conference, `binding_mismatch` when it does not point at the given receipt. Legacy
 * receipts are always `unsupported_version`.
 *
 * @param wallet - Signing wallet; defaults to a new random one.
 * @returns The double. Digests are NOT the canonical v3 encoding.
 */
export function createReceiptCryptoDouble(wallet = ethers.Wallet.createRandom()): ReceiptCryptoDouble {
  const keyId = 'double-key-1';
  const sign = async (domain: SignedEnvelope['domain'], digest: Hex32): Promise<SignedEnvelope> => ({
    schema: 'otk.envelope.v1', domain, payloadDigest: digest, alg: 'eip191-secp256k1', signer: wallet.address as SignedEnvelope['signer'],
    keyId, signature: (await wallet.signMessage(ethers.getBytes(digest))) as `0x${string}`, signedAt: new Date().toISOString(),
  });
  const verify = (domain: SignedEnvelope['domain'], digest: Hex32, env: SignedEnvelope): VerifyResult => {
    if (env.domain !== domain) return { ok: false, reason: 'wrong_domain' };
    if (env.payloadDigest.toLowerCase() !== digest.toLowerCase()) return { ok: false, reason: 'digest_mismatch' };
    let rec: string;
    try { rec = ethers.verifyMessage(ethers.getBytes(digest), env.signature); } catch { return { ok: false, reason: 'bad_signature' }; }
    if (rec.toLowerCase() !== wallet.address.toLowerCase()) return { ok: false, reason: 'unauthorized_signer' };
    return { ok: true, signer: env.signer, keyId: env.keyId };
  };
  const self: ReceiptCryptoDouble = {
    signer: wallet.address,
    keyId,
    digestReceipt: (r: PrivateReceiptV3) => digestOf('OTK_PRIVATE_RECEIPT_V3', r),
    digestConference: (rep: ConferenceReport) => digestOf('OTK_CONFERENCE_V1', rep),
    signReceipt: (r) => sign('OTK_PRIVATE_RECEIPT_V3', self.digestReceipt(r)),
    signConference: (rep) => sign('OTK_CONFERENCE_V1', self.digestConference(rep)),
    verifyReceipt: (r, env) => verify('OTK_PRIVATE_RECEIPT_V3', self.digestReceipt(r), env),
    verifyConference: (rep, env, receipt) => {
      if (rep.receiptDigest.toLowerCase() !== self.digestReceipt(receipt).toLowerCase()) return { ok: false, reason: 'binding_mismatch' };
      return verify('OTK_CONFERENCE_V1', self.digestConference(rep), env);
    },
    verifyLegacy: () => ({ ok: false, reason: 'unsupported_version', detail: 'double' }),
  };
  return self;
}

/**
 * CU double: (tIn + tOut) × 0.4 exactly, in micro-CU (hand-checkable: 100 + 20 → 48 CU).
 *
 * @param usage - Normalized usage; only `tIn` and `tOut` are read.
 * @param cfg - Weight reference and formula name, copied into the result.
 * @returns A `computed` result, or `usage_not_computable` with `cu: null` when either token count is `null`.
 */
export function computeCuDouble(usage: NormalizedUsage, cfg: Pick<CuConfig, 'ref' | 'formula'>): CuResult {
  if (usage.tIn === null || usage.tOut === null) {
    return { schema: 'otk.cu_result.v1', status: 'usage_not_computable', cu: null, formula: cfg.formula, weights: cfg.ref, tIn: usage.tIn, tOut: usage.tOut, wModelMilli: null, wProviderMilli: null, developmentProfile: true };
  }
  const units = (usage.tIn + usage.tOut) * 400n * 1_000n; // ×0.4 CU in micro-CU
  return { schema: 'otk.cu_result.v1', status: 'computed', cu: { units, scale: 1_000_000n }, formula: cfg.formula, weights: cfg.ref, tIn: usage.tIn, tOut: usage.tOut, wModelMilli: 400n, wProviderMilli: 1000n, developmentProfile: true };
}

/**
 * Reservation double: CU(estimatedInput + maxOutput) with the same 0.4 weight.
 *
 * @param req - Reservation request; only `estimatedInputTokens` and `maxOutputTokens` are read.
 * @returns A worst-case CU reservation in micro-CU, with no money part.
 */
export const estimateReservationDouble: EstimateReservationFn = (req) => ({
  cu: { units: (req.estimatedInputTokens + req.maxOutputTokens) * 400_000n, scale: 1_000_000n } as Scaled,
  money: null,
  basis: 'worst_case_estimate@double',
});

/**
 * Local counter double: counts whitespace-separated words (not a tokenizer).
 *
 * @returns A stateful counter: input words are counted on the JSON text of the request body, output words on each
 *   text chunk; `finish` reports both categories as covered.
 */
export function createLocalCounterDouble(): LocalCounter {
  let input = 0n; let output = 0n;
  const words = (s: string) => BigInt(s.split(/\s+/).filter(Boolean).length);
  return {
    observeInput: (inp) => { input += words(JSON.stringify(inp.body)); },
    observeOutputText: (t) => { output += words(t); },
    finish: (): LocalCountResult => ({
      counts: [{ category: 'input', count: input }, { category: 'output', count: output }],
      covered: ['input', 'output'], uncovered: [], status: 'ok', counterVersion: 'counter-double@1',
      cost: { cpuMicros: null, peakBufferedBytes: 0 },
    }),
  };
}

/**
 * Conference report double: compares provider and local counts for input and output (absolute delta only, `null`
 * when either side is missing) and always returns state `incomplete` with verdict `not_applicable`.
 *
 * @param args - Operation key, receipt digest, normalized usage, local count result, threshold and creation time.
 * @returns A new report with no tokenizer description and no relative deltas.
 */
export const buildConferenceReportDouble: BuildConferenceReportFn = (args) => {
  const local = new Map(args.local.counts.map((c) => [c.category, c.count]));
  const prov = new Map(args.usage.categories.map((c) => [c.name, c.count]));
  const comparisons = (['input', 'output'] as const).map((category) => {
    const p = prov.get(category) ?? null; const l = local.get(category) ?? null;
    return { category, provider: p, local: l, absoluteDelta: p !== null && l !== null ? p - l : null, relativeDelta: null };
  });
  return {
    schema: 'otk.conference.v1', key: args.key, receiptDigest: args.receiptDigest, tokenizer: null,
    coveredCategories: ['input', 'output'], uncoveredCategories: [], comparisons, threshold: args.threshold,
    state: 'incomplete', verdict: 'not_applicable', counterVersion: args.local.counterVersion, createdAt: args.now,
  };
};

/**
 * Opening double: random blinding from node crypto (CSPRNG), not A's field construction.
 *
 * @param key - Tenant and operation identifiers of the opening.
 * @param usage - Committed usage (scaled CU).
 * @param circuitId - Circuit the opening is meant for.
 * @param privateInputs - Extra private circuit inputs, kept by reference.
 * @returns A new opening with a 31-byte random blinding written in decimal and the current time as `createdAt`.
 */
export const newCommitmentOpeningDouble: NewCommitmentOpeningFn = (key: OperationKey, usage: Scaled, circuitId: string, privateInputs: Record<string, string>): CommitmentOpening => ({
  schema: 'otk.opening.v1', key, circuitId, usage,
  blinding: BigInt(ethers.hexlify(ethers.randomBytes(31))).toString(10), privateInputs, createdAt: new Date().toISOString(),
});

// ───────────────────────────── proof doubles (A's adapter, authorization, chain) ─────────────

import type { BuildPublicAuthorizationFn, ProofAdapter, ProofBundle, PublicAuthorization } from '../../../../src/types/d1d8/index.js';
import type { ChainSubmitter, Target } from '../../../../src/operations/proofPipeline.js';

/**
 * Authorization double: digest over the public fields (keccak of canonical JSON), double envelope.
 *
 * @param crypto - Receipt crypto double whose receipt signature is reused as the authorization envelope (domain and
 *   payload digest replaced, so the signature itself does not cover the authorization digest).
 * @returns A builder that derives the operation reference and replay key from the tenant and operation ids, with
 *   epoch fixed at 1.
 */
export function createBuildPublicAuthorizationDouble(crypto: ReceiptCryptoDouble): BuildPublicAuthorizationFn {
  return async ({ receipt, domain, bucket }) => {
    const operationRef = ethers.keccak256(ethers.toUtf8Bytes(`ref
${receipt.key.tenantId}
${receipt.key.operationId}`)) as Hex32;
    const fields = [{ name: 'commitment', value: String(receipt.publicCommitment) }, { name: 'min', value: bucket.min.toString() }, { name: 'max', value: bucket.max.toString() }];
    const authorizationDigest = ethers.keccak256(ethers.toUtf8Bytes(canonicalJson({ domain, fields, operationRef }))) as Hex32;
    const signature: SignedEnvelope = { ...(await crypto.signReceipt(receipt)), domain: 'OTK_PUBLIC_AUTHORIZATION_V1', payloadDigest: authorizationDigest };
    const auth: PublicAuthorization = {
      schema: 'otk.public_authorization.v1', domain, circuitId: receipt.config.circuitId, commitment: String(receipt.publicCommitment),
      epoch: 1n, bucket, operationRef, replayKey: ethers.keccak256(ethers.toUtf8Bytes(`replay
${operationRef}`)) as Hex32,
      fields, authorizationDigest, signature,
    };
    return auth;
  };
}

/**
 * Proof adapter double: no circuit; calldata = [replayKey, authorizationDigest, publicSignals].
 *
 * @param circuitId - Circuit id reported by the adapter and stamped on every bundle.
 * @returns The adapter plus a `proved` counter incremented on each `prove` call (lets tests assert that a retry
 *   did not prove twice). Local verification always succeeds.
 */
export function createProofAdapterDouble(circuitId: string): ProofAdapter & { proved: number } {
  const self = {
    circuitId,
    proved: 0,
    buildWitnessInput: (_opening: CommitmentOpening, auth: PublicAuthorization) => ({ commitment: auth.commitment, min: auth.bucket.min.toString(), max: auth.bucket.max.toString() }),
    prove: async (input: Record<string, string | string[]>): Promise<ProofBundle> => {
      self.proved++;
      return { circuitId, proof: { a: ['1', '2'], b: [['3', '4'], ['5', '6']], c: ['7', '8'] }, publicSignals: [String(input['commitment']), '1', String(input['min']), String(input['max'])], artifacts: { wasm: `0x${'01'.repeat(32)}`, zkey: `0x${'02'.repeat(32)}`, vkey: `0x${'03'.repeat(32)}` } };
    },
    verifyLocal: async () => true,
    encodeSubmission: (auth: PublicAuthorization, bundle: ProofBundle) => ({ abi: ['function submitV3(bytes32,bytes32,uint256[4])'], functionName: 'submitV3', args: [auth.replayKey, auth.authorizationDigest, bundle.publicSignals] }),
  };
  return self;
}

/**
 * Chain double: one registry (replayKey → authorizationDigest) per target; can lose one answer.
 *
 * A target is keyed by chain id, lower-cased registry address and schema version. Every `submit` is recorded in
 * `txs` and registers the call immediately. Setting `loseNextAnswer` makes the next `submit` register the call and
 * then throw a timeout error, simulating a transaction that was mined but whose answer never arrived.
 */
export class ChainSubmitterDouble implements ChainSubmitter {
  /** Simulated registries by target key; each maps replay key to the registered authorization digest. */
  readonly registries = new Map<string, Map<string, string>>();
  /** Every submitted call in order, with its target key and call arguments. */
  readonly txs: Array<{ target: string; args: unknown[] }> = [];
  /** When `true`, the next `submit` registers the call, resets this flag and then throws. */
  loseNextAnswer = false;
  private reg(t: Target): Map<string, string> {
    const k = `${t.chainId}:${t.registry.toLowerCase()}:${t.schemaVersion}`;
    if (!this.registries.has(k)) this.registries.set(k, new Map());
    return this.registries.get(k)!;
  }
  /**
   * Counts the transactions sent to one target.
   *
   * @param t - Target chain, registry and schema version.
   * @returns Number of `submit` calls recorded for that target, including one whose answer was lost.
   */
  txsTo(t: Target): number { return this.txs.filter((x) => x.target === `${t.chainId}:${t.registry.toLowerCase()}:${t.schemaVersion}`).length; }
  /**
   * Reports whether the authorization's replay key is already registered on the target.
   *
   * @param t - Target chain, registry and schema version.
   * @param auth - Authorization whose replay key and digest are looked up.
   * @returns `not_registered`, `registered_same` (same authorization digest) or `registered_other`.
   */
  async registration(t: Target, auth: PublicAuthorization) {
    const cur = this.reg(t).get(auth.replayKey);
    return cur === undefined ? 'not_registered' as const : cur === auth.authorizationDigest ? 'registered_same' as const : 'registered_other' as const;
  }
  /**
   * Records the call and registers `args[0]` (replay key) with `args[1]` (authorization digest) on the target.
   *
   * @param t - Target chain, registry and schema version.
   * @param call - Encoded call; only `args` is used.
   * @returns A fake transaction hash derived from the running transaction count.
   * @throws {Error} When `loseNextAnswer` is set: the call is already registered, only the answer is lost.
   */
  async submit(t: Target, call: { abi: string[]; functionName: string; args: unknown[] }) {
    const m = this.reg(t);
    this.txs.push({ target: `${t.chainId}:${t.registry.toLowerCase()}:${t.schemaVersion}`, args: call.args });
    m.set(String(call.args[0]), String(call.args[1]));
    if (this.loseNextAnswer) { this.loseNextAnswer = false; throw new Error('timeout waiting for receipt (mined, answer lost)'); }
    return { txHash: `0x${this.txs.length.toString(16).padStart(64, '0')}` };
  }
}
