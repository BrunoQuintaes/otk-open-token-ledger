/**
 * On-chain submission of ZK proofs, selected by circuit version (R19).
 *
 * Before R19 the daemon generated v1 or v2 proofs but always submitted with the v1 ABI
 * (uint256[3] pubSignals) to a single registry address, so every v2 proof failed on-chain
 * or went to the wrong contract. Here the ABI, the registry address and the number of
 * public signals are chosen per version, and an incompatible configuration is rejected
 * before any transaction is sent.
 *
 *   v1 → ReceiptRegistry   (pubSignals [commitment, epoch, maxUsage])
 *   v2 → ReceiptRegistryV2 (pubSignals [commitment, epoch, minUsageBucket, maxUsageBucket])
 *
 * Used by the prover daemon (`ProverDaemon.ts`), which passes the chain settings in. This module reads no
 * environment variable. Legacy v1/v2 path only; v3 proofs are submitted by `src/operations/proofPipeline.ts`.
 *
 * @module src/prover/onChainSubmission
 */
import { ethers } from 'ethers';

/** Legacy circuit version. */
export type CircuitVersion = 'v1' | 'v2';

/** Raw receipt fields signed and submitted with the proof (decimal strings; `usage` is the CU value). */
export interface SubmissionInput {
  userId: string;
  usage: string;
  nonce: string;
  epoch: string;
  /** N15: registry the job was created for; a different configured registry is refused */
  targetRegistry?: string;
}

/** Groth16 proof points as snarkjs returns them (decimal strings). */
export interface SnarkProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

const RAW = '(uint256 userId, uint256 nonce, uint256 epoch, uint256 costUnits) raw';
const SIG = 'bytes32 rawHash, uint8 v, bytes32 r, bytes32 s';

const USED = 'function usedCommitments(bytes32) view returns (bool)';

/** Human-readable ABI fragments of each registry version (submit and replay check). */
export const REGISTRY_ABI: Record<CircuitVersion, string[]> = {
  v1: [`function submitReceipt(${RAW}, ${SIG}, (uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[3] pubSignals) proof) external`, USED],
  v2: [`function submitReceipt(${RAW}, ${SIG}, (uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[4] pubSignals) proof) external`, USED],
};

/** Number of public signals each circuit version produces. */
export const PUBLIC_SIGNAL_COUNT: Record<CircuitVersion, number> = { v1: 3, v2: 4 };

/**
 * Normalizes a circuit version label (`'2'` → `'v2'`); absent means v1.
 *
 * @param v - Version label, with or without the `v` prefix.
 * @returns `'v1'` or `'v2'`.
 * @throws {Error} For any other version.
 */
export function normalizeVersion(v: string | undefined): CircuitVersion {
  const s = (v ?? 'v1').startsWith('v') ? (v ?? 'v1') : `v${v}`;
  if (s !== 'v1' && s !== 'v2') throw new Error(`unsupported circuit version: ${v}`);
  return s;
}

/**
 * Canonical 4-field hash signed for ReceiptRegistry*.submitReceipt.
 * Matches deploy_besu_u4_6.js: `costUnits\n${x}\nepoch\n${x}\nnonce\n${x}\nuserId\n${x}\n`.
 * The registries do not recompute it on-chain (see R16).
 *
 * @param input - Raw receipt fields.
 * @returns keccak256 of the canonical text, `0x`-prefixed hex.
 */
