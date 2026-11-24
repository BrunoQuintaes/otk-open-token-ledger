/**
 * OVERNIGHT 20261005 / Phase 8 — builds calibration profiles. No provider call, no key, no network.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/calibration/buildProfiles.ts --synthetic-test-profile <out.json> [--report <file.json>]
 *     SYNTHETIC profile (target = SYNTHETIC_RULE_V1, not any provider) for tests of the runtime path only.
 *   node node_modules/tsx/dist/cli.mjs scripts/calibration/buildProfiles.ts --pilot <PILOTO_V3 dir> --out-dir <dir> [--pairs-out <file>]
 *     infrastructure-test profiles from the 24 historical real pilot calls (input pairs only); the acceptance
 *     policy decides calibrated (expected: false, insufficient sample).
 * --created-at <iso> fixes createdAt (default 2026-10-06T00:00:00.000Z) so the files are reproducible byte for byte.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveModelSupport } from '../../src/providers/catalog/modelCatalog.js';
import { CORPUS_SEED, CORPUS_VERSION, corpusToJsonl, generateCorpus, sha256 } from './corpus.js';
import { loadCorpus } from './runOffline.js';
import { alerts, fitCalibrationProfile, type CalibrationPair, type ThresholdNumbers } from './fitProfile.js';
import { buildMessageCorpus, localCountsOf, MESSAGE_CORPUS_SPLIT_RULE, MESSAGE_CORPUS_VERSION, SYNTHETIC_RULE_V1, syntheticTarget, toRequestBody } from './messageCorpus.js';
import { extractPilotPairs, pilotRowsToPairs, PILOT_PAIRS_VERSION, PILOT_SOURCES } from './pilotPairs.js';
import { expectedTokens, type CalibrationCategory, type CalibrationProfileV1 } from '../../src/tokenization/calibrationProfile.js';
import { HEURISTIC_THRESHOLD_V0 } from '../../src/tokenization/conferenceReport.js';

export const SYNTHETIC_PROFILE_ID = 'otk.calib.SYNTHETIC-TEST-ONLY.anthropic.messages.claude-haiku-4-5-20251001.v1';
export const DEFAULT_CREATED_AT = '2026-10-06T00:00:00.000Z';

/**
 * Synthetic corpora. 'development' is the committed corpus v1 (seed 20260930, 15 groups per family): the threshold
 * method was developed on it and its holdout was looked at, so it is NOT used for the committed profile.
 * 'final' is generated fresh from another seed with more groups (never evaluated during development).
 */
export const SYNTHETIC_CORPORA = Object.freeze({
  development: { seed: CORPUS_SEED, groupsPerFamily: 15, committed: true },
  final: { seed: 20261006, groupsPerFamily: 50, committed: false },
});
export type SyntheticCorpusName = keyof typeof SYNTHETIC_CORPORA;

export function syntheticPairs(name: SyntheticCorpusName = 'final'): { pairs: CalibrationPair[]; corpusSha: string; corpusId: string; counterVersion: string; docs: number } {
  const spec = SYNTHETIC_CORPORA[name];
  const docs = spec.committed ? loadCorpus().docs : generateCorpus({ seed: spec.seed, groupsPerFamily: spec.groupsPerFamily });
  const sha = sha256(corpusToJsonl(docs));
  const support = resolveModelSupport('anthropic', 'anthropic.messages', 'claude-haiku-4-5-20251001');
  const mdocs = buildMessageCorpus(docs);
  const pairs: CalibrationPair[] = [];
  let counterVersion = '';
  for (const d of mdocs) {
    const local = localCountsOf(support, toRequestBody('anthropic.messages', 'claude-haiku-4-5-20251001', d), d.outputText);
    counterVersion = local.counterVersion;
    const t = syntheticTarget(d);
    if (local.input !== null) pairs.push({ id: d.id, group: d.group, split: d.split, category: 'input', local: local.input, target: t.input });
    if (local.output !== null) pairs.push({ id: d.id, group: d.group, split: d.split, category: 'output', local: local.output, target: t.output });
  }
  return { pairs, corpusSha: sha, corpusId: `${MESSAGE_CORPUS_VERSION} over ${CORPUS_VERSION} seed=${spec.seed} groupsPerFamily=${spec.groupsPerFamily}`, counterVersion, docs: mdocs.length };
}

