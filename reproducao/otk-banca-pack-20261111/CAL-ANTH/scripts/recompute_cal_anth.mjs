// CAL_ANTH_VERIFY (C141, B06): recálculo INDEPENDENTE dos números da CAL-ANTH-01 (e contagens da CAL-ANTH-02) a partir
// dos arquivos brutos sanitizados, SEM usar analyze.ts/fitProfile.ts. Reimplementa as definições pré-registradas:
//   alerta: |Δ| > abs E (alvo = 0 OU |Δ|/alvo > rel)      (otk.conference.rule.v1)
//   predição: round(slope·local + intercept) em micro-inteiros (expectedTokens), nunca < 0
//   limiar: grade (60 pontos) sobre resíduos da validação; falso alerta ≤ 1%; maior poder médio (+10%, +25%, +50 tok);
//           desempate: maior abs, depois maior rel
//   bootstrap: 2000 reamostragens dos GRUPOS do holdout, mulberry32(20261014), quantis por ceil(q·n)-1
// Uso: node recompute_cal_anth.mjs --cal01=<raiz do git archive b55c342> --cal02=<raiz do git archive 4120a757> --out=<json>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const C1 = path.join(arg('cal01'), 'docs/_ops/experiments/OTK_CAL_ANTH_01');
const C2 = arg('cal02') ? path.join(arg('cal02'), 'docs/_ops/experiments/OTK_CAL_ANTH_02') : null;
const OUT = arg('out');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const L = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const quant = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return r6(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]); };
const mean = (xs) => (xs.length ? r6(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const MICRO = 1000000n;
const toMicro = (s) => { const neg = s.startsWith('-'); const [i, f = ''] = s.replace('-', '').split('.'); const v = BigInt(i) * MICRO + BigInt((f + '000000').slice(0, 6)); return neg ? -v : v; };
const predictAffine = (slope, intercept) => { const s = toMicro(String(slope)), c = toMicro(String(intercept)); return (p) => { const v = s * BigInt(typeof p === 'number' ? p : p.local) + c; return v <= 0n ? 0 : Number((v + MICRO / 2n) / MICRO); }; };
const alerts = (pred, target, t) => { const d = Math.abs(target - pred); if (d <= t.abs) return false; if (target === 0 || t.rel === null) return true; return d / target > t.rel; };
const ALTS = [['+10%', (y) => Math.round(y * 1.1)], ['+25%', (y) => Math.round(y * 1.25)], ['+50 tokens', (y) => y + 50]];
function metrics(points, predict, t) {
  const err = points.map((p) => predict(p) - p.target); const abs = err.map(Math.abs);
  const rel = points.filter((p) => p.target > 0).map((p) => Math.abs(predict(p) - p.target) / p.target);
  const fa = points.filter((p) => alerts(predict(p), p.target, t)).length;
  const det = Object.fromEntries(ALTS.map(([n, f]) => [n, points.length ? r6(points.filter((p) => alerts(predict(p), f(p.target), t)).length / points.length) : null]));
  return { n: points.length, groups: new Set(points.map((p) => p.group)).size, bias: mean(err), mae: mean(abs), medianAbs: quant(abs, 0.5), p95Abs: quant(abs, 0.95), maxAbs: abs.length ? Math.max(...abs) : null, relMedian: quant(rel, 0.5), relP95: quant(rel, 0.95), falseAlarms: fa, falseAlarmRate: points.length ? r6(fa / points.length) : null, detection: det };
}
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrap(points, predict, t, B = 2000, seed = 20261014) {
  const groups = [...new Set(points.map((p) => p.group))]; const by = new Map(groups.map((g) => [g, points.filter((p) => p.group === g)]));
  const r = mulberry32(seed); const st = { bias: [], mae: [], falseAlarmRate: [], detPlus25: [] };
  for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < groups.length; i++) s.push(...by.get(groups[Math.floor(r() * groups.length)])); const m = metrics(s, predict, t); st.bias.push(m.bias ?? 0); st.mae.push(m.mae ?? 0); st.falseAlarmRate.push(m.falseAlarmRate ?? 0); st.detPlus25.push(m.detection['+25%'] ?? 0); }
  return Object.fromEntries(Object.entries(st).map(([k, v]) => [k, [quant(v, 0.025), quant(v, 0.975)]]));
}
// OLS afim y = a + b x (equações normais)
function olsAffine(rows) { const n = rows.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const { x, y } of rows) { sx += x; sy += y; sxx += x * x; sxy += x * y; } const b = (n * sxy - sx * sy) / (n * sxx - sx * sx); const a = (sy - b * sx) / n; return { slope: b, intercept: a }; }
const gridOf = (values, points) => { const u = [...new Set(values)].sort((a, b) => a - b); if (u.length <= points) return u; return [...new Set(Array.from({ length: points }, (_, i) => u[Math.round((i * (u.length - 1)) / (points - 1))]))]; };
function selectThreshold(val) {
  const absC = gridOf([1, ...val.map((r) => Math.max(1, Math.ceil(Math.abs(r.target - r.pred))))], 60);
  const relC = gridOf([0, ...val.filter((r) => r.target > 0).map((r) => Math.ceil((Math.abs(r.target - r.pred) / r.target) * 1e6) / 1e6)], 60);
  let best = null;
  for (const A of absC) for (const R of relC) { const t = { abs: A, rel: R }; const fa = val.filter((r) => alerts(r.pred, r.target, t)).length / val.length; if (fa > 0.01) continue; const power = ALTS.reduce((s, [, f]) => s + val.filter((r) => alerts(r.pred, f(r.target), t)).length / val.length, 0) / ALTS.length; if (!best || power > best.power + 1e-12 || (Math.abs(power - best.power) <= 1e-12 && (A > best.abs || (A === best.abs && R > best.rel)))) best = { abs: A, rel: R, fa: r6(fa), power: r6(power) }; }
  return best;
}

