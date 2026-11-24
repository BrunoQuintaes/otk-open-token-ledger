/**
 * E3G (C160 BRACO-GO; DR-205): the paid CALIBRATION arm Google + OpenAI of the scientific executor. Pure (node:fs/crypto only, no env, no network).
 * Scope: ONLY the two arm models below. Every rule here is a no-op for any other model (the Anthropic path and the legacy models are untouched).
 *   - google  gemini-3.1-flash-lite  Standard (DR-168 prices, DR-187 id, DR-194 tier declared by the author; no tier parameter exists in generateContent)
 *   - openai  gpt-6-luna             Standard (DR-208 prices + tier; service_tier "default" fixed in EVERY request, context <= 272k)
 * Fail-closed rules (runner, before anything is reserved or after the response, before the money is settled):
 *   A1 price: the executor's PriceTable must be the ATTESTED arm table (provenance per model) => otherwise STOP_ARM_PRICE_NOT_ATTESTED (nothing reserved);
 *   A2 ledger: one ledger PER PROVIDER (file ledger.<provider>.jsonl) with the named arm profile (provider US$ 1,00; the other providers 0; campaign 1,00) => otherwise STOP_ARM_LEDGER;
 *   A3 tier: served tier must be Standard (openai: response service_tier === "default", absent => STOP; google: usageMetadata.serviceTier absent => Standard by the
 *      author's declaration DR-194, present and not standard => STOP) => STOP_TIER_NOT_STANDARD (latching; the cost is NOT computed at the Standard price: UNKNOWN, possibly charged);
 *   A4 UNKNOWN never becomes 0 (unchanged engine: an unknown count or a null price keeps the cost UNKNOWN and the money possibly charged).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider } from '../types.js';
import type { PriceTable } from '../record/prices.js';
import { usdToPico } from './ledger.js';

export const E3G_ARM_VERSION = 'otk.h2eval.e3g_arm.v1';
export const E3G_ARM_MODELS = Object.freeze({ 'gemini-3.1-flash-lite': 'google', 'gpt-6-luna': 'openai' } as const);
export type E3GArmModel = keyof typeof E3G_ARM_MODELS;
export const isArmModel = (m: string): m is E3GArmModel => Object.prototype.hasOwnProperty.call(E3G_ARM_MODELS, m);
export const armProviderOf = (m: string): Provider | null => (isArmModel(m) ? E3G_ARM_MODELS[m] : null);

/** DR-205: US$ 1,00 per provider, separate accounting. The only arm profile values the runner accepts (named, never a free number). */
export const E3G_PROVIDER_CAP_USD = '1';
export const E3G_LEDGER_FILE = (p: Provider): string => `ledger.${p}.jsonl`;

/** A3: served-tier rule per arm provider (the request side is fixed in the adapters: openai service_tier="default"; google sends no tier parameter). */
export const E3G_TIER_RULE = Object.freeze({
  openai: Object.freeze({ requested: 'default', accepted: Object.freeze(['default']), absent: 'STOP' as const, basis: 'DR-208 literal C160Z (sha256 6ee16eeb...): Standard tier; service_tier "default" fixed in every request; the response service_tier must say "default"' }),
  google: Object.freeze({ requested: 'NONE', accepted: Object.freeze(['standard', 'STANDARD']), absent: 'AUTHOR_DECLARATION' as const, basis: 'DR-194 literal C160S item 6 (sha256 d519e5b5...): served only on Standard, risk accepted by the author; generateContent has no tier parameter' }),
});

