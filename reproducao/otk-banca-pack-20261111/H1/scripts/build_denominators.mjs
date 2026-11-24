#!/usr/bin/env node
// R04 - DENOMINADORES: explica, com as proprias linhas, 219 -> 215 -> 211 (OpenAI) e equivalentes
// (Anthropic 219 -> 214 -> 210 = 119/54/37; Gemini 220 -> 216 -> 212 = 121/54/37).
// Entrada: o inventario do R02 (uma linha por operacao, derivado dos _calls.jsonl do H1 7606bc9b).
// Uso: node build_denominators.mjs --inventory ../R02/inventory_662.jsonl --out <runs/R04>
// Cada operacao sai em EXATAMENTE um passo (particao): nao ha dupla contagem.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const INV = arg('inventory'); const OUT = arg('out');
if (!INV || !OUT) { console.error('uso: --inventory <inventory_662.jsonl> --out <dir>'); process.exit(2); }
const invBuf = readFileSync(INV); const rows = invBuf.toString('utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const invSha = createHash('sha256').update(invBuf).digest('hex');
const by = (xs, f) => { const m = {}; for (const x of xs) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const PROVIDERS = ['openai', 'anthropic', 'gemini'];
const FAMILIES = ['pt_prose', 'en_prose', 'code_ts', 'json', 'markdown_table', 'mixed_unicode', 'numeric', 'tiny'];

// classificacao: cada linha recebe UM passo de saida (ou 'par')
function stepOf(r) {
  if (r.httpStatus !== 200) return { step: 'S1_recusa', why: `http ${r.httpStatus}: recusado antes do uso (sem usage, sem conferencia); ledger refused` };
  if (!(r.local_input !== '' && r.declared_input !== '')) return { step: 'S2_sem_conferencia', why: `conference.state=${r.conference_state}: comparacao de input nao capturada no registro (sem contagem local)` };
  if (r.taskType === 'cache-probe') return { step: 'S3_cache', why: 'cache-probe (taskType != calibration-sample; repeticao do mesmo prompt para medir cache; fora do escopo do perfil)' };
  if (!r.taskType) return { step: 'S3_besu', why: 'besu (taskType=null, sem meta.group/docId; chamada minima de infraestrutura)' };
  if (r.taskType === 'calibration-sample' && r.group && r.consistent === true) return { step: 'PAR', why: 'par de calibracao (regra analyzeCampaign.ts: calibration-sample + meta.group + consistent + input provedor/local presentes)' };
  return { step: 'S9_outro', why: 'nao classificado (nao esperado)' };
}
const D = { generatedBy: 'runs/R04/scripts/build_denominators.mjs', inventory: { path: INV.replace(/\\/g, '/'), sha256: invSha, lines: rows.length }, providers: {} };
const excluded = [];
for (const p of PROVIDERS) {
  const rs = rows.filter((r) => r.provider === p).map((r) => ({ ...r, ...stepOf(r) }));
  const n0 = rs.length;
  const s1 = rs.filter((r) => r.step === 'S1_recusa'); const after1 = rs.filter((r) => r.step !== 'S1_recusa');
  const s2 = after1.filter((r) => r.step === 'S2_sem_conferencia'); const after2 = after1.filter((r) => r.step !== 'S2_sem_conferencia');
  const s3c = after2.filter((r) => r.step === 'S3_cache'); const s3b = after2.filter((r) => r.step === 'S3_besu'); const pairs = after2.filter((r) => r.step === 'PAR'); const other = after2.filter((r) => r.step === 'S9_outro');
  for (const r of rs.filter((x) => x.step !== 'PAR')) excluded.push({ provider: p, step: r.step, label: r.label, docId: r.docId, split: r.split_norm, family: r.family, httpStatus: r.httpStatus, conference_state: r.conference_state, why: r.why, source: `${r.source_file}:${r.source_line}` });
  // corpus: 216 textos esperados = 8 familias x 9 grupos x 3 variantes; quais docIds nunca chegaram a este provedor
  const allDocs = new Set(rows.filter((r) => r.taskType === 'calibration-sample' && r.docId).map((r) => r.docId));
  const sentDocs = new Set(rs.filter((r) => r.taskType === 'calibration-sample').map((r) => r.docId));
  const neverSent = [...allDocs].filter((d) => !sentDocs.has(d)).sort();
  const completedDocs = new Set(rs.filter((r) => r.taskType === 'calibration-sample' && r.httpStatus === 200).map((r) => r.docId));
  D.providers[p] = {
    S0_linhas_calls_jsonl: n0,
    S0_composicao: { calibration_sample_lines: rs.filter((r) => r.taskType === 'calibration-sample').length, docIds_unicos_enviados: sentDocs.size, docIds_do_corpus_nunca_enviados: neverSent, cache_probe: rs.filter((r) => r.taskType === 'cache-probe').length, besu: rs.filter((r) => !r.taskType).length },
    S1_realizadas_http200: after1.length, S1_saem_recusas: s1.map((r) => ({ label: r.label, httpStatus: r.httpStatus, split: r.split_norm, family: r.family, repetida_depois: rs.some((x) => x.label === r.label && x.httpStatus === 200) ? 'SIM (repeticao concluida)' : 'NAO (texto perdido para este provedor)', source: `${r.source_file}:${r.source_line}` })),
    S1_coleta_denominador: { concluidas: after1.length, textos_unicos_concluidos: completedDocs.size, cache: s3c.length + after1.filter((r) => r.taskType === 'cache-probe' && r.step === 'S2_sem_conferencia').length, besu: s3b.length + after1.filter((r) => !r.taskType && r.step === 'S2_sem_conferencia').length, nota: 'denominador da COLETA (custo, tokens declarados, campaign_summary.json): todas as concluidas, inclusive cache e besu e as sem conferencia' },
    S2_com_conferencia_capturada: after2.length, S2_estado_conferencia_das_realizadas: by(after1, (r) => `${r.conference_state}/${r.conference_verdict}`),
    S2_saem_sem_conferencia: s2.map((r) => ({ label: r.label, split: r.split_norm, family: r.family, conference_state: r.conference_state, source: `${r.source_file}:${r.source_line}` })),
    S3_pares_calibracao: pairs.length, S3_saem_cache: s3c.map((r) => `${r.label} (cacheProbe=${r.cacheProbe}, declared_input=${r.declared_input}, cache_read=${r.declared_input_cache_read})`), S3_saem_besu: s3b.map((r) => `${r.label} (declared_input=${r.declared_input}, local=${r.local_input})`), S3_nao_classificados: other.map((r) => r.label),
    S4_splits: by(pairs, (r) => r.split_norm), S4_split_x_familia: Object.fromEntries(['train', 'validation', 'holdout'].map((s) => [s, Object.fromEntries(FAMILIES.map((f) => [f, pairs.filter((r) => r.split_norm === s && r.family === f).length]))])),
    S4_grupos_holdout: new Set(pairs.filter((r) => r.split_norm === 'holdout').map((r) => r.group)).size,
    S4_familias: by(pairs, (r) => r.family),
    particao_ok: s1.length + s2.length + s3c.length + s3b.length + pairs.length + other.length === n0,
    cadeia: `${n0} linhas -> ${after1.length} realizadas (-${s1.length} recusas) -> ${after2.length} com conferencia capturada (-${s2.length} not_produced) -> ${pairs.length} pares (-${s3c.length} cache, -${s3b.length} besu) = ${['train', 'validation', 'holdout'].map((s) => pairs.filter((r) => r.split_norm === s).length).join('/')}`,
  };
}
D.totais = { linhas: rows.length, realizadas: rows.filter((r) => r.httpStatus === 200).length, pares: rows.filter((r) => stepOf(r).step === 'PAR').length, excluidas_nominais: excluded.length };
D.mixed_unicode_000_v1 = { openai: 'enviado, recusado http 400 invalid_json (S1), nunca repetido: texto ausente para a OpenAI', anthropic: 'NUNCA enviado (ausente de todos os _calls.jsonl da Anthropic): a exclusao pre-declarada foi aplicada antes do envio (F-OVN2-08, RESULTADOS_CALIBRACAO.md); por isso a Anthropic tem 220 linhas e nao 221', gemini: 'enviado e concluido (http 200): entra na coleta e nos pares da Gemini' };
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'denominators.json'), JSON.stringify(D, null, 1) + '\n');
const csvEsc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ecols = ['provider', 'step', 'label', 'docId', 'split', 'family', 'httpStatus', 'conference_state', 'why', 'source'];
writeFileSync(join(OUT, 'excluded_nominal.csv'), ecols.join(',') + '\n' + excluded.map((e) => ecols.map((k) => csvEsc(e[k])).join(',')).join('\n') + '\n');