const out = { schema: 'otk.cal_anth_verify.recompute.v1', generatedUtc: new Date().toISOString(), inputs: {}, cal01: {}, cal02: null };
const rec = (p) => { out.inputs[path.relative(arg('cal01'), p).replace(/\\/g, '/')] = sha256(fs.readFileSync(p)); };

// ------------------------------------------------------------------ CAL-ANTH-01
const rows = L(path.join(C1, 'CALL_RESULTS_SANITIZED.jsonl')); rec(path.join(C1, 'CALL_RESULTS_SANITIZED.jsonl'));
const ledger = L(path.join(C1, 'COST_LEDGER.jsonl')); rec(path.join(C1, 'COST_LEDGER.jsonl'));
const results = J(path.join(C1, 'RESULTS_PER_MODEL.json')); rec(path.join(C1, 'RESULTS_PER_MODEL.json'));
const prices = J(path.join(C1, 'MODEL_PRICE_SNAPSHOT.json')); rec(path.join(C1, 'MODEL_PRICE_SNAPSHOT.json'));
const e2e = L(path.join(C1, 'E2E_RESULTS.jsonl')); rec(path.join(C1, 'E2E_RESULTS.jsonl'));
const corpus = L(path.join(C1, 'corpus.jsonl')); rec(path.join(C1, 'corpus.jsonl'));

