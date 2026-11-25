/**
 * CU reference framework (OVERNIGHT 2, phase 4): invariants.
 * CU = normalized quantity of AI-service consumption; weights = p/p_ref of the frozen 2026-10 reference structure.
 * Every expected number below is computed by hand from the profile prices (micro-USD per MTok):
 *   haiku-4-5: in 1_000_000 · cache_write 1_250_000 · cache_read 100_000 · out 5_000_000
 *   gpt-4o-mini: in 150_000 · cache_read 75_000 · out 600_000
 *   gemini-3.5-flash-lite: in 300_000 · cache_read 30_000 · out 2_500_000 · reasoning 2_500_000
 *
 * Modules under test: `src/economics/cuReference.ts` (profile validation, digest, usage
 * decomposition, reference CU, ratios), with `computeCu`/`developmentCuConfig` for the legacy
 * formula, `src/pricing/priceUsage.ts` for money quotes and `src/zk/v3/index.ts` for the signed
 * statement bound to a receipt.
 *
 * Strategy / partitions: the candidate profile (valid, no normalization chosen, every entry
 * traceable to an archived source) and the final profile (reference, scale, derived weights,
 * alias resolution, no caller override); invariants: determinism, decimal rounding, independence
 * from current prices, monotonicity, category sensitivity, no double counting of cached input,
 * profile versioning, legacy immutability, replay, rescaling keeps ratios; "not computable,
 * never zero" cases (no reference, unknown model, unpriced category, audio, partial stream,
 * missing base); invalid profiles (no reference on a final profile, zero or float prices,
 * tampered weights, bad scale); statements that verify and refuse a swapped receipt or a
 * tampered quantity, leaving the receipt bytes unchanged.
 *
 * Needs: read access to the two profiles in `config/cu_reference/` and to the archived source
 * files the candidate profile names; signing uses in-memory test keys. No network.
 *
 * Run just this file: `npx tsx --test test/unit/cu_reference.test.ts`
 *
 * @module test/unit/cu_reference.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import type { CuReferenceDefinition, CuReferenceProfileV1, CuReferenceStatementV1, NormalizedUsage, TokenCategory } from '../../src/types/d1d8/index.js';
import { computeCuReference, cuRatio, decomposeUsage, digestCuReferenceProfile, validateCuReferenceProfile } from '../../src/economics/cuReference.js';
import { computeCu } from '../../src/economics/computeCu.js';
import { developmentCuConfig } from '../../src/economics/cuWeightsV2.js';
import { priceTableRef, priceUsageWithTable, type PriceTableV1 } from '../../src/pricing/priceUsage.js';
import { createKeyRing, createReceiptCrypto, digestReceiptV3 } from '../../src/zk/v3/index.js';
import { receiptFixture } from '../fixtures/d1d8/a/receiptFixture.js';

const PROFILE_PATH = path.join(import.meta.dirname, '..', '..', 'config', 'cu_reference', 'otk.cu.reference.v1.2026-10.candidate-1.json');
const loadProfile = (): CuReferenceProfileV1 => JSON.parse(readFileSync(PROFILE_PATH, 'utf8')) as CuReferenceProfileV1;
const REF_4OMINI_IN: CuReferenceDefinition = { kind: 'model_category', provider: 'openai', model: 'gpt-4o-mini', category: 'input_uncached' };
const REF_1USD: CuReferenceDefinition = { kind: 'abstract_price', priceMicroUsdPerMTok: '1000000' };

type Cat = Omit<TokenCategory, 'sourceField'> & { sourceField?: string };
function usage(provider: string, api: NormalizedUsage['api'], model: string, cats: Cat[], completeness: NormalizedUsage['completeness'] = 'complete'): NormalizedUsage {
  return {
    schema: 'otk.usage.v1', api, provider, modelRequested: model, modelReturned: model, providerRequestId: null, origin: 'provider_response', completeness,
    categories: cats.map((c) => ({ sourceField: `test.${c.name}`, ...c })), tIn: null, tOut: null, tRule: 'test', rawUsageDigest: `0x${'00'.repeat(32)}`,
    normalizerVersion: 'test', docRef: { url: 'test', retrievedAt: '2026-10-07T00:00:00.000Z' }, observedAt: '2026-10-07T00:00:00.000Z',
  };
}
const openai = (prompt: bigint, cached: bigint | null, completion: bigint, reasoning: bigint | null = null) => usage('openai', 'openai.chat_completions', 'gpt-4o-mini', [
  { name: 'input', count: prompt, inclusion: 'base' }, { name: 'output', count: completion, inclusion: 'base' },
  { name: 'input_cache_read', count: cached, inclusion: 'subset_of_input' }, { name: 'output_reasoning', count: reasoning, inclusion: 'subset_of_output' },
]);
const anthropic = (input: bigint, read: bigint, write: bigint, output: bigint, model = 'claude-haiku-4-5-20251001') => usage('anthropic', 'anthropic.messages', model, [
  { name: 'input', count: input, inclusion: 'base' }, { name: 'output', count: output, inclusion: 'base' },
  { name: 'input_cache_write', count: write, inclusion: 'separate_addend' }, { name: 'input_cache_read', count: read, inclusion: 'separate_addend' },
]);
const gemini = (prompt: bigint, cached: bigint, candidates: bigint, thoughts: bigint) => usage('gemini', 'gemini.generate_content', 'gemini-3.5-flash-lite', [
  { name: 'input', count: prompt, inclusion: 'base' }, { name: 'output', count: candidates, inclusion: 'base' },
  { name: 'input_cache_read', count: cached, inclusion: 'subset_of_input' }, { name: 'output_reasoning', count: thoughts, inclusion: 'separate_addend' },
]);
const frac = (n: bigint, d: bigint) => { let a = n, b = d; while (b) [a, b] = [b, a % b]; return { numerator: (n / a).toString(), denominator: (d / a).toString() }; };

describe('CU reference profile 2026-10 (candidate)', () => {
  it('is valid, has no normalization chosen (DN-01 open) and every entry has archived source + sha256 + literal line', () => {
    const p = validateCuReferenceProfile(loadProfile());
    assert.equal(p.status, 'CANDIDATE');
    assert.equal(p.referenceDefinition, null);
    assert.equal(p.basePeriod, '2026-10');
    for (const e of p.entries) {
      assert.match(e.source.sha256, /^[0-9a-f]{64}$/);
      const archived = readFileSync(path.join(import.meta.dirname, '..', '..', e.source.archivedCopy));
      assert.equal(ethers.sha256(archived).slice(2), e.source.sha256, `${e.model}/${e.category}: archived copy hash`);
      assert.ok(archived.toString('utf8').split('\n').some((l) => l.split(/\s+/).join(' ').trim() === e.source.literal), `${e.model}/${e.category}: literal line present in the archive`);
    }
  });

  it('without a reference the CU is not computable, never a default (reference_undefined), but quantities are reported', () => {
    const r = computeCuReference(openai(1000n, 0n, 100n), loadProfile());
    assert.equal(r.status, 'reference_undefined');
    assert.equal(r.cu, null);
    assert.equal(r.quantities!.input_uncached, '1000');
  });
});

describe('invariants', () => {
  const p = loadProfile();
  it('determinism: same quantities + same profile = same CU (also after a JSON round trip of the profile)', () => {
    const u = anthropic(120n, 800n, 0n, 60n);
    const a = computeCuReference(u, p, { reference: REF_4OMINI_IN });
    const b = computeCuReference(structuredClone(u), JSON.parse(JSON.stringify(p)), { reference: REF_4OMINI_IN });
    assert.deepEqual(a, b);
    // hand: (120×1_000_000 + 800×100_000 + 60×5_000_000) / 150_000 = 500_000_000/150_000 = 10000/3
    assert.deepEqual(a.exact, frac(500_000_000n, 150_000n));
    assert.equal(a.cu!.units, 3_333_333_333_333n);
    assert.equal(a.label, 'CU_REFERENCE_CANDIDATE');
  });

  it('decimal rendering rounds half up at 10^-9 and keeps the exact fraction', () => {
    // 1 uncached Haiku input token / gpt-4o-mini input reference = 1_000_000/150_000 = 20/3 = 6.6666666666...
    const r = computeCuReference(anthropic(1n, 0n, 0n, 0n), p, { reference: REF_4OMINI_IN });
    assert.deepEqual(r.exact, { numerator: '20', denominator: '3' });
    assert.equal(r.cu!.units, 6_666_666_667n, 'half up, not truncation (6_666_666_666)');
  });

  it('price-current invariance: a new CURRENT price changes the money quote but not the CU of the base series', () => {
    const u = openai(1000n, 0n, 200n);
    const cuBefore = computeCuReference(u, p, { reference: REF_4OMINI_IN });
    const current = (inMicro: string): PriceTableV1 => ({ schema: 'otk.price_table.v1', version: `cur-${inMicro}`, currency: 'USD', aliases: {}, entries: [
      { provider: 'openai', model: 'gpt-4o-mini', category: 'input', pricePerMTokMicroUsd: BigInt(inMicro), effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: null, source: 't' },
      { provider: 'openai', model: 'gpt-4o-mini', category: 'output', pricePerMTokMicroUsd: 600_000n, effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: null, source: 't' },
    ] });
    const t1 = current('150000'); const t2 = current('300000');
    const m1 = priceUsageWithTable(u, '2026-11-01T00:00:00.000Z', t1, priceTableRef(t1));
    const m2 = priceUsageWithTable(u, '2026-11-01T00:00:00.000Z', t2, priceTableRef(t2));
    assert.notDeepEqual(m1.total, m2.total, 'money follows the current price');
    const cuAfter = computeCuReference(u, p, { reference: REF_4OMINI_IN });
    assert.deepEqual(cuAfter, cuBefore, 'CU uses only the frozen base structure');
    // hand: (1000×150_000 + 200×600_000)/150_000 = 1800
    assert.deepEqual(cuBefore.exact, { numerator: '1800', denominator: '1' });
  });

  it('monotonicity: adding positive quantity to any priced category never lowers the CU', () => {
    const base = { in: 500n, read: 300n, write: 40n, out: 90n };
    const cu = (u: NormalizedUsage) => { const r = computeCuReference(u, p, { reference: REF_1USD }); assert.equal(r.status, 'computed'); return BigInt(r.exact!.numerator) * 10n ** 18n / BigInt(r.exact!.denominator); };
    const c0 = cu(anthropic(base.in, base.read, base.write, base.out));
    for (const d of [1n, 7n, 1000n]) {
      assert.ok(cu(anthropic(base.in + d, base.read, base.write, base.out)) > c0);
      assert.ok(cu(anthropic(base.in, base.read + d, base.write, base.out)) > c0);
      assert.ok(cu(anthropic(base.in, base.read, base.write + d, base.out)) > c0);
      assert.ok(cu(anthropic(base.in, base.read, base.write, base.out + d)) > c0);
    }
  });

  it('category sensitivity: the same 1000 raw tokens give different CU when the composition changes', () => {
    const cuOf = (u: NormalizedUsage) => computeCuReference(u, p, { reference: REF_4OMINI_IN }).exact;
    const allInput = cuOf(openai(1000n, 0n, 0n));      // 1000×150_000/150_000 = 1000
    const allCached = cuOf(openai(1000n, 1000n, 0n));  // 1000×75_000/150_000 = 500
    const allOutput = cuOf(openai(0n, 0n, 1000n));     // 1000×600_000/150_000 = 4000
    assert.deepEqual([allInput, allCached, allOutput], [{ numerator: '1000', denominator: '1' }, { numerator: '500', denominator: '1' }, { numerator: '4000', denominator: '1' }]);
  });

  it('no double counting: cached input inside the prompt total (OpenAI) is carved out; Anthropic cache stays a separate addend', () => {
    const o = decomposeUsage(openai(1000n, 800n, 50n));
    assert.equal(o.quantities.input_uncached, 200n);
    assert.equal(o.quantities.input_cache_read, 800n);
    assert.equal(o.quantities.input_uncached + o.quantities.input_cache_read, 1000n, 'the 1000 prompt tokens are counted once');
    assert.deepEqual(computeCuReference(openai(1000n, 800n, 50n), p, { reference: REF_4OMINI_IN }).exact, frac(200n * 150_000n + 800n * 75_000n + 50n * 600_000n, 150_000n));
    const a = decomposeUsage(anthropic(100n, 800n, 30n, 20n));
    assert.deepEqual([a.quantities.input_uncached, a.quantities.input_cache_read, a.quantities.input_cache_write], [100n, 800n, 30n]);
    const g = decomposeUsage(gemini(1500n, 1024n, 40n, 12n));
    assert.deepEqual([g.quantities.input_uncached, g.quantities.input_cache_read, g.quantities.output_visible, g.quantities.output_reasoning], [476n, 1024n, 40n, 12n]);
    const r = decomposeUsage(openai(10n, 0n, 100n, 30n));
    assert.deepEqual([r.quantities.output_visible, r.quantities.output_reasoning], [70n, 30n]);
    assert.equal(decomposeUsage(openai(10n, 11n, 5n)).ok, false, 'a subset larger than its base is refused');
  });

  it('profile versioning: changing a price changes the digest and the CU; changing only a note changes the digest, not the CU', () => {
    const p2 = structuredClone(p);
    p2.entries.find((e) => e.model === 'gpt-4o-mini' && e.category === 'output_visible')!.priceMicroUsdPerMTok = '700000';
    p2.profileId = 'otk.cu.reference.v1.2026-10.test-variant';
    assert.notEqual(digestCuReferenceProfile(p2), digestCuReferenceProfile(p));
    const u = openai(0n, 0n, 100n);
    const r1 = computeCuReference(u, p, { reference: REF_4OMINI_IN });
    const r2 = computeCuReference(u, p2, { reference: REF_4OMINI_IN });
    assert.notDeepEqual(r1.exact, r2.exact);
    assert.notEqual(r1.profileDigest, r2.profileDigest);
    const p3 = structuredClone(p);
    p3.entries[0]!.note = 'only a note';
    assert.notEqual(digestCuReferenceProfile(p3), digestCuReferenceProfile(p));
    assert.deepEqual(computeCuReference(u, p3, { reference: REF_4OMINI_IN }).exact, r1.exact);
  });

  it('legacy immutability: the development_legacy formula gives the historical number and a receipt is never touched', () => {
    const u = { ...openai(1000n, 0n, 0n), tIn: 1000n, tOut: 0n };
    const legacy = computeCu(u, developmentCuConfig());
    assert.equal(legacy.status, 'computed');
    assert.equal(legacy.cu!.units, 400_000_000n, '1000 tokens × 0.4 CU (gpt-4o-mini development weight) = 400 CU at 10^-6');
    assert.equal(legacy.developmentProfile, true);
    const receipt = receiptFixture({ circuitId: 'metering_v3@test', cuUnits: 640n, operationId: 'op-legacy-1' });
    const before = JSON.stringify(receipt, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    const d0 = digestReceiptV3(receipt);
    computeCuReference(receipt.usage, p, { reference: REF_1USD });
    assert.equal(digestReceiptV3(receipt), d0, 'the receipt v3 digest is the same after an analytical recomputation');
    assert.equal(JSON.stringify(receipt, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)), before);
  });

  it('replay: the same historical quantities under the same profile give the same value, run after run', () => {
    // illustrative quantities (prompt 48, candidates 155, thoughts 0); expected value computed by hand from the profile
    const u = gemini(48n, 0n, 155n, 0n);
    const runs = Array.from({ length: 5 }, () => computeCuReference(u, loadProfile(), { reference: REF_1USD }));
    for (const x of runs) assert.deepEqual(x, runs[0]);
    assert.deepEqual(runs[0]!.exact, frac(48n * 300_000n + 155n * 2_500_000n, 1_000_000n));
  });

  it('changing the normalization only rescales: ratios between operations are identical under every reference and scale', () => {
    const a = anthropic(120n, 800n, 0n, 60n);
    const b = gemini(1500n, 1024n, 40n, 12n);
    const c = openai(1000n, 800n, 50n);
    const refs: CuReferenceDefinition[] = [REF_4OMINI_IN, REF_1USD, { kind: 'model_category', provider: 'anthropic', model: 'claude-haiku-4-5', category: 'output_visible' }];
    const ratios = refs.flatMap((ref) => ['1', '1000'].map((scale) => {
      const prof = { ...p, scale };
      return [cuRatio(computeCuReference(a, prof, { reference: ref }), computeCuReference(b, prof, { reference: ref })),
        cuRatio(computeCuReference(b, prof, { reference: ref }), computeCuReference(c, prof, { reference: ref }))];
    }));
    for (const r of ratios) assert.deepEqual(r, ratios[0]);
  });

  it('not computable, never zero: unknown model, unpriced category, audio, partial stream, missing base', () => {
    assert.equal(computeCuReference(usage('openai', 'openai.chat_completions', 'gpt-9', [{ name: 'input', count: 1n, inclusion: 'base' }, { name: 'output', count: 1n, inclusion: 'base' }]), p, { reference: REF_1USD }).status, 'model_not_in_profile');
    assert.equal(computeCuReference(openai(10n, 0n, 100n, 30n), p, { reference: REF_1USD }).status, 'category_not_in_profile', 'gpt-4o-mini has no reasoning price');
    const audio = usage('openai', 'openai.chat_completions', 'gpt-4o-mini', [{ name: 'input', count: 10n, inclusion: 'base' }, { name: 'output', count: 1n, inclusion: 'base' }, { name: 'input_audio', count: 5n, inclusion: 'subset_of_input' }]);
    assert.equal(computeCuReference(audio, p, { reference: REF_1USD }).status, 'category_not_in_profile');
    assert.equal(computeCuReference(openai(10n, 0n, 5n), p, { reference: REF_1USD, acceptCompleteness: ['complete'] }).status, 'computed');
    assert.equal(computeCuReference({ ...openai(10n, 0n, 5n), completeness: 'partial' }, p, { reference: REF_1USD }).status, 'usage_not_computable');
    assert.equal(computeCuReference(usage('openai', 'openai.chat_completions', 'gpt-4o-mini', [{ name: 'output', count: 1n, inclusion: 'base' }]), p, { reference: REF_1USD }).status, 'usage_not_computable');
    assert.equal(computeCuReference(openai(10n, 0n, 5n), p, { reference: { kind: 'model_category', provider: 'openai', model: 'gpt-4o-mini', category: 'output_reasoning' } }).status, 'reference_undefined');
    const unknownReturned = { ...openai(10n, 0n, 5n), modelReturned: 'gpt-4o-mini-2099-01-01' };
    assert.equal(computeCuReference(unknownReturned, p, { reference: REF_1USD }).status, 'model_not_in_profile', 'an unknown returned id is not replaced by the requested one');
  });

  it('a FINAL profile requires a reference; invalid prices are refused (no zero, no float)', () => {
    assert.throws(() => validateCuReferenceProfile({ ...p, status: 'FINAL' }), /FINAL profile needs a referenceDefinition/);
    const bad = structuredClone(p); bad.entries[0]!.priceMicroUsdPerMTok = '0';
    assert.throws(() => validateCuReferenceProfile(bad), /positive integer/);
    const bad2 = structuredClone(p); bad2.entries[0]!.priceMicroUsdPerMTok = '1.5';
    assert.throws(() => validateCuReferenceProfile(bad2), /positive integer/);
  });
});

describe('signed CU-reference statement bound to a receipt (OTK_CU_REFERENCE_V1)', () => {
  it('signs, verifies, and refuses a swap to another receipt or a tampered quantity', async () => {
    const wallet = new ethers.Wallet(ethers.id('otk-ovn2-cu-reference-test-key (TEST ONLY, public seed)'));
    const ring = createKeyRing([{ keyId: 'op-test', address: wallet.address as `0x${string}`, status: 'active' }]);
    const rc = createReceiptCrypto({ keyRing: ring, signer: { keyId: 'op-test', wallet }, now: () => new Date('2026-10-07T04:00:00.000Z') });
    const receipt = receiptFixture({ circuitId: 'metering_v3@test', cuUnits: 640n, operationId: 'op-cu-ref-1' });
    const other = receiptFixture({ circuitId: 'metering_v3@test', cuUnits: 640n, operationId: 'op-cu-ref-2' });
    const p = loadProfile();
    const res = computeCuReference(openai(1000n, 800n, 50n), p, { reference: REF_4OMINI_IN });
    const st: CuReferenceStatementV1 = {
      schema: 'otk.cu_reference_statement.v1', key: receipt.key, receiptDigest: digestReceiptV3(receipt), kind: 'issued_with_operation',
      cuFormulaVersion: 'CU_REF_SUM_v1', cuReferenceProfileId: p.profileId, basePeriod: p.basePeriod, profileDigest: res.profileDigest,
      label: res.label, reference: res.reference, quantities: res.quantities as Record<string, string>, exact: res.exact!, computedAt: '2026-10-07T04:00:00.000Z',
    };
    const env = await rc.signCuReference!(st);
    assert.equal(env.domain, 'OTK_CU_REFERENCE_V1');
    assert.deepEqual(rc.verifyCuReference!(st, env, receipt), { ok: true, signer: wallet.address, keyId: 'op-test' });
    const swapped = rc.verifyCuReference!({ ...st, key: other.key }, env, other);
    assert.equal(swapped.ok, false);
    const tampered = rc.verifyCuReference!({ ...st, quantities: { ...st.quantities, input_uncached: '1' } }, env, receipt);
    assert.equal(tampered.ok, false);
    const asReceipt = rc.verifyReceipt(receipt, env);
    assert.equal(asReceipt.ok, false, 'a CU statement signature is not a receipt signature');
    await assert.rejects(rc.signCuReference!({ ...st, basePeriod: '2026-13' }), /basePeriod/);
    await assert.rejects(rc.signCuReference!({ ...st, computedAt: '07/10/2026' }), /computedAt/);
    await assert.rejects(rc.signCuReference!({ ...st, cuReferenceProfileId: '' }), /cuReferenceProfileId/);
  });
});

// ───────────── FINAL CLOSURE (07/10/2026): DN-01 resolved, final profile otk.cu.reference.v1.2026-10 ─────────────
// Reference (ruler only): gpt-4o-mini-2024-07-18 / input_uncached, p_ref = US$ 0.15/MTok. Scale 1/1000: 1 CU = 1 000
// reference units. CU = quantidade normalizada de consumo de serviços de IA.
const FINAL_PATH = path.join(import.meta.dirname, '..', '..', 'config', 'cu_reference', 'otk.cu.reference.v1.2026-10.json');
const loadFinal = (): CuReferenceProfileV1 => JSON.parse(readFileSync(FINAL_PATH, 'utf8')) as CuReferenceProfileV1;

describe('final CU reference profile 2026-10 (DN-01)', () => {
  const f = loadFinal();
  it('is FINAL, names the reference and the scale, records derived weights, and has its own digest', () => {
    validateCuReferenceProfile(f);
    assert.equal(f.status, 'FINAL');
    assert.deepEqual(f.referenceDefinition, { kind: 'model_category', provider: 'openai', model: 'gpt-4o-mini-2024-07-18', category: 'input_uncached' });
    assert.equal(f.scale, '1/1000');
    assert.notEqual(digestCuReferenceProfile(f), digestCuReferenceProfile(loadProfile()), 'final and candidate never share a digest');
    assert.notEqual(f.profileId, loadProfile().profileId);
  });

  it('the reference category weighs exactly 1 before the scale; cache read 1/2; output 4', () => {
    const w = (m: string, c: string) => f.derivedWeights!.find((x) => x.model === m && x.category === c)!.weight;
    assert.deepEqual(w('gpt-4o-mini', 'input_uncached'), { numerator: '1', denominator: '1' });
    assert.deepEqual(w('gpt-4o-mini', 'input_cache_read'), { numerator: '1', denominator: '2' });
    assert.deepEqual(w('gpt-4o-mini', 'output_visible'), { numerator: '4', denominator: '1' });
  });

  it('1 000 reference units = 1 CU; 1 000 cache reads = 0.5 CU; 1 000 output = 4 CU (label FINAL)', () => {
    const one = computeCuReference(openai(1000n, 0n, 0n), f);
    assert.equal(one.status, 'computed');
    assert.equal(one.label, 'CU_REFERENCE_FINAL');
    assert.deepEqual(one.exact, { numerator: '1', denominator: '1' });
    assert.equal(one.cu!.units, 1_000_000_000n);
    assert.deepEqual(computeCuReference(openai(1000n, 1000n, 0n), f).exact, { numerator: '1', denominator: '2' });
    assert.equal(computeCuReference(openai(1000n, 1000n, 0n), f).cu!.units, 500_000_000n);
    assert.deepEqual(computeCuReference(openai(0n, 0n, 1000n), f).exact, { numerator: '4', denominator: '1' });
  });

  it('the dated snapshot returned by the API resolves through the explicit alias; an unknown snapshot does not', () => {
    const u = { ...openai(1000n, 0n, 0n), modelReturned: 'gpt-4o-mini-2024-07-18' };
    assert.equal(computeCuReference(u, f).model, 'gpt-4o-mini');
    assert.equal(computeCuReference({ ...u, modelReturned: 'gpt-4o-mini-2099-01-01' }, f).status, 'model_not_in_profile');
  });

  it('a caller cannot override the reference of a FINAL profile', () => {
    const r = computeCuReference(openai(1000n, 0n, 0n), f, { reference: REF_1USD });
    assert.deepEqual(r.reference, f.referenceDefinition);
    assert.deepEqual(r.exact, { numerator: '1', denominator: '1' });
  });

  it('the reference sets the scale, not the relations: ratios equal the candidate ratios under any reference', () => {
    const ops = [anthropic(120n, 800n, 0n, 60n), gemini(1500n, 1024n, 40n, 12n), openai(1000n, 800n, 50n)];
    const fin = ops.map((u) => computeCuReference(u, f));
    const cand = ops.map((u) => computeCuReference(u, loadProfile(), { reference: REF_1USD }));
    assert.deepEqual(cuRatio(fin[0]!, fin[1]!), cuRatio(cand[0]!, cand[1]!));
    assert.deepEqual(cuRatio(fin[1]!, fin[2]!), cuRatio(cand[1]!, cand[2]!));
    assert.equal(cand[0]!.label, 'CU_REFERENCE_CANDIDATE');
  });

  it('reasoning is a disjoint category and is weighted only where the profile prices it', () => {
    // Gemini thoughts (separate addend) priced as output: (1000 × 0.30 + 1000 × 2.50) / 0.15 / 1000 = 56/3 CU
    assert.deepEqual(computeCuReference(gemini(1000n, 0n, 0n, 1000n), f).exact, { numerator: '56', denominator: '3' });
    assert.equal(computeCuReference(openai(10n, 0n, 100n, 30n), f).status, 'category_not_in_profile');
  });

  it('tampered or missing derived weights, a reference outside the profile or a bad scale are refused', () => {
    const bad = structuredClone(f); bad.derivedWeights![0]!.weight = { numerator: '7', denominator: '1' };
    assert.throws(() => validateCuReferenceProfile(bad), /derivedWeights/);
    const noW = structuredClone(f); delete noW.derivedWeights;
    assert.throws(() => validateCuReferenceProfile(noW), /derivedWeights/);
    const badRef = structuredClone(f); badRef.referenceDefinition = { kind: 'model_category', provider: 'openai', model: 'gpt-9', category: 'input_uncached' };
    assert.throws(() => validateCuReferenceProfile(badRef), /referenceDefinition/);
    const badScale = structuredClone(f); badScale.scale = '0/1000';
    assert.throws(() => validateCuReferenceProfile(badScale), /scale/);
  });

  it('a statement under the final profile signs, verifies and leaves the receipt byte-for-byte unchanged', async () => {
    const wallet = new ethers.Wallet(ethers.id('otk-final-closure-cu-reference-test-key (TEST ONLY, public seed)'));
    const ring = createKeyRing([{ keyId: 'op-test', address: wallet.address as `0x${string}`, status: 'active' }]);
    const rc = createReceiptCrypto({ keyRing: ring, signer: { keyId: 'op-test', wallet }, now: () => new Date('2026-10-07T20:00:00.000Z') });
    const receipt = receiptFixture({ circuitId: 'metering_v3@test', cuUnits: 640n, operationId: 'op-final-1' });
    const before = JSON.stringify(receipt, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    const res = computeCuReference(receipt.usage, f);
    const st: CuReferenceStatementV1 = {
      schema: 'otk.cu_reference_statement.v1', key: receipt.key, receiptDigest: digestReceiptV3(receipt), kind: 'analytical_recomputation',
      cuFormulaVersion: 'CU_REF_SUM_v1', cuReferenceProfileId: f.profileId, basePeriod: f.basePeriod, profileDigest: res.profileDigest,
      label: res.label, reference: res.reference, quantities: res.quantities as Record<string, string>, exact: res.exact!, computedAt: '2026-10-07T20:00:00.000Z',
    };
    assert.equal(st.label, 'CU_REFERENCE_FINAL');
    const env = await rc.signCuReference!(st);
    assert.equal(rc.verifyCuReference!(st, env, receipt).ok, true);
    assert.equal(rc.verifyCuReference!({ ...st, profileDigest: digestCuReferenceProfile(loadProfile()) }, env, receipt).ok, false, 'another profile digest breaks the signature');
    assert.equal(JSON.stringify(receipt, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)), before);
  });
});
