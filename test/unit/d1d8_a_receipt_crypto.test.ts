/**
 * D3-G01 / D1-G01 (receipt side) — CE1 encoding, receipt v3 and conference v1 signatures,
 * legacy verification with the original algorithms (front A, run 20260930-1625).
 * Expected bytes below are written by hand from the CE1 table in A/01_design.md §5.
 *
 * Modules under test: `src/receipt/v3/canonicalEncoding.ts`, `src/receipt/v3/receiptCrypto.ts`,
 * `src/receipt/v3/keyRing.ts`, and for the legacy case `src/metering/SignatureManager.ts` and
 * `src/receipt/canonicalReceiptV1.ts`.
 *
 * Strategy / partitions: CE1 bytes for each value type; refused inputs (JS numbers, undefined,
 * lone surrogates, dates, sparse arrays); different domains give different digests; a v3
 * receipt that verifies, and one changed in count, version, tenant, binding or configuration;
 * envelopes with the wrong domain, a forged signer, and unknown, revoked or retired keys; key
 * ring rules (one entry per address, a retired key needs a retirement time); conference
 * statements whose coverage or count changes, or that are moved to another receipt; legacy raw
 * and V1 receipts still verify with the original algorithms.
 *
 * Needs: nothing external (in-memory keys and a fixed clock; no network).
 *
 * Run just this file: `npx tsx --test test/unit/d1d8_a_receipt_crypto.test.ts`
 *
 * @module test/unit/d1d8_a_receipt_crypto.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { encodeCE1, domainDigest, CanonicalEncodingError } from '../../src/receipt/v3/canonicalEncoding.js';
import { createReceiptCrypto, digestReceiptV3, envelopeDigest } from '../../src/receipt/v3/receiptCrypto.js';
import { createKeyRing } from '../../src/receipt/v3/keyRing.js';
import { sign as signRaw, canonicalHash } from '../../src/metering/SignatureManager.js';
import { hashCanonicalReceiptV1 } from '../../src/receipt/canonicalReceiptV1.js';
import type { RawReceipt } from '../../src/types/receipt.js';
import type { PrivateReceiptV3, SignedEnvelope } from '../../src/types/d1d8/index.js';
import { conferenceFixture, receiptFixture } from '../fixtures/d1d8/a/receiptFixture.js';

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const CIRCUIT = 'metering_v3@sha256:test';
const op = ethers.Wallet.createRandom();
const other = ethers.Wallet.createRandom();
const retiredW = ethers.Wallet.createRandom();
const revokedW = ethers.Wallet.createRandom();
const ring = createKeyRing([
  { keyId: 'op-2026-09', address: op.address as `0x${string}`, status: 'active' },
  { keyId: 'op-2026-08', address: retiredW.address as `0x${string}`, status: 'retired', retiredAt: '2026-09-30T19:00:03.500Z' },
  { keyId: 'op-2026-07', address: revokedW.address as `0x${string}`, status: 'revoked' },
]);
const fixedNow = () => new Date('2026-09-30T19:00:03.000Z');
const rc = createReceiptCrypto({ keyRing: ring, signer: { keyId: 'op-2026-09', wallet: op }, now: fixedNow });

test('CE1: hand-computed bytes for object, bigint, string, null, bool, array', () => {
  assert.equal(hex(encodeCE1({ b: 'x', a: 1n, c: null })),
    '06' + '00000003' + '04' + '00000001' + '61' + '03' + '00' + '00000001' + '01'
    + '04' + '00000001' + '62' + '04' + '00000001' + '78' + '04' + '00000001' + '63' + '00');
  assert.equal(hex(encodeCE1(0n)), '03' + '00' + '00000000');
  assert.equal(hex(encodeCE1(-256n)), '03' + '01' + '00000002' + '0100');
  assert.equal(hex(encodeCE1([true, false])), '05' + '00000002' + '02' + '01');
  assert.equal(hex(encodeCE1('é')), '04' + '00000002' + 'c3a9');
  // keys sorted by UTF-8 bytes: "B" (0x42) < "a" (0x61) < "aa" < "b"
  assert.equal(hex(encodeCE1({ b: null, aa: null, a: null, B: null })),
    '06' + '00000004' + '04000000014200' + '04000000016100' + '0400000002616100' + '04000000016200');
});

test('CE1: refuses JS numbers, undefined and lone surrogates (absent never becomes 0)', () => {
  assert.throws(() => encodeCE1({ a: 1 }), CanonicalEncodingError);
  assert.throws(() => encodeCE1({ a: undefined }), CanonicalEncodingError);
  assert.throws(() => encodeCE1('\ud800'), CanonicalEncodingError);
  assert.throws(() => encodeCE1(new Date()), CanonicalEncodingError);
  // sparse array: a hole must not be skipped (count 3 with 2 items would be ambiguous)
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => encodeCE1([1n, , 2n]), CanonicalEncodingError);
  const extra = Object.assign([1n], { note: 'ignored?' });
  assert.throws(() => encodeCE1(extra), CanonicalEncodingError);
  // null and 0n are different encodings
  assert.notEqual(hex(encodeCE1({ a: null })), hex(encodeCE1({ a: 0n })));
});

test('CE1: domain separation — same payload, different domains → different digests', () => {
  assert.notEqual(domainDigest('OTK_PRIVATE_RECEIPT_V3', { a: 1n }), domainDigest('OTK_CONFERENCE_V1', { a: 1n }));
  assert.equal(domainDigest('X', { a: 1n }), ethers.keccak256(ethers.concat([ethers.toUtf8Bytes('X'), '0x00', encodeCE1({ a: 1n })])));
});

test('D3-G01 receipt v3: sign → verify ok; envelope binds domain, key and time', async () => {
  const r = receiptFixture({ circuitId: CIRCUIT, publicCommitment: '123' });
  const env = await rc.signReceipt(r);
  assert.equal(env.domain, 'OTK_PRIVATE_RECEIPT_V3');
  assert.equal(env.alg, 'eip191-secp256k1');
  assert.equal(env.payloadDigest, digestReceiptV3(r));
  assert.equal(env.signedAt, '2026-09-30T19:00:03.000Z');
  assert.equal(ethers.verifyMessage(ethers.getBytes(envelopeDigest(env)), env.signature), op.address);
  assert.deepEqual(rc.verifyReceipt(r, env), { ok: true, signer: op.address, keyId: 'op-2026-09' });
});

test('D3-G01 receipt v3: changing count, version, tenant, binding or config invalidates', async () => {
  const r = receiptFixture({ circuitId: CIRCUIT, publicCommitment: '123' });
  const env = await rc.signReceipt(r);
  const mutate = (f: (x: PrivateReceiptV3) => void) => { const c = structuredClone(r); f(c); return c; };
  const cases: Array<[string, PrivateReceiptV3]> = [
    ['input count', mutate((x) => { x.usage.categories[0]!.count = 101n; })],
    ['absent → zero', mutate((x) => { x.usage.categories[2]!.count = 0n; })],
    ['tenant', mutate((x) => { x.key.tenantId = 'tenant-test-b'; })],
    ['operation', mutate((x) => { x.key.operationId = 'op-0002'; })],
    ['public commitment link', mutate((x) => { x.publicCommitment = '124'; })],
    ['cu weights version', mutate((x) => { x.config.cuWeights.version = 'cw-test-2026-09-30.2'; })],
    ['exact CU', mutate((x) => { x.cu.cu = { units: 121n, scale: 1n }; })],
    ['source/origin', mutate((x) => { x.source = 'client_declared'; })],
  ];
  for (const [name, c] of cases) {
    const v = rc.verifyReceipt(c, env);
    assert.equal(v.ok, false, name);
    assert.equal((v as { reason: string }).reason, 'digest_mismatch', name);
  }
  const wrongSchema = mutate((x) => { (x as { schema: string }).schema = 'otk.receipt.v2'; });
  assert.equal((rc.verifyReceipt(wrongSchema, env) as { reason: string }).reason, 'unsupported_version');
  const withContent = mutate((x) => { (x as { contentDigests: unknown }).contentDigests = { prompt: '0x00' }; });
  assert.equal((rc.verifyReceipt(withContent, env) as { reason: string }).reason, 'malformed');
});

test('D3-G01 envelope: wrong domain, forged signer, unknown/revoked/retired keys', async () => {
  const r = receiptFixture({ circuitId: CIRCUIT });
  const env = await rc.signReceipt(r);
  assert.equal((rc.verifyReceipt(r, { ...env, domain: 'OTK_CONFERENCE_V1' }) as { reason: string }).reason, 'wrong_domain');
  assert.equal((rc.verifyReceipt(r, { ...env, keyId: 'nope' }) as { reason: string }).reason, 'unauthorized_signer');
  assert.equal((rc.verifyReceipt(r, { ...env, signedAt: '2026-09-30T19:00:04.000Z' }) as { reason: string }).reason, 'bad_signature');
  // signature by a key that is not in the ring, claiming the operator key id
  const forged = { ...env, signature: (await other.signMessage(ethers.getBytes(envelopeDigest(env)))) as `0x${string}` };
  assert.equal((rc.verifyReceipt(r, forged) as { reason: string }).reason, 'bad_signature');
  // retired key: historical signature verifies, new signatures are refused
  const retiredRc = createReceiptCrypto({ keyRing: ring, signer: { keyId: 'op-2026-08', wallet: retiredW }, now: fixedNow });
  await assert.rejects(retiredRc.signReceipt(r), /not active/);
  const retiredEnv: SignedEnvelope = { ...env, signer: retiredW.address as `0x${string}`, keyId: 'op-2026-08', signature: '0x' as `0x${string}` };
  retiredEnv.signature = (await retiredW.signMessage(ethers.getBytes(envelopeDigest(retiredEnv)))) as `0x${string}`;
  assert.equal(rc.verifyReceipt(r, retiredEnv).ok, true); // signedAt 19:00:03.000 ≤ retiredAt 19:00:03.500
  const lateEnv: SignedEnvelope = { ...retiredEnv, signedAt: '2026-09-30T19:00:04.000Z' };
  lateEnv.signature = (await retiredW.signMessage(ethers.getBytes(envelopeDigest(lateEnv)))) as `0x${string}`;
  assert.equal((rc.verifyReceipt(r, lateEnv) as { reason: string }).reason, 'revoked_key', 'retired key cannot sign after retiredAt');
  const looseTime: SignedEnvelope = { ...env, signedAt: '2026-09-30 19:00:03' };
  assert.equal((rc.verifyReceipt(r, looseTime) as { reason: string }).reason, 'malformed');
  const revokedEnv: SignedEnvelope = { ...env, signer: revokedW.address as `0x${string}`, keyId: 'op-2026-07', signature: '0x' as `0x${string}` };
  revokedEnv.signature = (await revokedW.signMessage(ethers.getBytes(envelopeDigest(revokedEnv)))) as `0x${string}`;
  assert.equal((rc.verifyReceipt(r, revokedEnv) as { reason: string }).reason, 'revoked_key');
});

test('KeyRing: one entry per address (no revocation bypass by keyId choice); retired needs retiredAt', () => {
  assert.throws(() => createKeyRing([
    { keyId: 'op-A', address: op.address as `0x${string}`, status: 'revoked' },
    { keyId: 'op-A-old', address: op.address.toLowerCase() as `0x${string}`, status: 'retired', retiredAt: '2026-01-01T00:00:00.000Z' },
  ]), /already registered/);
  assert.throws(() => createKeyRing([{ keyId: 'x', address: op.address as `0x${string}`, status: 'retired' }]), /needs retiredAt/);
});

test('D3-G01/D3-G06 conference: coverage/count change invalidates; swap between receipts refused', async () => {
  const r1 = receiptFixture({ circuitId: CIRCUIT, operationId: 'op-0001' });
  const r2 = receiptFixture({ circuitId: CIRCUIT, operationId: 'op-0002' });
  const rep = conferenceFixture(digestReceiptV3(r1));
  const env = await rc.signConference(rep);
  assert.equal(rc.verifyConference(rep, env, r1).ok, true);
  const cov = structuredClone(rep); cov.uncoveredCategories = [];
  assert.equal((rc.verifyConference(cov, env, r1) as { reason: string }).reason, 'digest_mismatch');
  const cnt = structuredClone(rep); cnt.comparisons[0]!.local = 100n;
  assert.equal((rc.verifyConference(cnt, env, r1) as { reason: string }).reason, 'digest_mismatch');
  // same signed report presented with another receipt
  assert.equal((rc.verifyConference(rep, env, r2) as { reason: string }).reason, 'binding_mismatch');
  // a receipt signature is not a conference signature
  const renv = await rc.signReceipt(r1);
  assert.equal((rc.verifyConference(rep, renv, r1) as { reason: string }).reason, 'wrong_domain');
  // a report for another tenant that points to r1's digest is refused
  const otherTenant = conferenceFixture(digestReceiptV3(r1), { tenantId: 'tenant-test-b', operationId: 'op-0001' });
  const envB = await rc.signConference(otherTenant);
  assert.equal((rc.verifyConference(otherTenant, envB, r1) as { reason: string }).reason, 'binding_mismatch');
  // non-compared state with a divergence verdict cannot be signed as a seal
  const seal = structuredClone(rep); seal.state = 'incomplete';
  await assert.rejects(rc.signConference(seal), /requires state 'compared'/);
});

test('D3-G04 legacy: raw receipt canonicalHash and OTK_RECEIPT_V1 verify with the original algorithm', async () => {
  const raw: RawReceipt = {
    userId: 42n, nonce: 0n, provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 20,
    latencyMs: 900, costUnits: 120, timestamp: 1790000000000, requestId: 'req-legacy-1', cwVersion: 'static',
  } as unknown as RawReceipt;
  const sig = await signRaw(raw, op);
  assert.equal(sig.rawHash, canonicalHash(raw));
  assert.deepEqual(rc.verifyLegacy('raw_receipt_canonical_hash', raw, sig), { ok: true, signer: op.address, keyId: 'op-2026-09' });
  const tampered = { ...raw, costUnits: 1 } as unknown as RawReceipt;
  assert.equal(rc.verifyLegacy('raw_receipt_canonical_hash', tampered, sig).ok, false);
  const otherSig = await signRaw(raw, other);
  assert.equal((rc.verifyLegacy('raw_receipt_canonical_hash', raw, otherSig) as { reason: string }).reason, 'unauthorized_signer');

  const v1 = { provider: 'openai', model: 'gpt-4o', input_tokens: 100n, output_tokens: 20n, total_tokens: 120n, latency_ms: 900n, cost_unit: 120n, user_id: 'u-42', project_id: 'p-1', timestamp: 1790000000000n, nonce: 0n, epoch: 497222n };
  const h = hashCanonicalReceiptV1(v1);
  const s = await op.signMessage(ethers.getBytes(h));
  assert.equal(rc.verifyLegacy('otk_receipt_v1', v1, { rawHash: h, signature: s }).ok, true);
  assert.equal((rc.verifyLegacy('otk_receipt_v1', { ...v1, cost_unit: 1n, total_tokens: 120n }, { rawHash: h, signature: s }) as { reason: string }).reason, 'digest_mismatch');
  const revokedSig = await revokedW.signMessage(ethers.getBytes(h));
  assert.equal((rc.verifyLegacy('otk_receipt_v1', v1, { signature: revokedSig }) as { reason: string }).reason, 'revoked_key');
});
