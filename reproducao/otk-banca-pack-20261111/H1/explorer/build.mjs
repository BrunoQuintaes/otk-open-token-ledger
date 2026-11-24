#!/usr/bin/env node
// Explorador H1 (R26 rev. 2) - script de build. SOMENTE LEITURA das fontes; escreve apenas em web/data/ e web/fig/.
// Deterministico: sem relogio, sem aleatoriedade, JSON canonico (chaves ordenadas). Mesma entrada => mesmos bytes.
//   node build.mjs [--source <_source: copia da baseline H1>] [--inputs <_inputs: copia dos runs R02..R05/CAL>] [--ops-file <inventario R02 alternativo>] [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = '7606bc9be46bde8c1bc427c2eb4873bc1a474779';
const REL = 'docs/_ops/OVERNIGHT2_20261006'; // `git show ${BASELINE}:${REL}/<arquivo>`
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const SOURCE = path.resolve(arg('--source', path.join(here, '_source')));
const INPUTS = path.resolve(arg('--inputs', path.join(here, '_inputs')));
const OUT = path.resolve(arg('--out', path.join(here, 'web', 'data')));
const FIG_OUT = path.resolve(arg('--fig-out', path.join(path.dirname(OUT), 'fig')));
const ROOT = path.join(SOURCE, ...REL.split('/'));
const OPS_FILE = path.resolve(arg('--ops-file', path.join(INPUTS, 'R02', 'inventory_662.jsonl')));

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const canon = (v) => { if (Array.isArray(v)) return v.map(canon); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])); return v; };
const stable = (v) => JSON.stringify(canon(v), null, 1);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const nl = (s) => s.split('\n').filter((l) => l.trim());
const readJsonlAbs = (abs) => nl(fs.readFileSync(abs, 'utf8')).map((l, i) => ({ line: i + 1, o: JSON.parse(l) }));
const num = (s) => (s === '' || s === null || s === undefined ? null : Number(s));

// ---------- registro de arquivos de origem (com sha256) ----------
const files = new Map();
function reg(key, label, abs) {
  if (files.has(key)) return files.get(key);
  const b = fs.readFileSync(abs);
  const f = { path: key, label, sha256: sha(b), bytes: b.length, lines: b.toString('utf8').split('\n').filter((l) => l.length).length };
  files.set(key, f); return f;
}
const h1 = (rel) => reg(`${REL}/${rel}`, 'H1 baseline ' + BASELINE.slice(0, 8), path.join(ROOT, ...rel.split('/')));
const inp = (rel, label) => reg(`runs/${rel}`, label, path.join(INPUTS, ...rel.split('/')));

// ---------- R02: inventario por operacao (fonte primaria) ----------
const R02 = readJsonlAbs(OPS_FILE);
const r02f = reg('runs/R02/inventory_662.jsonl', 'R02 (MET-02) inventário por operação', OPS_FILE);

// ---------- chamadas e manifestos brutos da H1 (campos que o R02 nao traz) ----------
const campaignDir = path.join(ROOT, 'campaign');
const syntheticCalls = [];
const calls = new Map();
for (const abs of walk(campaignDir).filter((f) => f.endsWith('_calls.jsonl'))) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const lines = nl(fs.readFileSync(abs, 'utf8'));
  if (/campaign\/synthetic_gate/.test(rel)) { lines.forEach((l) => syntheticCalls.push(JSON.parse(l).opId)); continue; }
  lines.forEach((l, i) => { const o = JSON.parse(l); calls.set(o.opId, { file: rel, line: i + 1, o }); });
}
const manifests = new Map();
for (const abs of walk(campaignDir).filter((f) => f.endsWith('_manifest.json') && !/campaign\/synthetic_gate/.test(path.relative(ROOT, f).split(path.sep).join('/')))) {
  const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  manifests.set(j.runId, { file: path.relative(ROOT, abs).split(path.sep).join('/'), json: j });
}

