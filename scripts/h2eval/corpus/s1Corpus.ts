/**
 * H2-EVAL / R13 — corpus S1 (uma mensagem): 8 células (4 tarefas × 2 tamanhos) × G grupos × V variantes (R07 §3.1).
 * Split por GRUPO, alocação balanceada por célula (R09 §2). Piloto = grupos próprios (phase PILOT, split NONE), fora da amostra.
 * 24 repetições (R07): 3 prompts por célula recebem uma 2ª chamada (rep 1); o prompt e o split são os mesmos.
 */
import { assertFreshSeed } from './seedGuard.js';
import { assignSplits, assignSplitsCounts, S1_FRACTIONS, type Split, type SplitCounts } from './split.js';
import { makeText, SIZES, TASKS, variantOf, type Size, type Task } from './s1Text.js';
import { hasLoneSurrogate, rngFor, sha256Hex } from './util.js';

export const S1_CORPUS_VERSION = 'otk.h2eval_corpus.v1';

export interface S1Prompt {
  promptId: string; cellId: string; groupId: string; variant: number; task: Task; size: Size;
  phase: 'CONFIRMATORY' | 'PILOT'; split: Split | 'NONE';
  text: string; textSha256: string; chars: number; rubric: Record<string, unknown>;
}

export interface S1Options {
  seed: number; groupsPerCell?: number; variantsPerGroup?: number; repeatsPerCell?: number;
  pilotCells?: readonly string[]; extraForbiddenSeeds?: readonly number[];
  /** C154 (R5): composicao EXPLICITA por celula (grupos por split); celula ausente ou com soma 0 NAO e gerada; grupos = soma das contagens (groupsPerCell ignorado nessas celulas) */
  splitPlanCells?: Readonly<Record<string, SplitCounts>>;
  /** C154 (R5): grupos de piloto por celula de piloto (padrao 1) */
  pilotGroupsPerCell?: number;
}

/** 6 células do piloto segregado (R07 §3.3: 6 chamadas S1 por modelo): uma por tarefa, tamanho S, mais resumo L e análise L. */
export const DEFAULT_PILOT_CELLS: readonly string[] = Object.freeze(['summary-S', 'code_fix-S', 'analysis-S', 'code_gen-S', 'summary-L', 'analysis-L']);

export const cellIdOf = (task: Task, size: Size): string => `${task}-${size}`;
export const CELL_IDS: readonly string[] = Object.freeze(TASKS.flatMap((t) => SIZES.map((s) => cellIdOf(t, s))));

export function buildS1(o: S1Options): { seed: number; prompts: S1Prompt[]; repeats: Array<{ promptId: string; rep: 1 }>; cells: string[] } {
  const seed = assertFreshSeed(o.seed, o.extraForbiddenSeeds ?? []);
  const G = o.groupsPerCell ?? 8; const V = o.variantsPerGroup ?? 3; const RPT = o.repeatsPerCell ?? 3;
  if (!Number.isInteger(G) || G < 1 || !Number.isInteger(V) || V < 1 || V > 3 || RPT < 0 || RPT > G) throw new RangeError('parâmetros de corpus inválidos (variantes: 1..3)');
  const prompts: S1Prompt[] = []; const repeats: Array<{ promptId: string; rep: 1 }> = [];
  const PG = o.pilotGroupsPerCell ?? 1; if (!Number.isInteger(PG) || PG < 1) throw new RangeError('pilotGroupsPerCell invalido');
  for (const task of TASKS) for (const size of SIZES) {
    const cell = cellIdOf(task, size);
    // C154: com split plan, a celula tem exatamente os grupos pedidos (0 = celula fora do corpus); sem ele, G grupos pelas fracoes de sempre
    const planned = o.splitPlanCells ? (o.splitPlanCells[cell] ?? { train: 0, validation: 0, holdout: 0 }) : null;
    const Gc = planned ? planned.train + planned.validation + planned.holdout : G; if (Gc === 0) continue;
    const splits = planned ? assignSplitsCounts(seed, `S1|${cell}`, planned) : assignSplits(seed, `S1|${cell}`, G, S1_FRACTIONS);
    for (let g = 0; g < Gc; g++) {
      const groupId = `${cell}-g${String(g).padStart(2, '0')}`;
      const base = makeText(task, size, rngFor(seed, 'S1', cell, `g${g}`));
      for (let v = 0; v < V; v++) {
        const text = variantOf(base.text, v);
        prompts.push({ promptId: `${groupId}-v${v}`, cellId: cell, groupId, variant: v, task, size, phase: 'CONFIRMATORY', split: splits[g]!, text, textSha256: sha256Hex(text), chars: text.length, rubric: base.rubric });
      }
    }
    // repetições: RPT grupos por célula, escolhidos por hash (nunca por resultado); a repetição é do prompt-base v0
    const order = Array.from({ length: Gc }, (_, g) => g).sort((a, b) => { const ha = sha256Hex(`${seed}|repeat|${cell}|${a}`); const hb = sha256Hex(`${seed}|repeat|${cell}|${b}`); return ha < hb ? -1 : ha > hb ? 1 : a - b; });
    for (const g of order.slice(0, Math.min(RPT, Gc)).sort((a, b) => a - b)) repeats.push({ promptId: `${cell}-g${String(g).padStart(2, '0')}-v0`, rep: 1 });
  }
  for (const cell of (o.pilotCells ?? DEFAULT_PILOT_CELLS)) {
    const [task, size] = cell.split('-') as [Task, Size];
    if (!TASKS.includes(task) || !SIZES.includes(size)) throw new RangeError(`célula de piloto desconhecida: ${cell}`);
    for (let g = 0; g < PG; g++) { // C154: PG grupos de piloto por celula (g0 e byte-identico ao de antes)
      const groupId = `PILOT-${cell}-g${String(g).padStart(2, '0')}`; const base = makeText(task, size, rngFor(seed, 'PILOT', cell, `g${g}`));
      prompts.push({ promptId: `${groupId}-v0`, cellId: cell, groupId, variant: 0, task, size, phase: 'PILOT', split: 'NONE', text: base.text, textSha256: sha256Hex(base.text), chars: base.text.length, rubric: base.rubric });
    }
  }
  for (const p of prompts) if (hasLoneSurrogate(p.text)) throw new Error(`surrogate isolado em ${p.promptId}`); // defeito F-OVN2-08 da H1: proibido aqui
  return { seed, prompts, repeats, cells: [...CELL_IDS] };
}
