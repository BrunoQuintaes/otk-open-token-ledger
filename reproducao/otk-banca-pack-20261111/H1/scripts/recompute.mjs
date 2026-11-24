#!/usr/bin/env node
// R05 - RECOMPUTO INDEPENDENTE das metricas dos perfis H1 (campanha OVERNIGHT2_20261006, baseline 7606bc9b).
// Script NOVO, fora do H1. Usa EXATAMENTE os parametros/limiares congelados dos perfis originais
// (sem reajuste, sem mudar limiar, sem promover perfil rejeitado). RMSE e metrica NOVA (nao existe no original).
// Separa: RAW (contagem local crua, limiar heuristico v0) x CALIBRADO (afim congelado, limiar do perfil) x DECLARADO (alvo).
// Uso: node recompute.mjs --h1 <copia_leitura_7606bc9b> --inventory ../R02/inventory_662.jsonl --out <runs/R05>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const H1 = arg('h1'); const INV = arg('inventory'); const OUT = arg('out');
if (!H1 || !INV || !OUT) { console.error('uso: --h1 <copia> --inventory <inventory_662.jsonl> --out <dir>'); process.exit(2); }
const sha = (b) => createHash('sha256').update(b).digest('hex');
const CAL = join(H1, 'docs/_ops/OVERNIGHT2_20261006/calibration');
const invBuf = readFileSync(INV); const inv = invBuf.toString('utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const MODELS = [
  { provider: 'openai', model: 'gpt-4o-mini-2024-07-18', file: 'calibration_profile_openai_gpt-4o-mini-2024-07-18.json' },
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', file: 'calibration_profile_anthropic_claude-haiku-4-5-20251001.json' },
  { provider: 'gemini', model: 'gemini-3.5-flash-lite', file: 'calibration_profile_gemini_gemini-3.5-flash-lite.json' },
];
const FAMILIES = ['pt_prose', 'en_prose', 'code_ts', 'json', 'markdown_table', 'mixed_unicode', 'numeric', 'tiny'];
const SPLITS = ['train', 'validation', 'holdout'];
const HEURISTIC_V0 = { abs: 16, rel: 0.1 }; // src/tokenization/conferenceReport.ts HEURISTIC_THRESHOLD_V0 (16 tokens, 0.100000)