// ---------- R03: prompts planejados ----------
inp('R03/prompts.jsonl', 'R03 (E2E-01) prompts planejados');
const prompts = new Map(); // docId -> {prompt, sha256, line}
readJsonlAbs(path.join(INPUTS, 'R03', 'prompts.jsonl')).forEach(({ line, o }) => prompts.set(o.docId, { prompt: o.prompt, sha256: o.prompt_sha256, line }));
inp('R03/special_prompts.json', 'R03 prompts de cache e Besu');
const special = JSON.parse(fs.readFileSync(path.join(INPUTS, 'R03', 'special_prompts.json'), 'utf8')).cacheprobe_and_besu;
const specialByLabel = { besu: special.find((s) => s.name === 'besu'), cache: special.find((s) => /^cacheprobe/.test(s.name)) };
inp('R03/planned_prompt_hash_check.csv', 'R03 prova por hash (manifesto x reconstruído)');
const hashCheck = new Map();
for (const l of nl(fs.readFileSync(path.join(INPUTS, 'R03', 'planned_prompt_hash_check.csv'), 'utf8')).slice(1)) { const c = l.split(','); hashCheck.set(`${c[0]}|${c[3]}`, c[8] === 'true' && c[9] === 'true'); }

// ---------- R05: pares calibrados e metricas ----------
inp('R05/data/pairs_633.csv', 'R05 pares de calibração (633)');
const pairs = new Map();
nl(fs.readFileSync(path.join(INPUTS, 'R05', 'data', 'pairs_633.csv'), 'utf8')).forEach((l, i) => { if (i === 0) return; const c = l.split(','); pairs.set(`${c[0]}|${c[2]}`, { line: i + 1, pred: Number(c[8]), errRaw: Number(c[9]), errCal: Number(c[10]), alertRaw: c[11] === 'true', alertCal: c[12] === 'true' }); });
inp('R05/data/metrics_long.json', 'R05 métricas recomputadas');
const metricsRows = JSON.parse(fs.readFileSync(path.join(INPUTS, 'R05', 'data', 'metrics_long.json'), 'utf8'));
inp('R05/comparison.json', 'R05 comparação com os perfis originais');
const cmp = JSON.parse(fs.readFileSync(path.join(INPUTS, 'R05', 'comparison.json'), 'utf8'));

// ---------- perfis H1 (aceite) ----------
const profiles = {};
for (const f of fs.readdirSync(path.join(ROOT, 'calibration')).filter((n) => /^calibration_profile_.*\.json$/.test(n)).sort()) {
  const rel = `calibration/${f}`; const j = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); h1(rel); profiles[j.model] = { file: `${REL}/${rel}`, json: j };
}
h1('calibration/campaign_summary.json'); h1('calibration/RESULTADOS_CALIBRACAO.md'); h1('campaign/RESUMO_CAMPANHA.md');
const summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'calibration', 'campaign_summary.json'), 'utf8')).summary;

