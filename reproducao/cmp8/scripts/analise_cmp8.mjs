// analise_cmp8.mjs (CMP8_PREP, C160): tabela ampliada (8 modelos) dos tokens de entrada declarados por tipo de texto, com a MESMA estatística da tabela
// de 23/11 (tabela_dif_provedores.cjs): mediana por família e mediana da razão texto a texto contra o gpt-4o-mini; exclusões do PROTOCOLO_CMP8 §5.
// Lê só os TENTATIVAS_CMP8.jsonl dos 3 batchDirs (e, como referência, o h1_chamadas.csv de 7/10). Nenhuma rede.
// Uso: node analise_cmp8.mjs <raizBatch> <h1_chamadas.csv> <saidaDir> [--rotulo ENSAIO|REAL]
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const [RAIZ, CSV, OUT] = process.argv.slice(2); const ROT = process.argv.includes('--rotulo') ? process.argv[process.argv.indexOf('--rotulo') + 1] : 'REAL';
// V1_3: --dir-google <dir> (o Google da V1_3 vem de outro batchDir); --nota-extra "<texto>" acrescentado à nota
const optA = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const DIRS = { openai: path.join(RAIZ, 'openai'), anthropic: path.join(RAIZ, 'anthropic'), google: optA('--dir-google') ?? path.join(RAIZ, 'google') };
// V1_3 (X1 resultado R3): entrada declarada pelo PROTOCOLO §3, do uso BRUTO do provedor (não do U do executor); a do arquivo fica para conferência
const doBruto = (p, b) => { if (!b) return null; const n = (k) => (Number.isSafeInteger(b[k]) && b[k] >= 0 ? b[k] : null);
  if (p === 'openai') return n('prompt_tokens'); if (p === 'google') return n('promptTokenCount');
  const a = n('input_tokens'); if (a === null) return null; const cr = n('cache_read_input_tokens'), cw = n('cache_creation_input_tokens');
  if (('cache_read_input_tokens' in b && cr === null) || ('cache_creation_input_tokens' in b && cw === null)) return null; return a + (cr ?? 0) + (cw ?? 0); };
