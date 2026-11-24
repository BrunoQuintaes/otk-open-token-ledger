import { createRequire } from 'node:module';
import { buildCorpus, type CorpusBuild, type Counters } from '../../../scripts/h2eval/corpus/manifest.js';

/** Semente SÓ de teste (≠ H1/CAL-ANTH). A semente real é do Bruno (D-3). */
export const TEST_SEED = 424242;

const req = createRequire(import.meta.url);
export function loadCounters(): Required<Counters> {
  const { Tiktoken } = req('js-tiktoken') as { Tiktoken: new (r: unknown) => { encode(t: string, a: string[], d: string[]): number[] } };
  const mk = (n: string) => { const r = req(`js-tiktoken/ranks/${n}`) as { default?: unknown }; const e = new Tiktoken(r.default ?? r); return (t: string) => (t.length === 0 ? 0 : e.encode(t, [], []).length); };
  return { o200k_base: mk('o200k_base'), cl100k_base: mk('cl100k_base') };
}

let cached: CorpusBuild | null = null;
export const defaultBuild = (): CorpusBuild => (cached ??= buildCorpus({ seed: TEST_SEED }));