// ---------- aritmetica identica a do H1 (src/tokenization/calibrationProfile.ts) ----------
const MICRO = 1000000n;
const decToMicro = (s) => { const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.'); const m = BigInt(i) * MICRO + BigInt((f + '000000').slice(0, 6)); return neg ? -m : m; };
const expectedTokens = (slope, intercept, local) => { const v = decToMicro(slope) * BigInt(local) + decToMicro(intercept); if (v <= 0n) return 0; return Number((v + MICRO / 2n) / MICRO); }; // round_half_up, min 0
const r6 = (x) => Math.round(x * 1e6) / 1e6;
// regra otk.conference.rule.v1: |d| > abs AND (target = 0 OR rel = null OR |d|/target > rel)
const alerts = (pred, target, t) => { const d = Math.abs(target - pred); if (d <= t.abs) return false; if (target === 0 || t.rel === null) return true; return d / target > t.rel; };
const quantileOrNull = (sorted, q) => { if (!sorted.length) return null; const need = q === 0.5 ? 1 : Math.ceil(1 / (1 - q) - 1e-9); if (sorted.length < need) return null; return r6(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]); };
const ALTER = [['det_plus10pct', (y) => Math.round(y * 1.1)], ['det_plus25pct', (y) => Math.round(y * 1.25)], ['det_plus50tok', (y) => y + 50]];
function summarize(rows, predict, t) {
  const errs = rows.map((r) => predict(r.local) - r.target); const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const relRows = rows.filter((r) => r.target > 0); const rel = relRows.map((r) => Math.abs(predict(r.local) - r.target) / r.target).sort((a, b) => a - b);
  const n = rows.length;
  const o = { n, groups: new Set(rows.map((r) => r.group)).size,
    bias: n ? r6(errs.reduce((s, e) => s + e, 0) / n) : null, mae: n ? r6(abs.reduce((s, e) => s + e, 0) / n) : null,
    rmse_NEW: n ? r6(Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / n)) : null, maxAbs: n ? abs[abs.length - 1] : null,
    nRelative: rel.length, zeroTargets: n - relRows.length, p50: quantileOrNull(rel, 0.5), p90: quantileOrNull(rel, 0.9), p95: quantileOrNull(rel, 0.95), p99: quantileOrNull(rel, 0.99),
    alertRate: n && t ? r6(rows.filter((r) => alerts(predict(r.local), r.target, t)).length / n) : null, alerts_n: n && t ? rows.filter((r) => alerts(predict(r.local), r.target, t)).length : null };
  for (const [k, f] of ALTER) o[k] = n && t ? r6(rows.filter((r) => alerts(predict(r.local), f(r.target), t)).length / n) : null;
  return o;
}
// verificacao dos parametros congelados: minimos quadrados pelo MESMO metodo do H1 (scripts/calibration/models.ts: equacoes normais, x escalado). NAO e um reajuste usado em nada.
function fitAffineLikeH1(rows) {
  const s = Math.max(1, ...rows.map((r) => Math.abs(r.local))); const k = 2; const A = [[0, 0], [0, 0]]; const b = [0, 0];
  for (const r of rows) { const f = [1, r.local / s]; for (let i = 0; i < k; i++) { b[i] += f[i] * r.target; for (let j = 0; j < k; j++) A[i][j] += f[i] * f[j]; } }
  const M = A.map((row, i) => [...row, b[i]]); const n = 2;
  for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; if (Math.abs(M[p][c]) < 1e-12) return null; [M[c], M[p]] = [M[p], M[c]]; for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let q = c; q <= n; q++) M[r][q] -= f * M[c][q]; } }
  const coef = M.map((row, i) => row[n] / row[i]); const c = coef.map((v, i) => v / s ** i);
  const dec6 = (x) => { const micro = BigInt(Math.round(Math.abs(x) * 1e6)) * (x < 0 ? -1n : 1n); const neg = micro < 0n; const m = neg ? -micro : micro; return `${neg && m !== 0n ? '-' : ''}${m / MICRO}.${(m % MICRO).toString().padStart(6, '0')}`; };
  return { slope: dec6(c[1]), intercept: dec6(c[0]) };
}
// verificacao do limiar congelado: mesma grade do H1 (fitProfile.ts selectThreshold) sobre a validacao com os parametros congelados
function selectThresholdLikeH1(val) {
  const gridOf = (values, points) => { const u = [...new Set(values)].sort((a, b) => a - b); if (u.length <= points) return u; return [...new Set(Array.from({ length: points }, (_, i) => u[Math.round((i * (u.length - 1)) / (points - 1))]))]; };
  const absC = gridOf([1, ...val.map((r) => Math.max(1, Math.ceil(Math.abs(r.target - r.pred))))], 60);
  const relC = gridOf([0, ...val.filter((r) => r.target > 0).map((r) => Math.ceil((Math.abs(r.target - r.pred) / r.target) * 1e6) / 1e6)], 60);
  let best = null;
  for (const A of absC) for (const R of relC) { const t = { abs: A, rel: R }; const fa = val.filter((r) => alerts(r.pred, r.target, t)).length / val.length; if (fa > 0.01) continue; const power = ALTER.reduce((s, [, f]) => s + val.filter((r) => alerts(r.pred, f(r.target), t)).length / val.length, 0) / ALTER.length; if (!best || power > best.power + 1e-12 || (Math.abs(power - best.power) <= 1e-12 && (A > best.abs || (A === best.abs && R > best.rel)))) best = { abs: A, rel: R, falseAlertRate: r6(fa), power: r6(power) }; }
  const ceilMicro = (x) => { const micro = Math.ceil(x * 1e6 - 1e-6); return `${Math.floor(micro / 1e6)}.${String(micro % 1e6).padStart(6, '0')}`; };
  return best ? { absoluteTokens: String(best.abs), relative: ceilMicro(best.rel), falseAlertRate: best.falseAlertRate, meanDetection: best.power } : null;
}

// ---------- valores do RESULTADOS_CALIBRACAO.md (tabela, transcritos para comparar) ----------
const RESULTADOS_MD = {
  'gpt-4o-mini-2024-07-18': { pairs: '120 / 53 / 38 (13)', fit: '1,000000 x local + 7', holdout: '0, 0, 0', falseAlert: '0', det25: '100%', calibrated: 'true', n211: 211 },
  'claude-haiku-4-5-20251001': { pairs: '119 / 54 / 37 (13)', fit: '1,165964 x local + 4,10', holdout: '+6,0; 13,8; 54', falseAlert: '5,4% (2 de 37)', det25: '78%', calibrated: 'false' },
  'gemini-3.5-flash-lite': { pairs: '121 / 54 / 37 (13)', fit: '1,252777 x local - 6,10', holdout: '-0,2; 58,1; 285', falseAlert: '0', det25: '8%', calibrated: 'false' },
};

