/**
 * OVERNIGHT 20261005 / Phase 8 — versioned CalibrationProfile, loader states, and the conference path that uses it.
 * No provider call, no network. The calibrated profiles used here are SYNTHETIC (target = a synthetic rule) and
 * exist only to exercise the runtime path; the pilot profiles (real historical data) are calibrated=false.
 *
 *   node node_modules/tsx/dist/cli.mjs --test test/unit/ovn_p8_calibration_profile.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkCompatibility, computeEvidenceHash, createCalibrationRegistry, emptyCalibrationRegistry, expectedTokens, loadCalibrationProfilesFromDir,
  parseCalibrationProfile, sealProfile, type CalibrationProfileV1, type CalibrationSelection,
} from '../../src/tokenization/calibrationProfile.js';
import { buildConferenceReport, HEURISTIC_THRESHOLD_LABEL, HEURISTIC_THRESHOLD_V0 } from '../../src/tokenization/conferenceReport.js';
import { COUNTER_VERSION } from '../../src/tokenization/localCounter.js';
import { resolveModelSupport } from '../../src/providers/catalog/modelCatalog.js';
import { normalizeUsage } from '../../src/providers/usage/normalizeUsage.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { decodeConference, encodeJson } from '../../src/operations/codec.js';
import { digestConferenceV1 } from '../../src/receipt/v3/receiptCrypto.js';
import { d1d8ProfileFromEnv, type D1D8ConfigError } from '../../src/operations/bootstrapD1D8.js';
import type { ConferenceReport, LocalCountResult, ModelSupport, NormalizedUsage } from '../../src/types/d1d8/index.js';
import { fitCalibrationProfile, summarize, type CalibrationPair } from '../../scripts/calibration/fitProfile.js';
import { buildMessageCorpus } from '../../scripts/calibration/messageCorpus.js';
import { generateCorpus, splitOf } from '../../scripts/calibration/corpus.js';

const SYN_FILE = 'test/fixtures/calibration/synthetic_test_profile_anthropic_haiku45.json';
const PILOT_DIR = 'docs/_ops/OVERNIGHT_20261005_MASTER/calibration/profiles';
const PILOT_FILES = ['pilot_v3_anthropic_claude-haiku-4-5-20251001.json', 'pilot_v3_openai_gpt-4o-mini.json', 'pilot_v3_gemini_gemini-3.5-flash-lite.json'];
const synText = readFileSync(SYN_FILE, 'utf8');
const syn = JSON.parse(synText) as CalibrationProfileV1;
const haiku = resolveModelSupport('anthropic', 'anthropic.messages', 'claude-haiku-4-5-20251001');
const mini = resolveModelSupport('openai', 'openai.chat_completions', 'gpt-4o-mini');
const NOW = '2026-10-06T12:00:00.000Z';
const KEY = { tenantId: 't-p8', operationId: 'op-p8' };
const DIGEST = `0x${'cd'.repeat(32)}` as const;

const reseal = (p: CalibrationProfileV1, patch: (b: Record<string, any>) => void): string => {
  const b = JSON.parse(JSON.stringify(p)) as Record<string, any>;
  delete b['evidenceHash'];
  patch(b);
  return JSON.stringify(sealProfile(b as never));
};
const local = (input: number, output: number): LocalCountResult => ({
  counts: [{ category: 'input', count: BigInt(input) }, { category: 'output', count: BigInt(output) }],
  covered: ['input', 'output'], uncovered: [], status: 'ok', counterVersion: COUNTER_VERSION, cost: { cpuMicros: 0n, peakBufferedBytes: 0 },
});
const anthropicUsage = (input: number, output: number): NormalizedUsage => normalizeUsage('anthropic.messages',
  { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: input, output_tokens: output } },
  { provider: 'anthropic', modelRequested: 'claude-haiku-4-5-20251001', origin: 'provider_response', observedAt: NOW });
const openaiUsage = (input: number, output: number): NormalizedUsage => normalizeUsage('openai.chat_completions',
  { model: 'gpt-4o-mini', usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } },
  { provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_response', observedAt: NOW });
const conference = (support: ModelSupport, usage: NormalizedUsage, l: LocalCountResult, sel: CalibrationSelection | null): ConferenceReport =>
  buildConferenceReport({ key: KEY, receiptDigest: DIGEST, usage, local: l, support, now: NOW, threshold: sel ? sel.threshold : HEURISTIC_THRESHOLD_V0, ...(sel ? { calibration: sel.conference } : {}) });
const synRegistry = () => createCalibrationRegistry([{ source: 'syn.json', text: synText }], { allowSynthetic: true });

describe('Phase 8 — the historical rule stays labelled HEURISTIC', () => {
  it('HEURISTIC_THRESHOLD_V0 is >16 tokens AND >10%, calibrated=false, calibrationVersion=null, label HEURISTIC', () => {
    assert.equal(HEURISTIC_THRESHOLD_LABEL, 'HEURISTIC');
    assert.equal(HEURISTIC_THRESHOLD_V0.absoluteTokens, 16n);
    assert.equal(HEURISTIC_THRESHOLD_V0.relative, '0.100000');
    assert.equal(HEURISTIC_THRESHOLD_V0.calibrated, false);
    assert.equal(HEURISTIC_THRESHOLD_V0.calibrationVersion, null);
    assert.ok(Object.isFrozen(HEURISTIC_THRESHOLD_V0));
  });
  it('B ports keep the heuristic as fallback; without profiles every selection is ABSENT with the heuristic threshold', () => {
    const ports = d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables([]) });
    assert.equal(ports.conferenceThreshold, HEURISTIC_THRESHOLD_V0);
    const sel = ports.selectCalibration!(haiku, COUNTER_VERSION);
    assert.equal(sel.state, 'ABSENT');
    assert.deepEqual(sel.threshold, { ...HEURISTIC_THRESHOLD_V0 });
    assert.equal(sel.conference.expected, undefined);
  });
});

describe('Phase 8 — profile integrity and loader states', () => {
  it('the committed SYNTHETIC fixture parses, its evidenceHash matches, and it is labelled synthetic', () => {
    const r = parseCalibrationProfile(synText);
    assert.ok(r.ok);
    assert.equal(computeEvidenceHash(syn), syn.evidenceHash);
    assert.equal(syn.synthetic, true);
    assert.equal(syn.targetKind, 'synthetic_rule');
    assert.match(syn.profileId, /SYNTHETIC-TEST-ONLY/);
    assert.equal(syn.calibrated, true);
    assert.equal(syn.acceptance.passed, true);
    assert.ok(syn.validationMetrics.holdout.input!.n >= 30);
  });
  it('COMPATIBLE: synthetic calibrated profile, same tokenizer digest/package/assembly and counter version, synthetic allowed', () => {
    const sel = synRegistry().select(haiku, COUNTER_VERSION);
    assert.equal(sel.state, 'COMPATIBLE');
    assert.equal(sel.threshold.calibrated, true);
    assert.equal(sel.threshold.calibrationVersion, syn.profileId);
    assert.equal(sel.threshold.absoluteTokens, BigInt(syn.thresholdPolicy.absoluteTokens));
  });
  it('ABSENT: no profile, or a profile for another model; aliases are never implied (no prefix matching)', () => {
    assert.equal(emptyCalibrationRegistry().select(haiku, COUNTER_VERSION).state, 'ABSENT');
    assert.equal(synRegistry().select(mini, COUNTER_VERSION).state, 'ABSENT');
    const alias = resolveModelSupport('anthropic', 'anthropic.messages', 'claude-haiku-4-5');
    const s = synRegistry().select(alias, COUNTER_VERSION);
    assert.equal(s.state, 'ABSENT');
    assert.equal(s.threshold.calibrated, false);
    assert.equal(synRegistry().select(resolveModelSupport('acme', 'openai.chat_completions', 'x'), COUNTER_VERSION).reason, 'no_local_tokenizer');
  });
  it('wrong model checked directly is INCOMPATIBLE model_mismatch', () => {
    const haikuAsOtherModel = { ...haiku, modelRequested: 'claude-sonnet-4-5' };
    assert.deepEqual(checkCompatibility(syn, haikuAsOtherModel, COUNTER_VERSION, { allowSynthetic: true }), { state: 'INCOMPATIBLE', reason: 'model_mismatch' });
  });
  it('CORRUPT: evidenceHash changed', () => {
    const p = JSON.parse(synText); p.evidenceHash = p.evidenceHash.slice(0, -1) + (p.evidenceHash.endsWith('0') ? '1' : '0');
    const sel = createCalibrationRegistry([{ source: 'x.json', text: JSON.stringify(p) }], { allowSynthetic: true }).select(haiku, COUNTER_VERSION);
    assert.equal(sel.state, 'CORRUPT');
    assert.equal(sel.reason, 'evidence_hash_mismatch');
    assert.equal(sel.threshold.calibrated, false);
    assert.equal(sel.conference.record.profileId, syn.profileId);
  });
  it('CORRUPT: a parameter tampered without recomputing the hash', () => {
    const p = JSON.parse(synText); p.parameters.categories.input.slope = '2.000000';
    const sel = createCalibrationRegistry([{ source: 'x.json', text: JSON.stringify(p) }], { allowSynthetic: true }).select(haiku, COUNTER_VERSION);
    assert.equal(sel.state, 'CORRUPT');
    assert.equal(sel.reason, 'evidence_hash_mismatch');
    assert.equal(sel.conference.expected, undefined);
  });
  it('CORRUPT: calibrated=true without a passed acceptance is refused even with a consistent hash', () => {
    const text = reseal(syn, (b) => { b['acceptance'].checks[0].passed = false; b['acceptance'].passed = false; });
    const r = parseCalibrationProfile(text);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'calibrated_without_acceptance');
    assert.equal(createCalibrationRegistry([{ source: 'x.json', text }], { allowSynthetic: true }).select(haiku, COUNTER_VERSION).state, 'CORRUPT');
  });
  it('CORRUPT file that does not even parse: recorded at load, lookups stay ABSENT (no key can be claimed)', () => {
    const reg = createCalibrationRegistry([{ source: 'broken.json', text: '{"schema": "otk.calibration_profile.v1",' }]);
    assert.deepEqual(reg.summary().corrupt, [{ source: 'broken.json', reason: 'json_parse_failed' }]);
    assert.equal(reg.select(haiku, COUNTER_VERSION).state, 'ABSENT');
  });
  it('INCOMPATIBLE: other vocabulary digest, other encoding, other counter version, synthetic not allowed, two profiles', () => {
    const dig = reseal(syn, (b) => { b['tokenizerVersion'].vocabularyDigest = `0x${'00'.repeat(32)}`; });
    assert.equal(createCalibrationRegistry([{ source: 'a', text: dig }], { allowSynthetic: true }).select(haiku, COUNTER_VERSION).reason, 'tokenizer_vocabulary_digest_mismatch');
    const enc = reseal(syn, (b) => { b['tokenizer'] = 'o200k_base'; });
    assert.equal(createCalibrationRegistry([{ source: 'a', text: enc }], { allowSynthetic: true }).select(haiku, COUNTER_VERSION).reason, 'tokenizer_encoding_mismatch');
    const pkg = reseal(syn, (b) => { b['tokenizerVersion'].packageVersion = '0.0.1'; });
    assert.equal(createCalibrationRegistry([{ source: 'a', text: pkg }], { allowSynthetic: true }).select(haiku, COUNTER_VERSION).reason, 'tokenizer_package_mismatch');
    const s1 = synRegistry().select(haiku, 'otk.local_counter.b4@1');
    assert.deepEqual([s1.state, s1.reason, s1.threshold.calibrated], ['INCOMPATIBLE', 'counter_version_mismatch', false]);
    const s2 = createCalibrationRegistry([{ source: 'a', text: synText }]).select(haiku, COUNTER_VERSION);
    assert.deepEqual([s2.state, s2.reason], ['INCOMPATIBLE', 'synthetic_profile_not_allowed']);
    const two = createCalibrationRegistry([{ source: 'a', text: synText }, { source: 'b', text: reseal(syn, (b) => { b['profileId'] = 'other'; }) }], { allowSynthetic: true });
    assert.deepEqual([two.select(haiku, COUNTER_VERSION).state, two.select(haiku, COUNTER_VERSION).reason], ['INCOMPATIBLE', 'multiple_profiles_for_key']);
  });
  it('NOT_CALIBRATED: the pilot profiles (24 historical real calls) are intact, compatible and calibrated=false', () => {
    const reg = loadCalibrationProfilesFromDir(PILOT_DIR);
    assert.equal(reg.summary().corrupt.length, 0);
    assert.equal(reg.summary().loaded.length, 3);
    for (const f of PILOT_FILES) {
      const p = JSON.parse(readFileSync(join(PILOT_DIR, f), 'utf8')) as CalibrationProfileV1;
      assert.equal(p.calibrated, false, f);
      assert.equal(p.synthetic, false, f);
      assert.equal(p.targetKind, 'provider_final_usage', f);
      assert.ok(p.limitations.some((l) => /Insufficient sample/.test(l)), f);
      const support = resolveModelSupport(p.provider, p.apiVariant, p.model);
      const sel = reg.select(support, COUNTER_VERSION);
      assert.equal(sel.state, 'NOT_CALIBRATED', f);
      assert.equal(sel.profileId, p.profileId);
      assert.deepEqual(sel.threshold, { ...HEURISTIC_THRESHOLD_V0 }, f);
    }
  });
});

describe('Phase 8 — the conference uses the selected profile', () => {
  const adj = syn.parameters.categories.input!;
  const L = 1000; const E = Number(expectedTokens(adj, BigInt(L)));
  it('approximate tokenizer: heuristic gives no verdict; the COMPATIBLE profile gives one (verdict changes)', () => {
    const usage = anthropicUsage(E, 20);
    const heur = conference(haiku, usage, local(L, 20), emptyCalibrationRegistry().select(haiku, COUNTER_VERSION));
    assert.equal(heur.state, 'incomplete');
    assert.equal(heur.verdict, 'not_applicable');
    assert.deepEqual(heur.calibration, { state: 'ABSENT', profileId: null, evidenceHash: null, reason: 'no_profile_for_provider_api_model' });
    const cal = conference(haiku, usage, local(L, 20), synRegistry().select(haiku, COUNTER_VERSION));
    assert.equal(cal.state, 'compared');
    assert.equal(cal.verdict, 'within_threshold');
    assert.equal(cal.threshold.calibrated, true);
    assert.equal(cal.threshold.calibrationVersion, syn.profileId);
    assert.deepEqual(cal.calibration, { state: 'COMPATIBLE', profileId: syn.profileId, evidenceHash: syn.evidenceHash, reason: null });
    // output is not covered by this profile: listed with raw numbers, outside the verdict
    assert.deepEqual(cal.coveredCategories, ['input']);
    assert.ok(cal.uncoveredCategories.includes('output'));
    assert.equal(cal.comparisons.find((c) => c.category === 'output')!.adjusted, undefined);
  });
  it('raw local count and provider usage are kept; the adjusted expectation is reported separately', () => {
    const P = E + 400;
    const rep = conference(haiku, anthropicUsage(P, 20), local(L, 20), synRegistry().select(haiku, COUNTER_VERSION));
    const c = rep.comparisons.find((x) => x.category === 'input')!;
    assert.equal(c.local, BigInt(L));
    assert.equal(c.provider, BigInt(P));
    assert.equal(c.absoluteDelta, BigInt(P - L));
    assert.deepEqual(c.adjusted, { expected: BigInt(E), absoluteDelta: 400n, relativeDelta: c.adjusted!.relativeDelta });
    assert.equal(rep.verdict, 'divergent');
  });
  it('exact tokenizer: a calibrated (synthetic) envelope turns the heuristic "divergent" into "within_threshold"', () => {
    // synthetic pairs: provider = local + 40 ± 2 (an invented envelope), 300 groups split by group hash
    const pairs: CalibrationPair[] = Array.from({ length: 300 }, (_, i) => {
      const group = `env-${i}`; const s = splitOf(group);
      return { id: group, group, split: s === 'test' ? 'holdout' : s, category: 'input' as const, local: 20 + 13 * i, target: 20 + 13 * i + 40 + ((i % 5) - 2) };
    });
    const profile = fitCalibrationProfile({ profileId: 'otk.calib.SYNTHETIC-TEST-ONLY.envelope40', synthetic: true, targetKind: 'synthetic_rule', support: mini, model: 'gpt-4o-mini',
      counterVersion: COUNTER_VERSION, categories: ['input'], pairs, corpusId: 'in-test', corpusSha256: null, splitRule: 'corpus.ts splitOf', createdAt: NOW,
      scope: { description: 'SYNTHETIC', excludes: [] }, limitations: ['SYNTHETIC'] });
    assert.equal(profile.calibrated, true, JSON.stringify(profile.acceptance.checks.filter((c) => !c.passed)));
    const reg = createCalibrationRegistry([{ source: 'env.json', text: JSON.stringify(profile) }], { allowSynthetic: true });
    const usage = openaiUsage(140, 5); const l = local(100, 5);
    const heur = conference(mini, usage, l, null);
    assert.deepEqual([heur.state, heur.verdict], ['compared', 'divergent']);
    const cal = conference(mini, usage, l, reg.select(mini, COUNTER_VERSION));
    assert.deepEqual([cal.state, cal.verdict], ['compared', 'within_threshold']);
    assert.equal(cal.comparisons[0]!.absoluteDelta, 40n); // raw delta still reported
  });
  it('CE1 accepts the report and a stored copy decodes to the same digest; a report without calibration has no new keys', () => {
    const rep = conference(haiku, anthropicUsage(E + 400, 20), local(L, 20), synRegistry().select(haiku, COUNTER_VERSION));
    const d = digestConferenceV1(rep);
    assert.equal(digestConferenceV1(decodeConference(JSON.parse(encodeJson(rep)))), d);
    const plain = buildConferenceReport({ key: KEY, receiptDigest: DIGEST, usage: openaiUsage(100, 5), local: local(100, 5), support: mini, now: NOW, threshold: HEURISTIC_THRESHOLD_V0 });
    assert.equal('calibration' in plain, false);
    assert.ok(plain.comparisons.every((c) => !('adjusted' in c)));
    assert.equal(digestConferenceV1(decodeConference(JSON.parse(encodeJson(plain)))), digestConferenceV1(plain));
  });
  it('restart: profiles reloaded from files give the same selection and the same report digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'otk-p8-'));
    try {
      writeFileSync(join(dir, 'syn.json'), synText);
      for (const f of PILOT_FILES) writeFileSync(join(dir, f), readFileSync(join(PILOT_DIR, f)));
      const digests = [0, 1].map(() => {
        const reg = loadCalibrationProfilesFromDir(dir, { allowSynthetic: true });
        const sel = reg.select(haiku, COUNTER_VERSION);
        assert.equal(sel.state, 'INCOMPATIBLE'); // two profiles claim haiku (synthetic + pilot): fail closed
        const only = loadCalibrationProfilesFromDir(dir, { allowSynthetic: true });
        return { sel: { state: sel.state, reason: sel.reason }, gem: only.select(resolveModelSupport('gemini', 'gemini.generate_content', 'gemini-3.5-flash-lite'), COUNTER_VERSION).state };
      });
      assert.deepEqual(digests[0], digests[1]);
      rmSync(join(dir, PILOT_FILES[0]!));
      const reports = [0, 1].map(() => digestConferenceV1(conference(haiku, anthropicUsage(E, 20), local(L, 20), loadCalibrationProfilesFromDir(dir, { allowSynthetic: true }).select(haiku, COUNTER_VERSION))));
      assert.equal(reports[0], reports[1]);
      const again = conference(haiku, anthropicUsage(E, 20), local(L, 20), loadCalibrationProfilesFromDir(dir, { allowSynthetic: true }).select(haiku, COUNTER_VERSION));
      assert.equal(again.calibration!.state, 'COMPATIBLE');
      // the same directory loaded the way bootstrap does (synthetic refused) never yields a calibrated threshold
      assert.equal(loadCalibrationProfilesFromDir(dir).select(haiku, COUNTER_VERSION).threshold.calibrated, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Phase 8 — out-of-sample metrics and splits', () => {
  const pairs: CalibrationPair[] = Array.from({ length: 400 }, (_, i) => {
    const group = `g-${i % 200}`; const s = splitOf(group);
    return { id: `r-${i}`, group, split: s === 'test' ? 'holdout' : s, category: 'input' as const, local: 10 + 7 * i, target: Math.round((10 + 7 * i) * 1.1) + 5 + (i % 7) };
  });
  const fitIt = (ps: CalibrationPair[]) => fitCalibrationProfile({ profileId: 'otk.calib.SYNTHETIC-TEST-ONLY.metrics', synthetic: true, targetKind: 'synthetic_rule', support: haiku,
    model: 'claude-haiku-4-5-20251001', counterVersion: COUNTER_VERSION, categories: ['input'], pairs: ps, corpusId: 'in-test', corpusSha256: null, splitRule: 'corpus.ts splitOf',
    createdAt: NOW, scope: { description: 'SYNTHETIC', excludes: [] }, limitations: [] });
  it('holdout metrics are computed on the holdout rows only, with the rounded parameters and integer arithmetic', () => {
    const p = fitIt(pairs);
    const hold = pairs.filter((r) => r.split === 'holdout');
    const pred = (x: number) => Number(expectedTokens(p.parameters.categories.input!, BigInt(x)));
    const manual = summarize(hold, pred, { abs: Number(p.thresholdPolicy.absoluteTokens), rel: Number(p.thresholdPolicy.relative) });
    assert.deepEqual(p.validationMetrics.holdout.input, manual);
    assert.equal(p.validationMetrics.holdout.input!.n, hold.length);
    const mae = hold.reduce((s, r) => s + Math.abs(pred(r.local) - r.target), 0) / hold.length;
    assert.equal(p.validationMetrics.holdout.input!.mae, Math.round(mae * 1e6) / 1e6);
    // a quantile is reported only with enough rows (p99 needs 100): never a p99 from a few dozen rows
    if (hold.length < 100) assert.equal(p.validationMetrics.holdout.input!.relErrorQuantiles.p99, null);
    else assert.notEqual(p.validationMetrics.holdout.input!.relErrorQuantiles.p99, null);
  });
  it('the holdout never influences parameters or threshold (changing holdout targets changes only holdout metrics)', () => {
    const a = fitIt(pairs);
    const b = fitIt(pairs.map((r) => (r.split === 'holdout' ? { ...r, target: r.target * 3 } : r)));
    assert.deepEqual(b.parameters, a.parameters);
    assert.deepEqual(b.thresholdPolicy, a.thresholdPolicy);
    assert.notDeepEqual(b.validationMetrics.holdout, a.validationMetrics.holdout);
  });
  it('splits are by group: no group crosses splits in the message corpus', () => {
    const docs = buildMessageCorpus(generateCorpus({ groupsPerFamily: 4 }));
    const byGroup = new Map<string, Set<string>>();
    for (const d of docs) byGroup.set(d.group, (byGroup.get(d.group) ?? new Set()).add(d.split));
    for (const s of byGroup.values()) assert.equal(s.size, 1);
    assert.ok(docs.some((d) => d.kind === 'conversation' && d.messages.length >= 2));
    assert.ok(docs.some((d) => d.system !== null));
  });
});

describe('Phase 8 — bootstrap reads OTK_CALIBRATION_PROFILES_DIR', () => {
  it('a configured directory that does not exist is a startup error (never a silent heuristic)', async () => {
    const env = { OTK_CALIBRATION_PROFILES_DIR: join(tmpdir(), 'otk-p8-does-not-exist-20261006') } as NodeJS.ProcessEnv;
    let missing: string[] = [];
    try { await d1d8ProfileFromEnv('postgres://u:p@127.0.0.1:1/none', env); } catch (e) { missing = (e as D1D8ConfigError).missing ?? []; }
    assert.ok(missing.some((m) => m.startsWith('OTK_CALIBRATION_PROFILES_DIR')), missing.join(' | '));
  });
});