const models = ['claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'];
const c1 = out.cal01;
c1.rowsInFile = rows.length;
c1.perModel = {};
let totalCost = 0n, totalCalls = 0, totalValid = 0, totalRef = 0, total400 = 0, totalUnc = 0;
for (const m of models) {
  const mine = rows.filter((r) => r.modelRequested === m);
  const valid = mine.filter((r) => r.httpStatus === 200 && Number.isInteger(r.usage?.input_tokens));
  const ref = valid.filter((r) => r.stopReason === 'refusal' || r.logicalStatus === 'refusal');
  const h400 = mine.filter((r) => r.httpStatus === 400);
  const unc = mine.filter((r) => r.logicalStatus === 'uncertain');
  const cost = mine.reduce((s, r) => s + BigInt(r.costMicroUsd ?? '0'), 0n);
  // custo recalculado pela tabela congelada (micro-USD por MTok): tokens × preço / 1e6, arredondado para cima por chamada
  const pr = prices.models[m];
  const recalc = mine.reduce((s, r) => { const u = r.usage; if (!u) return s; const micro = (BigInt(u.input_tokens) * BigInt(pr.inputPerMTokMicroUsd) + BigInt(u.cache_creation_input_tokens ?? 0) * BigInt(pr.cacheWrite5mPerMTokMicroUsd) + BigInt(u.cache_read_input_tokens ?? 0) * BigInt(pr.cacheReadPerMTokMicroUsd) + BigInt(u.output_tokens) * BigInt(pr.outputPerMTokMicroUsd)); return s + (micro + 999999n) / 1000000n; }, 0n);
  const stages = {}; for (const r of mine) stages[r.stage] = (stages[r.stage] || 0) + 1;
  c1.perModel[m] = { calls: mine.length, stages, valid: valid.length, refusalsWithUsage: ref.length, http400NotBilled: h400.length, uncertain: unc.length, modelReturnedEqual: valid.filter((r) => r.modelReturned === m).length, inputTokens: valid.reduce((s, r) => s + r.usage.input_tokens, 0), outputTokens: valid.reduce((s, r) => s + r.usage.output_tokens, 0), costMicroUsdFromRows: cost.toString(), costMicroUsdRecalcCeilPerCall: recalc.toString(), reportedCostMicroUsd: results.models[m]?.operations?.costMicroUsd ?? null, refusalFamilies: Object.entries(ref.reduce((o, r) => { o[r.family] = (o[r.family] || 0) + 1; return o; }, {})) };
  totalCost += cost; totalCalls += mine.length; totalValid += valid.length; totalRef += ref.length; total400 += h400.length; totalUnc += unc.length;
}
const e2eCost = e2e.reduce((s, r) => s + Math.round(Number(r.pilotLedgerDelta.confirmedUsd) * 1e6), 0);
const e2eCalls = e2e.reduce((s, r) => s + r.executorSummary.calls, 0);
const settle = ledger.filter((l) => l.type === 'settle'); const settleSum = settle.reduce((s, l) => s + BigInt(l.actualMicro ?? '0'), 0n);
c1.totals = { callsInRows: totalCalls, e2eCalls, callsTotal: totalCalls + e2eCalls, valid: totalValid, e2eValid: e2e.reduce((s, r) => s + r.executorSummary.consistent, 0), refusalsWithUsage: totalRef, http400: total400, uncertain: totalUnc, costRowsMicroUsd: totalCost.toString(), e2eCostMicroUsd: e2eCost, costTotalUsd: ((Number(totalCost) + e2eCost) / 1e6).toFixed(6), ledgerSettleCount: settle.length, ledgerSettleSumMicroUsd: settleSum.toString(), ledgerReserveCount: ledger.filter((l) => l.type === 'reserve').length, ledgerOverruns: ledger.filter((l) => l.type === 'settle' && l.overrun === true).length, firstCallAt: rows.map((r) => r.at).sort()[0], lastCallAt: rows.map((r) => r.at).sort().at(-1), firstLedgerAt: ledger.map((l) => l.at).sort()[0], lastLedgerAt: ledger.map((l) => l.at).sort().at(-1) };

