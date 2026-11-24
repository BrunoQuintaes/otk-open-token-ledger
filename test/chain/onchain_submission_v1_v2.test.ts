/**
 * R19 — end-to-end on a local chain: real proof → version-aware submission → registry event.
 *
 * Real: Hardhat JSON-RPC node (tools/hardhat), compiled verifier + registry contracts,
 * snarkjs Groth16 proof generation for v2 with the MPC key (zk/keys/metering_v2_final_mpc.zkey),
 * src/prover/onChainSubmission.ts over JSON-RPC.
 * v1 uses the stored proof zk/build/proof.json (no v1 key in zk/keys).
 * Not covered: the daemon HTTP queue (API → /prove → worker); a public or Besu network.
 *
 * Requires compiled artifacts: cd tools/hardhat && npx hardhat compile
 * Run: npx tsx --test test/chain/onchain_submission_v1_v2.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { submitProofOnChain } from '../../src/prover/onChainSubmission.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HH = path.join(ROOT, 'tools', 'hardhat');
const snarkjs = createRequire(import.meta.url)('snarkjs') as {
  groth16: { fullProve: (i: Record<string, string>, wasm: string, zkey: string) => Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }> };
};

function artifact(file: string, name: string): { abi: ethers.InterfaceAbi; bytecode: string } {
  const p = path.join(HH, 'artifacts', 'contracts', file, `${name}.json`);
  if (!existsSync(p)) throw new Error(`artifact missing (compile first): ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('port')))); });
  });
}

let node: ChildProcess;
let rpcUrl: string;
let provider: ethers.JsonRpcProvider;
let signerKey: string;
let trusted: ethers.HDNodeWallet;

async function deploy(file: string, name: string, ...args: unknown[]): Promise<ethers.Contract> {
  const a = artifact(file, name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, trusted).deploy(...args);
  await c.waitForDeployment();
  return c as unknown as ethers.Contract;
}

describe('R19 — real proofs reach the registry of their version', () => {
  before(async () => {
    const port = await freePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    node = spawn(process.execPath, [path.join(HH, 'node_modules', 'hardhat', 'dist', 'src', 'cli.js'), 'node', '--port', String(port)], {
      cwd: HH, stdio: ['ignore', 'pipe', 'pipe'],
    });
    node.stdout?.on('data', () => {});
    node.stderr?.on('data', () => {});
    // cacheTimeout -1: consecutive deployments must not reuse a cached nonce
    provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
    const deadline = Date.now() + 60000;
    for (;;) {
      try { await provider.getBlockNumber(); break; } catch { if (Date.now() > deadline) throw new Error('hardhat node did not start'); }
      await new Promise(r => setTimeout(r, 500));
    }
    // Fresh trusted signer funded by the node's unlocked dev account (no fixed key in the repo)
    const funder = await provider.getSigner(0);
    trusted = ethers.Wallet.createRandom().connect(provider);
    signerKey = trusted.privateKey;
    await (await funder.sendTransaction({ to: trusted.address, value: ethers.parseEther('10') })).wait();
  });

  after(async () => {
    // snarkjs keeps bn128 worker threads alive until the curve is terminated
    await (globalThis as { curve_bn128?: { terminate: () => Promise<void> } }).curve_bn128?.terminate();
    provider?.destroy();
    node?.stdout?.destroy();
    node?.stderr?.destroy();
    if (node?.pid) {
      if (process.platform === 'win32') spawn('taskkill', ['/F', '/T', '/PID', String(node.pid)], { stdio: 'ignore' });
      else node.kill('SIGKILL');
    }
  });

  it('v2: freshly generated MPC proof → ReceiptRegistryV2 emits ReceiptSubmittedV2', async () => {
    const verifier = await deploy('MeteringVerifierV2MPC.sol', 'MeteringVerifierV2MPC');
    const registry = await deploy('ReceiptRegistryV2.sol', 'ReceiptRegistryV2', await verifier.getAddress(), trusted.address);

    const input = { userId: '77', usage: '640', nonce: '0', epoch: '812' };
    const t0 = Date.now();
    const result = await snarkjs.groth16.fullProve(
      { ...input, minUsageBucket: '600', maxUsageBucket: '699' },
      path.join(ROOT, 'zk', 'build', 'metering_v2_js', 'metering_v2.wasm'),
      path.join(ROOT, 'zk', 'keys', 'metering_v2_final_mpc.zkey'),
    );
    const proveMs = Date.now() - t0;
    assert.equal(result.publicSignals.length, 4);

    const txHash = await submitProofOnChain('v2', input, result, { rpcUrl, signerKey, registry: { v2: await registry.getAddress() } });
    assert.ok(txHash);
    const rc = await provider.getTransactionReceipt(txHash!);
    const ev = rc!.logs.map(l => { try { return registry.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'ReceiptSubmittedV2');
    assert.ok(ev, 'ReceiptSubmittedV2 emitted');
    assert.equal(ev!.args['epoch'].toString(), '812');
    assert.equal(ev!.args['minUsageBucket'].toString(), '600');
    assert.equal(ev!.args['maxUsageBucket'].toString(), '699');
    assert.equal(ev!.args['commitment'], ethers.toBeHex(BigInt(result.publicSignals[0]!), 32));
    console.log(`[R19] v2 proveMs=${proveMs} gasUsed=${rc!.gasUsed} tx=${txHash}`);
  });

  it('v1: stored proof → ReceiptRegistry (v1 ABI, 3 signals)', async () => {
    const verifier = await deploy('MeteringVerifier.sol', 'Groth16Verifier');
    const registry = await deploy('ReceiptRegistry.sol', 'ReceiptRegistry', await verifier.getAddress(), trusted.address);
    const proof = JSON.parse(readFileSync(path.join(ROOT, 'zk', 'build', 'proof.json'), 'utf8'));
    const pub = JSON.parse(readFileSync(path.join(ROOT, 'zk', 'build', 'public.json'), 'utf8')) as string[];
    // proof inputs: userId 12345678901234567890, usage 999, nonce 444, epoch 1. The fresh registry
    // expects nonce 0; it accepts only because proof and receipt nonce are not bound (R16).
    const input = { userId: '12345678901234567890', usage: '999', nonce: '0', epoch: pub[1]! };
    const txHash = await submitProofOnChain('1', input, { proof, publicSignals: pub }, { rpcUrl, signerKey, registry: { v1: await registry.getAddress() } });
    const rc = await provider.getTransactionReceipt(txHash!);
    assert.equal(rc!.status, 1);
  });

  it('N15: resubmitting an already registered proof returns the original tx, sends nothing', async () => {
    const verifier = await deploy('MeteringVerifierV2MPC.sol', 'MeteringVerifierV2MPC');
    const registry = await deploy('ReceiptRegistryV2.sol', 'ReceiptRegistryV2', await verifier.getAddress(), trusted.address);
    const input = { userId: '88', usage: '640', nonce: '0', epoch: '900' };
    const result = await snarkjs.groth16.fullProve({ ...input, minUsageBucket: '600', maxUsageBucket: '699' },
      path.join(ROOT, 'zk', 'build', 'metering_v2_js', 'metering_v2.wasm'), path.join(ROOT, 'zk', 'keys', 'metering_v2_final_mpc.zkey'));
    const cfg = { rpcUrl, signerKey, registry: { v2: await registry.getAddress() } };
    const first = await submitProofOnChain('v2', input, result, cfg);
    const nonceBefore = await provider.getTransactionCount(trusted.address);
    const again = await submitProofOnChain('v2', input, result, cfg);
    assert.equal(again, first, 'same transaction hash returned');
    assert.equal(await provider.getTransactionCount(trusted.address), nonceBefore, 'no new transaction sent');
  });

  it('N15: a job created for another registry is refused before any transaction', async () => {
    const nonceBefore = await provider.getTransactionCount(trusted.address);
    await assert.rejects(
      submitProofOnChain('v2', { userId: '1', usage: '1', nonce: '0', epoch: '1', targetRegistry: ethers.Wallet.createRandom().address },
        { proof: { pi_a: ['1', '1'], pi_b: [['1', '1'], ['1', '1']], pi_c: ['1', '1'] }, publicSignals: ['1', '1', '1', '1'] },
        { rpcUrl, signerKey, registry: { v2: trusted.address } }),
      /job target mismatch/,
    );
    assert.equal(await provider.getTransactionCount(trusted.address), nonceBefore);
  });

  it('a v2 proof is not sent to a v1-only configuration', async () => {
    await assert.rejects(
      submitProofOnChain('v2', { userId: '1', usage: '1', nonce: '0', epoch: '1' },
        { proof: { pi_a: ['1', '1'], pi_b: [['1', '1'], ['1', '1']], pi_c: ['1', '1'] }, publicSignals: ['1', '1', '1', '1'] },
        { rpcUrl, signerKey, registry: { v1: trusted.address } }),
      /no registry configured for circuit v2/,
    );
  });
});
