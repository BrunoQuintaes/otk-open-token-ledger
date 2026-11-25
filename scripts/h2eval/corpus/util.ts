/**
 * H2-EVAL / R13 — utilitários puros e determinísticos do gerador de corpus (versão própria; não importa nada do corpus da H1).
 * Sem rede, sem relógio, sem aleatoriedade externa: tudo sai da semente recebida por parâmetro.
 *
 * In English: pure, deterministic helpers of the corpus generator (hashing, canonical JSON, seeded random numbers).
 * No network, clock or external randomness: everything derives from the seed passed in. Used by the corpus modules,
 * `cache/dialogs.ts`, `cache/contentStore.ts` and `cli/pilot.ts`.
 *
 * @module scripts/h2eval/corpus/util
 */
import { createHash } from 'node:crypto';

/**
 * SHA-256 of a string's UTF-8 bytes.
 *
 * @param s - Text to hash.
 * @returns Lowercase hex digest (64 characters).
 */
export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * JSON canônico: chaves ordenadas, sem espaços. Usado para todo hash de manifesto.
 *
 * Canonical JSON: keys sorted, no spaces, `undefined` properties dropped; used for every manifest hash.
 *
 * @param v - Any JSON-compatible value (not mutated).
 * @returns The canonical JSON text.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/**
 * Small seeded pseudo-random generator (mulberry32); the same seed always gives the same sequence.
 *
 * @param seed - Seed, taken as an unsigned 32-bit integer.
 * @returns A function that returns the next number in [0, 1) each time it is called.
 */
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

/**
 * Gerador independente por (semente, rótulos): mudar a quantidade de itens de um rótulo não desloca os outros.
 *
 * Independent generator per (seed, labels): changing how many items one label draws does not shift the others.
 *
 * @param seed - Corpus seed.
 * @param labels - Labels that name the stream (for example a cell and an item index).
 * @returns A mulberry32 generator seeded with the first 32 bits of SHA-256(`seed|label1|label2…`).
 */
export function rngFor(seed: number, ...labels: string[]): () => number {
  const h = sha256Hex(`${seed}|${labels.join('|')}`);
  return mulberry32(parseInt(h.slice(0, 8), 16));
}

/**
 * Picks one element uniformly with the given generator.
 *
 * @param r - Generator returning numbers in [0, 1).
 * @param xs - Non-empty list; an empty list returns `undefined` despite the type.
 * @returns The chosen element.
 */
export function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

/**
 * Draws an integer uniformly in the closed range [lo, hi].
 *
 * @param r - Generator returning numbers in [0, 1).
 * @param lo - Smallest value (inclusive).
 * @param hi - Largest value (inclusive).
 * @returns The drawn integer.
 */
export const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

/**
 * Há surrogate UTF-16 isolado? (defeito F-OVN2-08 do gerador da H1: aqui é proibido e testado)
 *
 * Tells whether the string holds an unpaired UTF-16 surrogate (it would not survive UTF-8 encoding intact).
 *
 * @param s - Text to check.
 * @returns `true` when at least one lone high or low surrogate is present.
 */
export const hasLoneSurrogate = (s: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