// pontos por modelo principal (regra do protocolo: ok/refusal com uso e localInput; 1 observação por docId)
const pointsOf = (m) => { const byDoc = new Map(); for (const r of rows) if (r.modelRequested === m && r.stage === 'core' && (r.logicalStatus === 'ok' || r.logicalStatus === 'refusal') && r.usage?.input_tokens != null && r.localInput != null) byDoc.set(r.docId, r); return [...byDoc.values()].map((r) => ({ id: r.docId, group: r.group, family: r.family, split: r.split, local: r.localInput, target: r.usage.input_tokens, ct: r.countTokensInput, refusal: r.logicalStatus === 'refusal' })); };
c1.primary = {};
for (const m of models.slice(0, 4)) {
  const pts = pointsOf(m); const sp = (s) => pts.filter((p) => p.split === s);
  const rep = results.models[m];
  // (1) ajuste afim independente só no treino
  const fit = olsAffine(sp('train').map((p) => ({ x: p.local, y: p.target })));
  const slope6 = r6(fit.slope), int6 = r6(fit.intercept);
  const pred = predictAffine(rep.parameters.slope, rep.parameters.intercept); // parâmetros congelados do relatório
  const predMine = predictAffine(slope6.toFixed(6), int6.toFixed(6));
  // (2) limiar independente na validação, com os parâmetros congelados
  const sel = selectThreshold(sp('validation').map((p) => ({ pred: pred(p), target: p.target })));
  const thr = { abs: rep.threshold.abs, rel: rep.threshold.rel };
  // (3) holdout uma vez, parâmetros e limiar congelados
  const hold = metrics(sp('holdout'), pred, thr);
  const fam = {}; for (const f of [...new Set(sp('holdout').map((p) => p.family))].sort()) fam[f] = metrics(sp('holdout').filter((p) => p.family === f), pred, thr);
  const boot = bootstrap(sp('holdout'), pred, thr);
  const policy = { train_n: sp('train').length >= 60, validation_n: sp('validation').length >= 30, holdout_n: sp('holdout').length >= 30, holdout_groups: new Set(sp('holdout').map((p) => p.group)).size >= 10, holdout_alert_rate: hold.falseAlarmRate <= 0.05, holdout_det25: hold.detection['+25%'] >= 0.5 };
  const ct = pts.filter((p) => p.ct != null).map((p) => ({ d: p.ct - p.target, refusal: p.refusal }));
  c1.primary[m] = { n: { train: sp('train').length, validation: sp('validation').length, holdout: sp('holdout').length, holdoutGroups: new Set(sp('holdout').map((p) => p.group)).size },
    fitIndependent: { slope: slope6, intercept: int6 }, reportedParams: rep.parameters, paramsMatch: slope6.toFixed(6) === rep.parameters.slope && Math.abs(int6 - Number(rep.parameters.intercept)) < 1e-6,
    thresholdIndependent: sel, reportedThreshold: rep.threshold, thresholdMatch: sel && sel.abs === rep.threshold.abs && Math.abs(sel.rel - rep.threshold.rel) < 1e-6,
    holdout: hold, reportedHoldout: rep.metrics.holdout, holdoutWithMyFit: metrics(sp('holdout'), predMine, thr),
    train: metrics(sp('train'), pred, thr), validation: metrics(sp('validation'), pred, thr),
    bootstrapCi95: boot, reportedBootstrap: rep.holdoutBootstrap?.ci95 ?? null,
    policyChecks: policy, calibratedIndependent: Object.values(policy).every(Boolean), reportedStatus: rep.status,
    holdoutByFamilyMae: Object.fromEntries(Object.entries(fam).map(([f, v]) => [f, { mae: v.mae, falseAlarms: v.falseAlarms, det25: v.detection['+25%'] }])), reportedByFamilyMae: Object.fromEntries(Object.entries(rep.holdoutByFamily ?? {}).map(([f, v]) => [f, v.mae])),
    countTokensVsFinal: { n: ct.length, equal: ct.filter((x) => x.d === 0).length, nonEqual: ct.filter((x) => x.d !== 0).length, nonEqualAllRefusals: ct.filter((x) => x.d !== 0).every((x) => x.refusal), nonEqualDiffs: [...new Set(ct.filter((x) => x.d !== 0).map((x) => x.d))] } };
}
// perfil histórico 07/10 (parâmetros publicados no relatório: 1.165964 / 4.10; limiar 6 / 0.142) no holdout novo do Haiku 4.5
{ const pts = pointsOf('claude-haiku-4-5-20251001').filter((p) => p.split === 'holdout'); const hp = results.models['claude-haiku-4-5-20251001'].historicalHaiku45; const par = hp?.parameters ?? { slope: '1.165964', intercept: '4.10' }; const ht = hp?.threshold ?? { abs: 6, rel: 0.142 }; c1.historicalHaiku45OnNewHoldout = { parametersUsed: par, thresholdUsed: ht, fromReport: !!hp, metrics: metrics(pts, predictAffine(par.slope, par.intercept), ht), reported: hp?.onNewHoldout ?? null }; }
// tokenizador compartilhado (descritivo)
{ const byDoc = (m) => new Map(pointsOf(m).filter((p) => !p.refusal).map((p) => [p.id, p.target])); const h = byDoc('claude-haiku-5-5'), s = byDoc('claude-sonnet-5-5'), o = byDoc('claude-opus-5-5'); let hs = 0, hsN = 0, ho = 0, hoN = 0; for (const [id, v] of h) { if (s.has(id)) { hsN++; if (s.get(id) === v) hs++; } if (o.has(id)) { hoN++; if (o.get(id) === v + 2) ho++; } } c1.sharedTokenizer = { haikuEqSonnet: `${hs}/${hsN}`, opusEqHaikuPlus2: `${ho}/${hoN}` }; }
// Fable exploratório
{ const pts = rows.filter((r) => r.modelRequested === 'claude-fable-5-1' && r.stage === 'exploratory' && r.usage?.input_tokens != null && r.localInput > 0); const ratio = pts.map((r) => r.usage.input_tokens / r.localInput); c1.fableExploratory = { n: pts.length, ratioMedian: quant(ratio, 0.5), p05: quant(ratio, 0.05), p95: quant(ratio, 0.95), refusals: pts.filter((r) => r.logicalStatus === 'refusal').length }; }
c1.corpus = { texts: corpus.length, splits: corpus.reduce((o, x) => { o[x.split] = (o[x.split] || 0) + 1; return o; }, {}), families: new Set(corpus.map((x) => x.family)).size, holdoutGroups: new Set(corpus.filter((x) => x.split === 'holdout').map((x) => x.group)).size };

