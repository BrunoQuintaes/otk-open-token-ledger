// tex_estimado.mjs (CMP8_ESTIMADO, C160): .tex (texto novo, não aprovado), cartão do Mapa e relatório a partir de tabela_estimado.json.
// Uso: node tex_estimado.mjs <dir>
import fs from 'node:fs'; import path from 'node:path';
const D = process.argv[2]; const j = JSON.parse(fs.readFileSync(path.join(D, 'tabela_estimado.json'), 'utf8'));
const br = (x, d = 1) => (x === null || x === undefined ? '--' : (Math.round(x * 10 ** d) / 10 ** d).toString().replace('.', '{,}'));
const pc = (x) => (x === null || x === undefined ? '--' : br(100 * x, 1) + '\\,\\%');
const nome = (m) => m.replace(/-2024-07-18|-20251001/, '');
const reg = (r) => (r.suporte === 'unsupported' ? 'sem régua (não suportado)' : r.encoding === 'o200k_base' ? 'o200k (exata)' : 'cl100k (aprox.)');
const perf = (p) => (p && 'profileId' in p ? 'sim' : p && /^APROVADO/.test(p.status) ? 'sim (+7)' : 'não');
let lin = '';
for (const t of j.tabela) {
  const b = t.porFamilia.TODOS.bruto, c = t.porFamilia.TODOS.corrigido; const temC = c.nPares > 0;
  lin += [nome(t.model), reg(t.regua), b.medianaEstimado === null ? '--' : br(b.medianaEstimado, 1), b.nPares ? br(b.medianaDeclarado, 1) : '--', b.nPares ? br(b.vies) : '--', b.nPares ? br(b.erroAbsMedio) : '--', b.nPares ? pc(b.erroRelMediano) : '--', b.nPares ? `${b.foraDoLimite16e10pct}/${b.nPares}` : '--',
    perf(t.perfil), temC ? br(c.vies) : '--', temC ? br(c.erroAbsMedio) : '--', temC ? `${c.foraDoLimite16e10pct}/${c.nPares}` : '--'].join(' & ') + ' \\\\\n';
}
const tex = `% Gerado por tex_estimado.mjs (CMP8_ESTIMADO, C160) a partir de tabela_estimado.json. TEXTO NOVO, NÃO APROVADO.
\\begin{table}[htbp]
\\centering
\\caption{Contagem do OTK antes de ver o declarado e entrada declarada pelos provedores, por modelo (215 textos da CMP8)}
\\label{tab:cmp8-estimado-declarado}
\\scriptsize
\\begin{tabular}{@{}llrrrrrrlrrr@{}}
\\toprule
 & & \\multicolumn{6}{c}{Contagem do OTK (sem correção)} & \\multicolumn{4}{c}{Com perfil aprovado} \\\\
\\cmidrule(lr){3-8}\\cmidrule(l){9-12}
Modelo & Régua & Mediana OTK & Mediana declarada & Viés & Erro abs. médio & Erro rel. mediano & Fora do limite & Perfil & Viés & Erro abs. médio & Fora do limite \\\\
\\midrule
${lin}\\bottomrule
\\end{tabular}
\\nota{Conferência, não previsão gravada antes: a contagem do OTK (contador otk.local\\_counter.b3@1, o mesmo da coleta de 7/10) é determinística e não usa o declarado, mas foi calculada depois da coleta. Viés = média de (OTK $-$ declarado); erro relativo = |OTK $-$ declarado| / declarado; fora do limite = |diferença| $>$ 16 tokens e $>$ 10\\,\\% ao mesmo tempo. O contador não suporta o gpt-6-luna. O gpt-6-luna não tem régua no contador: sem contagem do OTK. Google: declarado da refeitura V1\\_3 (429 chamadas) mais a 1ª chamada do gemini-3.5 da coleta inicial (pt\\_prose-000-v0). Perfis: gpt-4o-mini, o de 7/10 (+7, aprovado); Sonnet e Opus 5.5, os do H2-EVAL aprovados no holdout, e gemini-3.1, o GOOGLE-R (M0: a própria contagem), aplicados fora do escopo em que foram validados (leitura exploratória); Haiku 4.5 e Gemini 3.5 têm perfis reprovados (não aplicados); Haiku 5.5 não tem perfil aprovado.}
\\end{table}
`;
fs.writeFileSync(path.join(D, 'tabela_estimado.tex'), tex);
const pl = (x) => (x === null || x === undefined ? '--' : (Math.round(x * 1000) / 10).toString().replace('.', ',') + '%'); const bp = (x) => (x === null ? '--' : Math.round(x).toString());
const T = Object.fromEntries(j.tabela.map((t) => [t.model, t.porFamilia.TODOS]));
const cartao = `CMP8 — o que o OTK estima do nosso lado (conferência pós-coleta, US$ 0)
Contador do OTK (o mesmo de 7/10), 215 textos × 8 modelos, sem chamar provedor; comparado com o que cada provedor declarou na CMP8.
• gpt-4o-mini: régua exata; o OTK fica 7 tokens abaixo em todos os textos (é o envelope da mensagem); com o +7 do perfil de 7/10 o erro é zero.
• Claude (Haiku 4.5, Haiku 5.5, Sonnet 5.5, Opus 5.5): régua aproximada; o OTK conta de menos — viés médio ${bp(T['claude-haiku-4-5-20251001'].bruto.vies)} (Haiku 4.5) e ${bp(T['claude-haiku-5-5'].bruto.vies)} a ${bp(T['claude-opus-5-5'].bruto.vies)} (família 5.5), erro relativo mediano ${pl(T['claude-haiku-4-5-20251001'].bruto.erroRelMediano)} a ${pl(T['claude-opus-5-5'].bruto.erroRelMediano)}. Com os perfis aprovados do Sonnet e do Opus (exploratório: feitos para outro tipo de pedido) o viés passa a +${bp(T['claude-sonnet-5-5'].corrigido.vies)} e +${bp(T['claude-opus-5-5'].corrigido.vies)} (agora conta de mais) e o erro absoluto médio cai à metade, mas ainda ${T['claude-sonnet-5-5'].corrigido.foraDoLimite16e10pct} (Sonnet) e ${T['claude-opus-5-5'].corrigido.foraDoLimite16e10pct} (Opus) de 215 ficam fora do limite (16 tokens e 10%).
• gpt-6-luna: o contador não tem régua para ele.
• Google (gemini-3.5 e gemini-3.1 declaram o mesmo): régua aproximada; em média o OTK conta de menos (de mais em prosa em português e Unicode, bem de menos em números e JSON) — viés médio ${bp(T['gemini-3.5-flash-lite'].bruto.vies)}, erro absoluto médio ${bp(T['gemini-3.5-flash-lite'].bruto.erroAbsMedio)}, erro relativo mediano ${pl(T['gemini-3.5-flash-lite'].bruto.erroRelMediano)}, ${T['gemini-3.5-flash-lite'].bruto.foraDoLimite16e10pct} de 215 fora do limite. O perfil aprovado do 3.1 (GOOGLE-R) é a própria contagem: não muda nada.
É conferência, não previsão: calculado depois da coleta. Texto novo, não aprovado.`;
fs.writeFileSync(path.join(D, 'CARTAO_MAPA_CMP8_ESTIMADO.txt'), cartao + '\n');
console.log(cartao);