// ---------- detalhe de cada operacao ----------
const detail = [];
const opBySource = new Map();
for (const { line, o: r } of R02) {
  const c = calls.get(r.opId) ?? null;
  if (c) h1(c.file);
  const man = c ? manifests.get(c.o.runId) ?? null : null;
  if (man) h1(man.file);
  const planned = man ? (man.json.plannedCalls ?? []).findIndex((p) => p.label === r.label) : -1;
  const plan = man && planned >= 0 ? man.json.plannedCalls[planned] : null;
  const completed = r.httpStatus === 200;
  const pair = r.docId ? pairs.get(`${r.model_returned}|${r.docId}`) ?? null : null;
  let pr = null;
  const exact = r.docId ? prompts.get(r.docId) : r.label === 'besu' ? specialByLabel.besu : /^cache-/.test(r.label) ? specialByLabel.cache : null;
  if (exact) {
    const text = exact.prompt; const psha = exact.sha256 ?? exact.prompt_sha256;
    pr = { key: r.docId ? r.docId : r.label === 'besu' ? 'special:besu' : 'special:cache', sha256: psha, chars: text.length, manifestSha256: plan?.promptSha256 ?? null, manifestChars: plan?.promptChars ?? null,
      provenByHash: !!plan && plan.promptSha256 === psha && plan.promptChars === text.length && (hashCheck.get(`${REL}/${man.file}|${r.label}`) ?? false),
      r03Line: exact.line ?? null, r03File: exact.line ? 'runs/R03/prompts.jsonl' : 'runs/R03/special_prompts.json' };
  }
  detail.push({
    id: r.opId, label: r.label, line, runId: r.runId, provider: r.provider, model: r.model_returned || null, modelReason: r.model_reason,
    family: r.family || null, group: r.group || null, docId: r.docId || null, sizeBucket: r.sizeBucket || null, splitRaw: r.split_raw || null, split: r.split_norm || null,
    taskType: r.taskType || null, phase: r.phase_dir, http: r.httpStatus, completed, state: r.execution_state, settlement: r.settlement, consistent: r.consistent,
    tsLog: r.ts_log_utc || null, tsSource: r.ts_source,
    conference: r.conference_state ? { state: r.conference_state, verdict: r.conference_verdict } : null,
    local: { input: num(r.local_input), output: num(r.local_output) },
    declared: { input: num(r.declared_input), output: num(r.declared_output), cacheRead: num(r.declared_input_cache_read), reasoning: num(r.declared_output_reasoning), sourceFields: r.declared_source_fields },
    diff: { input: r.diff_input_declared_minus_local === '' ? null : r.diff_input_declared_minus_local, output: r.diff_output_declared_minus_local === '' ? null : r.diff_output_declared_minus_local },
    pair: r.in_calibration_pairs || null, excludedReason: r.excluded_reason || null,
    calibrated: pair ? { pred: pair.pred, errCal: pair.errCal, errRaw: pair.errRaw, alertRaw: pair.alertRaw, alertCal: pair.alertCal, file: 'runs/R05/data/pairs_633.csv', line: pair.line } : null,
    reserveUsd: r.reservedUsd_conservative, cost: { ledgerUsd: r.costUsd_ledger_record, recomputed: r.costUsd_recomputed_frozen_table_NOT_INVOICE || null, vsLedger: r.cost_recompute_vs_ledger || null, note: r.cost_note || null },
    priceTable: { version: r.price_table_version, file: r.price_table_file, sha256: r.price_table_sha256 },
    manifestCommit: r.manifest_commit || null, notes: r.notes || null, missing: r.missing_fields || null,
    receiptDigest: c?.o.conference?.receiptDigest ?? null, conferenceDigest: c?.o.conference?.digest ?? null,
    usageDeclared: c?.o.otkUsageCategories ?? null, output: c ? { chars: c.o.responseChars, sha256: c.o.responseTextSha256 } : null,
    latencyMs: c?.o.latencyMs ?? null, error: c?.o.error ?? null, reservePico: c?.o.otk?.reservedMoneyPico ?? null,
    prompt: pr,
    origin: { inventoryLine: line, sourceFile: r.source_file, sourceLine: r.source_line, sourceSha256: r.source_file_sha256, manifestFile: r.manifest_file, plannedIndex: planned >= 0 ? planned : null },
  });
  opBySource.set(`${r.source_file}:${r.source_line}`, r.opId);
}
for (const x of new Set(detail.map((d) => d.origin.sourceFile))) h1(x.replace(`${REL}/`, ''));
for (const x of new Set(detail.map((d) => d.origin.manifestFile))) if (x) h1(x.replace(`${REL}/`, ''));

// ---------- visao geral ----------
const scale = 1e9; const costNum = (d) => Number(d.cost.recomputed ?? 0);
const group = (arr, f) => { const m = {}; for (const d of arr) (m[f(d)] ??= []).push(d); return m; };
const sumCost = (arr) => arr.reduce((s, d) => s + Math.round(costNum(d) * scale), 0) / scale;
const done = detail.filter((d) => d.completed);
const byModel = Object.entries(group(done, (d) => `${d.provider}/${d.model}`)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, a]) => ({
  key: k, completed: a.length, costRecomputedUsd: Number(sumCost(a).toFixed(8)),
  ledgerUsd: Number((a.reduce((s, d) => s + Math.round((d.cost.ledgerUsd ?? 0) * scale), 0) / scale).toFixed(8)),
  pairs: a.filter((d) => d.pair === 'SIM').length, conference: Object.fromEntries(Object.entries(group(a, (d) => d.conference?.state ?? 'null')).map(([s, x]) => [s, x.length]).sort()) }));
const refused = detail.filter((d) => !d.completed).map((d) => ({ id: d.id, provider: d.provider, http: d.http, label: d.label, error: d.error }));
const familyByProvider = Object.entries(group(detail.filter((d) => d.family), (d) => d.family)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, a]) => ({ family: k, perProvider: Object.fromEntries(Object.entries(group(a, (d) => d.provider)).map(([p, x]) => [p, x.length]).sort()) }));
const profilesInfo = Object.entries(profiles).sort(([a], [b]) => (a < b ? -1 : 1)).map(([m, p]) => ({
  model: m, provider: p.json.provider, tokenizer: p.json.tokenizer, calibrated: p.json.calibrated, file: p.file, evidenceHash: p.json.evidenceHash,
  fit: p.json.parameters.categories.input, threshold: p.json.thresholdPolicy, acceptancePassed: p.json.acceptance.passed,
  acceptance: p.json.acceptance.checks.map((c) => ({ id: c.id, required: c.required, observed: c.observed, passed: c.passed })) }));