const long = []; const pairsOut = []; const comparison = { models: {} }; const profilesUsed = {};
const near = (a, b) => (a === null || b === null || a === undefined || b === undefined ? a === b : Math.abs(a - b) <= 1e-6);
for (const M of MODELS) {
  const pbuf = readFileSync(join(CAL, M.file)); const P = JSON.parse(pbuf.toString('utf8'));
  const adj = P.parameters.categories.input; const thr = { abs: Number(P.thresholdPolicy.absoluteTokens), rel: P.thresholdPolicy.relative === null ? null : Number(P.thresholdPolicy.relative) };
  profilesUsed[M.model] = { file: `docs/_ops/OVERNIGHT2_20261006/calibration/${M.file}`, sha256: sha(pbuf), profileId: P.profileId, evidenceHash: P.evidenceHash, slope: adj.slope, intercept: adj.intercept, thresholdAbs: P.thresholdPolicy.absoluteTokens, thresholdRel: P.thresholdPolicy.relative, calibrated: P.calibrated };
  const rows = inv.filter((r) => r.provider === M.provider && r.in_calibration_pairs === 'SIM').map((r) => ({ id: r.docId, group: r.group, split: r.split_norm, family: r.family, local: Number(r.local_input), target: Number(r.declared_input), label: r.label, src: `${r.source_file}:${r.source_line}` }));
  const predCal = (x) => expectedTokens(adj.slope, adj.intercept, x); const predRaw = (x) => x;
  for (const r of rows) pairsOut.push({ model: M.model, provider: M.provider, docId: r.id, group: r.group, split: r.split, family: r.family, local_raw: r.local, declared: r.target, pred_calibrated: predCal(r.local), err_raw: r.local - r.target, err_calibrated: predCal(r.local) - r.target, alert_raw_heuristic_v0: alerts(r.local, r.target, HEURISTIC_V0), alert_calibrated_frozen: alerts(predCal(r.local), r.target, thr), source: r.src });
  const levels = [['all', (r) => true], ...SPLITS.map((s) => [s, (r) => r.split === s])];
  for (const [split, fs] of levels) for (const fam of ['all', ...FAMILIES]) {
    const sub = rows.filter((r) => fs(r) && (fam === 'all' || r.family === fam));
    long.push({ model: M.model, split, family: fam, estimator: 'RAW_local_heuristic_v0', ...summarize(sub, predRaw, HEURISTIC_V0) });
    long.push({ model: M.model, split, family: fam, estimator: 'CALIBRATED_frozen_profile', ...summarize(sub, predCal, thr) });
  }
  // comparacao com o perfil original (errorMetrics.train, validationMetrics.validation/holdout) e com o RESULTADOS_CALIBRACAO.md
  const cmp = { profile: profilesUsed[M.model], splits: {}, acceptance: {}, parameters_verification: null, threshold_verification: null, resultados_md: RESULTADOS_MD[M.model] };
  for (const s of SPLITS) {
    const orig = s === 'train' ? P.errorMetrics.train.input : P.validationMetrics[s].input;
    const mine = long.find((l) => l.model === M.model && l.split === s && l.family === 'all' && l.estimator === 'CALIBRATED_frozen_profile');
    const fields = { n: [orig.n, mine.n], groups: [orig.groups, mine.groups], bias: [orig.bias, mine.bias], mae: [orig.mae, mine.mae], maxAbs: [orig.maxAbs, mine.maxAbs], p50: [orig.relErrorQuantiles.p50, mine.p50], p90: [orig.relErrorQuantiles.p90, mine.p90], p95: [orig.relErrorQuantiles.p95, mine.p95], p99: [orig.relErrorQuantiles.p99, mine.p99], alertRate: [orig.alertRate, s === 'train' ? null : mine.alertRate] };
    const diffs = Object.entries(fields).filter(([, [a, b]]) => !near(a, b)).map(([k, [a, b]]) => `${k}: original=${a} recomputado=${b}`);
    cmp.splits[s] = { original: Object.fromEntries(Object.entries(fields).map(([k, [a]]) => [k, a])), recomputed: Object.fromEntries(Object.entries(fields).map(([k, [, b]]) => [k, b])), rmse_NEW: mine.rmse_NEW, verdict: diffs.length ? 'DIFERE' : 'REPRODUZIDO', diffs, note_train_alertRate: s === 'train' ? 'original nao calcula alertRate no treino (null); recomputado tambem omitido aqui (valor disponivel em metrics_long.csv)' : undefined };
  }
  const hold = long.find((l) => l.model === M.model && l.split === 'holdout' && l.family === 'all' && l.estimator === 'CALIBRATED_frozen_profile');
  const val = long.find((l) => l.model === M.model && l.split === 'validation' && l.family === 'all' && l.estimator === 'CALIBRATED_frozen_profile');
  const chk = (id) => P.acceptance.checks.find((c) => c.id === id);
  cmp.acceptance = {
    holdout_alert_rate: { original: chk('input.holdout_alert_rate').observed, recomputed: String(hold.alertRate), verdict: near(Number(chk('input.holdout_alert_rate').observed), hold.alertRate) ? 'REPRODUZIDO' : 'DIFERE', alerts_n: hold.alerts_n, n: hold.n },
    holdout_detection_plus25pct: { original: chk('input.holdout_detection_plus25pct').observed, recomputed: String(hold.det_plus25pct), verdict: near(Number(chk('input.holdout_detection_plus25pct').observed), hold.det_plus25pct) ? 'REPRODUZIDO' : 'DIFERE' },
    holdout_detection_plus10pct_NEW: hold.det_plus10pct, holdout_detection_plus50tok_NEW: hold.det_plus50tok,
    validation_false_alert_in_derivation: { original_text: (P.thresholdPolicy.derivation.match(/Validation false-alert rate ([0-9]+(?:.[0-9]+)?), mean detection ([0-9]+(?:.[0-9]+)?)/) || []).slice(1), recomputed: [val.alertRate, r6((val.det_plus10pct + val.det_plus25pct + val.det_plus50tok) / 3)] },
    calibrated_original: P.calibrated, calibrated_recomputed_with_same_policy: (hold.n >= 30 && val.n >= 30 && hold.groups >= 10 && hold.alertRate <= 0.05 && hold.det_plus25pct >= 0.5 && long.find((l) => l.model === M.model && l.split === 'train' && l.family === 'all' && l.estimator === 'CALIBRATED_frozen_profile').n >= 60),
  };
  cmp.acceptance.validation_false_alert_in_derivation.verdict = near(Number(cmp.acceptance.validation_false_alert_in_derivation.original_text[0]), val.alertRate) && near(Number(cmp.acceptance.validation_false_alert_in_derivation.original_text[1]), cmp.acceptance.validation_false_alert_in_derivation.recomputed[1]) ? 'REPRODUZIDO' : 'DIFERE';
  const refit = fitAffineLikeH1(rows.filter((r) => r.split === 'train'));
  cmp.parameters_verification = { note: 'VERIFICACAO apenas (minimos quadrados pelo mesmo metodo do H1 sobre o treino); os parametros USADOS nas metricas sao os congelados do perfil', frozen: { slope: adj.slope, intercept: adj.intercept }, refit_check: refit, verdict: refit && refit.slope === adj.slope && refit.intercept === adj.intercept ? 'REPRODUZIDO' : 'DIFERE' };
  const sel = selectThresholdLikeH1(rows.filter((r) => r.split === 'validation').map((r) => ({ pred: predCal(r.local), target: r.target })));
  cmp.threshold_verification = { note: 'VERIFICACAO apenas (mesma grade do H1 sobre a validacao com os parametros congelados); o limiar USADO e o congelado', frozen: { absoluteTokens: P.thresholdPolicy.absoluteTokens, relative: P.thresholdPolicy.relative }, grid_check: sel, verdict: sel && sel.absoluteTokens === P.thresholdPolicy.absoluteTokens && sel.relative === P.thresholdPolicy.relative ? 'REPRODUZIDO' : 'DIFERE' };
  // RESULTADOS_CALIBRACAO.md (tabela): pares, ajuste, holdout vies/MAE/max, falso alerta, deteccao
  const t = long.find((l) => l.model === M.model && l.split === 'train' && l.family === 'all' && l.estimator === 'CALIBRATED_frozen_profile');
  cmp.resultados_md_check = { pairs_recomputed: `${t.n} / ${val.n} / ${hold.n} (${hold.groups})`, holdout_recomputed: `${hold.bias}; ${hold.mae}; ${hold.maxAbs}`, falseAlert_recomputed: `${hold.alertRate} (${hold.alerts_n} de ${hold.n})`, det25_recomputed: `${Math.round(hold.det_plus25pct * 100)}%`, calibrated_recomputed: String(cmp.acceptance.calibrated_recomputed_with_same_policy) };
  comparison.models[M.model] = cmp;
}
mkdirSync(OUT, { recursive: true }); mkdirSync(join(OUT, 'data'), { recursive: true }); mkdirSync(join(OUT, 'tables'), { recursive: true });
const csvEsc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => { const cols = Object.keys(rows[0]); return cols.join(',') + '\n' + rows.map((r) => cols.map((k) => csvEsc(r[k])).join(',')).join('\n') + '\n'; };
writeFileSync(join(OUT, 'data', 'pairs_633.csv'), toCsv(pairsOut));
writeFileSync(join(OUT, 'data', 'metrics_long.csv'), toCsv(long));
writeFileSync(join(OUT, 'data', 'metrics_long.json'), JSON.stringify(long, null, 1) + '\n');
comparison.inputs = { inventory: { path: 'runs/R02/' + INV.split(/[\\/]/).pop(), sha256: sha(invBuf) }, profiles: profilesUsed, heuristic_threshold_v0: HEURISTIC_V0, resultados_md_sha256: sha(readFileSync(join(CAL, 'RESULTADOS_CALIBRACAO.md'))) };
comparison.overall = Object.fromEntries(Object.entries(comparison.models).map(([m, c]) => [m, { splits: Object.fromEntries(SPLITS.map((s) => [s, c.splits[s].verdict])), acceptance_alert: c.acceptance.holdout_alert_rate.verdict, acceptance_det25: c.acceptance.holdout_detection_plus25pct.verdict, derivation: c.acceptance.validation_false_alert_in_derivation.verdict, parameters: c.parameters_verification.verdict, threshold: c.threshold_verification.verdict, calibrated: `${c.acceptance.calibrated_original} -> ${c.acceptance.calibrated_recomputed_with_same_policy}` }]));
writeFileSync(join(OUT, 'comparison.json'), JSON.stringify(comparison, null, 1) + '\n');

