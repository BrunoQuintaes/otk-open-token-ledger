/**
 * H2-EVAL / R13 — planejador do braço de cache pela taxa de hit do PILOTO segregado (R07 §3.2):
 *   D = ceil(30 / (2 · p_baixo)),  p_baixo = limite inferior de Wilson (80%) da taxa de hit medida no piloto,
 *   no máximo 2 chamadas de hit por diálogo (turnos 2 e 3); p_baixo < 0,3 => braço daquele modelo NOT_RUN (taxa registrada).
 * "Wilson 80%": o R07 não diz se é bilateral ou unilateral. Padrão aqui = bilateral 80% (z = 1,2816), que dá o p_baixo MENOR
 * (mais diálogos, mais conservador); `z` é parâmetro e a ambiguidade fica registrada no terminal (PENDING_HUMAN).
 * Nunca calcula taxa sem observações: attempts = 0 => INSUFFICIENT_PILOT (não é 0 nem 1).
 *
 * English summary: sizes the cache arm of each model from the hit rate measured in the segregated pilot. The number
 * of dialogs is D = ceil(30 / (2 * p_low)), where p_low is the lower Wilson bound (80%) of the pilot hit rate and each
 * dialog has at most 2 hit-eligible calls; below p_low = 0.3 the model's cache arm is NOT_RUN. The default is the
 * two-sided 80% bound (the more conservative reading of an ambiguous protocol); `z` is a parameter. A pilot with no
 * attempts gives INSUFFICIENT_PILOT, never a rate of 0 or 1. Pure functions; no I/O.
 *
 * @module scripts/h2eval/cache/planner
 */
/** z for a two-sided 80% interval (the default of {@link wilsonLower}). */
export const Z80_TWO_SIDED = 1.2815515655446004;
/** z for a one-sided 80% bound (gives a higher p_low, so fewer dialogs). */
export const Z80_ONE_SIDED = 0.8416212335729143;

/**
 * Lower bound of the Wilson score interval for a binomial proportion.
 *
 * @param hits - Number of hits, integer in [0, attempts].
 * @param attempts - Number of hit-eligible calls, integer of at least 1.
 * @param z - Normal quantile; default {@link Z80_TWO_SIDED}.
 * @returns The lower bound, clamped to at least 0.
 * @throws {RangeError} When the counts are not integers, attempts is below 1, or hits is outside [0, attempts].
 */
export function wilsonLower(hits: number, attempts: number, z: number = Z80_TWO_SIDED): number {
  if (!Number.isInteger(hits) || !Number.isInteger(attempts) || attempts < 1 || hits < 0 || hits > attempts) throw new RangeError('observações inválidas para Wilson');
  const p = hits / attempts; const z2 = z * z;
  const centre = p + z2 / (2 * attempts);
  const margin = z * Math.sqrt((p * (1 - p)) / attempts + z2 / (4 * attempts * attempts));
  return Math.max(0, (centre - margin) / (1 + z2 / attempts));
}

/**
 * Diálogos necessários para um p_baixo dado (a tabela do R07 usa p_baixo diretamente: 1,0→15; 0,7→22; 0,5→30; 0,3→50).
 *
 * @param pLower - Lower bound of the hit rate, above 0.
 * @param targetHits - Hits wanted in the arm (default 30).
 * @param maxHitsPerDialog - Hit-eligible calls per dialog (default 2).
 * @returns ceil(targetHits / (maxHitsPerDialog * pLower)), with a tiny tolerance for floating-point error.
 * @throws {RangeError} When `pLower` is not above 0.
 */
export function dialogsFor(pLower: number, targetHits = 30, maxHitsPerDialog = 2): number {
  if (!(pLower > 0)) throw new RangeError('p_baixo tem de ser > 0');
  return Math.ceil(targetHits / (maxHitsPerDialog * pLower) - 1e-9);
}

