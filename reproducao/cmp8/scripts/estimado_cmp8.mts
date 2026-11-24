// estimado_cmp8.mts (agente CMP8_ESTIMADO, C160): "o que o OTK estima do nosso lado" para os 215 textos × 8 modelos da CMP8, com o MESMO contador
// da coleta de 7/10 (otk.local_counter.b3@1, do executor congelado b0ec6f24, só lido/executado), sobre o corpo EXATO que o adaptador monta para cada
// modelo; nenhuma chamada a provedor. Depois compara com a entrada declarada da CMP8 (uso BRUTO do provedor, protocolo §3), só leitura.
// Perfis de correção: só os CONGELADOS e com holdout aprovado; aplicados como coluna à parte (estimativa corrigida), nunca no lugar da contagem bruta.
// Uso: node C:/dev/h2eval-exec-econ-b0ec6f24/node_modules/tsx/dist/cli.mjs estimado_cmp8.mts <saidaDir>
// ADAPTADO PARA O REPOSITÓRIO PÚBLICO (REPO_PUBLICO, C160): lê o código do próprio repositório (src/ = H1 7606bc9b; scripts/h2eval = executor
// b0ec6f24, conferidos por sha256 em PROVENIENCIA.json) e os dados de reproducao/cmp8; sem conferência de git (o repositório público não tem o
// histórico do executor). Nenhuma outra mudança na conta. Uso: npx tsx reproducao/cmp8/scripts/estimado_cmp8.mts <saidaDir>
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { pathToFileURL } from 'node:url';
const EX = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..'); const EXEC_SHA = 'b0ec6f2444c9648d13378ac5990a9e8ed7093b35';
const KIT = path.join(EX, 'reproducao', 'cmp8');
const RAIZ = path.join(EX, 'reproducao', 'cmp8', 'dados');
const OUT = process.argv[2]!;
const imp = (p: string) => import(pathToFileURL(path.join(EX, p)).href);
const modal = await imp('scripts/h2eval/modal/index.ts'); const canonM = await imp('scripts/h2eval/core/canon.ts'); const counter = await imp('src/tokenization/localCounter.ts'); const conf = await imp('src/tokenization/conferenceReport.ts');
const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex');
// (repositório público: sem conferência de git; ver PROVENIENCIA.json)

