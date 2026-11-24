/**
 * D1–D8 / S4 — front A's real modules composed for the durable runtime: v3 receipt/conference
 * signing (CE1 envelopes), commitment opening with CSPRNG blinding, public EIP-712 authorization
 * with the fixed 1000-CU bucket policy, the metering_v3 proof adapter (artifacts checked against
 * zk/v3/MANIFEST.json) and the on-chain submitter of ReceiptRegistryV3 (ethers, A's encoded call
 * sent unchanged). This is the ONLY proof path of new v3 operations (proofWorker of C); the
 * legacy ProverDaemon stays for historical v1/v2 receipts (S4-DEC-04).
 *
 * Keys come from the secrets boundary (getV3OperatorKey / getV3SubmitterKey); the operator key
 * signs, the submitter key only pays gas. Deployment addresses come from deploy_v3.js output
 * (OTK_V3_DEPLOYMENT_FILE). Nothing here logs a key, an opening or an exact usage.
 *
 * @module operations/d1d8ProofPorts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import type { ChainDomain, FrozenConfigRef, Hex32, OperationKey, PublicAuthorization, ProofAdapter } from '../types/d1d8/index.js';
import {
  BN254_R, classifyRegistration, commitmentOf, createKeyRing, createProofAdapterV3, createPublicAuthorizationBuilder, createReceiptCrypto,
  newCommitmentOpening, PUBLIC_BUCKET_POLICY_FIXED_1000CU, REGISTRY_V3_SUBMIT_ABI, bucketForReceipt, bucketPolicyRef, type KeyEntry,
} from '../zk/v3/index.js';
import type { CryptoPorts } from './context.js';
import type { ChainSubmitter, ProofPorts, Target } from './proofPipeline.js';
import type { FrozenProofConfig } from './d1d8Ports.js';

export interface V3Deployment {
  schema: 'otk.deploy_v3.v1';
  chainId: string;
  signer: string;
  circuitId: string;
  domain: { chainId: string; registry: string; verifier: string; schemaVersion: string };
}

export function readDeployment(file: string): V3Deployment {
  const d = JSON.parse(readFileSync(file, 'utf8')) as V3Deployment;
  if (d.schema !== 'otk.deploy_v3.v1' || !d.domain?.registry) throw new Error(`${file} is not a deploy_v3.js output`);
  return d;
}

export function chainDomainOf(d: V3Deployment): ChainDomain {
  return { chainId: BigInt(d.domain.chainId), registry: d.domain.registry as `0x${string}`, verifier: d.domain.verifier as `0x${string}`, schemaVersion: d.domain.schemaVersion };
}

/** Pseudonymous user reference inside a tenant: a field element, private (circuit input only). */
export function userRefOf(key: OperationKey): string {
  return (BigInt(ethers.keccak256(ethers.toUtf8Bytes(`otk.user_ref.v1\n${key.tenantId}`))) % BN254_R).toString(10);
}

export interface V3PortsOptions {
  root: string;
  operatorKey: string;
  operatorKeyId: string;
  /** Other keys known to verifiers (rotation/revocation), besides the active operator key. */
  extraKeys?: KeyEntry[];
  deployment: V3Deployment | null;
  /** RPC + submitter key: without them proofs are produced but submission waits (visible). */
  rpcUrl: string | null;
  submitterKey: string | null;
}

export interface V3Ports { crypto: CryptoPorts; proof: ProofPorts; proofConfig: FrozenProofConfig; operatorAddress: string; adapter: ProofAdapter; destroy(): void }