/** Pilot result of one model: hits among hit-eligible attempts. */
export interface PilotObservation { model: string; hits: number; attempts: number }
/**
 * Cache-arm plan of one model: status (`PLANNED`, `NOT_RUN` below the threshold, `INSUFFICIENT_PILOT` without
 * attempts), the pilot counts, the point rate `pHat` and its lower bound (`UNKNOWN` without attempts), the `z` used,
 * the number of dialogs and calls (`null` without attempts, 0 when NOT_RUN), whether `maxDialogs` capped the plan,
 * the formula as text and a note.
 */
export interface CachePlan {
  model: string; status: 'PLANNED' | 'NOT_RUN' | 'INSUFFICIENT_PILOT'; hits: number; attempts: number;
  pHat: number | 'UNKNOWN'; pLower: number | 'UNKNOWN'; z: number; dialogs: number | null; calls: number | null; cappedByLimit: boolean; formula: string; note: string;
}

/**
 * Options of {@link planCacheArm}; defaults: `z` two-sided 80%, `threshold` 0.3, `targetHits` 30, `maxHitsPerDialog`
 * 2, `callsPerDialog` 3, no `maxDialogs` cap.
 */
export interface PlanOptions { z?: number; threshold?: number; targetHits?: number; maxHitsPerDialog?: number; callsPerDialog?: number; maxDialogs?: number }

/**
 * Plans the cache arm of one model from its pilot observation.
 *
 * @param p - The pilot observation.
 * @param o - Planning options.
 * @returns The plan; a cap by `maxDialogs` is reported in `cappedByLimit` and `note`.
 * @throws {RangeError} When the pilot counts are invalid for the Wilson bound (for example hits above attempts).
 */
export function planCacheArm(p: PilotObservation, o: PlanOptions = {}): CachePlan {
  const z = o.z ?? Z80_TWO_SIDED; const thr = o.threshold ?? 0.3; const target = o.targetHits ?? 30; const mh = o.maxHitsPerDialog ?? 2; const cpd = o.callsPerDialog ?? 3;
  const formula = `D = ceil(${target} / (${mh} * p_baixo)); p_baixo = Wilson inferior (z=${z}); NOT_RUN se p_baixo < ${thr}`;
  if (p.attempts < 1) return { model: p.model, status: 'INSUFFICIENT_PILOT', hits: p.hits, attempts: p.attempts, pHat: 'UNKNOWN', pLower: 'UNKNOWN', z, dialogs: null, calls: null, cappedByLimit: false, formula, note: 'piloto sem tentativas de hit observadas: taxa desconhecida (não é 0)' };
  const pHat = p.hits / p.attempts; const pLower = wilsonLower(p.hits, p.attempts, z);
  if (pLower < thr) return { model: p.model, status: 'NOT_RUN', hits: p.hits, attempts: p.attempts, pHat, pLower, z, dialogs: 0, calls: 0, cappedByLimit: false, formula, note: 'braço de cache NOT_RUN para este modelo; a taxa observada fica registrada' };
  let d = dialogsFor(pLower, target, mh); let capped = false;
  if (o.maxDialogs !== undefined && d > o.maxDialogs) { d = o.maxDialogs; capped = true; }
  return { model: p.model, status: 'PLANNED', hits: p.hits, attempts: p.attempts, pHat, pLower, z, dialogs: d, calls: d * cpd, cappedByLimit: capped, formula, note: capped ? 'limitado por maxDialogs (decisão humana/orçamento): a meta de hits pode não ser atingida' : 'ok' };
}

/**
 * Tabela do R07 para conferência (p_baixo → diálogos, chamadas).
 *
 * Reference table of the protocol (p_low to dialogs and calls), used to cross-check {@link dialogsFor}.
 */
export const R07_TABLE: ReadonlyArray<{ pLower: number; dialogs: number; calls: number }> = Object.freeze([
  { pLower: 1.0, dialogs: 15, calls: 45 }, { pLower: 0.7, dialogs: 22, calls: 66 }, { pLower: 0.5, dialogs: 30, calls: 90 }, { pLower: 0.3, dialogs: 50, calls: 150 },
]);