// itens e planos da CMP8 (215 textos; corpos pelo adaptador congelado, com os mesmos parâmetros da coleta)
const itens = fs.readFileSync(path.join(KIT, 'corpus', 'itens.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { docId: string; family: string; prompt: string; promptSha256: string });
const MOD: Array<{ model: string; provider: string; api: string; serviceTier: string; reasoning: unknown; thinking: unknown }> = [
  { model: 'gpt-4o-mini-2024-07-18', provider: 'openai', api: 'openai.chat_completions', serviceTier: 'default', reasoning: 'NONE', thinking: { mode: 'none' } },
  { model: 'gpt-6-luna', provider: 'openai', api: 'openai.chat_completions', serviceTier: 'default', reasoning: 'NONE', thinking: { mode: 'none' } },
  { model: 'claude-haiku-4-5-20251001', provider: 'anthropic', api: 'anthropic.messages', serviceTier: 'standard_only', reasoning: 'NONE', thinking: { mode: 'none' } },
  { model: 'claude-haiku-5-5', provider: 'anthropic', api: 'anthropic.messages', serviceTier: 'standard_only', reasoning: 'NONE', thinking: { mode: 'none' } },
  { model: 'claude-sonnet-5-5', provider: 'anthropic', api: 'anthropic.messages', serviceTier: 'standard_only', reasoning: { effort: 'low' }, thinking: { mode: 'adaptive', effort: 'low' } },
  { model: 'claude-opus-5-5', provider: 'anthropic', api: 'anthropic.messages', serviceTier: 'standard_only', reasoning: { effort: 'low' }, thinking: { mode: 'adaptive', effort: 'low' } },
  { model: 'gemini-3.5-flash-lite', provider: 'google', api: 'gemini.generate_content', serviceTier: 'NONE', reasoning: { thinking_level: 'minimal' }, thinking: { mode: 'minimal', thinkingLevel: 'minimal' } },
  { model: 'gemini-3.1-flash-lite', provider: 'google', api: 'gemini.generate_content', serviceTier: 'NONE', reasoning: { thinking_level: 'minimal' }, thinking: { mode: 'minimal', thinkingLevel: 'minimal' } },
];
const planos = Object.fromEntries(['openai', 'anthropic', 'google'].map((p) => [p, fs.readFileSync(path.join(KIT, 'planos', `PLANO_${p}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { model: string; docId: string; requestBodySha256: string })]));
const plan = (m: (typeof MOD)[number], it: (typeof itens)[number]) => ({ schema: 'h2eval.plan.v0', studyId: 'estudo_cmp8', protocolHash: '0'.repeat(64), manifestSha256: '0'.repeat(64), batchId: 'x', phase: 'COMPARATIVE_PAIRED', cellId: 'cmp8', groupId: 'g', promptId: it.docId, rep: 0, variant: it.family, split: 'COMPARATIVE', provider: m.provider, api: m.api, endpoint: m.api, modelRequested: m.model, task: 'summary', sizeBucket: 'S', structure: 'S1', modality: 'text', plannedCacheArm: 'S1', promptSha256: it.promptSha256, prefixSha256: 'NOT_APPLICABLE', nonce: 'NOT_APPLICABLE', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: m.reasoning, serviceTier: m.serviceTier, serviceTierRequested: m.serviceTier, cacheDirectives: 'NONE', thinking: m.thinking, cacheTtlRequested: 'NOT_APPLICABLE' } });

// régua por modelo (do próprio catálogo do executor)
const reguas: Record<string, unknown> = {};
// declarado da CMP8 (uso bruto, protocolo §3), só leitura
const doBruto = (p: string, b: Record<string, number> | null) => { if (!b) return null; const n = (k: string) => (Number.isSafeInteger(b[k]) && b[k]! >= 0 ? b[k]! : null);
  if (p === 'openai') return n('prompt_tokens'); if (p === 'google') return n('promptTokenCount');
  const a = n('input_tokens'); if (a === null) return null; return a + (n('cache_read_input_tokens') ?? 0) + (n('cache_creation_input_tokens') ?? 0); };
const decl = new Map<string, { v: number; outcome: string; contagemLocalColeta: unknown }>(); const fontes: Record<string, string> = {};
// V2: o Google vem de google_v1_3 e, para o que faltar (pt_prose-000-v0 do gemini-3.5, opId 7175f36b), do batch google antigo (como analise_cmp8.mjs --dir-google google_v1_3,google)
const DIRS: Array<[string, string]> = [['openai', 'openai'], ['anthropic', 'anthropic'], ['google', 'google_v1_3'], ['google', 'google']];
const origemDecl = new Map<string, string>();
for (const [p, dir] of DIRS) { const f = path.join(RAIZ, dir, 'TENTATIVAS_CMP8.jsonl'); if (!fs.existsSync(f)) continue; const b = fs.readFileSync(f); fontes[dir] = sha(b);
  for (const l of b.toString('utf8').split('\n').filter(Boolean)) { const t = JSON.parse(l); const v = doBruto(p, t.usoBrutoProvedor ?? t.usage?.rawUsageSanitized ?? null);
    const inc = (t.outcome === 'OK' || t.outcome === 'REFUSED_WITH_USAGE') && t.modeloDevolvido === t.model && typeof v === 'number' && v > 0;
    if (inc && !decl.has(`${t.model}|${t.docId}`)) { decl.set(`${t.model}|${t.docId}`, { v: v!, outcome: t.outcome, contagemLocalColeta: t.contagemLocal }); origemDecl.set(`${t.model}|${t.docId}`, dir); } } }

// perfis: só congelados; status do registro de decisões; aplicados à parte
type Perfil = { arquivo: string; sha256: string; profileId: string; method: string; paramsSha256: string; a: number; b: number; status: string; fonteStatus: string; escopo: string };
const perfilDe = (arq: string, model: string, status: string, fonteStatus: string, escopo: string): Perfil => { const j = JSON.parse(fs.readFileSync(arq, 'utf8')); const p = j.profile.params[model]; return { arquivo: arq, sha256: sha(fs.readFileSync(arq)), profileId: j.profile.profileId, method: j.profile.method, paramsSha256: j.profile.paramsSha256, a: p.a, b: p.b, status, fonteStatus, escopo }; };
const ESC_H2 = 'perfil ajustado no H2-EVAL (pedidos com estrutura S1/S2/S3, outro corpus e outro max_tokens); aplicado aqui FORA do escopo de validação dele: leitura exploratória';
const PERFIS: Record<string, Perfil | { status: string; motivo: string; arquivo?: string; sha256?: string }> = {
  'gpt-4o-mini-2024-07-18': { status: 'APROVADO (calibrated=true, COMPATIBLE)', motivo: 'perfil de 7/10 (otk.calib.ovn2-20261007.openai…gpt-4o-mini-2024-07-18): provedor = 1,000000 × local + 7; holdout viés 0, MAE 0 (RESULTADOS_CALIBRACAO.md em 7606bc9b)', arquivo: 'git 7606bc9b:docs/_ops/OVERNIGHT2_20261006/calibration/calibration_profile_openai_gpt-4o-mini-2024-07-18.json' },
  'gpt-6-luna': { status: 'NAO_APLICAVEL', motivo: 'o perfil OPENAI-R (M1 a=6 b=1, holdout PASS, DR-250) usa L0 do contador; o contador b3@1 NÃO suporta gpt-6-luna (L0 UNKNOWN), então não há onde aplicar' },
  'claude-haiku-4-5-20251001': { status: 'REPROVADO (calibrated=false)', motivo: 'perfil de 7/10 com falso alerta 5,4% > 5% no holdout; não aplicado' },
  'claude-haiku-5-5': { status: 'SEM_PERFIL_APROVADO', motivo: 'R4 calibração NÃO ACEITA (DR-031); ciclo 3 INCONCLUSIVE; HAIKU-R NOT_RUN (DR-222, DR-248); nenhum aplicado' },
  'claude-sonnet-5-5': perfilDe(path.join(KIT, 'perfis', 'perfil_sonnet_r.json'), 'claude-sonnet-5-5', 'APROVADO no holdout (SONNET-R PASS 6/6, DR-215), exploratório nunca H1', 'DR-213/DR-215', ESC_H2),
  'claude-opus-5-5': perfilDe(path.join(KIT, 'perfis', 'perfil_opus_r6m.json'), 'claude-opus-5-5', 'APROVADO no holdout (Opus R6-M PASS 6/6, ESTADO_E_REGRAS §D; F5 DR-185, holdout DR-189)', 'DR-185/DR-189', ESC_H2),
  'gemini-3.5-flash-lite': { status: 'REPROVADO (calibrated=false)', motivo: 'perfil de 7/10 com detecção de +25% em 8% < 50% exigido; não aplicado' },
  'gemini-3.1-flash-lite': perfilDe(path.join(KIT, 'perfis', 'perfil_google_r.json'), 'gemini-3.1-flash-lite', 'APROVADO no holdout (GOOGLE-R PASS 6/6, DR-240), exploratório nunca H1', 'DR-240', ESC_H2 + '; M0 = a 0, b 1 (o próprio L0)'),
};
const corrige = (m: string, L0: number | null): number | null => { if (L0 === null) return null; const p = PERFIS[m] as Perfil & { status: string };
  if (m === 'gpt-4o-mini-2024-07-18') return L0 + 7; if (!('a' in p)) return null; return Math.max(0, Math.round(p.a + p.b * L0)); };

// contagem por modelo × texto
const linhas: Array<Record<string, unknown>> = [];
for (const m of MOD) {
  const ad = modal.ADAPTERS[m.api]; const sup = ad.modelSupport(m.model);
  reguas[m.model] = { suporte: sup.support, encoding: sup.tokenizer?.encoding ?? null, vocabularyDigest: sup.tokenizer?.vocabularyDigest ?? null, montagem: sup.tokenizer?.messageAssembly ?? null, leitura: sup.support === 'unsupported' ? 'NAO_SUPORTADO: o catálogo não tem gpt-6-*; sem régua, sem estimativa' : sup.tokenizer?.encoding === 'o200k_base' ? 'exata (o tokenizador do próprio modelo)' : 'aproximada (cl100k_base no lugar do tokenizador do provedor, não publicado)' };
  const pl = planos[m.provider]!.filter((x) => x.model === m.model); const bodyOk = new Map(pl.map((x) => [x.docId, x.requestBodySha256]));
  for (const it of itens) {
    const b = modal.bodyOf(plan(m, it), { promptSha256: it.promptSha256, messages: [{ role: 'user', parts: [{ type: 'text', text: it.prompt }] }], prefixMessages: 'NOT_APPLICABLE' });
    const corpoIgual = bodyOk.get(it.docId) === canonM.sha256Canon(b.body);
    const c = counter.createLocalCounter(sup, { maxTextBytes: 4_000_000 }); c.observeInput({ api: m.api, body: b.body }); const r = c.finish();
    const ic = r.counts.find((x: { category: string }) => x.category === 'input'); const L0 = ic && r.covered.includes('input') ? Number(ic.count) : null;
    const d = decl.get(`${m.model}|${it.docId}`);
    const est = L0; const cor = corrige(m.model, L0);
    const divergente = (e: number | null) => (e === null || !d ? null : conf.isDivergent({ provider: BigInt(d.v), absoluteDelta: BigInt(e - d.v), relativeDelta: conf.relativeDeltaString(BigInt(e - d.v), BigInt(d.v)) }, conf.HEURISTIC_THRESHOLD_V0));
    linhas.push({ origemDeclarado: origemDecl.get(`${m.model}|${it.docId}`) ?? null, model: m.model, docId: it.docId, family: it.family, L0: est, estimadoCorrigido: cor, declarado: d?.v ?? null, corpoIgualAoDaColeta: corpoIgual, contagemLocalDaColeta: d?.contagemLocalColeta ?? null, divergenteBruto: divergente(est), divergenteCorrigido: divergente(cor), contadorStatus: r.status });
  }
}
// métricas
const med = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
const FAM = ['pt_prose', 'en_prose', 'code_ts', 'json', 'markdown_table', 'mixed_unicode', 'numeric', 'tiny', 'TODOS'];
const metr = (ls: Array<Record<string, unknown>>, campo: 'L0' | 'estimadoCorrigido') => {
  const par = ls.filter((l) => typeof l[campo] === 'number' && typeof l['declarado'] === 'number') as Array<Record<string, number>>;
  const dif = par.map((l) => l[campo]! - l['declarado']!); const rel = par.map((l) => Math.abs(l[campo]! - l['declarado']!) / l['declarado']!);
  const divK = campo === 'L0' ? 'divergenteBruto' : 'divergenteCorrigido';
  return { nPares: par.length, medianaEstimado: med(ls.filter((l) => typeof l[campo] === 'number').map((l) => l[campo] as number)), medianaDeclarado: med(par.map((l) => l['declarado']!)), vies: r3(mean(dif)), erroAbsMedio: r3(mean(dif.map(Math.abs))), erroRelMediano: r3(med(rel)), foraDoLimite16e10pct: ls.filter((l) => l[divK] === true).length };
};
const tabela = MOD.map((m) => { const lm = linhas.filter((l) => l['model'] === m.model);
  return { model: m.model, regua: reguas[m.model], perfil: PERFIS[m.model], porFamilia: Object.fromEntries(FAM.map((f) => { const lf = f === 'TODOS' ? lm : lm.filter((l) => l['family'] === f); return [f, { bruto: metr(lf, 'L0'), corrigido: metr(lf, 'estimadoCorrigido') }]; })) }; });
const conferenciaColeta = linhas.filter((l) => typeof l['contagemLocalDaColeta'] === 'number').map((l) => l['contagemLocalDaColeta'] === l['L0']);
fs.mkdirSync(OUT, { recursive: true });
const linhasTxt = linhas.map((l) => JSON.stringify(l)).join('\n') + '\n'; fs.writeFileSync(path.join(OUT, 'linhas_estimado.jsonl'), linhasTxt);
const j = {
  schema: 'otk.cmp8.estimado.v1', versao: 'V2 (Google da V1_3 + a 1a chamada do batch google antigo)', origemDeclaradoGoogle: Object.fromEntries([...new Set([...origemDecl.entries()].filter(([k]) => k.startsWith('gemini')).map(([k, d]) => k.split('|')[0] + '@' + d))].map((x) => [x, [...origemDecl.entries()].filter(([k, d]) => `${k.split('|')[0]}@${d}` === x).length])), autor: 'CMP8_ESTIMADO (C160)', geradoUtc: new Date().toISOString(),
  natureza: 'CONFERÊNCIA, não previsão gravada antes: a contagem é determinística e não usa o declarado, mas foi calculada DEPOIS da coleta (mesma distinção do Cap. 3). A estimativa corrigida aplica perfis congelados antes desta conta; mesmo assim é conferência pós-coleta.',
  contador: { versao: counter.COUNTER_VERSION, executor: EXEC_SHA, limiteDivergencia: '|estimado − declarado| > 16 tokens E > 10 % (HEURISTIC_THRESHOLD_V0, não calibrado)', envelope: 'o contador b3@1 conta só o texto das partes (otk.assembly.text_parts@1); NÃO calcula envelope de mensagem; o +7 do gpt-4o-mini só entra pela correção (perfil de 7/10)' },
  fontes: { itens: sha(fs.readFileSync(path.join(KIT, 'corpus', 'itens.jsonl'))), tentativasCMP8: fontes, linhasEstimado: sha(linhasTxt) },
  conferenciaComAContagemDaColeta: { comparadas: conferenciaColeta.length, iguais: conferenciaColeta.filter(Boolean).length },
  corposIguaisAosDaColeta: linhas.filter((l) => l['corpoIgualAoDaColeta']).length + '/' + linhas.length,
  declaradoDisponivel: Object.fromEntries(MOD.map((m) => [m.model, linhas.filter((l) => l['model'] === m.model && typeof l['declarado'] === 'number').length])),
  tabela,
};
fs.writeFileSync(path.join(OUT, 'tabela_estimado.json'), JSON.stringify(j, null, 1) + '\n');
console.log(JSON.stringify({ ok: true, reguas: Object.fromEntries(Object.entries(reguas).map(([k, v]) => [k, (v as { encoding: string | null; suporte: string }).encoding ?? (v as { suporte: string }).suporte])), conf: j.conferenciaComAContagemDaColeta, corpos: j.corposIguaisAosDaColeta, decl: j.declaradoDisponivel,
  todos: Object.fromEntries(tabela.map((t) => [t.model, { b: t.porFamilia['TODOS']!.bruto, c: t.porFamilia['TODOS']!.corrigido }])) }));
