#!/usr/bin/env node
// R02 - INVENTARIO 658/662 da campanha OVERNIGHT2_20261006 (baseline H1 7606bc9b).
// Le SOMENTE uma copia de leitura do baseline (git archive); nunca o repositorio H1.
// Uso: node build_inventory.mjs --h1 <copia_leitura_7606bc9b> --out <runs/R02>
// Nenhum valor e inventado: campo ausente = celula vazia + motivo em missing_fields.
// A coluna costUsd_recomputed_frozen_table_NOT_INVOICE e um CUSTO CALCULADO pela tabela congelada; NAO e fatura.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, basename } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const H1 = arg('h1'); const OUT = arg('out');
if (!H1 || !OUT) { console.error('uso: --h1 <copia_leitura> --out <dir>'); process.exit(2); }
const CAMP = join(H1, 'docs/_ops/OVERNIGHT2_20261006');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const rel = (p) => relative(H1, p).replace(/\\/g, '/');
const PROVIDER_OF_DIR = { openai: 'openai', anthropic: 'anthropic', gemini35: 'gemini' };

// ---------- tabelas de preco congeladas (micro-USD por MTok; custo exato em pico-USD) ----------
const tables = {};
for (const f of ['scripts/pilot/price_table_pilot_v3_20261003.json', 'scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json', 'scripts/pilot/price_table_pilot_v3_gemini35_20261004.json']) {
  const buf = readFileSync(join(H1, f)); const t = JSON.parse(buf.toString('utf8'));
  tables[t.version] = { file: f, sha256: sha(buf), entries: t.entries };
}
const priceOf = (ver, provider, modelFamily, category) => {
  const t = tables[ver]; if (!t) return null;
  const e = t.entries.find((x) => x.provider === provider && x.model === modelFamily && x.category === category);
  return e ? BigInt(e.pricePerMTokMicroUsd) : null;
};
const MODEL_FAMILY = { 'gpt-4o-mini-2024-07-18': 'gpt-4o-mini', 'claude-haiku-4-5-20251001': 'claude-haiku-4-5', 'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite' };
const picoToUsd = (p) => { const s = p.toString().padStart(13, '0'); const t = `${s.slice(0, -12)}.${s.slice(-12)}`; return t.replace(/0+$/, '').replace(/\.$/, '.0'); };

// ---------- descoberta dos arquivos vivos ----------
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (!n.startsWith('synthetic')) walk(p); } else if (n.endsWith('_calls.jsonl')) files.push(p); } };
walk(join(CAMP, 'campaign'));
files.sort();
const manifests = {}; // runId -> manifesto (priceTable, commit)
for (const f of files) { const m = f.replace(/_calls\.jsonl$/, '_manifest.json'); try { const o = JSON.parse(readFileSync(m, 'utf8')); manifests[o.runId ?? basename(m).replace(/_manifest\.json$/, '')] = { ...o, _file: rel(m) }; } catch { /* sem manifesto */ } }
// timestamps: evento conference_calibration_not_applied (um por op concluida) nos logs do entrypoint
const logTs = {}; // opId -> { tsUtc, file, line }
const logs = [];
const walkLogs = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (!n.startsWith('synthetic')) walkLogs(p); } else if (n.endsWith('_entrypoint.log.txt')) logs.push(p); } };
walkLogs(join(CAMP, 'campaign'));
for (const lf of logs) {
  const lines = readFileSync(lf, 'utf8').split(/\r?\n/);
  lines.forEach((l, i) => { if (!l.includes('"event":"conference_calibration_not_applied"')) return; try { const o = JSON.parse(l); const key = JSON.parse(o.key); const opId = key[1]; logTs[opId] = { tsUtc: new Date(o.ts).toISOString(), file: rel(lf), line: i + 1 }; } catch { /* linha nao-JSON */ } });
}

