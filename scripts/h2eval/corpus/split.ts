/**
 * H2-EVAL / R13 — split por GRUPO (S1) ou DIÁLOGO (S2/S3) com alocação balanceada por célula (R09 §2).
 * Dentro de cada célula, ordena as unidades por sha256(semente|célula|índice) e atribui as primeiras a treino, depois validação,
 * depois holdout. Não usa nenhum dado de resultado. A atribuição é calculada uma vez e gravada no manifesto.
 *
 * In English: assigns train/validation/holdout per group (S1) or per dialog (S2/S3), balanced within each cell. Units
 * are ranked by a SHA-256 of seed, cell and index, and the first ones go to train, then validation, then holdout. No
 * result data is used. Called by `corpus/s1Corpus.ts` and `cache/dialogs.ts`.
 *
 * @module scripts/h2eval/corpus/split
 */
import { sha256Hex } from './util.js';

/** Data split of a group or dialog. */
export type Split = 'train' | 'validation' | 'holdout';

/** Number of units per split (non-negative integers). */
export interface SplitCounts { train: number; validation: number; holdout: number }

/**
 * Contagens por split. holdout = ceil(n·holdoutFrac) (arredonda para cima, como pede o R09 para S3); validation = round(n·valFrac);
 * o resto vai a treino. Garante soma = n e nunca deixa treino negativo.
 *
 * @param n - Number of units (integer >= 0).
 * @param fr - Holdout and validation fractions, each in [0, 1].
 * @returns Counts that add up to `n`.
 * @throws {RangeError} When `n` is not an integer >= 0.
 */
export function allocateCounts(n: number, fr: { holdoutFrac: number; valFrac: number }): SplitCounts {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n inválido');
  // epsilon: 15 × 0,2 = 3,0000000000000004 em ponto flutuante; sem ele ceil() daria 4
  const holdout = Math.min(n, Math.ceil(n * fr.holdoutFrac - 1e-9));
  const validation = Math.min(n - holdout, Math.round(n * fr.valFrac));
  return { train: n - holdout - validation, validation, holdout };
}

/** Split fractions for S1 groups. */
export const S1_FRACTIONS = Object.freeze({ holdoutFrac: 0.25, valFrac: 0.25 }); // 8 grupos -> 4/2/2
/** Split fractions for S2/S3 dialogs. */
export const DIALOG_FRACTIONS = Object.freeze({ holdoutFrac: 0.2, valFrac: 0.2 }); // 15 -> 9/3/3; 30 -> 18/6/6

/**
 * Ordem de atribuição: por sha256(semente|célula|índice). Devolve split por índice (0..n-1).
 *
 * @param seed - Corpus seed.
 * @param cellId - Cell label mixed into the hash.
 * @param n - Number of units in the cell.
 * @param fr - Holdout and validation fractions (see {@link allocateCounts}).
 * @returns The split of each unit, indexed 0..n-1.
 * @throws {RangeError} When `n` is not an integer >= 0.
 */
export function assignSplits(seed: number, cellId: string, n: number, fr: { holdoutFrac: number; valFrac: number }): Split[] {
  const c = allocateCounts(n, fr);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ha = sha256Hex(`${seed}|${cellId}|${a}`); const hb = sha256Hex(`${seed}|${cellId}|${b}`);
    return ha < hb ? -1 : ha > hb ? 1 : a - b;
  });
  const out: Split[] = new Array(n);
  order.forEach((idx, rank) => { out[idx] = rank < c.train ? 'train' : rank < c.train + c.validation ? 'validation' : 'holdout'; });
  return out;
}

/** C154 (R5): split por CONTAGENS explicitas (treino/validacao/holdout) em vez de fracoes; mesma permutacao semeada do assignSplits (ordem = ranking por hash).
 * n = soma das contagens; a atribuicao e por posicao no ranking: os primeiros `train` grupos sao treino, depois `validation`, depois `holdout`.
 *
 * Note: the ranking hash here is SHA-256(`seed|split|cell|index`), which differs from the one in {@link assignSplits},
 * so the permutation is seeded the same way but is not the same permutation.
 *
 * @param seed - Corpus seed.
 * @param cellId - Cell or dialog-arm label mixed into the hash.
 * @param c - Exact counts per split; their sum is the number of units.
 * @returns The split of each unit, indexed 0..n-1.
 * @throws {RangeError} When a count is not an integer >= 0.
 */
export function assignSplitsCounts(seed: number, cellId: string, c: SplitCounts): Split[] {
  for (const k of ['train', 'validation', 'holdout'] as const) if (!Number.isInteger(c[k]) || c[k] < 0) throw new RangeError(`split plan: ${cellId}.${k} invalido`);
  const n = c.train + c.validation + c.holdout; const out: Split[] = new Array(n);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => { const ha = sha256Hex(`${seed}|split|${cellId}|${a}`); const hb = sha256Hex(`${seed}|split|${cellId}|${b}`); return ha < hb ? -1 : ha > hb ? 1 : a - b; });
  order.forEach((idx, rank) => { out[idx] = rank < c.train ? 'train' : rank < c.train + c.validation ? 'validation' : 'holdout'; });
  return out;
}
