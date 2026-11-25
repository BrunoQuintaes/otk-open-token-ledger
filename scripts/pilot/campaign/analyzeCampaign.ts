/**
 * OVERNIGHT 2 — campaign analysis (offline; reads the runner's *_calls.jsonl files, never calls a provider).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/pilot/campaign/analyzeCampaign.ts --root=<campaign dir> --out=<dir>
 *
 * For every real operation: disjoint quantities per canonical category, CU under the 2026-10 CANDIDATE reference
 * profile (normalization NOT chosen by Bruno: computed under two explicit references, labelled CU_REFERENCE_CANDIDATE),
 * the legacy development CU the receipt carries, the computed cost (frozen public table; not an invoice), and the
 * calibration pair (provider input count vs local counter) with the split fixed by 07_CALIBRATION_PROTOCOL.md.
 * Then the calibration profile is fitted per model with the unchanged fitter and acceptance policy.
 *
 * Reads every `*_calls.jsonl` under `--root` (sub-folders whose name starts with `synthetic` are skipped) and the
 * candidate CU reference profile in `config/cu_reference/`. Writes `campaign_ops.jsonl`, one
 * `calibration_profile_<provider>_<model>.json` per model and `campaign_summary.json` into `--out`. Exit code 4
 * when an argument is missing, otherwise 0. No network, no environment variables.
 *
 * @module scripts/pilot/campaign/analyzeCampaign
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CuReferenceDefinition, CuReferenceProfileV1, NormalizedUsage, TokenCategory } from '../../../src/types/d1d8/index.js';
import { computeCuReference } from '../../../src/economics/cuReference.js';
import { fitCalibrationProfile, type CalibrationPair } from '../../calibration/fitProfile.js';
import { resolveModelSupport } from '../../../src/providers/catalog/modelCatalog.js';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'cu_reference', 'otk.cu.reference.v1.2026-10.candidate-1.json'), 'utf8')) as CuReferenceProfileV1;
const REFS: Record<string, CuReferenceDefinition> = {
  ref_4omini_input: { kind: 'model_category', provider: 'openai', model: 'gpt-4o-mini', category: 'input_uncached' },
  ref_abstract_1usd_per_mtok: { kind: 'abstract_price', priceMicroUsdPerMTok: '1000000' },
};
const API: Record<string, NormalizedUsage['api']> = { anthropic: 'anthropic.messages', openai: 'openai.chat_completions', gemini: 'gemini.generate_content' };

interface CallRec {
  runId: string; label: string; opId: string; httpStatus?: number; consistent: boolean; meta: Record<string, string> | null; attribution: Record<string, string> | null;
  otkUsageCategories: Array<{ name: TokenCategory['name']; count: string | null; inclusion: TokenCategory['inclusion']; sourceField?: string }> | null; otkModelReturned: string | null;
  conference: { state: string | null; verdict: string | null; comparisons: Array<{ category: string; provider: string | null; local: string | null }> } | null;
  ledgerReservation: { costUsd: number | null; settlement: string }; oracle: { cuMicro: string; costPico: string } | null; returnedModel?: string;
}

function readCalls(dir: string): CallRec[] {
  const out: CallRec[] = [];
  const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (!f.name.startsWith('synthetic')) walk(p); } else if (f.name.endsWith('_calls.jsonl')) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) if (l.trim()) out.push(JSON.parse(l) as CallRec); } };
  walk(dir);
  return out;
}

function main(): number {
  const root = arg('root'); const outDir = arg('out');
  if (!root || !outDir) { console.error('usage: --root=<campaign dir> --out=<dir>'); return 4; }
  fs.mkdirSync(outDir, { recursive: true });
  const calls = readCalls(root);
  const providerOf = (dir: string) => dir;
  const rows: Record<string, unknown>[] = [];
  const pairsByModel: Record<string, CalibrationPair[]> = {};
  const totals: Record<string, { calls: number; consistent: number; costUsd: number; legacyCuMicro: bigint; cuRef: Record<string, { num: bigint; den: bigint }>; q: Record<string, bigint>; notComputable: Record<string, number> }> = {};
  for (const c of calls) {
    // runId = pv3-<openai|gemini35|gemini>-live-... for those profiles and pv3-live-... for the Anthropic profile
    const rp = c.runId.split('-')[1] ?? '';
    const provider = rp === 'openai' ? 'openai' : rp.startsWith('gemini') ? 'gemini' : 'anthropic';
    const model = c.otkModelReturned ?? c.returnedModel ?? (c.httpStatus === 200 ? 'unknown' : 'refused_before_usage');
    const key = `${provider}/${model}`;
    const t = (totals[key] ??= { calls: 0, consistent: 0, costUsd: 0, legacyCuMicro: 0n, cuRef: {}, q: {}, notComputable: {} });
    t.calls++; if (c.consistent) t.consistent++;
    t.costUsd += c.ledgerReservation?.costUsd ?? 0;
    if (c.oracle) t.legacyCuMicro += BigInt(c.oracle.cuMicro);
    const cats = (c.otkUsageCategories ?? []).map((x) => ({ name: x.name, count: x.count === null ? null : BigInt(x.count), inclusion: x.inclusion, sourceField: x.sourceField ?? 'stored' }));
    const usage: NormalizedUsage = {
      schema: 'otk.usage.v1', api: API[provider] ?? 'openai.chat_completions', provider, modelRequested: model, modelReturned: model, providerRequestId: null, origin: 'provider_response',
      completeness: cats.length ? 'complete' : 'missing', categories: cats, tIn: null, tOut: null, tRule: 'stored', rawUsageDigest: `0x${'00'.repeat(32)}`, normalizerVersion: 'stored',
      docRef: { url: 'stored', retrievedAt: '1970-01-01T00:00:00.000Z' }, observedAt: '1970-01-01T00:00:00.000Z',
    };
    const cu: Record<string, unknown> = {};
    for (const [name, ref] of Object.entries(REFS)) {
      const r = computeCuReference(usage, PROFILE, { reference: ref });
      cu[name] = { status: r.status, label: r.label, exact: r.exact, decimal: r.cu ? (Number(r.cu.units) / 1e9).toFixed(9) : null, quantities: r.quantities };
      if (r.status === 'computed') {
        const acc = (t.cuRef[name] ??= { num: 0n, den: 1n });
        const n = BigInt(r.exact!.numerator); const d = BigInt(r.exact!.denominator);
        acc.num = acc.num * d + n * acc.den; acc.den *= d;
        if (name === 'ref_4omini_input') for (const [k, v] of Object.entries(r.quantities ?? {})) t.q[k] = (t.q[k] ?? 0n) + BigInt(v as string);
      } else t.notComputable[r.status] = (t.notComputable[r.status] ?? 0) + 1;
    }
    const inputCmp = c.conference?.comparisons.find((x) => x.category === 'input');
    const isCalibration = c.attribution?.taskType === 'calibration-sample' && c.meta?.group && c.consistent;
    if (isCalibration && inputCmp && inputCmp.provider !== null && inputCmp.local !== null) {
      (pairsByModel[key] ??= []).push({ id: c.meta!.docId!, group: c.meta!.group!, split: (c.meta!.split === 'test' ? 'holdout' : c.meta!.split) as CalibrationPair['split'], category: 'input', local: Number(inputCmp.local), target: Number(inputCmp.provider) });
    }
    rows.push({ label: c.label, opId: c.opId, provider, model, consistent: c.consistent, httpStatus: c.httpStatus, taskType: c.attribution?.taskType ?? null, meta: c.meta,
      costUsdComputed: c.ledgerReservation?.costUsd ?? null, legacyCuMicro: c.oracle?.cuMicro ?? null, cuReferenceCandidate: cu,
      conference: c.conference ? { state: c.conference.state, verdict: c.conference.verdict, input: inputCmp ?? null } : null });
  }
  fs.writeFileSync(path.join(outDir, 'campaign_ops.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const profiles: Record<string, unknown> = {};
  for (const [key, pairs] of Object.entries(pairsByModel)) {
    const [provider, model] = key.split('/') as [string, string];
    const support = resolveModelSupport(provider, API[provider] ?? 'openai.chat_completions', model);
    if (!support.tokenizer) { profiles[key] = { skipped: 'no local tokenizer for this model' }; continue; }
    const prof = fitCalibrationProfile({
      profileId: `otk.calib.ovn2-20261007.${provider}.${API[provider]}.${model}`, synthetic: false, targetKind: 'provider_final_usage',
      support, model, modelAliases: [], counterVersion: 'otk.local_counter.b3@1', categories: ['input'], pairs,
      corpusId: 'otk.calibration_corpus.synthetic.v1@seed20261007/g9/v2', corpusSha256: arg('corpus-sha256') ?? null,
      splitRule: 'sha256(otk.calibration_corpus.synthetic.v1:<group>) mod 100: <60 train, <80 validation, else holdout (fixed before data, 07_CALIBRATION_PROTOCOL.md)',
      createdAt: '2026-10-07T00:00:00.000Z',
      scope: { description: 'single user message summarization prompts of the OVERNIGHT 2 synthetic corpus (seed 20261007), max 24 output tokens, no stream, no system, no tools', excludes: ['system prompts', 'multi-turn', 'tools', 'images', 'documents', 'cache-probe repeats', 'streaming'] },
      limitations: ['real campaign of OVERNIGHT 2 (07/10/2026); one model version; protocol 07_CALIBRATION_PROTOCOL.md fixed before data; the target is the provider count itself (calibration cannot show that the provider counted right)'],
    });
    fs.writeFileSync(path.join(outDir, `calibration_profile_${provider}_${model}.json`), JSON.stringify(prof, null, 2) + '\n');
    profiles[key] = { calibrated: (prof as { calibrated: boolean }).calibrated, n: pairs.length, bySplit: Object.fromEntries(['train', 'validation', 'holdout'].map((s) => [s, pairs.filter((p) => p.split === s).length])) };
  }
  const summary = Object.fromEntries(Object.entries(totals).map(([k, t]) => [k, {
    calls: t.calls, consistent: t.consistent, costUsdComputedFromLedger: Number(t.costUsd.toFixed(9)), legacyDevelopmentCu: (Number(t.legacyCuMicro) / 1e6).toString(),
    quantities: Object.fromEntries(Object.entries(t.q).map(([a, b]) => [a, b.toString()])),
    cuReferenceCandidate: Object.fromEntries(Object.entries(t.cuRef).map(([n, f]) => [n, (Number(f.num * 1_000_000_000n / f.den) / 1e9).toFixed(9)])), notComputable: t.notComputable,
  }]));
  fs.writeFileSync(path.join(outDir, 'campaign_summary.json'), JSON.stringify({ note: 'CU under the CANDIDATE profile (normalization not chosen; two explicit references shown). Cost = computed from the frozen public table, not an invoice. Quantities = disjoint canonical categories summed over computed operations (once per reference; identical for both).', summary, calibration: profiles }, null, 2) + '\n');
  console.log(JSON.stringify({ calls: calls.length, models: Object.keys(totals), calibration: profiles }));
  void providerOf;
  return 0;
}
process.exit(main());
