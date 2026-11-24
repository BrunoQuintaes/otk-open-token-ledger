/**
 * H2-EVAL / R13 — textos sintéticos das 4 tarefas do S1 (resumo, correção de código, análise, geração de código), em dois tamanhos.
 * Tudo sai de um gerador com semente: sem dado pessoal, sem texto de terceiros, sem emoji (nenhum surrogate UTF-16 é produzido).
 * `charsTarget` é uma meta de TAMANHO em caracteres (a conversão para tokens é uma estimativa medida nos testes; o gerador não
 * depende de nenhum tokenizador, para o hash não variar com o ambiente).
 */
import { int, pick } from './util.js';

export type Task = 'summary' | 'code_fix' | 'analysis' | 'code_gen';
export type Size = 'S' | 'L';
export const TASKS: readonly Task[] = Object.freeze(['summary', 'code_fix', 'analysis', 'code_gen']);
export const SIZES: readonly Size[] = Object.freeze(['S', 'L']);

/** Metas de caracteres por tarefa e tamanho (S ≈ 700 tokens, L ≈ 5000 tokens de entrada; ver testes de faixa). */
export const CHARS_TARGET: Readonly<Record<Task, Readonly<Record<Size, number>>>> = Object.freeze({
  summary: Object.freeze({ S: 2700, L: 19500 }),
  code_fix: Object.freeze({ S: 2300, L: 15000 }),
  analysis: Object.freeze({ S: 2000, L: 12500 }),
  code_gen: Object.freeze({ S: 2500, L: 18000 }),
});