/**
 * SYNTHETIC test profile (target = SYNTHETIC_RULE_V1). The committed fixture is fitted on the 'final' corpus and
 * covers the categories given (default 'input'); whatever the acceptance policy decides is kept as is.
 */
export function buildSyntheticTestProfile(createdAt = DEFAULT_CREATED_AT, categories: CalibrationCategory[] = ['input'],
  data: ReturnType<typeof syntheticPairs> = syntheticPairs('final')): CalibrationProfileV1 {
  const { pairs, corpusSha, counterVersion, corpusId } = data;
  return fitCalibrationProfile({
    profileId: categories.length === 1 && categories[0] === 'input' ? SYNTHETIC_PROFILE_ID : `${SYNTHETIC_PROFILE_ID}.${categories.join('+')}`,
    synthetic: true, targetKind: 'synthetic_rule',
    support: resolveModelSupport('anthropic', 'anthropic.messages', 'claude-haiku-4-5-20251001'),
    model: 'claude-haiku-4-5-20251001', modelAliases: [], counterVersion, categories, pairs,
    corpusId, corpusSha256: corpusSha, splitRule: MESSAGE_CORPUS_SPLIT_RULE, createdAt,
    scope: { description: `SYNTHETIC TEST PROFILE. Target = ${SYNTHETIC_RULE_V1}, NOT Anthropic usage. Exists only to exercise the runtime path in tests; a runtime refuses it unless allowSynthetic is set.`, excludes: ['tools', 'images', 'documents', 'cache', 'thinking', 'any real provider behaviour'] },
    limitations: ['SYNTHETIC: says nothing about the precision of the local counter against Anthropic or any provider.', 'Bootstrap (OTK_CALIBRATION_PROFILES_DIR) refuses synthetic profiles (INCOMPATIBLE synthetic_profile_not_allowed).'],
  });
}