const md = [];
md.push('# R04 - Denominadores da campanha H1: de 219 realizadas a 211 pares (OpenAI) e equivalentes', '', `Entrada: \`runs/R02/inventory_662.jsonl\` (sha256 ${invSha}), derivado dos \`_calls.jsonl\` do baseline H1 \`7606bc9b\`. Cada operacao sai em **exatamente um** passo (particao verificada por provedor). Gerado por \`scripts/build_denominators.mjs\`.`, '');
md.push('## Cadeia por provedor', '', '| provedor | S0 linhas | S1 realizadas (http 200) | saem em S1 (recusas) | S2 com conferencia capturada | saem em S2 (not_produced) | S3 pares de calibracao | saem em S3 (cache + besu) | train / validation / holdout | grupos no holdout |', '|---|---|---|---|---|---|---|---|---|---|');
for (const p of PROVIDERS) { const P = D.providers[p]; md.push(`| ${p} | ${P.S0_linhas_calls_jsonl} | ${P.S1_realizadas_http200} | ${P.S1_saem_recusas.length} | ${P.S2_com_conferencia_capturada} | ${P.S2_saem_sem_conferencia.length} | ${P.S3_pares_calibracao} | ${P.S3_saem_cache.length} + ${P.S3_saem_besu.length} | ${P.S4_splits.train ?? 0} / ${P.S4_splits.validation ?? 0} / ${P.S4_splits.holdout ?? 0} | ${P.S4_grupos_holdout} |`); }
md.push('', '## Dois denominadores distintos (sem dupla contagem)', '', '- **COLETA** (custo calculado, tokens declarados, `campaign_summary.json`): todas as **realizadas** (S1): 219 openai + 219 anthropic + 220 gemini = **658**. Inclui cache-probe, besu e as concluidas sem conferencia.', '- **CALIBRACAO** (perfis, metricas, RESULTADOS_CALIBRACAO.md): so os **pares** (S3): 211 + 210 + 212 = **633**. Exclui, nesta ordem, recusas (S1), concluidas sem comparacao de input capturada (S2), cache-probe e besu (S3).', '- Uma operacao conta em um unico passo; as 4 recusas nao estao em nenhum dos dois denominadores (nem custo nem calibracao: ledger `refused`, costUsd 0).', '');
for (const p of PROVIDERS) {
  const P = D.providers[p];
  md.push(`## ${p}: ${P.cadeia}`, '');
  md.push(`- **S0 -> S1** (saem ${P.S1_saem_recusas.length}): ${P.S1_saem_recusas.map((r) => `\`${r.label}\` http ${r.httpStatus} (${r.split}, ${r.family}; ${r.repetida_depois}) [${r.source}]`).join('; ') || 'nenhuma'}.`);
  md.push(`- **S1 -> S2** (saem ${P.S2_saem_sem_conferencia.length}; estado da conferencia nas realizadas: ${Object.entries(P.S2_estado_conferencia_das_realizadas).map(([k, v]) => `${k}=${v}`).join(', ')}): ${P.S2_saem_sem_conferencia.map((r) => `\`${r.label}\` (${r.split}, ${r.family}; conference.state=${r.conference_state}) [${r.source}]`).join('; ')}. Nestas o registro tem usage declarado mas \`conference.comparisons\` vazio: sem contagem local, nao ha par. O motivo tecnico da nao-producao nao consta dos registros nem dos logs exportados.`);
  md.push(`- **S2 -> S3** (saem ${P.S3_saem_cache.length + P.S3_saem_besu.length}): cache-probe ${P.S3_saem_cache.map((x) => `\`${x}\``).join(', ')}; besu ${P.S3_saem_besu.map((x) => `\`${x}\``).join(', ')}. Tem contagem local e declarada (estao na coleta), mas nao sao amostras do corpus (sem \`meta.group\`/taskType calibration-sample): o escopo do perfil exclui "cache-probe repeats".`);
  md.push(`- **S3 -> splits**: ${['train', 'validation', 'holdout'].map((s) => `${s}=${P.S4_splits[s] ?? 0}`).join(', ')} (regra sha256(\`otk.calibration_corpus.synthetic.v1:<grupo>\`) mod 100: <60 train, <80 validation, senao holdout; \`meta.split=test\` e o holdout). Por familia: ${FAMILIES.map((f) => `${f}=${P.S4_familias[f] ?? 0}`).join(', ')}.`);
  if (P.S0_composicao.docIds_do_corpus_nunca_enviados.length) md.push(`- **Antes de S0**: textos do corpus nunca enviados a este provedor: ${P.S0_composicao.docIds_do_corpus_nunca_enviados.map((d) => `\`${d}\``).join(', ')} (por isso S0 = ${P.S0_linhas_calls_jsonl}).`);
  md.push('');
}
md.push('## Split x familia (pares)', '');
for (const p of PROVIDERS) { const P = D.providers[p]; md.push(`### ${p}`, '', `| split | ${FAMILIES.join(' | ')} | total |`, `|---|${FAMILIES.map(() => '---').join('|')}|---|`); for (const s of ['train', 'validation', 'holdout']) { const row = FAMILIES.map((f) => P.S4_split_x_familia[s][f]); md.push(`| ${s} | ${row.join(' | ')} | ${row.reduce((a, b) => a + b, 0)} |`); } md.push(''); }
md.push('## mixed_unicode-000-v1 (exclusao pre-declarada)', '', ...Object.entries(D.mixed_unicode_000_v1).map(([p, t]) => `- **${p}**: ${t}`), '');
md.push('## Verificacao', '', `- particao por provedor: ${PROVIDERS.map((p) => `${p}=${D.providers[p].particao_ok}`).join(', ')}; total de linhas ${D.totais.linhas}, realizadas ${D.totais.realizadas}, pares ${D.totais.pares}, excluidas nominais ${D.totais.excluidas_nominais} (${D.totais.linhas - D.totais.pares} esperadas).`, '- lista nominal completa das excluidas, com passo e motivo: `excluded_nominal.csv`.', '');
writeFileSync(join(OUT, 'denominators.md'), md.join('\n') + '\n');
console.log(JSON.stringify({ totais: D.totais, cadeias: Object.fromEntries(PROVIDERS.map((p) => [p, D.providers[p].cadeia])), particao: PROVIDERS.map((p) => D.providers[p].particao_ok) }, null, 1));