const TEAMS = ['Atlas', 'Boreal', 'Cinza', 'Delta', 'Eclipse', 'Faro', 'Granito', 'Horizonte'];
const SECTORS = ['almoxarifado', 'logística', 'conferência', 'expedição', 'manutenção', 'qualidade', 'faturamento', 'suporte'];
const AREAS = ['compras', 'operações', 'auditoria', 'planejamento', 'infraestrutura'];
const RES = ['energia', 'água', 'papel', 'largura de banda', 'horas de máquina', 'armazenamento'];
const COMPS = ['K-A', 'K-B', 'M-17', 'M-22', 'P-03', 'P-48'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const IDENT = ['total', 'limite', 'saldo', 'peso', 'fator', 'indice', 'valor', 'taxa', 'passo', 'alvo'];

type R = () => number;

function sentence(r: R): string {
  const t = int(r, 0, 4);
  const n = int(r, 3, 480);
  if (t === 0) return `A equipe ${pick(r, TEAMS)} registrou ${n} ocorrências no setor de ${pick(r, SECTORS)} durante a semana ${int(r, 1, 52)}, com tempo médio de resolução de ${int(r, 4, 95)} minutos.`;
  if (t === 1) return `O contrato C-${int(r, 100, 999)} prevê revisão em ${int(r, 10, 180)} dias, sujeita à aprovação do comitê de ${pick(r, AREAS)}.`;
  if (t === 2) return `Segundo o relatório R-${int(r, 10, 99)}, o consumo de ${pick(r, RES)} aumentou ${int(r, 1, 40)}% em relação ao período anterior.`;
  if (t === 3) return `Foi decidido que o lote L${int(r, 1000, 9999)} seria reprocessado após a conferência dos ${n} registros pendentes.`;
  return `Não houve incidentes relevantes no turno ${int(r, 1, 3)}, exceto o atraso de ${int(r, 2, 70)} minutos na entrega do componente ${pick(r, COMPS)}.`;
}

export interface TextResult { text: string; rubric: Record<string, unknown> }

function summaryText(r: R, charsTarget: number): TextResult {
  const head = 'Resuma em até três frases o texto a seguir, preservando os números mais importantes.\n\n';
  const paras: string[] = [];
  let len = head.length;
  while (len < charsTarget) {
    const k = int(r, 3, 6);
    const p = Array.from({ length: k }, () => sentence(r)).join(' ');
    paras.push(p); len += p.length + 2;
  }
  return { text: head + paras.join('\n\n'), rubric: { kind: 'summary', maxSentences: 3, paragraphs: paras.length } };
}

function codeFixText(r: R, charsTarget: number): TextResult {
  const head = 'O código TypeScript abaixo tem exatamente um defeito. Indique a função com o defeito e proponha a correção mínima.\n\n```ts\n';
  const tail = '```\n';
  const fns: Array<{ name: string; src: string }> = [];
  const used = new Set<string>();
  let len = head.length + tail.length;
  while (len < charsTarget) {
    let name = '';
    do { name = `${pick(r, IDENT)}${pick(r, ['De', 'Com', 'Por'])}${pick(r, IDENT).replace(/^./, (c) => c.toUpperCase())}${int(r, 1, 99)}`; } while (used.has(name));
    used.add(name);
    const lim = int(r, 2, 90); const k = int(r, 2, 9); const form = int(r, 0, 2);
    let src: string;
    if (form === 0) src = `export function ${name}(itens: number[], limite: number): number {\n  let acc = ${int(r, 0, 20)};\n  for (let i = 0; i < itens.length; i++) {\n    if (itens[i] > limite) acc += itens[i] * ${k};\n  }\n  return acc;\n}`;
    else if (form === 1) src = `export function ${name}(valores: number[]): number {\n  let maior = valores[0] ?? 0;\n  for (const v of valores) {\n    if (v > maior) maior = v;\n  }\n  return maior + ${lim};\n}`;
    else src = `export function ${name}(a: number, b: number): number {\n  if (a < b) {\n    return b - a + ${k};\n  }\n  return a - b + ${lim};\n}`;
    fns.push({ name, src }); len += src.length + 2;
  }
  // um defeito, semeado: erro de limite no laço (form 0) ou comparação invertida (form 1/2)
  const target = int(r, 0, fns.length - 1);
  let bug = 'none'; let bugged = fns[target]!.src;
  if (bugged.includes('i < itens.length')) { bugged = bugged.replace('i < itens.length', 'i <= itens.length'); bug = 'off_by_one'; }
  else if (bugged.includes('v > maior')) { bugged = bugged.replace('v > maior', 'v < maior'); bug = 'inverted_comparison'; }
  else { bugged = bugged.replace('if (a < b)', 'if (a > b)'); bug = 'inverted_comparison'; }
  fns[target] = { name: fns[target]!.name, src: bugged };
  return { text: head + fns.map((f) => f.src).join('\n\n') + '\n' + tail, rubric: { kind: 'code_fix', buggyFunction: fns[target]!.name, bugKind: bug, functions: fns.length } };
}

function analysisText(r: R, charsTarget: number): TextResult {
  const head = 'Com base na tabela abaixo, diga qual equipe teve o maior custo médio por unidade e em qual mês o custo total foi mais alto. Justifique com os números.\n\n';
  const header = '| equipe | mês | unidades | custo (centavos) |\n|---|---|---:|---:|\n';
  const question = '\nResponda com a equipe, o mês e o cálculo usado.\n';
  const rows: Array<{ team: string; month: string; units: number; cents: number }> = [];
  let len = head.length + header.length + question.length;
  const teams = TEAMS.slice(0, int(r, 4, 6));
  while (len < charsTarget) {
    const row = { team: pick(r, teams), month: pick(r, MONTHS), units: int(r, 50, 9000), cents: int(r, 5000, 900000) };
    rows.push(row); len += `| ${row.team} | ${row.month} | ${row.units} | ${row.cents} |\n`.length;
  }
  // resposta esperada, calculada em código (rubrica determinística): menor/maior razão por produto cruzado, desempate por nome
  const sums = new Map<string, { u: number; c: number }>();
  const byMonth = new Map<string, number>();
  for (const x of rows) { const s = sums.get(x.team) ?? { u: 0, c: 0 }; s.u += x.units; s.c += x.cents; sums.set(x.team, s); byMonth.set(x.month, (byMonth.get(x.month) ?? 0) + x.cents); }
  let bestTeam = ''; let bestNum = 0; let bestDen = 1;
  for (const t of [...sums.keys()].sort()) { const s = sums.get(t)!; if (bestTeam === '' || s.c * bestDen > bestNum * s.u) { bestTeam = t; bestNum = s.c; bestDen = s.u; } }
  let bestMonth = ''; let bestMonthCents = -1;
  for (const m of [...byMonth.keys()].sort()) if (byMonth.get(m)! > bestMonthCents) { bestMonth = m; bestMonthCents = byMonth.get(m)!; }
  const table = rows.map((x) => `| ${x.team} | ${x.month} | ${x.units} | ${x.cents} |`).join('\n') + '\n';
  return { text: head + header + table + question, rubric: { kind: 'analysis', expectedTeam: bestTeam, expectedMonth: bestMonth, rows: rows.length } };
}

function codeGenText(r: R, charsTarget: number): TextResult {
  const fname = `${pick(r, IDENT)}Agregado${int(r, 1, 99)}`;
  const head = `Implemente em TypeScript a função \`${fname}(entradas: number[]): number\` conforme a especificação a seguir. Responda apenas com o código.\n\nEspecificação:\n`;
  const reqs: string[] = [];
  let len = head.length;
  let i = 1;
  while (len < charsTarget) {
    const t = int(r, 0, 3); let line: string;
    if (t === 0) line = `${i}. Se uma entrada for maior que ${int(r, 10, 900)}, some ${int(r, 2, 9)} vezes o valor excedente ao resultado.`;
    else if (t === 1) line = `${i}. Ignore entradas negativas, exceto quando houver mais de ${int(r, 2, 8)} delas; nesse caso subtraia ${int(r, 1, 30)} do resultado.`;
    else if (t === 2) line = `${i}. A cada ${int(r, 3, 12)} entradas válidas consecutivas, acrescente ${int(r, 1, 50)} ao resultado e reinicie a contagem.`;
    else line = `${i}. Exemplo: com entradas [${Array.from({ length: int(r, 3, 6) }, () => int(r, -20, 120)).join(', ')}] o resultado parcial após esta regra é ${int(r, 0, 400)}.`;
    reqs.push(line); len += line.length + 1; i += 1;
  }
  return { text: head + reqs.join('\n') + '\n', rubric: { kind: 'code_gen', functionName: fname, requirements: reqs.length } };
}

export function makeText(task: Task, size: Size, r: R): TextResult {
  const n = CHARS_TARGET[task][size];
  switch (task) {
    case 'summary': return summaryText(r, n);
    case 'code_fix': return codeFixText(r, n);
    case 'analysis': return analysisText(r, n);
    case 'code_gen': return codeGenText(r, n);
  }
}

/**
 * Variantes quase duplicadas do texto-base (como na H1, mas SEM operar no meio de pares substitutos UTF-16 e sem alterar a semântica):
 *  v0 = base; v1 = base + quebra de linha final; v2 = primeira ocorrência de um espaço duplicado após a primeira frase, ou quebra inicial.
 */
export function variantOf(base: string, v: number): string {
  if (v === 0) return base;
  if (v === 1) return base + '\n';
  const i = base.indexOf('\n\n');
  return i > 0 ? base.slice(0, i) + '\n\n\n' + base.slice(i + 2) : '\n' + base;
}
