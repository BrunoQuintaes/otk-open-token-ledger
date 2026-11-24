/**
 * D2-G02 / D2-G05 / D1-G01 (TS side) — commitment opening, public bucket policy and public
 * authorization for ReceiptRegistryV3 (front A, run 20260930-1625).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  authorizationDigest, BN254_R, bucketFor, bucketPolicyId, circuitIdHash, commitmentOf, createKeyRing, createPublicAuthorizationBuilder,
  epochOf, newCommitmentOpening, operationRefOfOpening, PUBLIC_BUCKET_POLICY_FIXED_1000CU as POLICY, randomFieldElement, usageToCircuitUnits,
  verifyPublicAuthorization, bucketForReceipt, REGISTRY_V3_SCHEMA, TAG_V3, authorizationValues, typedDomain, REGISTRY_V3_NAME, AUTHORIZATION_TYPES,
} from '../../src/zk/v3/index.js';
import type { ChainDomain, PrivateReceiptV3 } from '../../src/types/d1d8/index.js';
import { receiptFixture } from '../fixtures/d1d8/a/receiptFixture.js';

const CIRCUIT = 'metering_v3@sha256:test';
const op = ethers.Wallet.createRandom();
const ring = createKeyRing([{ keyId: 'op-1', address: op.address as `0x${string}`, status: 'active' }]);
const build = createPublicAuthorizationBuilder({ keyRing: ring, signer: { keyId: 'op-1', wallet: op }, policy: POLICY, circuitId: CIRCUIT });
const EXPECT = { circuitId: CIRCUIT, policy: POLICY };
const DOMAIN: ChainDomain = { chainId: 31337n, registry: '0x5FbDB2315678afecb367f032d93F642f64180aa3', verifier: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', schemaVersion: REGISTRY_V3_SCHEMA };

async function prepared(over: Parameters<typeof receiptFixture>[0] = { circuitId: CIRCUIT }) {
  const r = receiptFixture(over);
  const opening = newCommitmentOpening(r.key, r.cu.cu!, CIRCUIT, { userRef: r.userRef, epoch: epochOf(r.timing.admittedAt).toString() });
  r.publicCommitment = await commitmentOf(opening);
  return { r, opening };
}

test('TAG_V3 equals ASCII "otk.metering.v3" (same constant as the circuit)', () => {
  assert.equal(TAG_V3, BigInt('0x' + Buffer.from('otk.metering.v3', 'ascii').toString('hex')));
});

test('unit mapping: exact micro-CU, finer scale or 2^64 refused', () => {
  assert.equal(usageToCircuitUnits({ units: 120n, scale: 1n }), 120_000_000n);
  assert.equal(usageToCircuitUnits({ units: 120_500n, scale: 1000n }), 120_500_000n);
  assert.equal(usageToCircuitUnits({ units: 0n, scale: 1n }), 0n);
  assert.throws(() => usageToCircuitUnits({ units: 1n, scale: 10_000_000n }), /lose digits/);
  assert.throws(() => usageToCircuitUnits({ units: 1n, scale: 3n }), /power of ten/);
  assert.throws(() => usageToCircuitUnits({ units: -1n, scale: 1n }), /negative/);
  assert.throws(() => usageToCircuitUnits({ units: (1n << 64n), scale: 1_000_000n }), /2\^64/);
  assert.equal(usageToCircuitUnits({ units: (1n << 64n) - 1n, scale: 1_000_000n }), (1n << 64n) - 1n);
});

test('bucket policy: fixed aligned 1000-CU windows, hand values', () => {
  assert.deepEqual(bucketFor(POLICY, 0n), { min: 0n, max: 999_999_999n, policyVersion: POLICY.version });
  assert.deepEqual(bucketFor(POLICY, 120_000_000n), { min: 0n, max: 999_999_999n, policyVersion: POLICY.version });
  assert.deepEqual(bucketFor(POLICY, 999_999_999n), { min: 0n, max: 999_999_999n, policyVersion: POLICY.version });
  assert.deepEqual(bucketFor(POLICY, 1_000_000_000n), { min: 1_000_000_000n, max: 1_999_999_999n, policyVersion: POLICY.version });
  assert.deepEqual(bucketFor(POLICY, 3_050_000_000n), bucketFor(POLICY, 3_000_000_000n)); // 3 050 CU and 3 000 CU publish the same window
  assert.throws(() => bucketFor(POLICY, (1n << 64n) - 1n), /2\^64/); // last partial window not representable
});

test('D2-G02: independent openings of the same usage → distinct commitments; caller cannot pick blinding', async () => {
  const r = receiptFixture({ circuitId: CIRCUIT });
  const inputs = { userRef: '42', epoch: epochOf(r.timing.admittedAt).toString() };
  const a = newCommitmentOpening(r.key, r.cu.cu!, CIRCUIT, inputs);
  const b = newCommitmentOpening(r.key, r.cu.cu!, CIRCUIT, inputs);
  assert.notEqual(a.blinding, b.blinding);
  assert.notEqual(a.privateInputs['opRefSalt'], b.privateInputs['opRefSalt']);
  assert.notEqual(await commitmentOf(a), await commitmentOf(b));
  assert.notEqual(operationRefOfOpening(a), operationRefOfOpening(b));
  assert.equal(await commitmentOf(a), await commitmentOf(structuredClone(a))); // opening verifies deterministically
  const tampered = structuredClone(a); tampered.usage.units += 1n;
  assert.notEqual(await commitmentOf(tampered), await commitmentOf(a));
  assert.throws(() => newCommitmentOpening(r.key, r.cu.cu!, CIRCUIT, { ...inputs, blinding: '1' }), /unexpected inputs blinding/);
  assert.throws(() => newCommitmentOpening(r.key, r.cu.cu!, 'metering_v2', inputs), /only metering_v3/);
  assert.throws(() => newCommitmentOpening(r.key, r.cu.cu!, CIRCUIT, { ...inputs, userRef: BN254_R.toString() }), /field order/);
  assert.throws(() => newCommitmentOpening(r.key, r.cu.cu!, CIRCUIT, { ...inputs, epoch: '0x10' }), /canonical/);
});

test('D2-G02: CSPRNG field elements are in range and not repeated in 2000 draws', () => {
  const seen = new Set<bigint>();
  for (let i = 0; i < 2000; i++) { const x = randomFieldElement(); assert.ok(x >= 0n && x < BN254_R); seen.add(x); }
  assert.equal(seen.size, 2000);
});

test('D1-G01 (TS): authorization digest equals an independent abi.encode EIP-712 computation', async () => {
  const { r, opening } = await prepared();
  const auth = await build({ receipt: r, opening, domain: DOMAIN, bucket: bucketForReceipt(r, POLICY) });
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const typeHash = ethers.id('Authorization(bytes32 circuitId,address verifier,uint256 commitment,uint64 epoch,uint64 minUsage,uint64 maxUsage,bytes32 bucketPolicy,bytes32 operationRef)');
  const domainSep = ethers.keccak256(coder.encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'], [
    ethers.id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), ethers.id('OTK ReceiptRegistryV3'), ethers.id('otk.registry.v3'), 31337n, DOMAIN.registry,
  ]));
  const structHash = ethers.keccak256(coder.encode(['bytes32', 'bytes32', 'address', 'uint256', 'uint64', 'uint64', 'uint64', 'bytes32', 'bytes32'], [
    typeHash, ethers.id(CIRCUIT), DOMAIN.verifier, BigInt(auth.commitment), 497443n, 0n, 999_999_999n, ethers.id(POLICY.version), auth.operationRef,
  ]));
  assert.equal(auth.epoch, 497443n); // 2026-09-30T19:00Z: date -u +%s / 3600 = 497443
  const manual = ethers.keccak256(ethers.concat(['0x1901', domainSep, structHash]));
  assert.equal(auth.authorizationDigest, manual);
  assert.equal(ethers.recoverAddress(manual, auth.signature.signature), op.address);
  assert.deepEqual(verifyPublicAuthorization(auth, ring, EXPECT), { ok: true, signer: op.address, keyId: 'op-1' });
  assert.equal(auth.replayKey, auth.operationRef);
  assert.deepEqual(auth.fields.map((f) => f.name), ['circuitId', 'verifier', 'commitment', 'epoch', 'minUsage', 'maxUsage', 'bucketPolicy', 'operationRef']);
  assert.equal(circuitIdHash(CIRCUIT), ethers.id(CIRCUIT));
  assert.equal(bucketPolicyId(POLICY), ethers.id(POLICY.version));
});

test('D1-G04 (TS): another chain, registry or schema → another digest', async () => {
  const { r, opening } = await prepared();
  const auth = await build({ receipt: r, opening, domain: DOMAIN, bucket: bucketForReceipt(r, POLICY) });
  const v = { circuitId: ethers.id(CIRCUIT) as `0x${string}`, verifier: DOMAIN.verifier, commitment: BigInt(auth.commitment), epoch: auth.epoch, minUsage: auth.bucket.min, maxUsage: auth.bucket.max, bucketPolicy: ethers.id(POLICY.version) as `0x${string}`, operationRef: auth.operationRef };
  assert.equal(authorizationDigest(DOMAIN, v), auth.authorizationDigest);
  assert.notEqual(authorizationDigest({ ...DOMAIN, chainId: 1337n }, v), auth.authorizationDigest);
  assert.notEqual(authorizationDigest({ ...DOMAIN, registry: '0x0000000000000000000000000000000000000001' }, v), auth.authorizationDigest);
  assert.notEqual(authorizationDigest({ ...DOMAIN, schemaVersion: 'otk.registry.v4' }, v), auth.authorizationDigest);
});

test('binding checks: the builder refuses public data that does not match the private receipt', async () => {
  const { r, opening } = await prepared();
  const bucket = bucketForReceipt(r, POLICY);
  const tryBuild = (rr: PrivateReceiptV3, o = opening, b = bucket, d = DOMAIN) => build({ receipt: rr, opening: o, domain: d, bucket: b });
  await assert.rejects(tryBuild({ ...r, publicCommitment: '1' }), /publicCommitment/);
  await assert.rejects(tryBuild({ ...r, publicCommitment: null }), /publicCommitment/);
  await assert.rejects(tryBuild({ ...r, key: { ...r.key, tenantId: 'tenant-test-b' } }), /another operation/);
  await assert.rejects(tryBuild({ ...r, userRef: '43' }), /userRef/);
  await assert.rejects(tryBuild({ ...r, cu: { ...r.cu, cu: { units: 121n, scale: 1n } } }), /exact CU/);
  await assert.rejects(tryBuild({ ...r, cu: { ...r.cu, status: 'unsupported_model', cu: null } }), /not computed/);
  await assert.rejects(tryBuild({ ...r, timing: { ...r.timing, admittedAt: '2026-09-30T21:00:00.000Z' } }), /epoch/);
  await assert.rejects(tryBuild({ ...r, config: { ...r.config, circuitId: 'metering_v3@sha256:other' } }), /explicit version selection/);
  await assert.rejects(tryBuild(r, opening, { ...bucket, min: 100_000_000n }), /policy window/);
  await assert.rejects(tryBuild(r, opening, { ...bucket, max: 120_000_000n }), /policy window/); // narrow window would reveal usage
  await assert.rejects(tryBuild(r, opening, bucket, { ...DOMAIN, schemaVersion: 'otk.registry.v2' }), /schemaVersion/);
  await assert.rejects(tryBuild(r, opening, bucket, { ...DOMAIN, verifier: '0x0000000000000000000000000000000000000000' }), /zero address/);
  const revokedRing = createKeyRing([{ keyId: 'op-1', address: op.address as `0x${string}`, status: 'revoked' }]);
  const b2 = createPublicAuthorizationBuilder({ keyRing: revokedRing, signer: { keyId: 'op-1', wallet: op }, policy: POLICY, circuitId: CIRCUIT });
  await assert.rejects(b2({ receipt: r, opening, domain: DOMAIN, bucket }), /not an active key/);
});

test('verifyPublicAuthorization: altered summary fields, digest or signer are rejected', async () => {
  const { r, opening } = await prepared();
  const auth = await build({ receipt: r, opening, domain: DOMAIN, bucket: bucketForReceipt(r, POLICY) });
  assert.equal((verifyPublicAuthorization({ ...auth, commitment: '5' }, ring, EXPECT) as { reason: string }).reason, 'binding_mismatch');
  const f = structuredClone(auth); f.fields[2]!.value = '5'; f.commitment = '5';
  assert.equal((verifyPublicAuthorization(f, ring, EXPECT) as { reason: string }).reason, 'digest_mismatch');
  const stranger = ethers.Wallet.createRandom();
  const sig = await stranger.signTypedData({ name: 'OTK ReceiptRegistryV3', version: 'otk.registry.v3', chainId: 31337n, verifyingContract: DOMAIN.registry },
    { Authorization: [{ name: 'circuitId', type: 'bytes32' }, { name: 'verifier', type: 'address' }, { name: 'commitment', type: 'uint256' }, { name: 'epoch', type: 'uint64' }, { name: 'minUsage', type: 'uint64' }, { name: 'maxUsage', type: 'uint64' }, { name: 'bucketPolicy', type: 'bytes32' }, { name: 'operationRef', type: 'bytes32' }] },
    { circuitId: ethers.id(CIRCUIT), verifier: DOMAIN.verifier, commitment: BigInt(auth.commitment), epoch: auth.epoch, minUsage: auth.bucket.min, maxUsage: auth.bucket.max, bucketPolicy: ethers.id(POLICY.version), operationRef: auth.operationRef });
  assert.equal((verifyPublicAuthorization({ ...auth, signature: { ...auth.signature, signature: sig as `0x${string}` } }, ring, EXPECT) as { reason: string }).reason, 'unauthorized_signer');
});

test('verifyPublicAuthorization mirrors the registry: policy, window, circuit, active key, envelope signer', async () => {
  const { r, opening } = await prepared();
  const auth = await build({ receipt: r, opening, domain: DOMAIN, bucket: bucketForReceipt(r, POLICY) });
  const reason = (x: ReturnType<typeof verifyPublicAuthorization>) => (x as { reason: string }).reason;
  assert.equal(reason(verifyPublicAuthorization(auth, ring, { ...EXPECT, circuitId: 'metering_v3@sha256:other' })), 'binding_mismatch');
  assert.equal(reason(verifyPublicAuthorization(auth, ring, { ...EXPECT, policy: { ...POLICY, version: 'other@1' } })), 'binding_mismatch');
  // operator-signed narrow window (valid signature) is refused off-chain as on-chain
  const vals = { ...authorizationValues(auth), minUsage: 120_000_000n, maxUsage: 120_000_000n };
  const narrow = structuredClone(auth);
  narrow.bucket = { ...narrow.bucket, min: vals.minUsage, max: vals.maxUsage };
  narrow.fields = narrow.fields.map((f) => (f.name === 'minUsage' || f.name === 'maxUsage' ? { ...f, value: String(vals[f.name]) } : f));
  narrow.authorizationDigest = authorizationDigest(DOMAIN, vals);
  narrow.signature = { ...narrow.signature, payloadDigest: narrow.authorizationDigest, signature: (await op.signTypedData(typedDomain(DOMAIN, REGISTRY_V3_NAME), AUTHORIZATION_TYPES as never, vals)) as `0x${string}` };
  assert.equal(reason(verifyPublicAuthorization(narrow, ring, EXPECT)), 'binding_mismatch');
  // envelope claims another signer / keyId than the recovered key
  assert.equal(reason(verifyPublicAuthorization({ ...auth, signature: { ...auth.signature, keyId: 'op-x' } }, ring, EXPECT)), 'binding_mismatch');
  // retired key: not accepted off-chain for public authorizations
  const retiredRing = createKeyRing([{ keyId: 'op-1', address: op.address as `0x${string}`, status: 'retired', retiredAt: '2026-12-31T00:00:00.000Z' }]);
  assert.equal(reason(verifyPublicAuthorization(auth, retiredRing, EXPECT)), 'revoked_key');
});

test('epochOf: strict ISO-8601 UTC (no host-timezone parsing)', () => {
  assert.equal(epochOf('2026-09-30T19:00:00.000Z'), 497443n);
  assert.equal(epochOf('2026-09-30T19:59:59Z'), 497443n);
  assert.throws(() => epochOf('2026-09-30T19:00:00'), /UTC with Z/);
  assert.throws(() => epochOf('2026-09-30'), /UTC with Z/);
  assert.throws(() => epochOf('2026-09-30T16:00:00-03:00'), /UTC with Z/);
});

test('D2-G05 (A side): the public authorization carries no exact usage, tenant, operation, user or opening secret', async () => {
  const { r, opening } = await prepared({ circuitId: CIRCUIT, cuUnits: 640n, tenantId: 'tenant-zz-unique', operationId: 'op-zz-unique' });
  const auth = await build({ receipt: r, opening, domain: DOMAIN, bucket: bucketForReceipt(r, POLICY) });
  const pub = JSON.stringify(auth, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  // Exact usage: no public leaf value equals it (substring search would collide with random hex).
  const leaves: string[] = [];
  const walk = (x: unknown): void => { if (x && typeof x === 'object') Object.values(x).forEach(walk); else leaves.push(String(x)); };
  walk(JSON.parse(pub));
  for (const exact of ['640', '640000000']) assert.ok(!leaves.includes(exact), `public authorization exposes usage ${exact}`);
  // Long unique private strings: substring search is safe.
  for (const secret of ['tenant-zz-unique', 'op-zz-unique', opening.blinding, opening.privateInputs['opRefSalt']!]) {
    assert.ok(!pub.includes(secret), `public authorization leaks ${secret.slice(0, 12)}`);
  }
  assert.ok(!pub.includes('"userRef"'));
  // The exact usage stays in the private receipt and the opening (accounting is exact).
  assert.equal(r.cu.cu!.units, 640n);
  assert.equal(opening.usage.units, 640_000_000n);
});
