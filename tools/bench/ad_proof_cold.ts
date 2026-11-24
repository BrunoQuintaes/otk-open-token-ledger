/**
 * FECHAMENTO_GEMINI_AD / B — ONE proof in a fresh process (cold start): artifact load (hash-checked), witness+prove
 * (adapter.prove), off-chain verify. Ephemeral operator key and a fixed local domain (proving time does not depend on the
 * chain). Prints one JSON line. Spawned by ad_proof_gas.ts.
 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ethers } from 'ethers';
import {
  createKeyRing, createProofAdapterV3, createPublicAuthorizationBuilder, commitmentOf, newCommitmentOpening,
  PUBLIC_BUCKET_POLICY_FIXED_1000CU, bucketForReceipt, bucketPolicyRef, epochOf, REGISTRY_V3_SCHEMA,
} from '../../src/zk/v3/index.js';
import type { PrivateReceiptV3 } from '../../src/types/d1d8/index.js';

const t0 = performance.now();
const manifest = JSON.parse(fs.readFileSync('zk/v3/MANIFEST.json', 'utf8')) as { circuitId: string; files: Record<string, string> };
const sha = (p: string) => `0x${manifest.files[p]!.replace(/^0x/, '')}` as `0x${string}`;
const WASM = 'zk/v3/build/metering_v3_js/metering_v3.wasm'; const ZKEY = 'zk/v3/keys/metering_v3_demo_final.zkey'; const VKEY = 'zk/v3/keys/metering_v3_demo_vkey.json';
async function main(): Promise<void> {
  const adapter = await createProofAdapterV3({ circuitId: manifest.circuitId, wasmPath: WASM, zkeyPath: ZKEY, vkeyPath: VKEY, expected: { wasm: sha(WASM), zkey: sha(ZKEY), vkey: sha(VKEY) } });
  const t1 = performance.now();
  const w = ethers.Wallet.createRandom();
  const keyRing = createKeyRing([{ keyId: 'op', address: w.address as `0x${string}`, status: 'active' }]);
  const policy = PUBLIC_BUCKET_POLICY_FIXED_1000CU;
  const build = createPublicAuthorizationBuilder({ keyRing, signer: { keyId: 'op', wallet: w }, policy, circuitId: manifest.circuitId });
  const k = { tenantId: 'bench-cold', operationId: `op-${Date.now()}` };
  const admittedAt = new Date().toISOString();
  const opening = newCommitmentOpening(k, { units: 42_000_000n, scale: 1_000_000n }, manifest.circuitId, { userRef: '7', epoch: epochOf(admittedAt).toString() });
  const receipt = { schema: 'otk.receipt.v3', key: k, source: 'otk_proxy_observed', provider: 'bench', usage: { observedAt: admittedAt },
    cu: { schema: 'otk.cu_result.v1', status: 'computed', cu: { units: 42_000_000n, scale: 1_000_000n } },
    config: { circuitId: manifest.circuitId, bucketPolicy: bucketPolicyRef(policy) }, userRef: '7', timing: { admittedAt }, publicCommitment: String(await commitmentOf(opening)), contentDigests: null } as unknown as PrivateReceiptV3;
  const domain = { chainId: 16263n, registry: '0x0000000000000000000000000000000000000001' as `0x${string}`, verifier: '0x0000000000000000000000000000000000000002' as `0x${string}`, schemaVersion: REGISTRY_V3_SCHEMA };
  const auth = await build({ receipt, opening, domain, bucket: bucketForReceipt(receipt, policy) });
  const t2 = performance.now();
  const bundle = await adapter.prove(adapter.buildWitnessInput(opening, auth));
  const t3 = performance.now();
  const ok = await adapter.verifyLocal(bundle);
  const t4 = performance.now();
  console.log(JSON.stringify({ loadMs: +(t1 - t0).toFixed(1), authMs: +(t2 - t1).toFixed(1), proveMs: +(t3 - t2).toFixed(1), verifyMs: +(t4 - t3).toFixed(1), verified: ok }));
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null }).curve_bn128?.terminate();
}
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
