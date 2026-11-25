/**
 * EXEC-ECON C160 delta 2 (R2 do G15 797ff7b0): GO do estudo econômico, schema `h2eval.go.econ.v1`. Assinatura: agente EXEC-ECON C160.
 *
 * Por que um schema próprio: o GO single (h2eval.go.v1) exige um modelo por lote e só os perfis nomeados de GO; o multi (h2eval.go.multi.v1)
 * tem teto de 1 446 tentativas, G17 por modelo e nonce por lote. O ECON tem 4 800 tentativas, 5 modelos misturados por bloco e o perfil de
 * ledger ECON (132/95/11/28). Os dois validadores existentes NÃO mudam (o perfil ECON continua fora de CAPS_PROFILES: nenhum deles o aceita).
 *
 * O GO ECON é finito e só cobre o ECON:
 *   escopo   = provedores e modelos (subconjunto dos 5 do estudo), faixa de seq [seqFrom, seqTo] do CRONOGRAMA (sha fixado), maxAttempts;
 *   lotes    = os blocos dessa faixa (o lote é o bloco do cronograma);
 *   teto     = EXATAMENTE o perfil ECON por provedor e agregado (= o ledger efetivo), pausa em 0,8;
 *   validade = janela UTC finita (no máximo GO_ECON_MAX_WINDOW_MS) e já começada;
 *   identidade = executor (SHA de árvore limpa), pré-registro, cronograma, timeout pré-registrado, estado do G-7b, campanha;
 *   assinatura humana + digest canônico; paradas obrigatórias.
 * Puro (sem I/O, sem env, sem rede). Devolve null quando válido, senão o primeiro código (nenhum valor do GO é ecoado).
 *
 * In English: validator of the signed GO file (the human authorisation to spend) for the economic study,
 * schema `h2eval.go.econ.v1`. A GO is finite: a scope (providers, models, a sequence range of the schedule, a maximum
 * number of attempts), spending caps that must equal the effective ledger caps and stay inside the economic envelope,
 * a finite UTC validity window already started, the executor and pre-registration identities, the mandatory stops,
 * a human signature and a canonical digest. Pure: no I/O, no environment, no network. Each check returns the first
 * failing code and never echoes GO values. Called by `scripts/h2eval/econ/econ.ts` at the start of collection and again
 * before every attempt.
 *
 * @module scripts/h2eval/econ/goEcon
 */
import { sha256Canon } from '../core/canon.js';
import { capsWithinEconEnvelope, usdToPico } from '../core/ledger.js';
import { GO_REQUIRED_STOPS } from '../core/egress.js';
import type { Provider } from '../types.js';

/** Schema id of the economic-study GO file. */
export const GO_ECON_SCHEMA = 'h2eval.go.econ.v1';
/** Janela máxima: a coleta é serial (4 800 tentativas, timeout de 600 s); 7 dias é o limite superior finito. Parâmetro do validador, não do GO. */
export const GO_ECON_MAX_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Stop codes a GO must list: the general required stops plus `STOP_ECON_ORDER`. */
export const GO_ECON_REQUIRED_STOPS: readonly string[] = Object.freeze([...GO_REQUIRED_STOPS, 'STOP_ECON_ORDER']);
const ECON_PROVIDERS: Readonly<Record<string, Provider>> = Object.freeze({ 'claude-sonnet-5': 'anthropic', 'claude-opus-5-5': 'anthropic', 'claude-haiku-5-5': 'anthropic', 'gpt-6-luna': 'openai', 'gemini-3.1-flash-lite': 'google' });

/**
 * Content of a GO file. Money values (`caps`) are decimal USD as string or number; `pauseAtFractionOfSubLedger` must be
 * 0.8; `scope.seqFrom`/`seqTo` are inclusive positions in the schedule; `signedBy` and `acknowledgedBy` start with
 * `human:`; `goDigestSha256` is the canonical SHA-256 of all other fields.
 */
export interface GoEconV1 {
  schema: typeof GO_ECON_SCHEMA; campaign: string; studyId: string;
  preregistrationSha256: string; executorCodeSha: string; cronogramaSha256: string; timeoutMs: number; g7bEstado: 'ABERTO' | 'LIMITA' | 'NAO_LIMITA';
  capsProfile: 'econ_dr277';
  caps: { perProviderSubLedgerUsd: Record<Provider, string | number>; globalCampaignUsd: string | number; pauseAtFractionOfSubLedger: number };
  scope: { providers: Provider[]; modelIds: string[]; seqFrom: number; seqTo: number; maxAttempts: number };
  window: { notBeforeUtc: string; notAfterUtc: string };
  pauseAck80pct?: Partial<Record<Provider, { acknowledgedBy: string; atUtc: string }>>;
  /** delta 7 (opção (c)): sha canônico da reserva do painel pela medida, quando em uso (ausente = sem a reserva) */
  reservaPainelSha256?: string;
  stops: string[]; signedBy: string; signatureStatement: string; goDigestSha256: string;
}
/**
 * What the executor knows and the GO must match: identities, schedule hash and length, timeout (ms), effective ledger
 * caps (decimal USD strings), the current time `nowMs` (ms since epoch) and `treeClean` (`null` = unknown, refused).
 */