/** Detection of injected inflation on the holdout split (calibrated adjusted vs heuristic raw), for the report. */
export function holdoutDetection(profile: CalibrationProfileV1, pairs: CalibrationPair[]) {
  const t: ThresholdNumbers = { abs: Number(profile.thresholdPolicy.absoluteTokens), rel: profile.thresholdPolicy.relative === null ? null : Number(profile.thresholdPolicy.relative) };
  const h: ThresholdNumbers = { abs: Number(HEURISTIC_THRESHOLD_V0.absoluteTokens), rel: Number(HEURISTIC_THRESHOLD_V0.relative) };
  const alterations: Array<[string, (y: number) => number]> = [['none', (y) => y], ['+5%', (y) => Math.round(y * 1.05)], ['+10%', (y) => Math.round(y * 1.1)], ['+25%', (y) => Math.round(y * 1.25)], ['+50 tokens', (y) => y + 50], ['+200 tokens', (y) => y + 200]];
  return profile.categoriesCovered.map((c) => {
    const adj = profile.parameters.categories[c];
    const rows = pairs.filter((p) => p.category === c && p.split === 'holdout');
    const pred = (x: number) => (adj ? Number(expectedTokens(adj, BigInt(x))) : x);
    return {
      category: c, n: rows.length,
      alterations: alterations.map(([name, f]) => ({
        alteration: name,
        calibratedAdjusted: rows.filter((r) => alerts(pred(r.local), f(r.target), t)).length,
        heuristicRaw: rows.filter((r) => alerts(r.local, f(r.target), h)).length,
      })),
    };
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const createdAt = arg('created-at') ?? DEFAULT_CREATED_AT;
  const synth = arg('synthetic-test-profile');
  if (synth) {
    const view = (p: CalibrationProfileV1, pairs: CalibrationPair[]) => ({ profileId: p.profileId, calibrated: p.calibrated, categories: p.categoriesCovered,
      corpusId: p.corpusId, corpus: p.corpus, parameters: p.parameters, thresholdPolicy: p.thresholdPolicy, train: p.errorMetrics.train,
      validation: p.validationMetrics.validation, holdout: p.validationMetrics.holdout, acceptance: p.acceptance, detection: holdoutDetection(p, pairs) });
    const dev = syntheticPairs('development');
    const fin = syntheticPairs('final');
    const profile = buildSyntheticTestProfile(createdAt, ['input'], fin);
    writeFileSync(synth, JSON.stringify(profile, null, 2) + '\n', 'utf8');
    const report = {
      target: 'SYNTHETIC rule (not a provider)',
      development: { note: 'method development corpus (holdout looked at while the threshold method changed); not used for the fixture',
        requestDocs: dev.docs, pairs: dev.pairs.length,
        inputOnly: view(buildSyntheticTestProfile(createdAt, ['input'], dev), dev.pairs), inputAndOutput: view(buildSyntheticTestProfile(createdAt, ['input', 'output'], dev), dev.pairs) },
      final: { note: 'fresh corpus, evaluated once with the frozen method', requestDocs: fin.docs, pairs: fin.pairs.length,
        committedFixture: view(profile, fin.pairs), inputAndOutput: view(buildSyntheticTestProfile(createdAt, ['input', 'output'], fin), fin.pairs) },
    };
    const out = arg('report');
    if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8'); else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const pilot = arg('pilot'); const outDir = arg('out-dir');
  if (pilot && outDir) {
    mkdirSync(outDir, { recursive: true });
    const ex = extractPilotPairs(pilot);
    // the pairs live next to (not inside) the profile directory: that directory is loaded as profiles only
    writeFileSync(arg('pairs-out') ?? join(outDir, '..', 'pilot_v3_input_pairs.json'), JSON.stringify(ex, null, 2) + '\n', 'utf8');
    const summary: unknown[] = [];
    for (const src of PILOT_SOURCES) {
      const rows = ex.rows.filter((r) => r.provider === src.provider);
      const profile = fitCalibrationProfile({
        profileId: `otk.calib.pilot_v3.${src.provider}.${src.api}.${src.model}.v1`, synthetic: false, targetKind: 'provider_final_usage',
        support: resolveModelSupport(src.provider, src.api, src.model), model: src.model, modelAliases: [], counterVersion: ex.counterVersion ?? '',
        categories: ['input'], pairs: pilotRowsToPairs(rows), corpusId: PILOT_PAIRS_VERSION, corpusSha256: null,
        splitRule: `${PILOT_PAIRS_VERSION}: sha256(version:provider:promptSha256) mod 100 → <60 train, <80 validation, else holdout (group = distinct prompt)`,
        createdAt,
        scope: { description: `Infrastructure test only: ${rows.length} real calls of the historical pilot PILOTO_V3 (2026-10-03/04), single user message, text only, ${new Set(rows.map((r) => r.group)).size} distinct prompts.`, excludes: ['output (text not recorded in the run)', 'system messages', 'multi-message', 'tools', 'images', 'cache variation', 'thinking', 'languages other than pt-BR'] },
        limitations: [
          `Insufficient sample: ${rows.length} calls with ${new Set(rows.map((r) => r.group)).size} distinct prompts cannot support a calibrated claim; repeated prompts are not independent observations.`,
          'Target is the usage the provider reported (a declaration of the provider API, not an independent measurement or an invoice).',
          'Output category not covered: the pilot stored only the sha256 and length of the output text.',
        ],
      });
      const file = `pilot_v3_${src.provider}_${src.model}.json`;
      writeFileSync(join(outDir, file), JSON.stringify(profile, null, 2) + '\n', 'utf8');
      summary.push({ file, profileId: profile.profileId, calibrated: profile.calibrated, n: rows.length, groups: profile.corpus.groups, documents: profile.corpus.documents,
        parameters: profile.parameters, thresholdPolicy: profile.thresholdPolicy, train: profile.errorMetrics.train, validation: profile.validationMetrics.validation, holdout: profile.validationMetrics.holdout,
        failedChecks: profile.acceptance.checks.filter((c) => !c.passed).map((c) => `${c.id} (required ${c.required}, observed ${c.observed})`) });
    }
    process.stdout.write(JSON.stringify({ excluded: ex.excluded, rows: ex.rows.length, profiles: summary }, null, 2) + '\n');
    return;
  }
  process.stderr.write('usage: buildProfiles.ts --synthetic-test-profile <out.json> [--report <file>] | --pilot <dir> --out-dir <dir> [--created-at <iso>]\n');
  process.exitCode = 4;
}

if (process.argv[1] && /buildProfiles\.ts$/.test(process.argv[1])) main();
