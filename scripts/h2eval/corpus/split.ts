/**
 * H2-EVAL / R13 — split por GRUPO (S1) ou DIÁLOGO (S2/S3) com alocação balanceada por célula (R09 §2).
 * Dentro de cada célula, ordena as unidades por sha256(semente|célula|índice) e atribui as primeiras a treino, depois validação,
 * depois holdout. Não usa nenhum dado de resultado. A atribuição é calculada uma vez e gravada no manifesto.
 */
import { sha256Hex } from './util.js';

export type Split = 'train' | 'validation' | 'holdout';

export interface SplitCounts { train: number; validation: number; holdout: number }

/**
 * Contagens por split. holdout = ceil(n·holdoutFrac) (arredonda para cima, como pede o R09 para S3); validation = round(n·valFrac);
 * o resto vai a treino. Garante soma = n e nunca deixa treino negativo.
 */
export function allocateCounts(n: number, fr: { holdoutFrac: number; valFrac: number }): SplitCounts {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n inválido');
  // epsilon: 15 × 0,2 = 3,0000000000000004 em ponto flutuante; sem ele ceil() daria 4
  const holdout = Math.min(n, Math.ceil(n * fr.holdoutFrac - 1e-9));
  const validation = Math.min(n - holdout, Math.round(n * fr.valFrac));
  return { train: n - holdout - validation, validation, holdout };
}

export const S1_FRACTIONS = Object.freeze({ holdoutFrac: 0.25, valFrac: 0.25 }); // 8 grupos -> 4/2/2
export const DIALOG_FRACTIONS = Object.freeze({ holdoutFrac: 0.2, valFrac: 0.2 }); // 15 -> 9/3/3; 30 -> 18/6/6

/** Ordem de atribuição: por sha256(semente|célula|índice). Devolve split por índice (0..n-1). */
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
 * n = soma das contagens; a atribuicao e por posicao no ranking: os primeiros `train` grupos sao treino, depois `validation`, depois `holdout`. */
export function assignSplitsCounts(seed: number, cellId: string, c: SplitCounts): Split[] {
  for (const k of ['train', 'validation', 'holdout'] as const) if (!Number.isInteger(c[k]) || c[k] < 0) throw new RangeError(`split plan: ${cellId}.${k} invalido`);
  const n = c.train + c.validation + c.holdout; const out: Split[] = new Array(n);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => { const ha = sha256Hex(`${seed}|split|${cellId}|${a}`); const hb = sha256Hex(`${seed}|split|${cellId}|${b}`); return ha < hb ? -1 : ha > hb ? 1 : a - b; });
  order.forEach((idx, rank) => { out[idx] = rank < c.train ? 'train' : rank < c.train + c.validation ? 'validation' : 'holdout'; });
  return out;
}
