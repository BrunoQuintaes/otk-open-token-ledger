/**
 * H2-EVAL / R13 — lista de operações S1 por modelo (R07 R2 §3). Desenho completo para gpt-4o-mini, claude-haiku-5-5 e gemini-3.5-flash-lite:
 * 8 células × 24 prompts + 24 repetições = 216. Haiku 4.5, opção B (recomendada no R07 R2): perfil formal só em correção de código, análise e
 * geração de código (6 células: 144 + 18 repetições) e resumo vira COMPARATIVO pareado (2 grupos por célula de resumo, 3 variantes = 12
 * prompts, `split = COMPARATIVE`, fora de treino/validação/holdout) => 174. Opção A = completo (216). A opção C (só comparativo) não é
 * implementada aqui (NOT_IMPLEMENTED: a decisão é do Bruno e a recomendada é B). O mesmo prompt (hash) vai a todos os modelos: pareável.
 */
import { buildS1 } from './s1Corpus.js';
import type { Split } from './split.js';
import { canonicalJson, sha256Hex } from './util.js';

export type ModelId = 'gpt-4o-mini' | 'claude-haiku-4-5' | 'claude-haiku-5-5' | 'gemini-3.5-flash-lite';
export type Design = 'FULL' | 'B_REDUZIDO';
export const DEFAULT_DESIGNS: Readonly<Record<ModelId, Design>> = Object.freeze({ 'gpt-4o-mini': 'FULL', 'claude-haiku-4-5': 'B_REDUZIDO', 'claude-haiku-5-5': 'FULL', 'gemini-3.5-flash-lite': 'FULL' });

export interface S1Operation { promptId: string; rep: 0 | 1; cellId: string; groupId: string; variant: number; split: Split | 'COMPARATIVE'; phase: 'CONFIRMATORY' | 'COMPARATIVE_PAIRED'; inProfile: boolean }
type S1 = ReturnType<typeof buildS1>;

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

export interface DesignSummary { design: Design; calls: number; profileObservations: Record<string, number>; profileGroups: Record<string, number>; comparativePrompts: number; repeats: number; opsSha256: string }

export function summarizeDesign(ops: readonly S1Operation[], design: Design): DesignSummary {
  const obs: Record<string, number> = {}; const grp: Record<string, Set<string>> = {};
  for (const o of ops.filter((x) => x.inProfile && x.rep === 0)) { obs[o.split] = (obs[o.split] ?? 0) + 1; (grp[o.split] ??= new Set()).add(o.groupId); }
  return { design, calls: ops.length, profileObservations: obs, profileGroups: Object.fromEntries(Object.entries(grp).map(([k, v]) => [k, v.size])), comparativePrompts: ops.filter((o) => o.phase === 'COMPARATIVE_PAIRED').length, repeats: ops.filter((o) => o.rep === 1).length, opsSha256: sha256Hex(canonicalJson(ops)) };
}
