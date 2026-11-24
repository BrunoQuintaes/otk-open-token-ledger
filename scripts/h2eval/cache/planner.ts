/**
 * H2-EVAL / R13 — planejador do braço de cache pela taxa de hit do PILOTO segregado (R07 §3.2):
 *   D = ceil(30 / (2 · p_baixo)),  p_baixo = limite inferior de Wilson (80%) da taxa de hit medida no piloto,
 *   no máximo 2 chamadas de hit por diálogo (turnos 2 e 3); p_baixo < 0,3 => braço daquele modelo NOT_RUN (taxa registrada).
 * "Wilson 80%": o R07 não diz se é bilateral ou unilateral. Padrão aqui = bilateral 80% (z = 1,2816), que dá o p_baixo MENOR
 * (mais diálogos, mais conservador); `z` é parâmetro e a ambiguidade fica registrada no terminal (PENDING_HUMAN).
 * Nunca calcula taxa sem observações: attempts = 0 => INSUFFICIENT_PILOT (não é 0 nem 1).
 */
export const Z80_TWO_SIDED = 1.2815515655446004;
export const Z80_ONE_SIDED = 0.8416212335729143;

export function wilsonLower(hits: number, attempts: number, z: number = Z80_TWO_SIDED): number {
  if (!Number.isInteger(hits) || !Number.isInteger(attempts) || attempts < 1 || hits < 0 || hits > attempts) throw new RangeError('observações inválidas para Wilson');
  const p = hits / attempts; const z2 = z * z;
  const centre = p + z2 / (2 * attempts);
  const margin = z * Math.sqrt((p * (1 - p)) / attempts + z2 / (4 * attempts * attempts));
  return Math.max(0, (centre - margin) / (1 + z2 / attempts));
}

/** Diálogos necessários para um p_baixo dado (a tabela do R07 usa p_baixo diretamente: 1,0→15; 0,7→22; 0,5→30; 0,3→50). */
export function dialogsFor(pLower: number, targetHits = 30, maxHitsPerDialog = 2): number {
  if (!(pLower > 0)) throw new RangeError('p_baixo tem de ser > 0');
  return Math.ceil(targetHits / (maxHitsPerDialog * pLower) - 1e-9);
}

export interface PilotObservation { model: string; hits: number; attempts: number }
export interface CachePlan {
  model: string; status: 'PLANNED' | 'NOT_RUN' | 'INSUFFICIENT_PILOT'; hits: number; attempts: number;
  pHat: number | 'UNKNOWN'; pLower: number | 'UNKNOWN'; z: number; dialogs: number | null; calls: number | null; cappedByLimit: boolean; formula: string; note: string;
}

export interface PlanOptions { z?: number; threshold?: number; targetHits?: number; maxHitsPerDialog?: number; callsPerDialog?: number; maxDialogs?: number }

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

/** Tabela do R07 para conferência (p_baixo → diálogos, chamadas). */
export const R07_TABLE: ReadonlyArray<{ pLower: number; dialogs: number; calls: number }> = Object.freeze([
  { pLower: 1.0, dialogs: 15, calls: 45 }, { pLower: 0.7, dialogs: 22, calls: 66 }, { pLower: 0.5, dialogs: 30, calls: 90 }, { pLower: 0.3, dialogs: 50, calls: 150 },
]);