export function canonicalHashForChain(input: SubmissionInput): string {
  const s = `costUnits\n${input.usage}\nepoch\n${input.epoch}\nnonce\n${input.nonce}\nuserId\n${input.userId}\n`;
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

/**
 * snarkjs proof → Solidity calldata. pi_b G2 coordinates are reversed per field.
 * Throws when the number of public signals does not match the circuit version.
 *
 * @param version - Circuit version.
 * @param proof - snarkjs proof.
 * @param publicSignals - Public signals as decimal strings.
 * @returns The `a`, `b`, `c` points and public signals as bigint.
 * @throws {Error} When the signal count does not match the version.
 */
export function proofToSolidity(version: CircuitVersion, proof: SnarkProof, publicSignals: string[]) {
  const expected = PUBLIC_SIGNAL_COUNT[version];
  if (publicSignals.length !== expected) {
    throw new Error(`${version} expects ${expected} public signals, got ${publicSignals.length}`);
  }
  return {
    a: [BigInt(proof.pi_a[0]!), BigInt(proof.pi_a[1]!)],
    b: [
      [BigInt(proof.pi_b[0]![1]!), BigInt(proof.pi_b[0]![0]!)],
      [BigInt(proof.pi_b[1]![1]!), BigInt(proof.pi_b[1]![0]!)],
    ],
    c: [BigInt(proof.pi_c[0]!), BigInt(proof.pi_c[1]!)],
    pubSignals: publicSignals.map(s => BigInt(s)),
  };
}

/** Chain settings; absent values mean "not configured". */
export interface ChainConfig {
  /** JSON-RPC endpoint. */
  rpcUrl?: string;
  /** Private key of the registry's trusted signer (secret; never log it). It also pays the gas. */
  signerKey?: string;
  /** Registry address per circuit version; v2 must never fall back to the v1 address. */
  registry: Partial<Record<CircuitVersion, string>>;
}

/**
 * Submit a proof to the registry of its circuit version.
 * Returns null when the chain is not configured at all (dev mode).
 * Throws when the version has no registry configured, or on submission failure,
 * so the caller can fail/retry the job instead of silently skipping it.
 *
 * Side effects: JSON-RPC calls, a signature with the signer key, and one transaction (spends gas). If the
 * commitment is already registered, nothing is sent and the earlier transaction hash (or an
 * `already-registered:<commitment>` marker) is returned.
 *
 * @param versionIn - Circuit version of the proof.
 * @param input - Raw receipt fields (and optional target registry).
 * @param result - Proof and public signals.
 * @param cfg - Chain settings.
 * @returns The transaction hash, a marker, or `null` when the chain is not configured.
 * @throws {Error} For an unsupported version, a missing registry for the version, a target mismatch, a signal
 *   count mismatch, or an RPC/transaction failure.
 */
export async function submitProofOnChain(
  versionIn: string | undefined,
  input: SubmissionInput,
  result: { proof: SnarkProof; publicSignals: string[] },
  cfg: ChainConfig,
): Promise<string | null> {
  const version = normalizeVersion(versionIn);
  const anyRegistry = cfg.registry.v1 || cfg.registry.v2;
  if (!cfg.rpcUrl || !cfg.signerKey || !anyRegistry) return null; // dev mode
  const registryAddr = cfg.registry[version];
  if (!registryAddr) {
    throw new Error(`no registry configured for circuit ${version} (refusing to submit to another version's contract)`);
  }
  // N15: a queued job keeps the registry it was created for. After a redeploy or a config
  // change, a stalled job resumed by a new daemon went to the new contract with a new signer.
  if (input.targetRegistry && input.targetRegistry.toLowerCase() !== registryAddr.toLowerCase()) {
    throw new Error(`job target mismatch: created for registry ${input.targetRegistry}, configured ${registryAddr} (not submitted)`);
  }
  const proofData = proofToSolidity(version, result.proof, result.publicSignals);

  // One provider per job; destroyed afterwards so a long-running daemon does not
  // accumulate polling providers.
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  try {
    const wallet = new ethers.Wallet(cfg.signerKey, provider);
    const raw = {
      userId: BigInt(input.userId),
      nonce: BigInt(input.nonce),
      epoch: BigInt(input.epoch),
      costUnits: BigInt(input.usage),
    };
    const rawHash = canonicalHashForChain(input);
    const sig = ethers.Signature.from(await wallet.signMessage(ethers.getBytes(rawHash)));
    const registry = new ethers.Contract(registryAddr, REGISTRY_ABI[version], wallet);
    // N15: a job resumed after a crash between confirmation and completion must not submit
    // again. If the commitment is already registered, return the transaction that did it.
    // (With R16 open, that transaction may not be ours: the registry does not bind the data.)
    const commitment = ethers.toBeHex(proofData.pubSignals[0]!, 32);
    if ((await registry.getFunction('usedCommitments')(commitment)) as boolean) {
      // RPCs may limit log ranges; failing here would fail forever a job whose proof is
      // on chain. Without the log, the job completes with a marker instead of a tx hash.
      const logs = await provider.getLogs({ address: registryAddr, topics: [null, commitment], fromBlock: 0, toBlock: 'latest' }).catch(() => []);
      const last = logs[logs.length - 1];
      return last ? last.transactionHash : `already-registered:${commitment}`;
    }
    const submit = registry.getFunction('submitReceipt');
    const tx = (await submit(raw, rawHash, sig.v, sig.r, sig.s, proofData)) as ethers.ContractTransactionResponse;
    const receipt = await tx.wait();
    if (!receipt) throw new Error('submitProofOnChain: tx receipt is null');
    return receipt.hash;
  } finally {
    provider.destroy();
  }
}
