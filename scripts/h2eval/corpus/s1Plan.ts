/**
 * H2-EVAL / R13 — lista de operações S1 por modelo (R07 R2 §3). Desenho completo para gpt-4o-mini, claude-haiku-5-5 e gemini-3.5-flash-lite:
 * 8 células × 24 prompts + 24 repetições = 216. Haiku 4.5, opção B (recomendada no R07 R2): perfil formal só em correção de código, análise e
 * geração de código (6 células: 144 + 18 repetições) e resumo vira COMPARATIVO pareado (2 grupos por célula de resumo, 3 variantes = 12
 * prompts, `split = COMPARATIVE`, fora de treino/validação/holdout) => 174. Opção A = completo (216). A opção C (só comparativo) não é
 * implementada aqui (NOT_IMPLEMENTED: a decisão é do Bruno e a recomendada é B). O mesmo prompt (hash) vai a todos os modelos: pareável.
 *
 * In English: turns the S1 corpus into the per-model list of S1 operations (one line of `s1_operations.<model>.jsonl`
 * per call). `FULL` sends every confirmatory prompt plus the repeats. `B_REDUZIDO` (reduced design) keeps the profile
 * only for the non-summary cells and turns 2 hash-chosen groups per summary cell into a paired comparative set outside
 * train/validation/holdout. The same prompt (same hash) goes to every model, so results are paired.
 * Called by `corpus/build.ts` and `corpus/manifest.ts`.
 *
 * @module scripts/h2eval/corpus/s1Plan
 */
import { buildS1 } from './s1Corpus.js';
import type { Split } from './split.js';
import { canonicalJson, sha256Hex } from './util.js';

/** Models that have an S1 design in this corpus generator. */
export type ModelId = 'gpt-4o-mini' | 'claude-haiku-4-5' | 'claude-haiku-5-5' | 'gemini-3.5-flash-lite';
/** S1 design: `FULL` (all cells) or `B_REDUZIDO` (reduced: summary cells become a paired comparative set). */
export type Design = 'FULL' | 'B_REDUZIDO';
/** Default design per model; part of `corpusSha256`. */
export const DEFAULT_DESIGNS: Readonly<Record<ModelId, Design>> = Object.freeze({ 'gpt-4o-mini': 'FULL', 'claude-haiku-4-5': 'B_REDUZIDO', 'claude-haiku-5-5': 'FULL', 'gemini-3.5-flash-lite': 'FULL' });

/** One planned S1 call; `rep` 1 is the repeat call of the same prompt, `inProfile` false means comparative only. */
export interface S1Operation { promptId: string; rep: 0 | 1; cellId: string; groupId: string; variant: number; split: Split | 'COMPARATIVE'; phase: 'CONFIRMATORY' | 'COMPARATIVE_PAIRED'; inProfile: boolean }
type S1 = ReturnType<typeof buildS1>;

/**
 * Lists the S1 operations one model makes under a design.
 *
 * @param s1 - The S1 corpus from `buildS1` (not mutated).
 * @param design - `FULL` or `B_REDUZIDO`.
 * @param opts - `comparativeGroupsPerCell`: groups per summary cell kept as comparative under `B_REDUZIDO` (default 2).
 * @returns Confirmatory (and comparative) base calls in corpus order, then the repeat calls.
 */
export function s1PlanFor(s1: S1, design: Design, opts: { comparativeGroupsPerCell?: number } = {}): S1Operation[] {
  const conf = s1.prompts.filter((p) => p.phase === 'CONFIRMATORY');
  const cmpPerCell = opts.comparativeGroupsPerCell ?? 2;
  const isSummary = (cell: string): boolean => cell.startsWith('summary-');
  const ops: S1Operation[] = [];
  const comparativeGroups = new Set<string>();
  if (design === 'B_REDUZIDO') {
    for (const cell of s1.cells.filter(isSummary)) {
      const groups = [...new Set(conf.filter((p) => p.cellId === cell).map((p) => p.groupId))];
      groups.sort((a, b) => { const ha = sha256Hex(`${s1.seed}|comparative|${cell}|${a}`); const hb = sha256Hex(`${s1.seed}|comparative|${cell}|${b}`); return ha < hb ? -1 : ha > hb ? 1 : a < b ? -1 : 1; });
      for (const g of groups.slice(0, cmpPerCell)) comparativeGroups.add(g);
    }
  }
  for (const p of conf) {
    if (design === 'B_REDUZIDO' && isSummary(p.cellId)) { if (comparativeGroups.has(p.groupId)) ops.push({ promptId: p.promptId, rep: 0, cellId: p.cellId, groupId: p.groupId, variant: p.variant, split: 'COMPARATIVE', phase: 'COMPARATIVE_PAIRED', inProfile: false }); continue; }
    ops.push({ promptId: p.promptId, rep: 0, cellId: p.cellId, groupId: p.groupId, variant: p.variant, split: p.split as Split, phase: 'CONFIRMATORY', inProfile: true });
  }
  const byId = new Map(conf.map((p) => [p.promptId, p]));
  for (const r of s1.repeats) { const p = byId.get(r.promptId)!; if (design === 'B_REDUZIDO' && isSummary(p.cellId)) continue; ops.push({ promptId: p.promptId, rep: 1, cellId: p.cellId, groupId: p.groupId, variant: p.variant, split: p.split as Split, phase: 'CONFIRMATORY', inProfile: true }); }
  return ops;
}

/** Per-model design summary in the manifest; `profileObservations`/`profileGroups` count base calls per split. */
export interface DesignSummary { design: Design; calls: number; profileObservations: Record<string, number>; profileGroups: Record<string, number>; comparativePrompts: number; repeats: number; opsSha256: string }

/**
 * Summarises a model's S1 operation list for the corpus manifest.
 *
 * @param ops - Operations from {@link s1PlanFor} (not mutated).
 * @param design - The design those operations came from.
 * @returns Call, profile, comparative and repeat counts plus `opsSha256` (SHA-256 of the canonical JSON of `ops`).
 */
export function summarizeDesign(ops: readonly S1Operation[], design: Design): DesignSummary {
  const obs: Record<string, number> = {}; const grp: Record<string, Set<string>> = {};
  for (const o of ops.filter((x) => x.inProfile && x.rep === 0)) { obs[o.split] = (obs[o.split] ?? 0) + 1; (grp[o.split] ??= new Set()).add(o.groupId); }
  return { design, calls: ops.length, profileObservations: obs, profileGroups: Object.fromEntries(Object.entries(grp).map(([k, v]) => [k, v.size])), comparativePrompts: ops.filter((o) => o.phase === 'COMPARATIVE_PAIRED').length, repeats: ops.filter((o) => o.rep === 1).length, opsSha256: sha256Hex(canonicalJson(ops)) };
}
