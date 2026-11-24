/**
 * H2-EVAL / R13 — classificador do braço de cache PELO OBSERVADO no usage (CONTRACT_MIN §4):
 *   HIT      = leitura de cache > 0
 *   CREATION = leitura 0 e escrita > 0
 *   NO_HIT   = leitura 0 e escrita 0 (ou escrita não aplicável/não reportada pela API)
 *   UNKNOWN  = o usage não permite decidir (campo ausente, inconsistente, resposta sem uso)
 * Nunca olha a diretiva do pedido nem o braço planejado para classificar; essas entradas só entram em `diagnose` e `resolveArm`
 * DEPOIS, para explicar e para registrar a mudança de braço. Campo ausente nunca vira 0, exceto a regra documentada do Gemini
 * (campo omitido sem cache, observado nas 3 chamadas da campanha da H1), que é sinalizada e pode ser desligada com `strictAbsent`.
 */
export type Provider = 'openai' | 'anthropic' | 'google';
export type Observed = 'HIT' | 'CREATION' | 'NO_HIT' | 'UNKNOWN';
export type Num = number | 'UNKNOWN' | 'NOT_APPLICABLE';

export interface CacheObservation {
  provider: Provider; observed: Observed;
  /** total de entrada normalizado (semântica por API, CONTRACT_MIN §4) */
  totalInput: Num; inputUncached: Num; cacheRead: Num; cacheWrite: Num; cacheWrite5m: Num; cacheWrite1h: Num;
  hitFraction: number | null; evidence: string[]; flags: string[];
}

export interface ClassifyOptions {
  /** Gemini: tratar campo cachedContentTokenCount ausente como UNKNOWN (padrão false = inferência documentada, com sinal) */
  strictAbsent?: boolean;
}