// ---------- uma linha por operacao ----------
const rows = []; const fileShas = {};
for (const f of files) {
  const buf = readFileSync(f); const fsha = sha(buf); fileShas[rel(f)] = fsha;
  const parts = rel(f).split("/"); const providerDir = parts[4]; const phaseDir = parts[5];
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    const c = JSON.parse(l);
    const provider = PROVIDER_OF_DIR[providerDir];
    const missing = []; const notes = [];
    const cats = Object.fromEntries((c.otkUsageCategories ?? []).map((x) => [x.name, x]));
    const cat = (n) => (cats[n] && cats[n].count !== null && cats[n].count !== undefined ? cats[n].count : '');
    const catSrc = (n) => (cats[n] ? cats[n].sourceField : '');
    const cmp = (name) => (c.conference?.comparisons ?? []).find((x) => x.category === name) ?? null;
    const ci = cmp('input'); const co = cmp('output');
    const refused = c.httpStatus !== 200;
    if (refused) missing.push(`clientUsage/otkUsageCategories/conference ausentes: recusa http ${c.httpStatus} antes do uso (${(c.error ?? '').slice(0, 80).replace(/\s+/g, ' ')})`);
    else if (!c.conference || c.conference.state === 'not_produced' || !(c.conference.comparisons ?? []).length) missing.push(`contagem local ausente: conference.state=${c.conference?.state ?? 'null'}, comparisons vazio (relatorio de conferencia nao capturado no registro)`);
    if (!refused && cats.input_cache_write && cats.input_cache_write.count === null) notes.push('input_cache_write=null no registro (campo nao devolvido pelo provedor)');
    if (!refused && cats.output_reasoning && cats.output_reasoning.count === null) notes.push('output_reasoning=null no registro (campo nao devolvido pelo provedor)');
    if (!refused && cats.input_cache_read && cats.input_cache_read.count === null) notes.push('input_cache_read=null no registro (campo nao devolvido pelo provedor)');
    const model = c.otkModelReturned ?? c.returnedModel ?? '';
    const modelReason = model ? 'otkModelReturned/returnedModel do registro' : `ausente: recusa http ${c.httpStatus} (analyzeCampaign rotula "refused_before_usage")`;
    const man = manifests[c.runId] ?? null;
    const ptVer = man?.priceTable?.version ?? c.checks?.price_table_frozen_in_operation?.observed ?? '';
    const pt = tables[ptVer] ?? null;
    // custo recalculado pela tabela congelada (pico-USD exato), categorias disjuntas:
    let costRe = ''; let costMatch = ''; let costNote = '';
    if (!refused && pt && model) {
      const fam = MODEL_FAMILY[model]; const toB = (v) => (v === '' ? 0n : BigInt(v));
      const input = toB(cat('input')); const cr = toB(cat('input_cache_read')); const cw = toB(cat('input_cache_write')); const out = toB(cat('output'));
      const pIn = priceOf(ptVer, provider, fam, 'input'); const pCr = priceOf(ptVer, provider, fam, 'input_cache_read'); const pCw = priceOf(ptVer, provider, fam, 'input_cache_write'); const pOut = priceOf(ptVer, provider, fam, 'output');
      if (pIn === null || pOut === null) { costNote = 'sem entrada na tabela congelada para o modelo'; }
      else {
        // openai e gemini: cache_read e SUBCONJUNTO de input (inclusion subset_of_input); anthropic: cache e ADDEND separado
        const subset = cats.input_cache_read?.inclusion === 'subset_of_input';
        const uncached = subset ? input - cr : input;
        let pico = uncached * pIn + out * pOut;
        if (cr > 0n) { if (pCr === null) costNote = 'cache_read>0 sem preco na tabela'; else pico += cr * pCr; }
        if (cw > 0n) { if (pCw === null) costNote = 'cache_write>0 sem preco na tabela'; else pico += cw * pCw; }
        costRe = picoToUsd(pico);
        const ledger = c.ledgerReservation?.costUsd; costMatch = ledger === undefined ? '' : (Math.abs(Number(costRe) - ledger) < 1e-12 ? 'IGUAL' : `DIFERE(ledger=${ledger})`);
        if (c.oracle?.costPico !== undefined && c.oracle.costPico !== null && BigInt(c.oracle.costPico) !== pico) costMatch += ` oracle.costPico=${c.oracle.costPico}!=${pico}`;
      }
    } else if (refused) costNote = 'sem custo: recusa (ledger costUsd=0, reserva liberada)';
    const splitRaw = c.meta?.split ?? '';
    const splitNorm = splitRaw === 'test' ? 'holdout' : splitRaw;
    const isCalibrationPair = !refused && c.attribution?.taskType === 'calibration-sample' && !!c.meta?.group && c.consistent === true && ci && ci.provider !== null && ci.local !== null;
    let excl = '';
    if (refused) excl = `RECUSA http ${c.httpStatus}: fora de 658 concluidas e fora da calibracao`;
    else if (c.attribution?.taskType === 'cache-probe') excl = 'cache-probe: coleta sim, calibracao nao (taskType != calibration-sample; repeticoes de cache excluidas pelo escopo do perfil)';
    else if (!c.attribution?.taskType) excl = 'besu (taskType=null, sem meta.group): coleta sim, calibracao nao';
    else if (!isCalibrationPair) excl = 'calibration-sample sem par: conferencia not_produced (sem contagem local no registro)';
    const ts = logTs[c.opId] ?? null;
    rows.push({
      opId: c.opId, label: c.label, runId: c.runId, provider, provider_dir: providerDir, phase_dir: phaseDir,
      model_returned: model, model_reason: modelReason,
      ts_log_utc: ts ? ts.tsUtc : '', ts_source: ts ? `evento conference_calibration_not_applied em ${ts.file}:${ts.line} (instante do registro no log, nao o da chamada ao provedor)` : (refused ? 'sem evento no log: recusa antes do uso; o registro _calls.jsonl nao tem timestamp por chamada' : 'sem evento no log'),
      httpStatus: c.httpStatus, execution_state: c.otk?.execution ?? (refused ? 'refused' : ''), settlement: c.ledgerReservation?.settlement ?? '', consistent: c.consistent,
      taskType: c.attribution?.taskType ?? '', docId: c.meta?.docId ?? '', family: c.meta?.family ?? '', group: c.meta?.group ?? '', split_raw: splitRaw, split_norm: splitNorm, sizeBucket: c.meta?.sizeBucket ?? '', cacheProbe: c.meta?.cacheProbe ?? '',
      local_input: ci?.local ?? '', local_output: co?.local ?? '',
      declared_input: cat('input'), declared_input_cache_read: cat('input_cache_read'), declared_input_cache_write: cat('input_cache_write'), declared_output: cat('output'), declared_output_reasoning: cat('output_reasoning'),
      declared_source_fields: [catSrc('input'), catSrc('input_cache_read'), catSrc('input_cache_write'), catSrc('output'), catSrc('output_reasoning')].join('|'),
      diff_input_declared_minus_local: ci && ci.local !== null && ci.provider !== null ? Number(ci.provider) - Number(ci.local) : '',
      diff_output_declared_minus_local: co && co.local !== null && co.provider !== null ? Number(co.provider) - Number(co.local) : '',
      conference_state: c.conference?.state ?? '', conference_verdict: c.conference?.verdict ?? '',
      reservedUsd_conservative: c.ledgerReservation?.reservedUsd ?? '', costUsd_ledger_record: c.ledgerReservation?.costUsd ?? '',
      costUsd_recomputed_frozen_table_NOT_INVOICE: costRe, cost_recompute_vs_ledger: costMatch, cost_note: costNote,
      price_table_version: ptVer, price_table_file: pt ? pt.file : '', price_table_sha256: pt ? pt.sha256 : '', manifest_file: man ? man._file : '', manifest_commit: man?.commit ?? man?.git?.commit ?? '',
      in_calibration_pairs: isCalibrationPair ? 'SIM' : 'NAO', excluded_reason: excl,
      source_file: rel(f), source_line: i + 1, source_file_sha256: fsha,
      missing_fields: missing.join('; '), notes: notes.join('; '),
    });
  });
}
const order = { openai: 0, anthropic: 1, gemini: 2 };
rows.sort((a, b) => order[a.provider] - order[b.provider] || a.source_file.localeCompare(b.source_file) || a.source_line - b.source_line);
rows.forEach((r, i) => { r.op_index = i + 1; });
const cols = ['op_index', ...Object.keys(rows[0]).filter((k) => k !== 'op_index')];
const csvEsc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'inventory_662.csv'), cols.join(',') + '\n' + rows.map((r) => cols.map((k) => csvEsc(r[k])).join(',')).join('\n') + '\n');
writeFileSync(join(OUT, 'inventory_662.jsonl'), rows.map((r) => JSON.stringify(Object.fromEntries(cols.map((k) => [k, r[k]])))).join('\n') + '\n');

