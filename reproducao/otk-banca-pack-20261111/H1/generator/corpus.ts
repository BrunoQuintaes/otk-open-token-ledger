/**
 * D8 §3 — synthetic calibration corpus (front B). Deterministic from a seed, fixed by sha256.
 *
 * Every document belongs to a `group` (one base text and its near-duplicate variants). Splits are
 * made by group, so a variant never lands in a different split from its base (no leakage by
 * almost identical texts). Families vary language, format and size, and include empty and
 * one-word texts for the small/zero cases. All text is generated here: no personal, banking or
 * third-party content.
 */
import { createHash } from 'node:crypto';

export const CORPUS_VERSION = 'otk.calibration_corpus.synthetic.v1';
export const CORPUS_SEED = 20260930;

export type Family = 'pt_prose' | 'en_prose' | 'code_ts' | 'json' | 'markdown_table' | 'mixed_unicode' | 'numeric' | 'tiny';

export interface CorpusDoc {
  id: string;
  group: string;
  variant: number;
  family: Family;
  lang: 'pt' | 'en' | 'mixed' | 'none';
  format: 'prose' | 'code' | 'json' | 'markdown' | 'numbers' | 'short';
  sizeBucket: 'zero' | 'xs' | 's' | 'm' | 'l';
  text: string;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PT = 'consumo reconciliação serviço fatura contrato modelo resposta pergunta equipe projeto tarefa custo orçamento registro conferência provedor recibo prova cadeia operação tempo usuário sistema dados privacidade auditoria limite medida unidade peso preço'.split(' ');
const PT_F = 'de o a que e do da em um para com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles estão você tinha foram essa num nem suas meu às minha têm numa pelos elas havia seja qual será nós'.split(' ');
const EN = 'usage reconciliation service invoice contract model response question team project task cost budget record conference provider receipt proof chain operation time user system data privacy audit limit measure unit weight price'.split(' ');
const EN_F = 'the of and to in is that it for on was with as by at from this be are or an which have not has but had they were their been one more its can all would there will when who what about out up into than'.split(' ');
const IDENT = 'total count usage receipt provider weights table result value item index buffer stream token model price'.split(' ');
const UNI = ['😀', '👨‍👩‍👧', '🇧🇷', '中文', '日本語', '한국어', 'Ünïcödé', 'ação', 'naïve', '—', '…', 'ß', 'Ω', '∑', '→'];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function sentence(r: () => number, content: string[], fn: string[], min: number, max: number): string {
  const n = min + Math.floor(r() * (max - min + 1));
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(r() < 0.45 ? pick(r, fn) : pick(r, content));
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + pick(r, ['.', '.', '.', '?', '!', ';']);
}

function prose(r: () => number, lang: 'pt' | 'en', sentences: number): string {
  const [c, f] = lang === 'pt' ? [PT, PT_F] : [EN, EN_F];
  const paras: string[] = [];
  let left = sentences;
  while (left > 0) {
    const k = Math.min(left, 1 + Math.floor(r() * 5));
    paras.push(Array.from({ length: k }, () => sentence(r, c, f, 4, 18)).join(' '));
    left -= k;
  }
  return paras.join('\n\n');
}

function code(r: () => number, fns: number): string {
  const out: string[] = [];
  for (let i = 0; i < fns; i++) {
    const name = `${pick(r, IDENT)}${pick(r, ['For', 'Of', 'With', 'From'])}${pick(r, IDENT).replace(/^./, (c) => c.toUpperCase())}`;
    const a = pick(r, IDENT);
    const b = pick(r, IDENT);
    out.push(`export function ${name}(${a}: number, ${b}: string[]): number {\n  // ${pick(r, EN)} ${pick(r, EN)} ${pick(r, EN)}\n  let acc = ${Math.floor(r() * 1000)};\n  for (const x of ${b}) {\n    if (x.length > ${a}) acc += x.length * ${(r() * 10).toFixed(2)};\n  }\n  return acc;\n}`);
  }
  return out.join('\n\n') + '\n';
}

function json(r: () => number, items: number): string {
  const arr = Array.from({ length: items }, (_, i) => ({
    id: `op-${i}-${Math.floor(r() * 1e6)}`,
    provider: pick(r, ['openai', 'anthropic', 'gemini', 'deepseek']),
    tokens: { input: Math.floor(r() * 5000), output: Math.floor(r() * 2000) },
    ok: r() < 0.9,
    note: sentence(r, EN, EN_F, 2, 6),
  }));
  return r() < 0.5 ? JSON.stringify(arr) : JSON.stringify(arr, null, 2);
}

function table(r: () => number, rows: number): string {
  const head = '| equipe | projeto | tokens | custo (US$) |\n|---|---|---:|---:|';
  const body = Array.from({ length: rows }, () => `| ${pick(r, PT)} | ${pick(r, PT)}-${Math.floor(r() * 99)} | ${Math.floor(r() * 90000)} | ${(r() * 40).toFixed(4)} |`);
  return [head, ...body].join('\n');
}

function mixed(r: () => number, n: number): string {
  return Array.from({ length: n }, () => (r() < 0.4 ? pick(r, UNI) : r() < 0.5 ? pick(r, PT) : pick(r, EN))).join(r() < 0.3 ? '' : ' ');
}

function numeric(r: () => number, n: number): string {
  return Array.from({ length: n }, () => (r() < 0.5 ? (r() * 1e6).toFixed(Math.floor(r() * 4)) : String(Math.floor(r() * 1e9)))).join(r() < 0.5 ? ', ' : '\n');
}

function bucket(len: number): CorpusDoc['sizeBucket'] {
  if (len === 0) return 'zero';
  if (len < 64) return 'xs';
  if (len < 512) return 's';
  if (len < 2048) return 'm';
  return 'l';
}

/** Small edit that keeps the text recognisably the same document (near-duplicate). */
function variantOf(r: () => number, text: string, v: number): string {
  if (text.length === 0) return v === 1 ? ' ' : '\n';
  const ops = [
    (t: string) => t + '\n',
    (t: string) => t.replace(/\.(\s|$)/, '!$1'),
    (t: string) => { const i = Math.floor(r() * t.length); return t.slice(0, i) + ' ' + t.slice(i); },
    (t: string) => t.replace(/ (\S+) /, (_m, w: string) => ` ${w.toUpperCase()} `),
  ];
  return ops[(v + Math.floor(r() * ops.length)) % ops.length]!(text);
}

const FAMILY_SPECS: Array<{ family: Family; lang: CorpusDoc['lang']; format: CorpusDoc['format']; make: (r: () => number) => string }> = [
  { family: 'pt_prose', lang: 'pt', format: 'prose', make: (r) => prose(r, 'pt', 1 + Math.floor(r() * 30)) },
  { family: 'en_prose', lang: 'en', format: 'prose', make: (r) => prose(r, 'en', 1 + Math.floor(r() * 30)) },
  { family: 'code_ts', lang: 'en', format: 'code', make: (r) => code(r, 1 + Math.floor(r() * 6)) },
  { family: 'json', lang: 'en', format: 'json', make: (r) => json(r, 1 + Math.floor(r() * 12)) },
  { family: 'markdown_table', lang: 'pt', format: 'markdown', make: (r) => table(r, 1 + Math.floor(r() * 25)) },
  { family: 'mixed_unicode', lang: 'mixed', format: 'prose', make: (r) => mixed(r, 3 + Math.floor(r() * 120)) },
  { family: 'numeric', lang: 'none', format: 'numbers', make: (r) => numeric(r, 1 + Math.floor(r() * 80)) },
  { family: 'tiny', lang: 'mixed', format: 'short', make: (r) => pick(r, ['', 'ok', 'Sim.', 'hello', '?', '42', 'obrigado!', 'a b']) },
];

/** Generates the corpus: groupsPerFamily groups × (1 base + variantsPerGroup variants). */
export function generateCorpus(opts: { seed?: number; groupsPerFamily?: number; variantsPerGroup?: number } = {}): CorpusDoc[] {
  const r = mulberry32(opts.seed ?? CORPUS_SEED);
  const groups = opts.groupsPerFamily ?? 15;
  const variants = opts.variantsPerGroup ?? 2;
  const docs: CorpusDoc[] = [];
  for (const spec of FAMILY_SPECS) {
    for (let g = 0; g < groups; g++) {
      const group = `${spec.family}-${String(g).padStart(3, '0')}`;
      const base = spec.make(r);
      for (let v = 0; v <= variants; v++) {
        const text = v === 0 ? base : variantOf(r, base, v);
        docs.push({ id: `${group}-v${v}`, group, variant: v, family: spec.family, lang: spec.lang, format: spec.format, sizeBucket: bucket(text.length), text });
      }
    }
  }
  return docs;
}

export function corpusToJsonl(docs: CorpusDoc[]): string {
  return docs.map((d) => JSON.stringify(d)).join('\n') + '\n';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Split by group: sha256(`${CORPUS_VERSION}:${group}`) mod 100 → <60 train, <80 validation, else test. */
export function splitOf(group: string): 'train' | 'validation' | 'test' {
  const h = parseInt(sha256(`${CORPUS_VERSION}:${group}`).slice(0, 8), 16) % 100;
  return h < 60 ? 'train' : h < 80 ? 'validation' : 'test';
}
