/**
 * Model/API/tokenizer catalog (D4 §4–5, D4-G03; front B). Implements ResolveModelSupportFn.
 *
 * Support levels (never upgraded by guessing):
 *  - exact            catalogued model whose provider documents the tokenizer we ship
 *                     (OpenAI o200k_base / cl100k_base as mapped by tiktoken's model table);
 *  - alias_known      explicitly listed dated snapshot of an exact entry;
 *  - generic_fallback provider/API known, but the local tokenizer is an approximation
 *                     (Anthropic, Gemini, DeepSeek, Mistral, Cohere have their own tokenizers;
 *                     an OpenAI-compatible wire format does not make the encoding identical),
 *                     or an unlisted id of a known OpenAI family;
 *  - unsupported      provider unknown, or api not offered by that provider.
 *
 * The catalog decides only tokenizer coverage for the auxiliary counter. CU weights come from
 * the signed weights table (cuWeightsV2.ts) and prices from price tables; a model can be
 * unsupported here and still be metered, or the reverse.
 */
import type { ModelSupport, SupportLevel, UsageApi } from '../../types/d1d8/index.js';
import { loadEncoding, type LocalEncoding } from '../../tokenization/tokenizerIdentity.js';

export const MODEL_CATALOG_VERSION = 'otk.model_catalog.v1@2026-09-30';

/** Which APIs each provider exposes in the declared text scope. */
export const PROVIDER_APIS: Readonly<Record<string, readonly UsageApi[]>> = Object.freeze({
  openai: ['openai.chat_completions', 'openai.responses'],
  anthropic: ['anthropic.messages'],
  gemini: ['gemini.generate_content'],
  deepseek: ['deepseek.chat_completions'],
  mistral: ['mistral.chat_completions'],
  cohere: ['cohere.chat'],
});

interface ExactEntry {
  encoding: LocalEncoding;
  /** Explicit dated snapshots that are the same model (tested one by one). */
  aliases: readonly string[];
}

/**
 * OpenAI entries. Encodings follow tiktoken's model table as shipped in js-tiktoken 1.0.21
 * (`getEncodingNameForModel`); a unit test checks every id here against that table.
 */
const OPENAI_EXACT: Readonly<Record<string, ExactEntry>> = Object.freeze({
  'gpt-4o': { encoding: 'o200k_base', aliases: ['gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'] },
  'gpt-4o-mini': { encoding: 'o200k_base', aliases: ['gpt-4o-mini-2024-07-18'] },
  'gpt-4.1': { encoding: 'o200k_base', aliases: ['gpt-4.1-2025-04-14'] },
  'gpt-4.1-mini': { encoding: 'o200k_base', aliases: ['gpt-4.1-mini-2025-04-14'] },
  'gpt-4.1-nano': { encoding: 'o200k_base', aliases: ['gpt-4.1-nano-2025-04-14'] },
  'gpt-5': { encoding: 'o200k_base', aliases: ['gpt-5-2025-08-07'] },
  'gpt-5-mini': { encoding: 'o200k_base', aliases: ['gpt-5-mini-2025-08-07'] },
  'gpt-5-nano': { encoding: 'o200k_base', aliases: ['gpt-5-nano-2025-08-07'] },
  o1: { encoding: 'o200k_base', aliases: ['o1-2024-12-17'] },
  'o1-mini': { encoding: 'o200k_base', aliases: ['o1-mini-2024-09-12'] },
  o3: { encoding: 'o200k_base', aliases: ['o3-2025-04-16'] },
  'o3-mini': { encoding: 'o200k_base', aliases: ['o3-mini-2025-01-31'] },
  'o4-mini': { encoding: 'o200k_base', aliases: ['o4-mini-2025-04-16'] },
  'gpt-4-turbo': { encoding: 'cl100k_base', aliases: ['gpt-4-turbo-2024-04-09'] },
  'gpt-4': { encoding: 'cl100k_base', aliases: ['gpt-4-0613'] },
  'gpt-3.5-turbo': { encoding: 'cl100k_base', aliases: ['gpt-3.5-turbo-0125'] },
});