// ---------- R04: denominadores ----------
inp('R04/denominators.json', 'R04 denominadores');
const den = JSON.parse(fs.readFileSync(path.join(INPUTS, 'R04', 'denominators.json'), 'utf8'));
const linkItem = (it) => ({ ...it, opId: it.source ? opBySource.get(it.source) ?? null : null });
const denominators = {
  generatedBy: den.generatedBy, inventory: den.inventory, totais: den.totais, mixed: den.mixed_unicode_000_v1,
  providers: Object.fromEntries(Object.entries(den.providers).sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, v]) => [p, {
    S0: v.S0_linhas_calls_jsonl, S0comp: v.S0_composicao, S1: v.S1_realizadas_http200, S1out: (v.S1_saem_recusas ?? []).map(linkItem), S1coleta: v.S1_coleta_denominador,
    S2: v.S2_com_conferencia_capturada, S2states: v.S2_estado_conferencia_das_realizadas, S2out: (v.S2_saem_sem_conferencia ?? []).map(linkItem),
    S3: v.S3_pares_calibracao, S3cache: v.S3_saem_cache, S3besu: v.S3_saem_besu, S4: v.S4_splits, S4family: v.S4_split_x_familia, groupsHoldout: v.S4_grupos_holdout, S4fam: v.S4_familias, chain: v.cadeia, partitionOk: v.particao_ok }])),
};

// ---------- R05: metricas ----------
const verdicts = Object.fromEntries(Object.entries(cmp.models).map(([m, v]) => [m, { splits: Object.fromEntries(Object.entries(v.splits ?? {}).map(([s, x]) => [s, x.verdict])) }]));
const figures = ['fig1_error_by_model_split', 'fig2_mae_by_family', 'fig3_local_vs_declared', 'fig4_holdout_alert_detection'].map((n) => { const f = inp(`R05/figures/${n}.png`, 'R05 figura'); return { name: n, file: `fig/${n}.png`, path: f.path, sha256: f.sha256 }; });
const metrics = { rows: metricsRows, verdicts, profiles: profilesInfo, figures };

// ---------- CAL-ANTH-01 (suplementar; nao mistura com a H1) ----------
inp('CAL_ANTH_VERIFY/RECOMPUTE_RESULTS.json', 'CAL_ANTH_VERIFY recálculo independente');
inp('CAL_ANTH_VERIFY/CAL_ANTH_VERIFICATION_REPORT.md', 'CAL_ANTH_VERIFY relatório de verificação');
const cal = JSON.parse(fs.readFileSync(path.join(INPUTS, 'CAL_ANTH_VERIFY', 'RECOMPUTE_RESULTS.json'), 'utf8')).cal01;
const calVerdict = { 'claude-haiku-4-5-20251001': 'CALIBRATION_ACCEPTED (com ressalvas; relatório §2 item 13)', 'claude-haiku-5-5': 'NOT_ACCEPTED (detecção +25% 12,5%; item 14)', 'claude-sonnet-5-5': 'NOT_ACCEPTED (detecção +25% 12,5%; item 14)', 'claude-opus-5-5': 'NOT_ACCEPTED (detecção +25% 12,5%; item 14)' };
const calOut = {
  commit: 'b55c34298fa7e24ec936396117ce1c7e58f61805', branch: 'origin/experiment/otk-cal-anth-01-20261014', collected: '15/10/2026', label: 'CAL-ANTH-01 - suplementar, 15/10/2026, posterior a H1',
  totals: cal.totals, corpus: cal.corpus, sharedTokenizer: cal.sharedTokenizer, fable: cal.fableExploratory, historicalHaiku45OnNewHoldout: cal.historicalHaiku45OnNewHoldout,
  models: Object.entries(cal.primary).map(([m, v]) => ({ model: m, n: v.n, fit: v.reportedParams, fitMatch: v.paramsMatch, threshold: v.reportedThreshold, thresholdMatch: v.thresholdMatch, holdout: v.reportedHoldout, verdict: calVerdict[m] ?? 'n/d' })),
  limits: { can: 'campanha posterior e suplementar à H1 (15/10 vs 07/10), pré-registrada e commitada antes do primeiro dado, análise congelada, holdout avaliado uma vez; custo CALCULADO pela tabela congelada (não é fatura); Haiku 4.5 aceito pela política v1 nesta amostra', cannot: 'revogar o resultado negativo da H1 (07/10) para o Haiku 4.5 (protocolos e amostras diferentes); afirmar que o OTK verificou cobrança ou detectou inflação real (inflação só simulada); cobrir cache, multimodal, multi-turn, system ou ferramentas', source: 'CAL_ANTH_VERIFICATION_REPORT.md §6' },
  cal02: 'A CAL-ANTH-02 (15/10, 579 chamadas) existe e está descrita no relatório de verificação; NÃO é exibida aqui.',
};

