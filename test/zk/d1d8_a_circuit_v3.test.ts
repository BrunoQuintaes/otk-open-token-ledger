/**
 * D2-G04 / D2-G03 / D6-G01 / D6-G02 (local) — metering_v3 circuit numeric boundaries, real
 * Groth16 proof with the demonstrative artifacts, artifact-combination refusal and the N13
 * equality test re-run against v3 public data (front A, run 20260930-1625).
 *
 * Numeric negatives exercise the witness generator, whose asserts mirror the R1CS constraints;
 * positives are additionally checked against the r1cs (wtns check). This is not a formal proof of
 * circuit soundness.
 *
 * Modules under test: the v3 metering circuit (compiled `zk/v3` artifacts) and `src/zk/v3` (commitment, Poseidon,
 * opening, public authorization builder, proof adapter).
 *
 * Partitions: usage 0, the bucket window edges and 2^64 − 1 (satisfy the constraints, output equals the TypeScript
 * commitment); below or above the window, 2^64, a value just below the field modulus, min > max and max ≥ 2^64 (the
 * witness generator refuses); a tampered witness fails the r1cs check; artifact hashes that do not match the manifest,
 * or a verification key from another circuit, are refused; a real proof from an opening verifies, while an altered
 * signal or another verification key does not, and the encoded submission carries the exact signals; and a sanity
 * check that a naive blinding-guess attack finds nothing on v3 public data (not a privacy proof).
 *
 * Needs: the compiled v3 circuit, the demonstration proving and verification keys and `zk/v3/MANIFEST.json`; a
 * temporary directory for witness files (removed afterwards); seconds of CPU for the real proof. No network.
 *
 * Run just this file: `npx tsx --test test/zk/d1d8_a_circuit_v3.test.ts`
 *
 * @module test/zk/d1d8_a_circuit_v3.test
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import * as snarkjs from 'snarkjs';
import {
  ArtifactMismatchError, BN254_R, bucketForReceipt, commitmentOf, createKeyRing, createProofAdapterV3, createPublicAuthorizationBuilder,
  epochOf, newCommitmentOpening, PUBLIC_BUCKET_POLICY_FIXED_1000CU as POLICY, REGISTRY_V3_SCHEMA, TAG_V3,
} from '../../src/zk/v3/index.js';
import { poseidonHash } from '../../src/zk/v3/poseidon.js';
import { receiptFixture } from '../fixtures/d1d8/a/receiptFixture.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const M = JSON.parse(readFileSync(path.join(ROOT, 'zk/v3/MANIFEST.json'), 'utf8'));
const F = (p: string) => path.join(ROOT, p);
const ART = {
  circuitId: M.circuitId as string,
  wasmPath: F('zk/v3/build/metering_v3_js/metering_v3.wasm'),
  zkeyPath: F('zk/v3/keys/metering_v3_demo_final.zkey'),
  vkeyPath: F('zk/v3/keys/metering_v3_demo_vkey.json'),
  expected: {
    wasm: `0x${M.files['zk/v3/build/metering_v3_js/metering_v3.wasm']}` as `0x${string}`,
    zkey: `0x${M.files['zk/v3/keys/metering_v3_demo_final.zkey']}` as `0x${string}`,
    vkey: `0x${M.files['zk/v3/keys/metering_v3_demo_vkey.json']}` as `0x${string}`,
  },
};
const tmp = mkdtempSync(path.join(os.tmpdir(), 'otk-a-v3-'));
after(async () => { rmSync(tmp, { recursive: true, force: true }); await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate(); });

const W = 1_000_000_000n;
const U64 = 1n << 64n;
const base = { usage: '120000000', blinding: '987654321', userRef: '42', epoch: '497443', minUsage: '0', maxUsage: (W - 1n).toString() };
let n = 0;
async function witness(input: Record<string, string>): Promise<string> {
  const f = path.join(tmp, `w${n++}.wtns`);
  await snarkjs.wtns.calculate(input, ART.wasmPath, f);
  return f;
}
const silent = { info() {}, warn() {}, error() {}, debug() {} };

test('D2-G04 positives: 0, window edges, 2^64−1 satisfy the r1cs; output = TS commitment', async () => {
  const cases = [
    base,
    { ...base, usage: '0' },
    { ...base, usage: (W - 1n).toString() },
    { ...base, usage: (U64 - 1n).toString(), minUsage: (U64 - 1n).toString(), maxUsage: (U64 - 1n).toString() },
    { ...base, blinding: (BN254_R - 1n).toString(), userRef: (BN254_R - 1n).toString() },
  ];
  for (const c of cases) {
    const f = await witness(c);
    assert.equal(await snarkjs.wtns.check(F('zk/v3/build/metering_v3.r1cs'), f, silent), true);
    const w = await snarkjs.wtns.exportJson(f);
    const expected = await poseidonHash([TAG_V3, BigInt(c.usage), BigInt(c.blinding), BigInt(c.userRef), BigInt(c.epoch)]);
    assert.equal(BigInt(w[1]), expected, 'pubSignal[0] commitment');
    assert.deepEqual([w[2], w[3], w[4]].map(String), [c.epoch, c.minUsage, c.maxUsage]);
  }
});

test('D2-G04 negatives: below/above window, 2^64, p−5 (N7), min>max, max ≥ 2^64', async () => {
  const bad: Array<[string, Record<string, string>]> = [
    ['usage < min', { ...base, usage: '5', minUsage: '10', maxUsage: '20' }],
    ['usage > max', { ...base, usage: W.toString() }],
    ['usage = 2^64', { ...base, usage: U64.toString(), minUsage: '0', maxUsage: (U64 - 1n).toString() }],
    ['usage = p − 5 (N7 case)', { ...base, usage: (BN254_R - 5n).toString(), minUsage: '0', maxUsage: '100' }],
    ['min > max', { ...base, usage: '15', minUsage: '20', maxUsage: '10' }],
    ['max = 2^64', { ...base, usage: '15', minUsage: '0', maxUsage: U64.toString() }],
    ['min = p − 1', { ...base, usage: '15', minUsage: (BN254_R - 1n).toString(), maxUsage: '20' }],
  ];
  for (const [name, input] of bad) {
    await assert.rejects(witness(input), (e: Error) => /Assert Failed|Error in template|Not enough values|Too many values/i.test(String(e?.message ?? e)), name);
  }
});

/**
 * Overwrites witness signal `index` (32-byte LE field element) in a .wtns file.
 *
 * @param src - Witness file to read (not modified).
 * @param dst - Path of the tampered copy to write.
 * @param index - Zero-based signal index in the witness section.
 * @param value - New field element value; only its low bytes, up to the element size declared by the file, are written.
 */