const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;
const obj = (x: unknown): Record<string, unknown> | null => (x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
const num = (x: unknown): Num => (isCount(x) ? x : 'UNKNOWN');

function decide(read: Num, write: Num): Observed {
  if (typeof read === 'number' && read > 0) return 'HIT';
  if (read === 'UNKNOWN') return 'UNKNOWN';
  // leitura = 0
  if (typeof write === 'number') return write > 0 ? 'CREATION' : 'NO_HIT';
  if (write === 'NOT_APPLICABLE') return 'NO_HIT';
  return 'UNKNOWN';
}

/** Classifica um objeto de uso cru (o `usage` do provedor, ou `usageMetadata` no Gemini) pelo que foi OBSERVADO. */
export function classifyCache(provider: Provider, rawUsage: unknown, opts: ClassifyOptions = {}): CacheObservation {
  const u = obj(rawUsage); const evidence: string[] = []; const flags: string[] = [];
  const blank = (): CacheObservation => ({ provider, observed: 'UNKNOWN', totalInput: 'UNKNOWN', inputUncached: 'UNKNOWN', cacheRead: 'UNKNOWN', cacheWrite: 'UNKNOWN', cacheWrite5m: 'UNKNOWN', cacheWrite1h: 'UNKNOWN', hitFraction: null, evidence: ['USAGE_MISSING'], flags: ['USAGE_MISSING'] });
  if (!u) return blank();

  if (provider === 'openai') {
    const prompt = num(u['prompt_tokens']); const d = obj(u['prompt_tokens_details']);
    const read: Num = d ? num(d['cached_tokens']) : 'UNKNOWN';
    if (d) evidence.push('usage.prompt_tokens_details.cached_tokens'); else flags.push('PROMPT_TOKENS_DETAILS_MISSING');
    if (typeof read === 'number' && typeof prompt === 'number' && read > prompt) { flags.push('CACHED_EXCEEDS_PROMPT'); return { ...blank(), evidence, flags, totalInput: prompt }; }
    if (typeof read === 'number' && read % 128 !== 0) flags.push('OPENAI_CACHED_NOT_MULTIPLE_OF_128'); // R08: arredondado para baixo a múltiplos de 128
    const write: Num = 'NOT_APPLICABLE'; // modelos anteriores ao GPT-5.6 não reportam escrita
    const observed = decide(read, write);
    const unc: Num = typeof prompt === 'number' && typeof read === 'number' ? prompt - read : 'UNKNOWN';
    return { provider, observed, totalInput: prompt, inputUncached: unc, cacheRead: read, cacheWrite: write, cacheWrite5m: 'NOT_APPLICABLE', cacheWrite1h: 'NOT_APPLICABLE', hitFraction: typeof read === 'number' && typeof prompt === 'number' && prompt > 0 ? read / prompt : null, evidence, flags };
  }

  if (provider === 'anthropic') {
    const inp = num(u['input_tokens']); const read = num(u['cache_read_input_tokens']); let write = num(u['cache_creation_input_tokens']);
    const cc = obj(u['cache_creation']); const w5 = cc ? num(cc['ephemeral_5m_input_tokens']) : 'UNKNOWN'; const w1 = cc ? num(cc['ephemeral_1h_input_tokens']) : 'UNKNOWN';
    if (read !== 'UNKNOWN') evidence.push('usage.cache_read_input_tokens'); else flags.push('CACHE_READ_FIELD_MISSING');
    if (write !== 'UNKNOWN') evidence.push('usage.cache_creation_input_tokens');
    if (write === 'UNKNOWN' && typeof w5 === 'number' && typeof w1 === 'number') { write = w5 + w1; evidence.push('usage.cache_creation.{ephemeral_5m,ephemeral_1h}'); }
    if (write === 'UNKNOWN') flags.push('CACHE_CREATION_FIELD_MISSING');
    if (typeof write === 'number' && typeof w5 === 'number' && typeof w1 === 'number' && w5 + w1 !== write) flags.push('CREATION_BREAKDOWN_MISMATCH');
    const observed = decide(read, write);
    if (observed === 'HIT' && typeof write === 'number' && write > 0) flags.push('HIT_WITH_WRITE');
    const total: Num = typeof inp === 'number' && typeof read === 'number' && typeof write === 'number' ? inp + read + write : 'UNKNOWN'; // input_tokens EXCLUI leitura e escrita
    return { provider, observed, totalInput: total, inputUncached: inp, cacheRead: read, cacheWrite: write, cacheWrite5m: w5, cacheWrite1h: w1, hitFraction: typeof read === 'number' && typeof total === 'number' && total > 0 ? read / total : null, evidence, flags };
  }

  // gemini
  const prompt = num(u['promptTokenCount']); let read: Num;
  if (isCount(u['cachedContentTokenCount'])) { read = u['cachedContentTokenCount'] as number; evidence.push('usageMetadata.cachedContentTokenCount'); }
  else if (typeof prompt === 'number' && Array.isArray(u['promptTokensDetails']) && !opts.strictAbsent) { read = 0; flags.push('READ_INFERRED_FROM_ABSENT_FIELD'); evidence.push('usageMetadata sem cachedContentTokenCount (campo omitido sem cache; observado na H1)'); }
  else { read = 'UNKNOWN'; flags.push('CACHED_CONTENT_FIELD_MISSING'); }
  const ctd = Array.isArray(u['cacheTokensDetails']) ? (u['cacheTokensDetails'] as unknown[]) : null;
  if (ctd && typeof read === 'number') { const s = ctd.reduce<number>((a, x) => a + (isCount(obj(x)?.['tokenCount']) ? (obj(x)!['tokenCount'] as number) : 0), 0); if (s !== read) flags.push('CACHE_DETAILS_MISMATCH'); }
  if (typeof read === 'number' && typeof prompt === 'number' && read > prompt) { flags.push('CACHED_EXCEEDS_PROMPT'); return { ...blank(), evidence, flags, totalInput: prompt }; }
  const write: Num = 'NOT_APPLICABLE'; // cache implícito: a API não reporta escrita
  const observed = decide(read, write);
  const unc: Num = typeof prompt === 'number' && typeof read === 'number' ? prompt - read : 'UNKNOWN';
  return { provider, observed, totalInput: prompt, inputUncached: unc, cacheRead: read, cacheWrite: write, cacheWrite5m: 'NOT_APPLICABLE', cacheWrite1h: 'NOT_APPLICABLE', hitFraction: typeof read === 'number' && typeof prompt === 'number' && prompt > 0 ? read / prompt : null, evidence, flags };
}

// ------------------------------------------------------------------ diagnóstico (explica; NÃO classifica)

export interface DiagnoseInput { cacheDirective: 'cache_control' | 'automatic' | 'none'; estimatedPrefixTokens?: number; minPrefixTokens?: number | null; partialToleranceTokens?: number }

/** Sinais extras a partir do plano + observado: marcação ignorada, prefixo abaixo do mínimo documentado, hit parcial. */
export function diagnose(plan: DiagnoseInput, obs: CacheObservation): string[] {
  const f: string[] = [];
  const tol = plan.partialToleranceTokens ?? 128;
  if (plan.cacheDirective === 'cache_control' && obs.observed === 'NO_HIT' && obs.cacheWrite === 0) {
    f.push('MARKED_BUT_NOT_APPLIED');
    if (typeof plan.estimatedPrefixTokens === 'number' && typeof plan.minPrefixTokens === 'number' && plan.estimatedPrefixTokens < plan.minPrefixTokens) f.push('PREFIX_BELOW_DOCUMENTED_MINIMUM');
  }
  if (plan.cacheDirective === 'none' && obs.observed === 'CREATION') f.push('CREATION_WITHOUT_DIRECTIVE');
  if (obs.observed === 'HIT' && typeof obs.cacheRead === 'number' && typeof plan.estimatedPrefixTokens === 'number' && obs.cacheRead + tol < plan.estimatedPrefixTokens) f.push('PARTIAL_HIT');
  return f;
}

// ------------------------------------------------------------------ braço final (nunca descarta)

export type PlannedArm = 'S1' | 'S2_NOHIT' | 'S3_HITATTEMPT';
export interface ArmResolution { planned: PlannedArm; observed: Observed; finalArm: string; changedFromPlan: boolean; controlContaminated: boolean; kept: true }

/**
 * O braço é o OBSERVADO. Chamada planejada com hit que não teve hit MUDA de braço (S3_NO_HIT/S3_CREATION); não é descartada.
 * Controle S2 com leitura de cache > 0 está CONTAMINADO: é registrado como tal e relatado, nunca reclassificado em silêncio.
 */
export function resolveArm(planned: PlannedArm, observed: Observed): ArmResolution {
  if (planned === 'S1') return { planned, observed, finalArm: observed === 'HIT' ? 'S1_HIT' : observed === 'CREATION' ? 'S1_CREATION' : observed === 'UNKNOWN' ? 'S1_UNKNOWN' : 'S1', changedFromPlan: observed === 'HIT' || observed === 'CREATION', controlContaminated: false, kept: true };
  if (planned === 'S2_NOHIT') {
    const fa = observed === 'NO_HIT' ? 'S2_NOHIT' : observed === 'HIT' ? 'S2_HIT_CONTAMINATED' : observed === 'CREATION' ? 'S2_CREATION' : 'S2_UNKNOWN';
    return { planned, observed, finalArm: fa, changedFromPlan: observed !== 'NO_HIT', controlContaminated: observed === 'HIT', kept: true };
  }
  const fa = observed === 'HIT' ? 'S3_HIT' : observed === 'CREATION' ? 'S3_CREATION' : observed === 'NO_HIT' ? 'S3_NO_HIT' : 'S3_UNKNOWN';
  return { planned, observed, finalArm: fa, changedFromPlan: observed !== 'HIT', controlContaminated: false, kept: true };
}

// ------------------------------------------------------------------ resumo por diálogo (entrada do planejador)

export interface DialogCacheSummary { calls: number; observed: Observed[]; hitEligibleCalls: number; hits: number; unknowns: number; firstCallObserved: Observed | null; mixedFlags: string[] }

/** Chamadas 2 e 3 são as elegíveis a hit (no máximo 2 por diálogo, R07). UNKNOWN fica fora da taxa e é contado à parte. */
export function summarizeDialog(observations: readonly CacheObservation[]): DialogCacheSummary {
  const el = observations.slice(1, 3);
  return { calls: observations.length, observed: observations.map((o) => o.observed), hitEligibleCalls: el.filter((o) => o.observed !== 'UNKNOWN').length, hits: el.filter((o) => o.observed === 'HIT').length, unknowns: observations.filter((o) => o.observed === 'UNKNOWN').length, firstCallObserved: observations[0]?.observed ?? null, mixedFlags: [...new Set(observations.flatMap((o) => o.flags))].sort() };
}