export interface GoEconContext {
  campaign: string; studyId: string; preregistrationSha256: string | undefined; executorCodeSha: string; treeClean: boolean | null;
  cronogramaSha256: string; cronogramaLength: number; timeoutMs: number; g7bEstado: string;
  ledgerCaps: { campaignUsd: string; providersUsd: Record<Provider, string> }; nowMs: number;
  /** delta 7: reserva do painel em uso no executor (sha canônico) ou null/ausente */
  reservaPainelSha256?: string | null;
}
const picoOf = (v: unknown): bigint | null => { try { return typeof v === 'number' || typeof v === 'string' ? usdToPico(String(v)) : null; } catch { return null; } };
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validação do arquivo inteiro (no início da coleta e de novo em cada tentativa).
 *
 * @param text - Raw text of the GO file; leftover `<placeholder>` text is refused before parsing.
 * @param ctx - Executor facts to match.
 * @returns `null` when the GO is valid; otherwise the first failing code (for example `GO_SCHEMA`, `GO_CAPS_MISMATCH`,
 *   `GO_EXPIRED`, `GO_UNSIGNED`, `GO_DIGEST_MISMATCH`). Never throws for bad input.
 */
export function validateGoEconV1(text: string, ctx: GoEconContext): string | null {
  if (/<[^<>\n]{1,120}>/.test(text)) return 'GO_PLACEHOLDER_LEFT';
  let go: GoEconV1; try { go = JSON.parse(text) as GoEconV1; } catch { return 'GO_FILE_INVALID'; }
  if (!go || typeof go !== 'object' || go.schema !== GO_ECON_SCHEMA) return 'GO_SCHEMA';
  if (go.campaign !== ctx.campaign || go.studyId !== ctx.studyId) return 'GO_CAMPAIGN_MISMATCH';
  if (!ctx.preregistrationSha256) return 'GO_PREREG_UNCONFIGURED';
  if (!HEX64.test(go.preregistrationSha256 ?? '') || go.preregistrationSha256 !== ctx.preregistrationSha256) return 'GO_PREREG_MISMATCH';
  if (typeof go.executorCodeSha !== 'string' || go.executorCodeSha !== ctx.executorCodeSha) return 'GO_EXECUTOR_MISMATCH';
  if (ctx.treeClean !== true) return 'GO_EXECUTOR_TREE_DIRTY';
  if (!HEX64.test(go.cronogramaSha256 ?? '') || go.cronogramaSha256 !== ctx.cronogramaSha256) return 'GO_CRONOGRAMA_MISMATCH';
  if (go.timeoutMs !== ctx.timeoutMs) return 'GO_TIMEOUT_MISMATCH';
  if (go.g7bEstado !== ctx.g7bEstado) return 'GO_G7B_MISMATCH';
  // delta 7: o parâmetro da reserva do painel é explícito no GO e tem de ser o mesmo do executor (ou ausente nos dois)
  if ((go.reservaPainelSha256 ?? null) !== (ctx.reservaPainelSha256 ?? null)) return 'GO_RESERVA_PAINEL_MISMATCH';
  // teto (delta 7b, X1 v3.5 R2): o GO declara os tetos do AUTOR, dentro do envelope ECON da DR-277 (cada sub-teto <= 95/11/28, agregado <= 132,
  // todos > 0), e eles têm de ser EXATAMENTE os do ledger efetivo. Nenhum valor acima do envelope; nenhum ledger diferente do GO.
  if (go.capsProfile !== 'econ_dr277' || !go.caps || go.caps.pauseAtFractionOfSubLedger !== 0.8) return 'GO_CAPS';
  let effCampaign: bigint; const effP = {} as Record<'anthropic' | 'openai' | 'google', bigint>;
  try { effCampaign = usdToPico(ctx.ledgerCaps.campaignUsd); for (const p of ['anthropic', 'openai', 'google'] as const) effP[p] = usdToPico(ctx.ledgerCaps.providersUsd[p]); } catch { return 'GO_CAPS_MISMATCH'; }
  if (picoOf(go.caps.globalCampaignUsd) !== effCampaign) return 'GO_CAPS_MISMATCH';
  for (const p of ['anthropic', 'openai', 'google'] as const) if (picoOf(go.caps.perProviderSubLedgerUsd?.[p]) !== effP[p]) return 'GO_CAPS_MISMATCH';
  if (!capsWithinEconEnvelope(effCampaign, effP)) return 'GO_CAPS_MISMATCH';
  // escopo finito: modelos do estudo, provedores coerentes, faixa de seq dentro do cronograma, maxAttempts <= tamanho da faixa
  const s = go.scope;
  if (!s || !Array.isArray(s.providers) || !s.providers.length || !Array.isArray(s.modelIds) || !s.modelIds.length || new Set(s.modelIds).size !== s.modelIds.length || new Set(s.providers).size !== s.providers.length) return 'GO_SCOPE_INVALID';
  if (s.modelIds.some((m) => typeof m !== 'string' || /[*?]|^all$/i.test(m) || ECON_PROVIDERS[m] === undefined)) return 'GO_MODEL_NOT_ECON';
  if (s.providers.some((p) => !['anthropic', 'openai', 'google'].includes(p)) || s.modelIds.some((m) => !s.providers.includes(ECON_PROVIDERS[m]!)) || s.providers.some((p) => !s.modelIds.some((m) => ECON_PROVIDERS[m] === p))) return 'GO_SCOPE_INVALID';
  if (!Number.isInteger(s.seqFrom) || !Number.isInteger(s.seqTo) || s.seqFrom < 0 || s.seqTo < s.seqFrom || s.seqTo >= ctx.cronogramaLength) return 'GO_SEQ_RANGE';
  if (!Number.isInteger(s.maxAttempts) || s.maxAttempts < 1 || s.maxAttempts > s.seqTo - s.seqFrom + 1) return 'GO_MAX_ATTEMPTS';
  // validade
  if (!go.window) return 'GO_WINDOW';
  const nb = Date.parse(go.window.notBeforeUtc); const na = Date.parse(go.window.notAfterUtc);
  if (!Number.isFinite(nb) || !Number.isFinite(na) || nb > ctx.nowMs) return 'GO_NOT_YET_VALID';
  if (na <= ctx.nowMs) return 'GO_EXPIRED';
  if (na - nb > GO_ECON_MAX_WINDOW_MS) return 'GO_WINDOW_TOO_LONG';
  if (!Array.isArray(go.stops) || GO_ECON_REQUIRED_STOPS.some((x) => !go.stops.includes(x))) return 'GO_STOPS_INCOMPLETE';
  if (go.pauseAck80pct !== undefined) { if (typeof go.pauseAck80pct !== 'object' || go.pauseAck80pct === null) return 'GO_PAUSE_ACK_INVALID'; for (const v of Object.values(go.pauseAck80pct)) if (!v || !/^human:\S.*$/.test(String(v.acknowledgedBy))) return 'GO_PAUSE_ACK_INVALID'; }
  if (typeof go.signedBy !== 'string' || !/^human:\S.*$/.test(go.signedBy)) return 'GO_UNSIGNED';
  if (typeof go.signatureStatement !== 'string' || go.signatureStatement.length < 20) return 'GO_UNSIGNED';
  const { goDigestSha256, ...rest } = go;
  if (typeof goDigestSha256 !== 'string' || sha256Canon(rest) !== goDigestSha256) return 'GO_DIGEST_MISMATCH';
  return null;
}

/**
 * Por tentativa (o GO já validado): a tentativa está no escopo e o orçamento de tentativas não acabou.
 *
 * @param go - A GO already accepted by {@link validateGoEconV1}.
 * @param a - The attempt: schedule position, provider, model and attempts already sent in this scope.
 * @returns `null` when covered; otherwise `GO_SEQ_NOT_IN_SCOPE`, `GO_PROVIDER_OR_MODEL_NOT_IN_SCOPE` or
 *   `GO_MAX_ATTEMPTS_REACHED`.
 */
export function goEconCoversAttempt(go: GoEconV1, a: { seq: number; provider: Provider; model: string; attemptsSentInScope: number }): string | null {
  const s = go.scope;
  if (a.seq < s.seqFrom || a.seq > s.seqTo) return 'GO_SEQ_NOT_IN_SCOPE';
  if (!s.providers.includes(a.provider) || !s.modelIds.includes(a.model)) return 'GO_PROVIDER_OR_MODEL_NOT_IN_SCOPE';
  if (a.attemptsSentInScope >= s.maxAttempts) return 'GO_MAX_ATTEMPTS_REACHED';
  return null;
}