export interface TierVerdict { ok: boolean; served: string; basis: 'RESPONSE_FIELD' | 'AUTHOR_DECLARATION_DR-194' | 'NOT_ARM'; reason: string | null }
/** A3. `served` is NormalizedUsageH2.serviceTierServed ('UNKNOWN' when the field is absent). */
export function servedTierVerdict(model: string, served: string | null | undefined): TierVerdict {
  const p = armProviderOf(model); const s = typeof served === 'string' && served !== '' ? served : 'UNKNOWN';
  if (p === null) return { ok: true, served: s, basis: 'NOT_ARM', reason: null };
  const rule = p === 'openai' ? E3G_TIER_RULE.openai : E3G_TIER_RULE.google;
  if (s === 'UNKNOWN') return rule.absent === 'AUTHOR_DECLARATION' ? { ok: true, served: s, basis: 'AUTHOR_DECLARATION_DR-194', reason: null } : { ok: false, served: s, basis: 'RESPONSE_FIELD', reason: 'SERVICE_TIER_ABSENT' };
  return (rule.accepted as readonly string[]).includes(s) ? { ok: true, served: s, basis: 'RESPONSE_FIELD', reason: null } : { ok: false, served: s.replace(/[^A-Za-z0-9_\-]/g, '?').slice(0, 32), basis: 'RESPONSE_FIELD', reason: 'SERVICE_TIER_NOT_STANDARD' };
}

// ------------------------------------------------------------------------------------------------------------------------------
// A1: attested price table (otk.h2eval.price_table.v1 + `attestation` per model)
// ------------------------------------------------------------------------------------------------------------------------------
export const E3G_PRICE_TABLE_PATH = fileURLToPath(new URL('../modal/pricing/price_table_h2eval_e3g_attested_v1.json', import.meta.url));
export interface ArmAttestation { attestedBy: string; decisionRecords: string[]; literals: Array<{ file: string; sha256: string }>; tier: string; note?: string }
/** Every price key a usage of the model can need (null = not applicable to that API; never "0"). */
const REQUIRED_KEYS: Readonly<Record<E3GArmModel, readonly string[]>> = Object.freeze({ 'gemini-3.1-flash-lite': ['input', 'output', 'cacheRead', 'reasoning'], 'gpt-6-luna': ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] });
export class ArmPriceTableError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); this.name = 'ArmPriceTableError'; } }

/** Validates the provenance of the attested arm table; refuses (throws) a model without attestation or with a missing required price. Returns the parsed table + sha256. */
export function validateArmPriceTable(buf: Buffer): { table: { schema: string; version: string; currency: string; capturedUtc: string; models: Record<string, { provider: string; attestation?: ArmAttestation; tiers: Array<{ id: string; prices: Record<string, string | null> }> }> }; sha256: string; attestedModels: E3GArmModel[] } {
  const table = JSON.parse(buf.toString('utf8'));
  if (table?.schema !== 'otk.h2eval.price_table.v1' || table.currency !== 'USD') throw new ArmPriceTableError('ARM_PRICE_TABLE_SCHEMA', 'schema/currency');
  const attested: E3GArmModel[] = [];
  for (const [m, pm] of Object.entries(table.models ?? {}) as Array<[string, { provider: string; attestation?: ArmAttestation; tiers: Array<{ id: string; prices: Record<string, string | null> }> }]>) {
    if (!isArmModel(m)) throw new ArmPriceTableError('ARM_PRICE_TABLE_FOREIGN_MODEL', m);
    if (pm.provider !== E3G_ARM_MODELS[m]) throw new ArmPriceTableError('ARM_PRICE_TABLE_PROVIDER', m);
    const a = pm.attestation;
    if (!a || !/^human:\S/.test(a.attestedBy ?? '') || !Array.isArray(a.decisionRecords) || !a.decisionRecords.length || !a.decisionRecords.every((d) => /^DR-\d+$/.test(d)) || !Array.isArray(a.literals) || !a.literals.length || !a.literals.every((l) => /^[0-9a-f]{64}$/.test(l.sha256 ?? '')) || a.tier !== 'STANDARD') throw new ArmPriceTableError('ARM_PRICE_NOT_ATTESTED', m);
    if (pm.tiers.length !== 1) throw new ArmPriceTableError('ARM_PRICE_TABLE_TIERS', `${m}: exactly one (Standard) tier`);
    for (const k of REQUIRED_KEYS[m]) { const v = pm.tiers[0]!.prices[k]; if (typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v)) throw new ArmPriceTableError('ARM_PRICE_MISSING', `${m}.${k}`); }
    attested.push(m);
  }
  return { table, sha256: createHash('sha256').update(buf).digest('hex'), attestedModels: attested };
}