const overview = {
  baseline: BASELINE, baselinePath: REL, opsSource: 'R02 inventory_662.jsonl', r02Sha256: r02f.sha256,
  totals: { operations: detail.length, completed: done.length, refused: refused.length, pairs: detail.filter((d) => d.pair === 'SIM').length, costRecomputedUsd: Number(sumCost(done).toFixed(8)) },
  byModel, refused, familyByProvider, summaryFromSource: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, { calls: v.calls, consistent: v.consistent, costUsdComputedFromLedger: v.costUsdComputedFromLedger }])),
  syntheticExcluded: { calls: syntheticCalls.length, note: 'chamadas de gate SINTÉTICO (pastas campaign/synthetic_gate*): existem na árvore, NÃO fazem parte das 662 operações e não entram em nenhuma contagem' },
  corpus: { sha256: '043b2561b898a375aad62d13be0c4822ccddd2b2d2c94738fdb97462885353e6', note: 'corpus SINTÉTICO (semente 20261007) enviado em chamadas REAIS; o prompt PLANEJADO é comprovado por hash (R03); o corpo exato enviado ao provedor não foi registrado no log (NOT_VERIFIED)' },
  splitNote: 'meta.split = test é o holdout (regra sha256 do grupo mod 100; R03/R04; mapeamento test→holdout do R02/H1): verificado, não é mais pendência.',
  costLabel: 'Custo CALCULADO pela tabela pública congelada; não é fatura.', reserveLabel: 'Reserva conservadora do razão: teto de segurança, não previsão.',
  files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
};

// ---------- escrita ----------
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(FIG_OUT, { recursive: true });
for (const f of figures) fs.copyFileSync(path.join(INPUTS, 'R05', 'figures', `${f.name}.png`), path.join(FIG_OUT, `${f.name}.png`));
const outputs = {};
const emit = (name, key, value) => { const json = stable(value) + '\n'; fs.writeFileSync(path.join(OUT, `${name}.json`), json); fs.writeFileSync(path.join(OUT, `${name}.js`), `window.H1DATA=window.H1DATA||{};window.H1DATA[${JSON.stringify(key)}]=${JSON.stringify(canon(value))};\n`); outputs[`${name}.json`] = sha(json); };
const index = detail.map((d) => ({ id: d.id, label: d.label, provider: d.provider, model: d.model, family: d.family, split: d.split, http: d.http, completed: d.completed, state: d.conference?.state ?? null, verdict: d.conference?.verdict ?? null, costUsd: d.cost.recomputed === null ? null : Number(d.cost.recomputed), diff: d.diff.input === null ? null : Number(d.diff.input), pair: d.pair }));
const promptTexts = Object.fromEntries([...[...prompts.entries()].map(([k, v]) => [k, v.prompt]), ['special:besu', specialByLabel.besu.prompt], ['special:cache', specialByLabel.cache.prompt]].sort(([a], [b]) => (a < b ? -1 : 1)));
emit('prompts', 'prompts', promptTexts);
emit('overview', 'overview', overview); emit('ops_index', 'index', index); emit('ops_detail', 'detail', detail);
emit('denominators', 'denominators', denominators); emit('metrics', 'metrics', metrics); emit('cal', 'cal', calOut);
fs.writeFileSync(path.join(OUT, 'BUILD_MANIFEST.json'), stable({ baseline: BASELINE, opsSource: 'R02', figures: figures.map((f) => ({ file: f.file, sha256: f.sha256 })), outputs }) + '\n');
console.log(JSON.stringify({ ok: true, operations: detail.length, completed: done.length, refused: refused.length, pairs: overview.totals.pairs, syntheticExcluded: syntheticCalls.length, promptsLinked: detail.filter((d) => d.prompt).length, provenByHash: detail.filter((d) => d.prompt?.provenByHash).length, outputs }, null, 1));