function tamperWtns(src: string, dst: string, index: number, value: bigint): void {
  const b = Buffer.from(readFileSync(src));
  let off = 12; // "wtns" + version + nSections
  let n8 = 0;
  for (;;) {
    const type = b.readUInt32LE(off); const size = Number(b.readBigUInt64LE(off + 4)); off += 12;
    if (type === 1) n8 = b.readUInt32LE(off);
    if (type === 2) {
      const at = off + index * n8;
      for (let i = 0; i < n8; i++) b[at + i] = Number((value >> BigInt(8 * i)) & 0xffn);
      writeFileSync(dst, b);
      return;
    }
    off += size;
  }
}

test('D2-G04 at R1CS level: a witness with usage = p − 5 (N7) or a changed blinding fails wtns check', async () => {
  // Signal indices from zk/v3/build/metering_v3.sym: 1 commitment, 2 epoch, 3 minUsage, 4 maxUsage, 5 usage, 6 blinding, 7 userRef.
  const good = await witness(base);
  const r1cs = F('zk/v3/build/metering_v3.r1cs');
  assert.equal(await snarkjs.wtns.check(r1cs, good, silent), true, 'control: untouched witness satisfies the r1cs');
  const bad1 = path.join(tmp, 'tampered_usage.wtns');
  tamperWtns(good, bad1, 5, BN254_R - 5n);
  assert.equal(await snarkjs.wtns.check(r1cs, bad1, silent), false, 'usage = p − 5 must violate the R1CS');
  const bad2 = path.join(tmp, 'tampered_blinding.wtns');
  tamperWtns(good, bad2, 6, 1n);
  assert.equal(await snarkjs.wtns.check(r1cs, bad2, silent), false, 'blinding change without recomputing the commitment must violate the R1CS');
});

