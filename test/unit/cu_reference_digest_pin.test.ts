/**
 * RUN-S-T024 / OTK-D03-F01-S01-W02 (RUN-S 2026-10-09, Gate S-08): regression pin of the CU reference profiles.
 * CU = quantidade normalizada de consumo de serviços de IA. The FINAL profile otk.cu.reference.v1.2026-10 (DN-01) was
 * fixed only by its content; no test pinned its digest, so any byte change (price, weight, note) could pass unnoticed.
 * The expected digests are the ones recorded when the profile was frozen (FINAL CLOSURE 07/10/2026,
 * docs/_ops/FINAL_CLOSURE_20261007/evidence/cu_profile_digests.txt) and carried by the signed recomputation statements of
 * the campaign. This file adds no formula, weight or runtime behaviour: the proxy still records the legacy CU.
 *
 * Module under test: `src/economics/cuReference.ts` (`digestCuReferenceProfile`,
 * `validateCuReferenceProfile`, `computeCuReference`).
 *
 * Strategy / partitions: the final and the candidate profile each match their frozen digest;
 * the pinned values equal the recorded digest list and the campaign statements; a computed
 * reference CU names the formula, the profile and the digest; repeated loads give the same
 * digest and CU; any edit to the final profile, even a note, changes the digest.
 *
 * Needs: read access to `config/cu_reference/` and to the frozen evidence under
 * `docs/_ops/FINAL_CLOSURE_20261007/evidence/`; no network.
 *
 * Run just this file: `npx tsx --test test/unit/cu_reference_digest_pin.test.ts`
 *
 * @module test/unit/cu_reference_digest_pin.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CuReferenceProfileV1, NormalizedUsage } from '../../src/types/d1d8/index.js';
import { CU_REF_FORMULA, computeCuReference, digestCuReferenceProfile, validateCuReferenceProfile } from '../../src/economics/cuReference.js';

const ROOT = path.join(import.meta.dirname, '..', '..');
const CFG = path.join(ROOT, 'config', 'cu_reference');
const load = (f: string) => JSON.parse(readFileSync(path.join(CFG, f), 'utf8')) as CuReferenceProfileV1;
const FINAL_DIGEST = '0xb1680cb34ad93fd3c5e98b3c5beff6c3a1783a259fc08ae382c7abc9923d6e4c';
const CANDIDATE_DIGEST = '0xa87d548db4a1934c0f3eb11db65dfca97df8dc0461421fb9e9400308183a524c';
const HIST = path.join(ROOT, 'docs', '_ops', 'FINAL_CLOSURE_20261007', 'evidence');

const usage = (prompt: bigint, completion: bigint): NormalizedUsage => ({
  schema: 'otk.usage.v1', api: 'openai.chat_completions', provider: 'openai', modelRequested: 'gpt-4o-mini', modelReturned: 'gpt-4o-mini',
  providerRequestId: null, origin: 'provider_response', completeness: 'complete',
  categories: [
    { sourceField: 'test.input', name: 'input', count: prompt, inclusion: 'base' },
    { sourceField: 'test.output', name: 'output', count: completion, inclusion: 'base' },
    { sourceField: 'test.cache', name: 'input_cache_read', count: 0n, inclusion: 'subset_of_input' },
  ],
  tIn: null, tOut: null, tRule: 'test', rawUsageDigest: `0x${'00'.repeat(32)}`, normalizerVersion: 'test',
  docRef: { url: 'test', retrievedAt: '2026-10-07T00:00:00.000Z' }, observedAt: '2026-10-07T00:00:00.000Z',
} as NormalizedUsage);

describe('S-08: CU reference profile digests are pinned', () => {
  it('FINAL otk.cu.reference.v1.2026-10 has exactly the frozen digest', () => {
    const f = load('otk.cu.reference.v1.2026-10.json');
    validateCuReferenceProfile(f);
    assert.equal(f.profileId, 'otk.cu.reference.v1.2026-10');
    assert.equal(f.status, 'FINAL');
    assert.equal(digestCuReferenceProfile(f), FINAL_DIGEST);
  });
  it('CANDIDATE candidate-1 keeps its own frozen digest (historical, not superseded in place)', () => {
    const c = load('otk.cu.reference.v1.2026-10.candidate-1.json');
    assert.equal(c.status, 'CANDIDATE');
    assert.equal(digestCuReferenceProfile(c), CANDIDATE_DIGEST);
  });
  it('the pinned values are the ones recorded at the freeze and carried by the campaign statements', () => {
    const rec = readFileSync(path.join(HIST, 'cu_profile_digests.txt'), 'utf8');
    assert.ok(rec.includes(`otk.cu.reference.v1.2026-10 FINAL ${FINAL_DIGEST}`));
    assert.ok(rec.includes(`candidate-1 CANDIDATE ${CANDIDATE_DIGEST}`));
    for (const s of ['statement_openai.json', 'statement_anthropic.json', 'statement_gemini35.json']) {
      const t = readFileSync(path.join(HIST, 'recompute_final', s), 'utf8');
      assert.ok(t.includes(FINAL_DIGEST), `${s} carries the FINAL digest`);
    }
  });
  it('a computed reference CU names the formula, the profile and the pinned digest, and is labelled FINAL', () => {
    const r = computeCuReference(usage(1000n, 0n), load('otk.cu.reference.v1.2026-10.json'));
    assert.equal(r.status, 'computed');
    assert.equal(r.formulaVersion, CU_REF_FORMULA);
    assert.equal(CU_REF_FORMULA, 'CU_REF_SUM_v1');
    assert.equal(r.profileId, 'otk.cu.reference.v1.2026-10');
    assert.equal(r.profileDigest, FINAL_DIGEST);
    assert.equal(r.label, 'CU_REFERENCE_FINAL');
  });
  it('determinism: the digest and the CU are identical across repeated loads', () => {
    const a = computeCuReference(usage(1234n, 56n), load('otk.cu.reference.v1.2026-10.json'));
    const b = computeCuReference(usage(1234n, 56n), load('otk.cu.reference.v1.2026-10.json'));
    assert.deepEqual(a.exact, b.exact);
    assert.equal(a.profileDigest, b.profileDigest);
  });
  it('any change to the FINAL profile, even a note, is caught by the pin', () => {
    const f = load('otk.cu.reference.v1.2026-10.json');
    const changed = { ...f, note: `${String((f as unknown as { note?: string }).note ?? '')} ` } as CuReferenceProfileV1;
    assert.notEqual(digestCuReferenceProfile(changed), FINAL_DIGEST);
  });
});
