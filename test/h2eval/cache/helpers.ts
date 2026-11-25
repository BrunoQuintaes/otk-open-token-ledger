/**
 * Shared helpers for the cache-study tests: a fixed test-only seed, the local token counters and a memoized
 * corpus build.
 *
 * The corpus build is deterministic for a given seed, so tests share one build per process instead of rebuilding
 * it. The counters load the `js-tiktoken` rank files from `node_modules` (no network).
 *
 * Used by `corpus.test.ts`, `dialogs.test.ts`, `fixtures_sync.test.ts`, `r2.test.ts` and `sim_e2e.test.ts` in this
 * folder.
 *
 * @module test/h2eval/cache/helpers
 */
import { createRequire } from 'node:module';
import { buildCorpus, type CorpusBuild, type Counters } from '../../../scripts/h2eval/corpus/manifest.js';

/** Semente SÓ de teste (≠ H1/CAL-ANTH). A semente real é do autor (D-3). */
export const TEST_SEED = 424242;

const req = createRequire(import.meta.url);
/**
 * Builds the two local token counters (`o200k_base` and `cl100k_base`) from the `js-tiktoken` package.
 *
 * @returns One function per encoding that returns the token count of a text (0 for the empty string).
 */
export function loadCounters(): Required<Counters> {
  const { Tiktoken } = req('js-tiktoken') as { Tiktoken: new (r: unknown) => { encode(t: string, a: string[], d: string[]): number[] } };
  const mk = (n: string) => { const r = req(`js-tiktoken/ranks/${n}`) as { default?: unknown }; const e = new Tiktoken(r.default ?? r); return (t: string) => (t.length === 0 ? 0 : e.encode(t, [], []).length); };
  return { o200k_base: mk('o200k_base'), cl100k_base: mk('cl100k_base') };
}

let cached: CorpusBuild | null = null;
/**
 * Returns the corpus built with {@link TEST_SEED}, building it once per process and reusing it afterwards.
 *
 * @returns The shared corpus build; callers must not mutate it, because later tests in the same process see it.
 */
export const defaultBuild = (): CorpusBuild => (cached ??= buildCorpus({ seed: TEST_SEED }));