export async function createV3Ports(o: V3PortsOptions): Promise<V3Ports> {
  const manifest = JSON.parse(readFileSync(path.join(o.root, 'zk/v3/MANIFEST.json'), 'utf8')) as { circuitId: string; files: Record<string, string> };
  const circuitId = manifest.circuitId;
  const operator = new ethers.Wallet(o.operatorKey);
  const keyRing = createKeyRing([{ keyId: o.operatorKeyId, address: operator.address as `0x${string}`, status: 'active' }, ...(o.extraKeys ?? [])]);
  const signer = { keyId: o.operatorKeyId, wallet: operator };
  const receiptCrypto = createReceiptCrypto({ keyRing, signer });
  const domain = o.deployment ? chainDomainOf(o.deployment) : null;
  if (o.deployment) {
    if (o.deployment.circuitId !== circuitId) throw new Error(`deployment circuit ${o.deployment.circuitId} ≠ manifest ${circuitId}`);
    if (o.deployment.signer.toLowerCase() !== operator.address.toLowerCase()) throw new Error('deployment signer is not the configured operator key');
  }
  const f = (p: string) => path.join(o.root, p);
  const sha = (p: string) => `0x${manifest.files[p]!.replace(/^0x/, '')}` as Hex32;
  const adapter = await createProofAdapterV3({
    circuitId,
    wasmPath: f('zk/v3/build/metering_v3_js/metering_v3.wasm'),
    zkeyPath: f('zk/v3/keys/metering_v3_demo_final.zkey'),
    vkeyPath: f('zk/v3/keys/metering_v3_demo_vkey.json'),
    expected: { wasm: sha('zk/v3/build/metering_v3_js/metering_v3.wasm'), zkey: sha('zk/v3/keys/metering_v3_demo_final.zkey'), vkey: sha('zk/v3/keys/metering_v3_demo_vkey.json') },
  });
  const policy = PUBLIC_BUCKET_POLICY_FIXED_1000CU;
  const target: Target | null = domain ? { chainId: domain.chainId, registry: domain.registry, circuitId, schemaVersion: domain.schemaVersion } : null;

  const crypto: CryptoPorts = {
    receiptCrypto,
    newOpening: newCommitmentOpening,
    commitmentOf: async (op) => String(await commitmentOf(op)),
    userRefOf,
    proofTarget: (cfg: FrozenConfigRef) => (cfg.chain && cfg.circuitId === circuitId ? { chainId: cfg.chain.chainId, registry: cfg.chain.registry, circuitId: cfg.circuitId, schemaVersion: cfg.chain.schemaVersion } : null),
    domain,
  };

  let chain: ChainSubmitter;
  let rpcProvider: ethers.JsonRpcProvider | null = null;
  if (o.rpcUrl && o.submitterKey) {
    const provider = new ethers.JsonRpcProvider(o.rpcUrl, undefined, { staticNetwork: true });
    rpcProvider = provider;
    const payer = new ethers.Wallet(o.submitterKey, provider);
    const registryOf = (t: Target) => new ethers.Contract(t.registry, REGISTRY_V3_SUBMIT_ABI as unknown as string[], payer);
    chain = {
      async registration(t: Target, auth: PublicAuthorization) {
        const onChain = String(await registryOf(t).getFunction('registeredDigest')(auth.operationRef));
        const c = classifyRegistration(onChain, auth);
        return c === 'registered_conflict' ? 'registered_other' : c;
      },
      async submit(t: Target, call) {
        const c = new ethers.Contract(t.registry, call.abi, payer);
        const tx = await c.getFunction(call.functionName)(...call.args);
        const rc = await tx.wait();
        return { txHash: String(rc?.hash ?? tx.hash) };
      },
    };
  } else {
    chain = {
      registration: async () => { throw new Error('chain submitter not configured (OTK_V3_RPC_URL / OTK_V3_SUBMITTER_KEY)'); },
      submit: async () => { throw new Error('chain submitter not configured (OTK_V3_RPC_URL / OTK_V3_SUBMITTER_KEY)'); },
    };
  }
  const proof: ProofPorts = {
    buildPublicAuthorization: createPublicAuthorizationBuilder({ keyRing, signer, policy, circuitId }),
    bucketFor: (r) => bucketForReceipt(r, policy),
    adapterFor: (id) => (id === circuitId ? adapter : null),
    currentTarget: () => (o.rpcUrl && o.submitterKey ? target : null),
    chain,
  };
  return { crypto, proof, operatorAddress: operator.address, adapter, proofConfig: { circuitId, bucketPolicy: bucketPolicyRef(policy), chain: domain }, destroy: () => rpcProvider?.destroy() };
}
