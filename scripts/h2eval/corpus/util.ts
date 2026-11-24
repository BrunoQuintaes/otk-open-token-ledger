/**
 * H2-EVAL / R13 — utilitários puros e determinísticos do gerador de corpus (versão própria; não importa nada do corpus da H1).
 * Sem rede, sem relógio, sem aleatoriedade externa: tudo sai da semente recebida por parâmetro.
 */
import { createHash } from 'node:crypto';

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** JSON canônico: chaves ordenadas, sem espaços. Usado para todo hash de manifesto. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
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

/** Gerador independente por (semente, rótulos): mudar a quantidade de itens de um rótulo não desloca os outros. */
export function rngFor(seed: number, ...labels: string[]): () => number {
  const h = sha256Hex(`${seed}|${labels.join('|')}`);
  return mulberry32(parseInt(h.slice(0, 8), 16));
}

export function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

export const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

/** Há surrogate UTF-16 isolado? (defeito F-OVN2-08 do gerador da H1: aqui é proibido e testado) */
export const hasLoneSurrogate = (s: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