/** A1 check used by the runner: the table is the attested arm table and covers the model. */
export function armPriceAttested(prices: PriceTable & { armAttestedModels?: readonly string[] }, model: string): boolean {
  return Array.isArray(prices.armAttestedModels) && prices.armAttestedModels.includes(model);
}

// ------------------------------------------------------------------------------------------------------------------------------
// A2: ledger separated per provider
// ------------------------------------------------------------------------------------------------------------------------------
export function armLedgerViolation(model: string, ledger: { campaignUsd: string; providersUsd: Record<Provider, string> }, ledgerPath: string | undefined): string | null {
  const p = armProviderOf(model); if (p === null) return null;
  const base = path.basename(ledgerPath ?? 'ledger.jsonl');
  if (base !== E3G_LEDGER_FILE(p)) return `LEDGER_FILE_NOT_PER_PROVIDER(${base})`;
  let ok = false;
  try { ok = usdToPico(ledger.campaignUsd) === usdToPico(E3G_PROVIDER_CAP_USD) && (['anthropic', 'openai', 'google'] as const).every((q) => usdToPico(ledger.providersUsd[q]) === (q === p ? usdToPico(E3G_PROVIDER_CAP_USD) : 0n)); } catch { ok = false; }
  return ok ? null : 'LEDGER_CAPS_NOT_ARM_PROFILE';
}

/** Provenance digest of the arm (for the G15 package / terminal). */
export function armSummary(): Record<string, unknown> {
  const buf = readFileSync(E3G_PRICE_TABLE_PATH);
  const v = validateArmPriceTable(buf);
  return { version: E3G_ARM_VERSION, models: E3G_ARM_MODELS, providerCapUsd: E3G_PROVIDER_CAP_USD, priceTable: { path: 'scripts/h2eval/modal/pricing/price_table_h2eval_e3g_attested_v1.json', sha256: v.sha256, attestedModels: v.attestedModels } };
}

// ------------------------------------------------------------------------------------------------------------------------------
// E3G2 (C160 BRACO-GO, ordem da master): Gemini que OMITE cachedContentTokenCount => liquidação pelo LIMITE SUPERIOR
// ------------------------------------------------------------------------------------------------------------------------------
export const CACHE_READ_EVIDENCE_UPPER_BOUND = 'ABSENT_FIELD_UPPER_BOUND' as const;
/**
 * Só para o modelo Google do braço e só no caso exato: `usageMetadata` presente, `cachedContentTokenCount` AUSENTE (chave inexistente; presente e inválido NÃO entra),
 * `promptTokenCount` inteiro >= 0 e o resto da contagem conhecido. Então toda a entrada vai ao preço CHEIO de entrada (cacheRead = 0 tokens a preço de cache,
 * inputUncached = promptTokenCount): o valor é >= ao real, porque o preço de cache read (0,025) < entrada (0,25). Qualquer outro campo ausente segue UNKNOWN.
 * Devolve a usage limitada (cópia) ou null (nada muda).
 */
export function googleCacheUpperBound<U extends { inputUncached: unknown; cacheRead: unknown; U: unknown }>(model: string, usage: U | null, responseBody: unknown): U | null {
  if (model !== 'gemini-3.1-flash-lite' || !usage) return null;
  if (usage.cacheRead !== 'UNKNOWN' || usage.inputUncached !== 'UNKNOWN') return null;
  const um = (responseBody && typeof responseBody === 'object' ? (responseBody as Record<string, unknown>)['usageMetadata'] : undefined) as Record<string, unknown> | undefined;
  if (!um || typeof um !== 'object' || Object.prototype.hasOwnProperty.call(um, 'cachedContentTokenCount')) return null;
  const p = um['promptTokenCount'];
  if (typeof p !== 'number' || !Number.isSafeInteger(p) || p < 0) return null;
  return { ...usage, inputUncached: p, cacheRead: 0, U: p };
}
/**
 * E3G4 (B4 do PROTO-GO v2): a usage que vai para o REGISTRO e o DATASET quando o limite superior vale. U = promptTokenCount (a entrada medida inteira,
 * que o Gemini informa mesmo sem a chave de cache); inputUncached e cacheRead SEGUEM UNKNOWN (a divisao nao e inventada) e a linha leva a marca
 * cacheReadEvidence ABSENT_FIELD_UPPER_BOUND. usageCompleteness vira COMPLETE so se todo o resto da contagem for conhecido; senao fica como estava.
 * O custo continua pelo limite (googleCacheUpperBound). Fora do caso exato (bounded null) nada muda.
 */
