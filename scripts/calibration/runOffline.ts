/**
 * D8-G02 — offline calibration experiment (front B). No provider call, no key, no network.
 *
 *   npx tsx scripts/calibration/runOffline.ts [--write-corpus] [--out <file.json>]
 *
 * The target here is SYNTHETIC (a simulated provider), so the numbers measure the pipeline and
 * the methods, not any real provider:
 *   S1 approx_tokenizer: local = cl100k_base text count; target = o200k_base count + 7
 *      (a different tokenizer plus a fixed envelope, standing in for an unknown provider);
 *   S2 exact_tokenizer_envelope: local = o200k_base; target = o200k_base + 7.
 * Real targets (provider count endpoint or final usage) come only from runExternal.ts, run by S4.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CORPUS_SEED, CORPUS_VERSION, corpusToJsonl, generateCorpus, sha256, splitOf, type CorpusDoc } from './corpus.js';
import { alerts, calibrateThreshold, detection, fit, metrics, type ModelName, type Row } from './models.js';
import { countWith, loadEncoding } from '../../src/tokenization/tokenizerIdentity.js';

export const CORPUS_PATH = 'test/fixtures/d1d8/b/calibration_corpus_v1.jsonl';
export const CORPUS_SHA_PATH = 'test/fixtures/d1d8/b/calibration_corpus_v1.sha256';
export const EXPERIMENT_VERSION = 'otk.calibration_offline.b4@1';
export const SYNTHETIC_ENVELOPE = 7;
export const HEURISTIC = { abs: 16, rel: 0.1 };

/**
 * The corpus digest is defined over LF line endings: a Windows checkout may convert the file to
 * CRLF (.gitattributes text=auto), and every CR inside a document is JSON-escaped, so this
 * normalization never changes document content.
 */
export function loadCorpus(path = CORPUS_PATH): { docs: CorpusDoc[]; sha: string } {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return { docs: text.trim().split('\n').map((l) => JSON.parse(l) as CorpusDoc), sha: sha256(text) };
}

/** Fit on train, select on validation, report on test (shared by offline and external data). */
export function evaluateScenario(rows: Record<'train' | 'validation' | 'test', Row[]>) {
  const models = (['baseline', 'affine', 'quadratic'] as ModelName[]).map((m) => fit(m, rows.train));
  const perModel = models.map((m) => {
    const thr = calibrateThreshold(m, rows.validation);
    return {
      model: m.name,
      coef: m.coef,
      validation: metrics(m, rows.validation),
      test: metrics(m, rows.test),
      falseAlertRateTest: {
        heuristic_16_10pct: rows.test.length ? alerts(m, rows.test, HEURISTIC).filter(Boolean).length / rows.test.length : null,
        validation_q99: rows.test.length ? alerts(m, rows.test, thr).filter(Boolean).length / rows.test.length : null,
      },
      thresholdFromValidation_q99: thr,
      detectionTest: { heuristic_16_10pct: detection(m, rows.test, HEURISTIC), validation_q99: detection(m, rows.test, thr) },
    };
  });
  const selectedByValidationMae = [...perModel].sort((a, b) => a.validation.mae - b.validation.mae)[0]!.model;
  return { selectedByValidationMae, models: perModel, note: 'quadratic is a comparison only; adopting it requires better out-of-sample results and a documented limit' };
}

export function runExperiment(docs: CorpusDoc[]) {
  const o200k = loadEncoding('o200k_base');
  const cl100k = loadEncoding('cl100k_base');
  const scenarios: Record<string, (d: CorpusDoc) => { x: number; y: number }> = {
    S1_approx_tokenizer_synthetic: (d) => ({ x: countWith(cl100k.encoder, d.text), y: countWith(o200k.encoder, d.text) + SYNTHETIC_ENVELOPE }),
    S2_exact_tokenizer_envelope_synthetic: (d) => ({ x: countWith(o200k.encoder, d.text), y: countWith(o200k.encoder, d.text) + SYNTHETIC_ENVELOPE }),
  };
  const splitCounts = { train: 0, validation: 0, test: 0 };
  const groupsBySplit: Record<string, Set<string>> = { train: new Set(), validation: new Set(), test: new Set() };
  for (const d of docs) { splitCounts[splitOf(d.group)]++; groupsBySplit[splitOf(d.group)]!.add(d.group); }

  const results: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(scenarios)) {
    const rows: Record<'train' | 'validation' | 'test', Row[]> = { train: [], validation: [], test: [] };
    for (const d of docs) rows[splitOf(d.group)].push({ id: d.id, ...f(d) });
    results[name] = evaluateScenario(rows);
  }
  return {
    experiment: EXPERIMENT_VERSION,
    target: 'SYNTHETIC simulated provider (not a provider measurement, not an invoice)',
    syntheticEnvelopeTokens: SYNTHETIC_ENVELOPE,
    tokenizers: { o200k_base: o200k.identity, cl100k_base: cl100k.identity },
    corpus: { version: CORPUS_VERSION, seed: CORPUS_SEED, docs: docs.length, groups: new Set(docs.map((d) => d.group)).size },
    splits: { rule: 'sha256(version:group) mod 100: <60 train, <80 validation, else test', docs: splitCounts, groups: Object.fromEntries(Object.entries(groupsBySplit).map(([k, v]) => [k, v.size])) },
    heuristicThreshold: { ...HEURISTIC, calibrated: false },
    scenarios: results,
    limitations: [
      'Target is synthetic: says nothing about the precision against any real provider (D8-G03 stays BLOCKED_EXTERNAL until S4 runs runExternal.ts).',
      'Text-only documents, no message envelope variation, no tools/media.',
      'One seed; distribution of a real workload may differ.',
    ],
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--write-corpus')) {
    const text = corpusToJsonl(generateCorpus());
    mkdirSync(dirname(CORPUS_PATH), { recursive: true });
    writeFileSync(CORPUS_PATH, text, 'utf8');
    writeFileSync(CORPUS_SHA_PATH, `${sha256(text)}  calibration_corpus_v1.jsonl\n`, 'utf8');
  }
  if (!existsSync(CORPUS_PATH)) throw new Error(`corpus missing: ${CORPUS_PATH} (run with --write-corpus)`);
  const { docs, sha } = loadCorpus();
  const expected = readFileSync(CORPUS_SHA_PATH, 'utf8').split(/\s+/)[0];
  if (sha !== expected) throw new Error(`corpus sha256 ${sha} differs from manifest ${expected}`);
  const regenerated = sha256(corpusToJsonl(generateCorpus()));
  const report = { ...runExperiment(docs), corpusSha256: sha, corpusRegeneratedMatches: regenerated === sha, generatedAt: new Date().toISOString() };
  const outIdx = args.indexOf('--out');
  const json = JSON.stringify(report, null, 2) + '\n';
  if (outIdx >= 0 && args[outIdx + 1]) writeFileSync(args[outIdx + 1]!, json, 'utf8');
  else process.stdout.write(json);
}

if (process.argv[1] && /runOffline\.ts$/.test(process.argv[1])) main();