const rotulo = (t) => (t.outcome === 'ERROR_NO_USAGE' ? `EXCL_SEM_USO_HTTP_${t.httpStatus ?? 'UNKNOWN'}` : t.outcome === 'TIMEOUT_UNCERTAIN' || t.outcome === 'SEM_REGISTRO' ? 'EXCL_INCERTO' : `EXCL_SEM_USO_${t.outcome}`);
const MODELOS = [['gpt-4o-mini-2024-07-18', 'openai'], ['gpt-6-luna', 'openai'], ['claude-haiku-4-5-20251001', 'anthropic'], ['claude-haiku-5-5', 'anthropic'], ['claude-sonnet-5-5', 'anthropic'], ['claude-opus-5-5', 'anthropic'], ['gemini-3.5-flash-lite', 'google'], ['gemini-3.1-flash-lite', 'google']];
const BASE = 'gpt-4o-mini-2024-07-18';
const FAM = [['pt_prose', 'Prosa em português'], ['en_prose', 'Prosa em inglês'], ['code_ts', 'Código'], ['json', 'JSON'], ['markdown_table', 'Tabela em markdown'], ['mixed_unicode', 'Unicode misto'], ['numeric', 'Números'], ['tiny', 'Textos muito curtos'], ['TODOS', 'Todos']];
const med = (a) => { a = a.slice().sort((x, y) => x - y); const n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// 1) tentativas, com a regra de inclusão do protocolo §5 (a repetição rep 1 substitui a rep 0 excluída por falta de uso)
const fontes = {}; const linhas = [];
// --dir-google aceita uma lista separada por vírgula (ex.: google_v1_3,google): as linhas são unidas; para o mesmo modelo×texto vale a primeira incluída, na ordem da lista
for (const p of ['openai', 'anthropic', 'google']) for (const [ix, dir] of DIRS[p].split(',').entries()) { const f = path.join(dir, 'TENTATIVAS_CMP8.jsonl'); if (!fs.existsSync(f)) continue; const b = fs.readFileSync(f); fontes[ix ? `${p}#${ix}` : p] = { arquivo: f, sha256: sha(b) }; for (const l of b.toString('utf8').split('\n').filter((x) => x.trim())) linhas.push({ ...JSON.parse(l), fonteOrdem: ix }); }
const conferenciaEntrada = { comparadas: 0, iguais: 0, divergentes: [] };
for (const t of linhas) { const v = doBruto(t.provider, t.usoBrutoProvedor); const antes = t.entradaDeclarada; if (typeof v === 'number' && typeof antes === 'number') { conferenciaEntrada.comparadas++; if (v === antes) conferenciaEntrada.iguais++; else conferenciaEntrada.divergentes.push({ model: t.model, docId: t.docId, doBruto: v, doArquivo: antes }); } t.entradaDoArquivo = antes; t.entradaDeclarada = v; }
const motivo = (t) => { if (t.outcome === 'OK' || t.outcome === 'REFUSED_WITH_USAGE') { if (t.exclusao === 'EXCL_MODEL_MISMATCH' || t.modeloDevolvido !== t.model) return 'EXCL_MODELO_DEVOLVIDO'; if (typeof t.entradaDeclarada !== 'number') return 'EXCL_ENTRADA_AUSENTE_OU_NULA'; if (t.entradaDeclarada === 0) return 'EXCL_ENTRADA_ZERO'; return null; } return rotulo(t); };
const incl = new Map(); const excl = [];
for (const t of linhas.sort((a, b) => (a.fonteOrdem ?? 0) - (b.fonteOrdem ?? 0) || a.rep - b.rep)) { const k = `${t.model}|${t.docId}`; const m = motivo(t); if (m) { excl.push({ model: t.model, docId: t.docId, rep: t.rep, motivo: m, httpStatus: t.httpStatus }); continue; } if (!incl.has(k)) incl.set(k, t); }
// 2) por modelo e família
const famOf = new Map(linhas.map((t) => [t.docId, t.family]));
const val = (m, d) => incl.get(`${m}|${d}`)?.entradaDeclarada;
const docs = [...famOf.keys()];
const tabela = FAM.map(([f, nome]) => {
  const ds = docs.filter((d) => f === 'TODOS' || famOf.get(d) === f);
  const col = Object.fromEntries(MODELOS.map(([m]) => { const xs = ds.map((d) => val(m, d)).filter((x) => typeof x === 'number'); const rs = ds.filter((d) => typeof val(m, d) === 'number' && typeof val(BASE, d) === 'number').map((d) => val(m, d) / val(BASE, d)); const r = med(rs); return [m, { n: xs.length, mediana: med(xs), razaoMedianaPct: r === null ? null : 100 * (r - 1), nRazao: rs.length }]; }));
  return { familia: f, nome, textos: ds.length, modelos: col };
});
// 3) cobertura (§7) e referência de 7/10 dos 3 modelos repetidos
const cobertura = Object.fromEntries(MODELOS.map(([m]) => { const n = docs.filter((d) => typeof val(m, d) === 'number').length; return [m, { incluidos: n, de: docs.length, estado: n === docs.length ? 'COMPLETA' : n >= 205 ? 'QUASE_COMPLETA' : 'INCOMPLETA', faltam: n === docs.length ? [] : docs.filter((d) => typeof val(m, d) !== 'number') }]; }));
let ref710 = null;
if (CSV && fs.existsSync(CSV)) {
  const L = fs.readFileSync(CSV, 'utf8').trim().split(/\r?\n/); const h = L[0].split(',');
  const rows = L.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [h[i], v]))).filter((r) => r.doc_id && r.concluida === 'True');
  const M710 = { openai: BASE, anthropic: 'claude-haiku-4-5-20251001', gemini: 'gemini-3.5-flash-lite' };
  const v710 = new Map(rows.map((r) => [`${M710[r.provedor]}|${r.doc_id}`, r.entrada_declarada !== '' ? +r.entrada_declarada : +r.entrada_nao_cacheada + +(r.entrada_cache_leitura || 0)]));
  // V1_1 (X1 R2): imputação marcada linha a linha
  const imputadas = rows.filter((r) => r.entrada_declarada === '').map((r) => ({ modelo: M710[r.provedor], docId: r.doc_id, valor: +r.entrada_nao_cacheada + +(r.entrada_cache_leitura || 0), regra: 'entrada_nao_cacheada + entrada_cache_leitura' }));
  const impSet = new Set(imputadas.map((x) => `${x.modelo}|${x.docId}`));
  ref710 = { csv: CSV, sha256: sha(fs.readFileSync(CSV)), imputadas, nImputadas: imputadas.length, nota: 'entrada declarada vazia no CSV (conferencia not_produced): usada entrada_nao_cacheada + entrada_cache_leitura, nunca 0; cada linha em imputadas e, nos pares, o campo imputada710',
    porModelo: Object.fromEntries(Object.values(M710).map((m) => { const pares = docs.filter((d) => v710.has(`${m}|${d}`) && typeof val(m, d) === 'number'); const dif = pares.map((d) => val(m, d) - v710.get(`${m}|${d}`)); return [m, { paresDetalhe: pares.map((d) => ({ docId: d, agora: val(m, d), em710: v710.get(`${m}|${d}`), imputada710: impSet.has(`${m}|${d}`) })), pares: pares.length, iguais: dif.filter((x) => x === 0).length, medianaDiferenca: med(dif), medianas710: Object.fromEntries(FAM.slice(0, 8).map(([f]) => [f, med(docs.filter((d) => famOf.get(d) === f && v710.has(`${m}|${d}`)).map((d) => v710.get(`${m}|${d}`)))])) }]; })) };
}
const br = (x) => String(x).replace('.', '{,}');
const pct = (x) => { if (x === null) return '--'; const r = Math.round(x); return (r === 0 ? '' : r > 0 ? '$+$' : '$-$') + br(Math.abs(r)) + '\\,\\%'; };
const nn = (c, tot) => (c.n < tot ? `\\,[${c.n}]` : '');
const cel = (c, base, tot) => (c.mediana === null ? '--' : base ? br(c.mediana) + nn(c, tot) : `${br(c.mediana)} (${pct(c.razaoMedianaPct)})${nn(c, tot)}`);
const cab = MODELOS.map(([m]) => m.replace(/-2024-07-18|-20251001/, '')).join(' & ');
let lin = ''; for (const o of tabela) { const b = o.familia === 'TODOS' ? (x) => '\\textbf{' + x + '}' : (x) => x; if (o.familia === 'TODOS') lin += '\\midrule\n'; lin += [o.nome, o.textos, ...MODELOS.map(([m]) => cel(o.modelos[m], m === BASE, o.textos))].map(b).join(' & ') + ' \\\\\n'; }
const esc = (x) => String(x).replace(/_/g, '\\_');
const incompletos = Object.entries(cobertura).filter(([, c]) => c.estado !== 'COMPLETA');
const motivosPor = (m) => [...new Set(excl.filter((e) => e.model === m && !incl.has(`${m}|${e.docId}`)).map((e) => `${esc(e.docId)} ${esc(e.motivo)}`))].join('; ');
const notaParcial = incompletos.length ? `Resultado PARCIAL: ${incompletos.map(([m, c]) => c.incluidos === 0 ? `${esc(m)} sem dados (${esc(optA('--motivo-' + m) ?? 'nenhuma chamada incluída')})` : `${esc(m)} ${c.incluidos}/${c.de} (${[motivosPor(m), optA('--motivo-' + m) ? esc(optA('--motivo-' + m)) : ''].filter(Boolean).join('; ') || 'sem motivo registrado'})`).join('; ')}. ${optA('--nota-extra') ?? ''} ` : '';
const tex = `% Gerado por analise_cmp8.mjs (CMP8_PREP, C160) a partir de TENTATIVAS_CMP8.jsonl (${ROT}). TEXTO NOVO, NAO APROVADO.
${ROT === 'ENSAIO' ? '% ENSAIO OFFLINE COM PROVEDOR SIMULADO: NUMEROS SINTETICOS, NAO SAO DADOS.\n' : ''}\\begin{table}[htbp]
\\centering
\\caption{Tokens de entrada declarados por oito modelos para os mesmos textos, por tipo de texto (mediana)}
\\label{tab:dif-oito-modelos-familia}
\\scriptsize
\\begin{tabular}{@{}lr${'r'.repeat(MODELOS.length)}@{}}
\\toprule
Tipo de texto & Textos & ${cab} \\\\
\\midrule
${lin}\\bottomrule
\\end{tabular}
\\nota{${notaParcial}Mediana dos tokens de entrada declarados por modelo; entre parênteses, a mediana da razão texto a texto contra o gpt-4o-mini, só com os textos incluídos nos dois; entre colchetes, o número de textos do modelo quando é menor que o da linha. Exclusões e cobertura no PROTOCOLO\\_CMP8.}
\\end{table}
`;
fs.mkdirSync(OUT, { recursive: true });
const j = { schema: 'otk.cmp8.tabela.v1', versaoAnalise: 'V1_3', entradaFonte: 'PROTOCOLO_S3_USO_BRUTO', conferenciaEntradaBrutoVsArquivo: conferenciaEntrada, notaParcial, rotulo: ROT, geradoUtc: new Date().toISOString(), fontes, tentativas: linhas.length, incluidas: incl.size, excluidas: excl, cobertura, coletaCompleta: Object.values(cobertura).every((c) => c.estado === 'COMPLETA'), tabela, referencia710: ref710 };
fs.writeFileSync(path.join(OUT, 'tabela_cmp8.json'), JSON.stringify(j, null, 1) + '\n'); fs.writeFileSync(path.join(OUT, 'tabela_cmp8.tex'), tex);
console.log(JSON.stringify({ ok: true, rotulo: ROT, tentativas: linhas.length, incluidas: incl.size, excluidas: excl.length, coletaCompleta: j.coletaCompleta, todos: tabela.at(-1).modelos }));