export function googleUpperBoundRecordUsage<U extends { U: unknown; usageCompleteness: string; cacheWrite5m: unknown; cacheWrite1h: unknown; cacheWrite: unknown; outputVisible: unknown; reasoning: unknown; imageUnits: unknown; audioUnits: unknown; toolTokens: unknown }>(usage: U, bounded: { U: unknown } | null): U {
  if (!bounded || typeof bounded.U !== 'number') return usage;
  const rest = [usage.cacheWrite5m, usage.cacheWrite1h, usage.cacheWrite, usage.outputVisible, usage.reasoning, usage.imageUnits, usage.audioUnits, usage.toolTokens];
  return { ...usage, U: bounded.U, usageCompleteness: rest.every((x) => x !== 'UNKNOWN') ? 'COMPLETE' : usage.usageCompleteness };
}

// ------------------------------------------------------------------------------------------------------------------------------
// EXEC-ECON delta 6 (DECISOES_MASTER_ECON; smoke ECON seq 2): gpt-6-luna que OMITE prompt_tokens_details.cache_write_tokens => LIMITE SUPERIOR
// ------------------------------------------------------------------------------------------------------------------------------
export const CACHE_WRITE_EVIDENCE_UPPER_BOUND = 'ABSENT_FIELD_UPPER_BOUND' as const;
/**
 * Só gpt-6-luna e só no caso exato: `usage` presente com `prompt_tokens` e `completion_tokens` inteiros >= 0 e a chave
 * `prompt_tokens_details.cache_write_tokens` AUSENTE (presente e inválida NÃO entra: segue UNKNOWN). O luna cobra a escrita de cache (0,125,
 * DR-208), o maior dos preços de entrada; cached/cache_write são subconjuntos de prompt_tokens. Então prompt_tokens INTEIRO ao preço da escrita
 * + completion_tokens ao preço de saída (= raciocínio, 0,50) é >= ao custo real para qualquer divisão. Devolve a usage do LIMITE (cópia, só
 * para o custo) ou null (nada muda). Qualquer outro campo ausente segue UNKNOWN.
 */
export function openaiCacheWriteUpperBound<U extends { cacheWrite: unknown; inputUncached: unknown; cacheRead: unknown; outputVisible: unknown; reasoning: unknown; U: unknown }>(model: string, usage: U | null, responseBody: unknown): U | null {
  if (model !== 'gpt-6-luna' || !usage) return null;
  if (usage.cacheWrite !== 'UNKNOWN') return null;
  const uo = (responseBody && typeof responseBody === 'object' ? (responseBody as Record<string, unknown>)['usage'] : undefined) as Record<string, unknown> | undefined;
  if (!uo || typeof uo !== 'object') return null;
  const p = uo['prompt_tokens']; const c = uo['completion_tokens'];
  if (typeof p !== 'number' || !Number.isSafeInteger(p) || p < 0 || typeof c !== 'number' || !Number.isSafeInteger(c) || c < 0) return null;
  const det = uo['prompt_tokens_details'];
  if (det !== undefined && det !== null && (typeof det !== 'object' || Object.prototype.hasOwnProperty.call(det, 'cache_write_tokens'))) return null;
  return { ...usage, inputUncached: 0, cacheRead: 0, cacheWrite: p, outputVisible: c, reasoning: 0, U: p };
}