// ---------- exemplo ponta a ponta: cal-pt_prose-000-v0 da OpenAI, so com valores do registro individual ----------
const ex = inv.find((r) => r.provider === 'openai' && r.label === 'cal-pt_prose-000-v0');
const exAdj = profilesUsed['gpt-4o-mini-2024-07-18'];
const exPred = expectedTokens(exAdj.slope, exAdj.intercept, Number(ex.local_input));
const example = {
  source: `${ex.source_file}:${ex.source_line} (sha256 do arquivo ${ex.source_file_sha256})`, opId: ex.opId,
  record: { local_input: Number(ex.local_input), declared_input: Number(ex.declared_input), declared_output: Number(ex.declared_output), local_output: Number(ex.local_output), cache_read: Number(ex.declared_input_cache_read), reservedUsd_conservative: ex.reservedUsd_conservative, costUsd_ledger: ex.costUsd_ledger_record, costUsd_recomputed_frozen_table_NOT_INVOICE: ex.costUsd_recomputed_frozen_table_NOT_INVOICE, verdict: ex.conference_verdict, split: ex.split_norm, family: ex.family, sizeBucket: ex.sizeBucket },
  letter_expected: { local: 441, declared: 448, output: 24 },
  match: Number(ex.local_input) === 441 && Number(ex.declared_input) === 448 && Number(ex.declared_output) === 24 ? 'CONFERE (441 local, 448 declarado, 24 output)' : 'NAO CONFERE',
  cost_walkthrough: `448 input x 0.15 USD/MTok + 24 output x 0.60 USD/MTok = 0.0000672 + 0.0000144 = 0.0000816 USD (tabela congelada pilot-v3 c76a0fad...; ledger costUsd ${ex.costUsd_ledger_record}; reserva conservadora previa ${ex.reservedUsd_conservative} USD, liquidada em ${ex.costUsd_ledger_record}). Calculo, nao fatura.`,
  calibration_walkthrough: `RAW: local 441 vs declarado 448 -> erro -7 (|7| <= 16 do limiar heuristico v0: sem alerta). CALIBRADO: round_half_up(${exAdj.slope} x 441 + ${exAdj.intercept}) = ${exPred} vs 448 -> erro ${exPred - 448}; limiar congelado abs ${exAdj.thresholdAbs}, rel ${exAdj.thresholdRel}: ${alerts(exPred, 448, { abs: Number(exAdj.thresholdAbs), rel: Number(exAdj.thresholdRel) }) ? 'ALERTA' : 'sem alerta'}. Split ${ex.split_norm}: a linha entra na selecao do limiar (validacao), nao no holdout.`,
  envelope_note: 'A diferenca de 7 tokens (448 - 441) e observada; a composicao desses 7 tokens de envelope NAO foi isolada nesta evidencia e nao e explicada aqui.',
};
writeFileSync(join(OUT, 'example_cal-pt_prose-000-v0_openai.json'), JSON.stringify(example, null, 1) + '\n');