// ---------- reconciliacao ----------
const by = (xs, f) => { const m = {}; for (const x of xs) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const opsBuf = readFileSync(join(CAMP, 'calibration/campaign_ops.jsonl')); const ops = opsBuf.toString('utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const opsById = Object.fromEntries(ops.map((o) => [o.opId, o]));
const summary = JSON.parse(readFileSync(join(CAMP, 'calibration/campaign_summary.json'), 'utf8'));
const R = { generatedBy: 'runs/R02/scripts/build_inventory.mjs', baselineCommit: '7606bc9be46bde8c1bc427c2eb4873bc1a474779', sourceFiles: fileShas, priceTables: Object.fromEntries(Object.entries(tables).map(([v, t]) => [v, { file: t.file, sha256: t.sha256 }])), campaign_ops_sha256: sha(opsBuf), providers: {} };
const expectedDocs = 216;
const allDocs = new Set(rows.filter((r) => r.taskType === 'calibration-sample' && r.docId).map((r) => r.docId));
for (const p of ['openai', 'anthropic', 'gemini']) {
  const rs = rows.filter((r) => r.provider === p);
  const ok = rs.filter((r) => r.httpStatus === 200); const ref = rs.filter((r) => r.httpStatus !== 200);
  const cal = ok.filter((r) => r.taskType === 'calibration-sample');
  const docs = new Set(cal.map((r) => r.docId));
  const labelCount = by(rs.filter((r) => r.taskType === 'calibration-sample'), (r) => r.label);
  const retried = Object.entries(labelCount).filter(([, n]) => n > 1).map(([l, n]) => ({ label: l, lines: n, outcomes: rs.filter((r) => r.label === l).map((r) => `${r.source_file}:${r.source_line} http ${r.httpStatus}`) }));
  const neverCompleted = [...allDocs].filter((d) => !docs.has(d)).sort().map((d) => { const att = rs.filter((r) => r.docId === d); return { docId: d, attempts: att.length, outcomes: att.map((r) => `${r.source_file}:${r.source_line} http ${r.httpStatus}`), reason: att.length ? 'recusa(s) sem repeticao bem-sucedida' : 'nunca enviado a este provedor (ausente de todos os _calls.jsonl)' }; });
  const pairs = cal.filter((r) => r.in_calibration_pairs === 'SIM');
  const notProduced = cal.filter((r) => r.in_calibration_pairs === 'NAO').map((r) => ({ label: r.label, docId: r.docId, split_norm: r.split_norm, family: r.family, conference_state: r.conference_state, src: `${r.source_file}:${r.source_line}` }));
  const costSum = ok.reduce((s, r) => s + Number(r.costUsd_ledger_record || 0), 0);
  const costReSum = ok.reduce((s, r) => s + Number(r.costUsd_recomputed_frozen_table_NOT_INVOICE || 0), 0);
  const sumKey = Object.keys(summary.summary).find((k) => k.startsWith(p + '/') && !k.endsWith('refused_before_usage'));
  R.providers[p] = {
    lines_in_calls_jsonl: rs.length, completed_http200: ok.length, refused: ref.map((r) => ({ label: r.label, httpStatus: r.httpStatus, docId: r.docId, split_norm: r.split_norm, src: `${r.source_file}:${r.source_line}` })),
    consistent_true: ok.filter((r) => r.consistent === true).length,
    byTaskType_completed: by(ok, (r) => r.taskType || 'null(besu)'),
    expected_per_letter: { texts: expectedDocs, cache: 3, besu: 1 },
    observed: { unique_texts_completed: docs.size, calibration_sample_lines_completed: cal.length, cache: ok.filter((r) => r.taskType === 'cache-probe').length, besu: ok.filter((r) => !r.taskType).length },
    texts_missing_vs_216: neverCompleted, labels_with_more_than_one_line: retried,
    docs_completed_by_family: by(cal, (r) => r.family), docs_completed_by_split_norm: by(cal, (r) => r.split_norm),
    calibration_pairs: { n: pairs.length, bySplit: by(pairs, (r) => r.split_norm), byFamily: by(pairs, (r) => r.family) },
    calibration_sample_without_pair_not_produced: notProduced,
    conference_states_completed: by(ok, (r) => r.conference_state), conference_verdicts_completed: by(ok, (r) => r.conference_verdict),
    cost_usd: { sum_ledger_record: Number(costSum.toFixed(10)), sum_recomputed_frozen_table_NOT_INVOICE: Number(costReSum.toFixed(10)), campaign_summary_costUsdComputedFromLedger: sumKey ? summary.summary[sumKey].costUsdComputedFromLedger : null, rows_recompute_differs: ok.filter((r) => r.cost_recompute_vs_ledger && !r.cost_recompute_vs_ledger.startsWith('IGUAL')).length, rows_recompute_differs_list: ok.filter((r) => r.cost_recompute_vs_ledger && !r.cost_recompute_vs_ledger.startsWith('IGUAL')).map((r) => `${r.label}: ${r.cost_recompute_vs_ledger}`) },
    declared_token_sums_completed: { input: ok.reduce((s, r) => s + Number(r.declared_input || 0), 0), input_cache_read: ok.reduce((s, r) => s + Number(r.declared_input_cache_read || 0), 0), output: ok.reduce((s, r) => s + Number(r.declared_output || 0), 0) },
    campaign_summary_quantities: sumKey ? summary.summary[sumKey].quantities : null,
    campaign_summary_calibration: summary.calibration[sumKey] ?? null,
    ts_log_coverage: { completed_with_ts: ok.filter((r) => r.ts_log_utc).length, refused_with_ts: ref.filter((r) => r.ts_log_utc).length },
  };
}
R.totals = { lines: rows.length, completed: rows.filter((r) => r.httpStatus === 200).length, refused: rows.filter((r) => r.httpStatus !== 200).length, calibration_pairs: rows.filter((r) => r.in_calibration_pairs === 'SIM').length, cost_usd_sum_ledger: Number(rows.reduce((s, r) => s + Number(r.costUsd_ledger_record || 0), 0).toFixed(10)), cost_usd_sum_recomputed_NOT_INVOICE: Number(rows.reduce((s, r) => s + Number(r.costUsd_recomputed_frozen_table_NOT_INVOICE || 0), 0).toFixed(10)) };
// cruzamento 1:1 com calibration/campaign_ops.jsonl (derivado pelo analyzeCampaign.ts do H1)
const cross = { campaign_ops_lines: ops.length, inventory_opIds_not_in_ops: rows.filter((r) => !opsById[r.opId]).map((r) => r.opId), ops_opIds_not_in_inventory: ops.filter((o) => !rows.find((r) => r.opId === o.opId)).map((o) => o.opId), cost_mismatch: [], local_mismatch: [], split_mismatch: [] };
for (const r of rows) {
  const o = opsById[r.opId]; if (!o) continue;
  const oc = o.costUsdComputed ?? null; const rc = r.costUsd_ledger_record === '' ? null : r.costUsd_ledger_record;
  if (oc !== rc) cross.cost_mismatch.push(r.opId);
  const ol = o.conference?.input?.local ?? ''; if (String(ol) !== String(r.local_input)) cross.local_mismatch.push(r.opId);
  if ((o.meta?.split ?? '') !== r.split_raw) cross.split_mismatch.push(r.opId);
}
R.cross_check_campaign_ops = cross;
writeFileSync(join(OUT, 'reconciliation.json'), JSON.stringify(R, null, 1) + '\n');

// ---------- ausentes EXPLICITOS (CSV) ----------
const miss = [];
for (const p of ['openai', 'anthropic', 'gemini']) { const P = R.providers[p]; for (const m of P.texts_missing_vs_216) miss.push({ provider: p, kind: 'texto_nao_concluido', item: m.docId, detail: `${m.reason}; tentativas=${m.attempts}: ${m.outcomes.join(' ; ')}` }); for (const r of P.refused) miss.push({ provider: p, kind: 'recusa', item: r.label, detail: `http ${r.httpStatus} (${r.src})` }); for (const n of P.calibration_sample_without_pair_not_produced) miss.push({ provider: p, kind: 'sem_contagem_local', item: n.label, detail: `conference.state=${n.conference_state}; split=${n.split_norm}; family=${n.family} (${n.src})` }); }
for (const r of rows.filter((r) => !r.ts_log_utc)) miss.push({ provider: r.provider, kind: 'sem_timestamp', item: r.label, detail: r.ts_source });
writeFileSync(join(OUT, 'missing_explicit.csv'), 'provider,kind,item,detail\n' + miss.map((m) => [m.provider, m.kind, m.item, m.detail].map(csvEsc).join(',')).join('\n') + '\n');

// ---------- markdown ----------
const md = [];
md.push('# R02 - Reconciliacao do inventario (662 linhas / 658 concluidas / 4 recusas)', '', 'Fonte: baseline H1 `7606bc9b` (copia de leitura via `git archive`), `docs/_ops/OVERNIGHT2_20261006/campaign/**/_calls.jsonl` (dirs `synthetic*` excluidos). Gerado por `scripts/build_inventory.mjs`. **Custo recalculado = calculo pela tabela congelada; NAO e fatura.**', '');
md.push('| provedor | linhas | concluidas (http 200) | recusas | consistent=true | textos unicos concluidos (esperado 216) | cache | besu | pares de calibracao | train/val/holdout |', '|---|---|---|---|---|---|---|---|---|---|');
for (const p of ['openai', 'anthropic', 'gemini']) { const P = R.providers[p]; md.push(`| ${p} | ${P.lines_in_calls_jsonl} | ${P.completed_http200} | ${P.refused.length} | ${P.consistent_true} | ${P.observed.unique_texts_completed} | ${P.observed.cache} | ${P.observed.besu} | ${P.calibration_pairs.n} | ${P.calibration_pairs.bySplit.train ?? 0}/${P.calibration_pairs.bySplit.validation ?? 0}/${P.calibration_pairs.bySplit.holdout ?? 0} |`); }
md.push(`| **total** | ${R.totals.lines} | ${R.totals.completed} | ${R.totals.refused} | | | | | ${R.totals.calibration_pairs} | |`, '');
md.push('## Recusas (4) - fora das 658', '', '| provedor | label | http | split | fonte |', '|---|---|---|---|---|');
for (const p of ['openai', 'anthropic', 'gemini']) for (const r of R.providers[p].refused) md.push(`| ${p} | ${r.label} | ${r.httpStatus} | ${r.split_norm} | ${r.src} |`);
md.push('', '## Textos ausentes por provedor (EXPLICITO)', '');
for (const p of ['openai', 'anthropic', 'gemini']) { const P = R.providers[p]; md.push(`- **${p}**: ${P.texts_missing_vs_216.length === 0 ? 'nenhum (216/216)' : P.texts_missing_vs_216.map((m) => `\`${m.docId}\` (${m.reason}; tentativas: ${m.outcomes.join('; ') || 'nenhuma'})`).join('; ')}`); }
md.push('', '## Labels com mais de uma linha (repeticao apos recusa)', '');
for (const p of ['openai', 'anthropic', 'gemini']) for (const t of R.providers[p].labels_with_more_than_one_line) md.push(`- ${p} \`${t.label}\`: ${t.outcomes.join(' ; ')}`);
md.push('', '## Concluidas sem contagem local (conference not_produced) - coleta sim, calibracao nao', '');
for (const p of ['openai', 'anthropic', 'gemini']) for (const n of R.providers[p].calibration_sample_without_pair_not_produced) md.push(`- ${p} \`${n.label}\` split=${n.split_norm} family=${n.family} (${n.src})`);
md.push('', '## Custo (USD) - calculado, NAO fatura', '', '| provedor | soma ledger (registros) | soma recalculada (tabela congelada) | campaign_summary.json | linhas com diferenca |', '|---|---|---|---|---|');
for (const p of ['openai', 'anthropic', 'gemini']) { const c = R.providers[p].cost_usd; md.push(`| ${p} | ${c.sum_ledger_record} | ${c.sum_recomputed_frozen_table_NOT_INVOICE} | ${c.campaign_summary_costUsdComputedFromLedger} | ${c.rows_recompute_differs} |`); }
md.push(`| **total** | ${R.totals.cost_usd_sum_ledger} | ${R.totals.cost_usd_sum_recomputed_NOT_INVOICE} | | |`, '');
md.push('## Tokens declarados (somas das concluidas) x campaign_summary.json', '', '| provedor | input declarado (inclui cache lido quando subset) | cache lido | output | summary input_uncached | summary cache_read | summary output_visible |', '|---|---|---|---|---|---|---|');
for (const p of ['openai', 'anthropic', 'gemini']) { const P = R.providers[p]; const q = P.campaign_summary_quantities ?? {}; md.push(`| ${p} | ${P.declared_token_sums_completed.input} | ${P.declared_token_sums_completed.input_cache_read} | ${P.declared_token_sums_completed.output} | ${q.input_uncached} | ${q.input_cache_read} | ${q.output_visible} |`); }
md.push('', '## Cruzamento 1:1 com calibration/campaign_ops.jsonl', '', `- linhas em campaign_ops.jsonl: ${cross.campaign_ops_lines}; opIds do inventario ausentes la: ${cross.inventory_opIds_not_in_ops.length}; opIds de la ausentes no inventario: ${cross.ops_opIds_not_in_inventory.length}`, `- custo divergente: ${cross.cost_mismatch.length}; contagem local divergente: ${cross.local_mismatch.length}; split divergente: ${cross.split_mismatch.length}`, '');
md.push('## Timestamps', '', '- O registro `_calls.jsonl` NAO tem timestamp por chamada. A coluna `ts_log_utc` vem do evento `conference_calibration_not_applied` do log do entrypoint (um por op concluida; e o instante do registro no log, nao o da chamada ao provedor). Recusas: sem evento, celula vazia.', '');
writeFileSync(join(OUT, 'reconciliation.md'), md.join('\n') + '\n');
console.log(JSON.stringify({ rows: rows.length, totals: R.totals, cross }, null, 1));