test('D6-G01: adapter refuses mismatching artifact hashes and a vkey that is not the zkey key', async () => {
  await assert.rejects(createProofAdapterV3({ ...ART, expected: { ...ART.expected, zkey: `0x${'00'.repeat(32)}` } }), ArtifactMismatchError);
  await assert.rejects(createProofAdapterV3({ ...ART, expected: { ...ART.expected, wasm: `0x${'00'.repeat(32)}` } }), ArtifactMismatchError);
  // historical v2 vkey presented as if it were the manifest's: the embedded-key comparison catches it
  const v2vkey = F('zk/keys/metering_v2_vkey_mpc.json');
  const v2hash = `0x${(await import('node:crypto')).createHash('sha256').update(readFileSync(v2vkey)).digest('hex')}` as `0x${string}`;
  await assert.rejects(createProofAdapterV3({ ...ART, vkeyPath: v2vkey, expected: { ...ART.expected, vkey: v2hash } }), /embedded in zkey differs/);
});

test('D6-G02 (local): real proof from the opening verifies; altered signal or other vkey does not; submission encodes exact signals', async () => {
  const adapter = await createProofAdapterV3(ART);
  const op = ethers.Wallet.createRandom();
  const ring = createKeyRing([{ keyId: 'op-1', address: op.address as `0x${string}`, status: 'active' }]);
  const build = createPublicAuthorizationBuilder({ keyRing: ring, signer: { keyId: 'op-1', wallet: op }, policy: POLICY, circuitId: ART.circuitId });
  const r = receiptFixture({ circuitId: ART.circuitId, cuUnits: 640n });
  const opening = newCommitmentOpening(r.key, r.cu.cu!, ART.circuitId, { userRef: r.userRef, epoch: epochOf(r.timing.admittedAt).toString() });
  r.publicCommitment = await commitmentOf(opening);
  const domain = { chainId: 31337n, registry: '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const, verifier: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const, schemaVersion: REGISTRY_V3_SCHEMA };
  const auth = await build({ receipt: r, opening, domain, bucket: bucketForReceipt(r, POLICY) });
  const input = adapter.buildWitnessInput(opening, auth);
  assert.deepEqual(Object.keys(input).sort(), ['blinding', 'epoch', 'maxUsage', 'minUsage', 'usage', 'userRef']);
  const bundle = await adapter.prove(input);
  assert.deepEqual(bundle.publicSignals, [auth.commitment, auth.epoch.toString(), '0', (W - 1n).toString()]);
  assert.equal(await adapter.verifyLocal(bundle), true);
  assert.equal(await adapter.verifyLocal({ ...bundle, publicSignals: [auth.commitment, auth.epoch.toString(), '0', (2n * W - 1n).toString()] }), false);
  assert.equal(await adapter.verifyLocal({ ...bundle, artifacts: { ...bundle.artifacts, vkey: `0x${'11'.repeat(32)}` } }), false);
  const sub = adapter.encodeSubmission(auth, bundle);
  assert.equal(sub.functionName, 'submitReceipt');
  assert.deepEqual((sub.args[2] as { pubSignals: string[] }).pubSignals, bundle.publicSignals);
  assert.throws(() => adapter.encodeSubmission({ ...auth, commitment: '1' }, bundle), /public signals do not match/);
  // witness for an opening outside the authorized window is refused before proving
  assert.throws(() => adapter.buildWitnessInput(opening, { ...auth, bucket: { ...auth.bucket, min: W, max: 2n * W - 1n } }), /outside the authorized bucket/);
});

test('D2-G03 sanity check (not a privacy proof): the old N13 equality test with naive blinding guesses finds nothing on v3 public data', async () => {
  const r = receiptFixture({ circuitId: ART.circuitId, cuUnits: 640n });
  const opening = newCommitmentOpening(r.key, r.cu.cu!, ART.circuitId, { userRef: r.userRef, epoch: epochOf(r.timing.admittedAt).toString() });
  const target = BigInt(await commitmentOf(opening));
  const epoch = epochOf(r.timing.admittedAt);
  // Attacker knows the old domain (0..640 CU), even the userRef, and tries the "public-looking"
  // values that legacy code used in the nonce slot. The blinding is a uniform 254-bit secret.
  const guesses = [0n, 1n, epoch, 42n];
  let hits = 0;
  for (let cu = 0n; cu <= 640n; cu++) {
    for (const g of guesses) if ((await poseidonHash([TAG_V3, cu * 1_000_000n, g, 42n, epoch])) === target) hits++;
  }
  assert.equal(hits, 0);
  // Control: with the secret blinding the opening does verify.
  assert.equal(await poseidonHash([TAG_V3, 640_000_000n, BigInt(opening.blinding), 42n, epoch]), target);
});