/** Unlisted ids that start with a known family prefix get that family's encoding, as fallback. */
const OPENAI_FAMILY_PREFIXES: ReadonlyArray<[string, LocalEncoding]> = [
  ['gpt-5', 'o200k_base'],
  ['gpt-4.1', 'o200k_base'],
  ['gpt-4o', 'o200k_base'],
  ['o4', 'o200k_base'],
  ['o3', 'o200k_base'],
  ['o1', 'o200k_base'],
  ['gpt-4', 'cl100k_base'],
  ['gpt-3.5', 'cl100k_base'],
];

/**
 * Providers whose own tokenizer is not shipped here. The counter uses cl100k_base as an
 * explicitly approximate encoding; its reports stay uncalibrated until a calibration exists.
 */
const APPROXIMATE_PROVIDERS: Readonly<Record<string, LocalEncoding>> = Object.freeze({
  anthropic: 'cl100k_base',
  gemini: 'cl100k_base',
  deepseek: 'cl100k_base',
  mistral: 'cl100k_base',
  cohere: 'cl100k_base',
});

const OPENAI_ALIAS_TO_KEY: ReadonlyMap<string, string> = new Map(
  Object.entries(OPENAI_EXACT).flatMap(([key, e]) => e.aliases.map((a) => [a, key] as [string, string])),
);

/** Every OpenAI id listed in the catalog (keys and aliases), for tests against tiktoken's table. */
export function listedOpenAiIds(): Array<{ id: string; encoding: LocalEncoding }> {
  return Object.entries(OPENAI_EXACT).flatMap(([key, e]) => [
    { id: key, encoding: e.encoding },
    ...e.aliases.map((id) => ({ id, encoding: e.encoding })),
  ]);
}

function result(provider: string, api: UsageApi, modelRequested: string, catalogKey: string | null,
  support: SupportLevel, encoding: LocalEncoding | null): ModelSupport {
  return {
    provider,
    api,
    modelRequested,
    catalogKey,
    support,
    tokenizer: encoding ? loadEncoding(encoding).identity : null,
    catalogVersion: MODEL_CATALOG_VERSION,
  };
}

/** ResolveModelSupportFn. Case-insensitive on provider and model ids; returns ids verbatim. */
export function resolveModelSupport(provider: string, api: UsageApi, modelRequested: string): ModelSupport {
  const p = provider.trim().toLowerCase();
  const m = modelRequested.trim().toLowerCase();
  const apis = Object.hasOwn(PROVIDER_APIS, p) ? PROVIDER_APIS[p] : undefined;
  if (!apis || !apis.includes(api) || m.length === 0) {
    return result(provider, api, modelRequested, null, 'unsupported', null);
  }
  if (p === 'openai') {
    const exact = Object.hasOwn(OPENAI_EXACT, m) ? OPENAI_EXACT[m] : undefined;
    if (exact) return result(provider, api, modelRequested, m, 'exact', exact.encoding);
    const aliasKey = OPENAI_ALIAS_TO_KEY.get(m);
    if (aliasKey) return result(provider, api, modelRequested, aliasKey, 'alias_known', OPENAI_EXACT[aliasKey]!.encoding);
    const family = OPENAI_FAMILY_PREFIXES.find(([prefix]) => m.startsWith(prefix));
    if (family) return result(provider, api, modelRequested, null, 'generic_fallback', family[1]);
    return result(provider, api, modelRequested, null, 'unsupported', null);
  }
  const approx = Object.hasOwn(APPROXIMATE_PROVIDERS, p) ? APPROXIMATE_PROVIDERS[p] : undefined;
  return result(provider, api, modelRequested, null, 'generic_fallback', approx ?? null);
}