// ------------------------------------------------------------------ CAL-ANTH-02 (contagens, custo, sobreposição de corpus)
if (C2) {
  const r2 = L(path.join(C2, 'CALL_RESULTS_SANITIZED.jsonl')); const res2 = J(path.join(C2, 'RESULTS_PER_MODEL.json')); const dev = L(path.join(C2, 'dev_corpus.jsonl')); const ho = L(path.join(C2, 'holdout_corpus.jsonl')); const dl = L(path.join(C2, 'DEV_LABELS.jsonl'));
  for (const f of ['CALL_RESULTS_SANITIZED.jsonl', 'RESULTS_PER_MODEL.json', 'dev_corpus.jsonl', 'holdout_corpus.jsonl', 'DEV_LABELS.jsonl', 'FROZEN_MODEL.json', 'HOLDOUT_EVALUATION_RECORD.json']) out.inputs['cal02/' + f] = sha256(fs.readFileSync(path.join(C2, f)));
  const per = {}; let cost2 = 0n; for (const r of r2) { const k = `${r.stage}|${r.modelRequested}`; per[k] = (per[k] || 0) + 1; cost2 += BigInt(r.costMicroUsd ?? '0'); }
  const h1 = new Map(corpus.map((x) => [sha256(x.text), x])); const hd = new Set(dev.map((x) => sha256(x.text)));
  const devHits = dev.filter((x) => h1.has(sha256(x.text))).map((x) => ({ dev: x.id, cal01: h1.get(sha256(x.text)).id, cal01Split: h1.get(sha256(x.text)).split }));
  const statusOf = (m) => { const x = res2.models?.[m] ?? res2[m]; return x ? { status: x.status ?? x.holdoutStatus, n: x.holdout?.n ?? x.n, mae: x.holdout?.mae ?? x.mae, falseAlarmRate: x.holdout?.falseAlarmRate ?? x.falseAlertRate, det25: x.holdout?.detection?.['+25%'] ?? x.detectionPlus25Simulated } : null; };
  out.cal02 = { rows: r2.length, perStageModel: per, refusals: r2.filter((r) => r.stopReason === 'refusal').length, modelReturnedDiff: r2.filter((r) => r.modelReturned !== r.modelRequested).length, costMicroUsd: cost2.toString(), firstCallAt: r2.map((r) => r.at).sort()[0], lastCallAt: r2.map((r) => r.at).sort().at(-1), countTokensEqualFinal: `${r2.filter((r) => r.countTokensInput === r.usage?.input_tokens).length}/${r2.length}`,
    devCorpus: { texts: dev.length, labels: dl.length, labelsPaid: dl.filter((x) => x.costMicroUsd && x.costMicroUsd !== '0').length, labelProvenance: [...new Set(dl.map((x) => x.labelProvenance))] },
    holdoutCorpus: { texts: ho.length, groups: new Set(ho.map((x) => x.group)).size, overlapWithCal01Texts: ho.filter((x) => h1.has(sha256(x.text))).length, overlapWithDevTexts: ho.filter((x) => hd.has(sha256(x.text))).length },
    devOverlapWithCal01: { count: devHits.length, byCal01Split: devHits.reduce((o, h) => { o[h.cal01Split] = (o[h.cal01Split] || 0) + 1; return o; }, {}), cal01HoldoutTextsPresentInDev: devHits.filter((h) => h.cal01Split === 'holdout') },
    statusPerModel: Object.fromEntries(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'].map((m) => [m, statusOf(m)])) };
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ written: OUT, cal01Total: c1.totals, haiku45: { params: c1.primary['claude-haiku-4-5-20251001'].paramsMatch, thr: c1.primary['claude-haiku-4-5-20251001'].thresholdMatch, holdout: c1.primary['claude-haiku-4-5-20251001'].holdout, boot: c1.primary['claude-haiku-4-5-20251001'].bootstrapCi95 } }, null, 1));