// ---------- tabelas: Markdown + LaTeX ----------
const f = (x, d = 3) => (x === null || x === undefined ? '--' : typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(d)) : String(x));
const pct = (x) => (x === null || x === undefined ? '--' : `${(x * 100).toFixed(1)}%`);
const md = []; const tex = [];
md.push('# R05 - Tabelas recomputadas (parametros e limiares congelados dos perfis H1)', '', 'Estimadores: **RAW** = contagem local crua com o limiar heuristico v0 (16 tokens, 10%); **CALIBRADO** = afim congelado do perfil com o limiar congelado do perfil. Alvo sempre = **DECLARADO** pelo provedor. RMSE e metrica nova (nao existe no original). Quantis de erro relativo: nearest-rank, `--` quando n < 1/(1-q).', '');
tex.push('% R05 - tabelas LaTeX (booktabs). Geradas por scripts/recompute.mjs; parametros/limiares congelados dos perfis H1 7606bc9b.', '% \\usepackage{booktabs}', '');
const T1 = long.filter((l) => l.family === 'all' && l.split !== 'all');
md.push('## Tabela 1 - Por modelo e split (todas as familias)', '', '| modelo | split | estimador | n | grupos | vies | MAE | RMSE (novo) | max | p50 rel | p90 rel | p95 rel | p99 rel | falso alerta | det +10% | det +25% | det +50 tok |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const l of T1) md.push(`| ${l.model} | ${l.split} | ${l.estimator.startsWith('RAW') ? 'RAW' : 'CALIBRADO'} | ${l.n} | ${l.groups} | ${f(l.bias)} | ${f(l.mae)} | ${f(l.rmse_NEW)} | ${f(l.maxAbs)} | ${f(l.p50)} | ${f(l.p90)} | ${f(l.p95)} | ${f(l.p99)} | ${pct(l.alertRate)} | ${pct(l.det_plus10pct)} | ${pct(l.det_plus25pct)} | ${pct(l.det_plus50tok)} |`);
tex.push('\\begin{table}[htbp]\\centering\\small', '\\caption{Erro do contador local por modelo e split: RAW (local cru, limiar heur\\\'istico v0) e CALIBRADO (afim e limiar congelados do perfil H1). Alvo: tokens de entrada declarados pelo provedor. RMSE \\\'e m\\\'etrica adicional desta recomputa\\c{c}\\~ao.}', '\\label{tab:r05-split}', '\\begin{tabular}{llrrrrrrrrrr}', '\\toprule', 'modelo & split & est. & $n$ & vi\\\'es & MAE & RMSE & m\\\'ax & p50 rel & p95 rel & falso alerta & det.\\ +25\\% \\\\', '\\midrule');
for (const l of T1) tex.push(`${l.model.replace(/_/g, '\\_')} & ${l.split} & ${l.estimator.startsWith('RAW') ? 'RAW' : 'CAL'} & ${l.n} & ${f(l.bias, 2)} & ${f(l.mae, 2)} & ${f(l.rmse_NEW, 2)} & ${f(l.maxAbs)} & ${f(l.p50)} & ${f(l.p95)} & ${pct(l.alertRate).replace('%', '\\%')} & ${pct(l.det_plus25pct).replace('%', '\\%')} \\\\`);
tex.push('\\bottomrule', '\\end{tabular}', '\\end{table}', '');
md.push('', '## Tabela 2 - Por modelo e familia (todos os pares; estimador CALIBRADO)', '', '| modelo | familia | n | vies | MAE | RMSE (novo) | max | p50 rel | p90 rel | falso alerta | det +25% |', '|---|---|---|---|---|---|---|---|---|---|---|');
const T2 = long.filter((l) => l.split === 'all' && l.family !== 'all' && l.estimator.startsWith('CAL'));
for (const l of T2) md.push(`| ${l.model} | ${l.family} | ${l.n} | ${f(l.bias)} | ${f(l.mae)} | ${f(l.rmse_NEW)} | ${f(l.maxAbs)} | ${f(l.p50)} | ${f(l.p90)} | ${pct(l.alertRate)} | ${pct(l.det_plus25pct)} |`);
tex.push('\\begin{table}[htbp]\\centering\\small', '\\caption{Erro do estimador calibrado por fam\\\'ilia de conte\\\'udo (todos os pares; par\\^ametros e limiares congelados).}', '\\label{tab:r05-family}', '\\begin{tabular}{llrrrrrrr}', '\\toprule', 'modelo & fam\\\'ilia & $n$ & vi\\\'es & MAE & RMSE & m\\\'ax & p50 rel & falso alerta \\\\', '\\midrule');
for (const l of T2) tex.push(`${l.model.replace(/_/g, '\\_')} & ${l.family.replace(/_/g, '\\_')} & ${l.n} & ${f(l.bias, 2)} & ${f(l.mae, 2)} & ${f(l.rmse_NEW, 2)} & ${f(l.maxAbs)} & ${f(l.p50)} & ${pct(l.alertRate).replace('%', '\\%')} \\\\`);
tex.push('\\bottomrule', '\\end{tabular}', '\\end{table}', '');
md.push('', '## Tabela 3 - Holdout por familia (estimador CALIBRADO; `markdown_table` nao tem pares no holdout)', '', '| modelo | familia | n | vies | MAE | max | falso alerta | det +25% |', '|---|---|---|---|---|---|---|---|');
for (const l of long.filter((l) => l.split === 'holdout' && l.family !== 'all' && l.estimator.startsWith('CAL'))) md.push(`| ${l.model} | ${l.family} | ${l.n} | ${f(l.bias)} | ${f(l.mae)} | ${f(l.maxAbs)} | ${pct(l.alertRate)} | ${pct(l.det_plus25pct)} |`);
md.push('', '## Tabela 4 - Comparacao com o original (perfis H1 e RESULTADOS_CALIBRACAO.md)', '', '| modelo | train | validation | holdout | falso alerta holdout | det +25% holdout | derivacao do limiar (validacao) | parametros (verif.) | limiar (verif.) | calibrated |', '|---|---|---|---|---|---|---|---|---|---|');
for (const [m, o] of Object.entries(comparison.overall)) md.push(`| ${m} | ${o.splits.train} | ${o.splits.validation} | ${o.splits.holdout} | ${o.acceptance_alert} | ${o.acceptance_det25} | ${o.derivation} | ${o.parameters} | ${o.threshold} | ${o.calibrated} |`);
for (const [m, c] of Object.entries(comparison.models)) { const d = SPLITS.flatMap((s) => c.splits[s].diffs.map((x) => `${s}: ${x}`)); if (d.length) md.push('', `Diferencas ${m}: ${d.join('; ')}`); }
md.push('', '## Tabela 5 - RESULTADOS_CALIBRACAO.md x recomputado', '', '| modelo | pares (md) | pares (rec.) | holdout vies; MAE; max (md) | (rec.) | falso alerta (md) | (rec.) | det +25% (md) | (rec.) | calibrated (md) | (rec.) |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const [m, c] of Object.entries(comparison.models)) md.push(`| ${m} | ${c.resultados_md.pairs} | ${c.resultados_md_check.pairs_recomputed} | ${c.resultados_md.holdout} | ${c.resultados_md_check.holdout_recomputed} | ${c.resultados_md.falseAlert} | ${c.resultados_md_check.falseAlert_recomputed} | ${c.resultados_md.det25} | ${c.resultados_md_check.det25_recomputed} | ${c.resultados_md.calibrated} | ${c.resultados_md_check.calibrated_recomputed} |`);
writeFileSync(join(OUT, 'tables', 'tables.md'), md.join('\n') + '\n');
writeFileSync(join(OUT, 'tables', 'tables.tex'), tex.join('\n') + '\n');
console.log(JSON.stringify(comparison.overall, null, 1));
console.log('exemplo:', example.match);
