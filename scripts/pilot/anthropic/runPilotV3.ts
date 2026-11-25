/**
 * Anthropic pilot v3 — through the DURABLE D1–D8 path (PILOTO_V3, 2026-10-03).
 *
 * The historical runner runPilot.ts is the LEGACY profile (OTK_DB_URL='', gateway without `operations`,
 * CU_MODEL_v1 bucket 100, TAL accounting): it never reaches handleDurableMitm and is not D1–D8 evidence.
 * This runner starts the REAL entrypoint (src/api/server.ts → startDurableProxyIfEnabled →
 * d1d8ProfileFromEnv) as a child process, with its own database, spool, instance id, tenant and money
 * budget, and checks every operation against independent oracles (CU and price computed here from the raw
 * provider usage and the frozen tables' DATA, never by calling the functions under test).
 *
 *   npx tsx scripts/pilot/anthropic/runPilotV3.ts [--provider=anthropic|openai|gemini] --mode=synthetic --phase=gate --out=<dir> [--besu-dir=<dir>]
 *   npx tsx scripts/pilot/anthropic/runPilotV3.ts [--provider=anthropic|openai|gemini] --mode=live --phase=minimal|stream|disconnect|sample|besu --out=<dir> [--besu-dir=<dir>]
 * Provider profiles (PROFILES below): anthropic = Messages + claude-haiku-4-5-20251001 under policy v2 (the profile of
 * the first real pilot, unchanged); openai = Chat Completions + gpt-4o-mini under policy v3 (opt-in instance policy);
 * gemini = generateContent/streamGenerateContent + gemini-2.5-flash-lite under policy v4, thinking explicitly off,
 * versioned development weights development-2026-10-03 (FECHAMENTO_GEMINI_AD). The OTK token goes to the OTK in
 * `Authorization: Bearer`; the Google key exists only in the child's environment (the server sends it as x-goog-api-key).
 *
 * Environment: OTK_PILOT_PG_URL (or OTK_TEST_PG_URL) = admin URL of an isolated PostgreSQL (a fresh database
 * is created per run and kept as evidence). live: ANTHROPIC_API_KEY (presence checked, value never printed).
 * synthetic: the upstream is the local ControllableProvider (its URL is asserted to be loopback) and the child
 * gets a fixture key; the run measures, and fails on, the real key being present in the child's environment or
 * in any request the synthetic provider received (manifest.upstream.realKeyInChildEnv / realKeySeenByProvider).
 * Budget (live): every call is reserved first in the canonical cumulative ledger (budgetLedger.ts, US$ 3 cap,
 * OTK_PILOT_LEDGER or <HOME>/otk-pilot/anthropic_budget_ledger.jsonl), serially, no retries; the OTK
 * money budget of the run gets that remaining balance as ceiling (both protect the same spend). The ledger is
 * settled only from a provider-reported usage (pilotV3Settlement.ts); otherwise the reservation stays uncertain.
 * Exit: 0 every check passed; 1 divergence or uncertain outcome; 2 budget refusal; 3 no credential (nothing
 * called); 4 usage error; 5 environment/preflight failure (nothing paid called).
 *
 * Other variables read: `OPENAI_API_KEY` / `GEMINI_API_KEY` for the other profiles (the profile's `keyEnv`),
 * `OTK_PV3_TEST_HOOKS` (=1 lets a test use a non-canonical ledger path), and in synthetic mode
 * `PV3_SYNTH_GEMINI_THOUGHTS`, `PV3_SYNTH_GEMINI_TIER`, `PV3_SYNTH_OPENAI_TIER` (behaviour of the local stand-in
 * provider). Started by the shell wrappers `run_live_pv3.sh` and `scripts/pilot/campaign/run_campaign_ovn2.sh`.
 * Live mode MAKES PAID CALLS.
 *
 * @module scripts/pilot/anthropic/runPilotV3
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { BudgetLedger, BudgetError, maxInputTokensFor } from './budgetLedger.js';
import { settlementFor } from './pilotV3Settlement.js';
import { corpusToJsonl, generateCorpus, sha256 as corpusSha256, splitOf } from '../../calibration/corpus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'gemini35';
/**
 * Oracle data per provider, frozen for this experiment (recorded in the manifest; compared with the running
 * config). Weights: development profile dev-static-from-CostUnits.ts (milli). Limits: the model's documented
 * context window and maximum output (the money bound policy the profile runs under).
 */
interface Profile {
  /** OTK provider id (both Gemini profiles are provider 'gemini') */
  provider: 'anthropic' | 'openai' | 'gemini'; model: string; allowedReturned: string[]; priceTableFile: string; priceModelKey: string;
  /** the ONE canonical cumulative ledger of this provider (US$ 3 each); another path only in the wrapper's test mode */
  canonicalLedger: string;
  wProviderMilli: bigint; wModelMilli: bigint; policyId: string; contextWindow: bigint; maxOutput: bigint;
  keyEnv: string; upstreamEnv: string; fixtureKey: string; route: string;
  preflight(key: string): { url: string; headers: Record<string, string> };
  providerHeaders: Record<string, string>; synthHeaders: Record<string, string>; synthModel: string; forwardHeaders: string;
  /** development weights profile of the child (OTK_CU_WEIGHTS_PROFILE) and the ref it must freeze into every operation */
  weightsProfile: string; weightsRef: { version: string; digest: string };
  /** id the Models API returns for this model in the free preflight */
  preflightId: string;
  /** Gemini: thinkingConfig the request carries (2.5: thinkingBudget 0; 3.5: thinkingLevel minimal, thinking cannot be off) */
  thinkingConfig?: Record<string, unknown>;
  /** Gemini: pricing terms the policy freezes into the operation */
  pricingTerms?: Record<string, unknown>;
  /** thinking tokens are allowed in the usage (3.5) or must be absent/0 (2.5, thinking off) */
  thinkingAllowed?: boolean;
}
const DEV_WEIGHTS_HISTORICAL = { version: 'dev-static-from-CostUnits.ts', digest: '0xf27b2c15b14173bcff5ba8c4c73516b49172d22f1a63cad636f885fe01dcbd93' };
const PROFILES: Record<ProviderName, Profile> = {
  anthropic: {
    provider: 'anthropic', model: 'claude-haiku-4-5-20251001', allowedReturned: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    priceTableFile: 'scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json', priceModelKey: 'claude-haiku-4-5',
    canonicalLedger: '<HOME>/otk-pilot/anthropic_budget_ledger.jsonl',
    wProviderMilli: 1100n, wModelMilli: 800n, policyId: 'otk.money_bound_policy.v2@2026-10-02', contextWindow: 200_000n, maxOutput: 64_000n,
    keyEnv: 'ANTHROPIC_API_KEY', upstreamEnv: 'OTK_PROXY_UPSTREAM_ANTHROPIC', fixtureKey: 'sk-ant-pilot-v3-synthetic-fixture', route: '/v1/messages',
    preflight: (key) => ({ url: 'https://api.anthropic.com/v1/models/claude-haiku-4-5-20251001', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }),
    providerHeaders: { 'anthropic-version': '2023-06-01' }, synthHeaders: { 'x-test-cache': '0,0' }, synthModel: 'claude-haiku-4-5-20251001',
    forwardHeaders: 'x-test-script,x-test-tokens,x-test-model,x-test-cache',
    weightsProfile: 'development', weightsRef: DEV_WEIGHTS_HISTORICAL, preflightId: 'claude-haiku-4-5-20251001',
  },
  openai: {
    provider: 'openai', model: 'gpt-4o-mini', allowedReturned: ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'],
    priceTableFile: 'scripts/pilot/price_table_pilot_v3_20261003.json', priceModelKey: 'gpt-4o-mini',
    canonicalLedger: '<HOME>/otk-pilot/openai_budget_ledger.jsonl',
    wProviderMilli: 1000n, wModelMilli: 400n, policyId: 'otk.money_bound_policy.v3@2026-10-03', contextWindow: 128_000n, maxOutput: 16_384n,
    keyEnv: 'OPENAI_API_KEY', upstreamEnv: 'OTK_PROXY_UPSTREAM_OPENAI', fixtureKey: 'sk-proj-pilot-v3-synthetic-fixture', route: '/v1/chat/completions',
    preflight: (key) => ({ url: 'https://api.openai.com/v1/models/gpt-4o-mini', headers: { authorization: `Bearer ${key}` } }),
    providerHeaders: {}, synthHeaders: { 'x-test-openai-cached': '0' }, synthModel: 'gpt-4o-mini-2024-07-18',
    forwardHeaders: 'x-test-script,x-test-tokens,x-test-model,x-test-openai-cached,x-test-openai-tier',
    weightsProfile: 'development', weightsRef: DEV_WEIGHTS_HISTORICAL, preflightId: 'gpt-4o-mini',
  },
  gemini: {
    provider: 'gemini', model: 'gemini-2.5-flash-lite', allowedReturned: ['gemini-2.5-flash-lite'],
    priceTableFile: 'scripts/pilot/price_table_pilot_v3_gemini_20261003.json', priceModelKey: 'gemini-2.5-flash-lite',
    canonicalLedger: '<HOME>/otk-pilot/gemini_budget_ledger.jsonl',
    wProviderMilli: 900n, wModelMilli: 600n, policyId: 'otk.money_bound_policy.v4@2026-10-03', contextWindow: 1_048_576n, maxOutput: 65_536n,
    keyEnv: 'GEMINI_API_KEY', upstreamEnv: 'OTK_PROXY_UPSTREAM_GEMINI', fixtureKey: 'AIza-pilot-v3-synthetic-gemini-fixture', route: '/v1beta/models/gemini-2.5-flash-lite',
    // free metadata call (Models API, no tokens); the key goes in the header, never in the URL
    preflight: (key) => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite', headers: { 'x-goog-api-key': key } }),
    providerHeaders: {}, synthHeaders: {}, synthModel: 'gemini-2.5-flash-lite',
    forwardHeaders: 'x-test-script,x-test-tokens,x-test-model,x-test-gemini-cached,x-test-gemini-thoughts,x-test-gemini-tier',
    // review L4: digest frozen here (first recorded by the synthetic gate of 7e184b7); a change of the profile is a divergence
    weightsProfile: 'development-2026-10-03', weightsRef: { version: 'dev-static-from-CostUnits.ts+gemini-2.5-flash-lite@2026-10-03', digest: '0x2376ce79f055faee50aa946ddd645eef1d9cc789022c3effadcb200991f4e800' },
    preflightId: 'models/gemini-2.5-flash-lite',
    thinkingConfig: { thinkingBudget: 0 }, pricingTerms: { serviceTier: 'standard', thinking: 'off' }, thinkingAllowed: false,
  },
  // author decision 2026-10-04 (DL-15): gemini-2.5-flash-lite is closed to this account (404); next economic model, same
  // US$ 3 cumulative Gemini ledger. Thinking cannot be turned off: minimal, bounded by maxOutputTokens, billed as output.
  gemini35: {
    provider: 'gemini', model: 'gemini-3.5-flash-lite', allowedReturned: ['gemini-3.5-flash-lite'],
    priceTableFile: 'scripts/pilot/price_table_pilot_v3_gemini35_20261004.json', priceModelKey: 'gemini-3.5-flash-lite',
    canonicalLedger: '<HOME>/otk-pilot/gemini_budget_ledger.jsonl',
    wProviderMilli: 900n, wModelMilli: 600n, policyId: 'otk.money_bound_policy.v5@2026-10-04', contextWindow: 1_048_576n, maxOutput: 65_536n,
    keyEnv: 'GEMINI_API_KEY', upstreamEnv: 'OTK_PROXY_UPSTREAM_GEMINI', fixtureKey: 'AIza-pilot-v3-synthetic-gemini35-fixture', route: '/v1beta/models/gemini-3.5-flash-lite',
    preflight: (key) => ({ url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite', headers: { 'x-goog-api-key': key } }),
    // synthetic provider reports a few thought tokens, as the real model may with thinking at minimal
    providerHeaders: {}, synthHeaders: { 'x-test-gemini-thoughts': '3' }, synthModel: 'gemini-3.5-flash-lite',
    forwardHeaders: 'x-test-script,x-test-tokens,x-test-model,x-test-gemini-cached,x-test-gemini-thoughts,x-test-gemini-tier',
    weightsProfile: 'development-2026-10-04', weightsRef: { version: 'dev-static-from-CostUnits.ts+gemini-2.5-flash-lite+gemini-3.5-flash-lite@2026-10-04', digest: '0xf5175787996e57b277954b96299c97efa24c3c5870cc79c46c7440a559895cb8' },
    preflightId: 'models/gemini-3.5-flash-lite',
    thinkingConfig: { thinkingLevel: 'minimal' }, pricingTerms: { serviceTier: 'standard' }, thinkingAllowed: true,
  },
};
const PROVIDER_ARG = arg('provider') ?? 'anthropic';
const PROVIDER_KNOWN = Object.hasOwn(PROFILES, PROVIDER_ARG);
const PROFILE: Profile = PROVIDER_KNOWN ? PROFILES[PROVIDER_ARG as ProviderName] : PROFILES.anthropic;
const OPENAI = PROFILE.provider === 'openai';
const GEMINI = PROFILE.provider === 'gemini';
const PROFILE_NAME = PROVIDER_ARG as ProviderName;
const MODEL = PROFILE.model;
const ALLOWED_RETURNED = PROFILE.allowedReturned;
const PRICE_TABLE_FILE = PROFILE.priceTableFile;
const CANONICAL_LEDGER = PROFILE.canonicalLedger;
const LIVE_LEDGER = process.env['OTK_PILOT_LEDGER'] ?? CANONICAL_LEDGER;
const TENANT = 'pilot-v3';
const W_PROVIDER_MILLI = PROFILE.wProviderMilli;
const W_MODEL_MILLI = PROFILE.wModelMilli;
// the Gemini profile's digest is computed by the oracle from the published version + the documented addition (main())
let WEIGHTS_REF_EXPECTED = PROFILE.weightsRef;
const POLICY_ID = PROFILE.policyId;
const CONTEXT_WINDOW = PROFILE.contextWindow;
const MAX_OUTPUT = PROFILE.maxOutput;

type Mode = 'synthetic' | 'live';
interface SynthProvider { start(): Promise<void>; stop(): Promise<void>; url: string; calls: unknown[]; finalBarriers: Array<{ promise: Promise<void>; release(): void }> }
type Phase = 'minimal' | 'stream' | 'disconnect' | 'sample' | 'besu' | 'gate' | 'campaign' | 'cacheprobe';
interface Case {
  label: string; stream: boolean; prompt: string; maxTokens: number;
  disconnect?: boolean; chain?: boolean;
  /** synthetic provider behaviour (cached: OpenAI/Gemini prompt tokens served from cache) */ synth?: { script: 'ok' | 'stream' | 'cut'; tokens: [number, number]; cached?: number };
  expect: 'final' | 'uncertain';
  /** OVERNIGHT 2 campaign: corpus document behind the prompt (calibration split is by group, fixed before the data) */
  meta?: Record<string, string>;
  /** OVERNIGHT 2 campaign: CLIENT_DECLARED project/task labels sent as x-otk-* headers */
  attribution?: { projectId: string; applicationId: string; taskType: string; taskRunId: string };
}

/** secret values of this run (key, token, private keys): replaced in every output, including fatal errors */
const secretsToRedact: string[] = [];
const redact = (s: string) => secretsToRedact.reduce((acc, v) => (v ? acc.split(v).join('[REDACTED]') : acc), s);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
function syntheticText(sentences: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= sentences; i++) parts.push(`Frase ${i}: o medidor registra ${i * 7} unidades no lote ${100 + i}, sem dados pessoais.`);
  return parts.join(' ');
}
const ASK = 'Responda apenas com a palavra ok.';

/**
 * OVERNIGHT 2 campaign (07_CALIBRATION_PROTOCOL.md, fixed before any data): fresh synthetic corpus, seed 20261007,
 * 9 groups per family, 3 texts per group; one user message per text, max 24 output tokens, no stream. 'cacheprobe' =
 * the same long prompt three times (prompt caching category observed when the provider applies it; excluded from
 * the calibration).
 */
export const CAMPAIGN_CORPUS = Object.freeze({ seed: 20261007, groupsPerFamily: 9, variantsPerGroup: 2 });
function campaignCases(phase: 'campaign' | 'cacheprobe'): Case[] {
  const run = `ovn2-${PROFILE_NAME}-${phase}-20261007`;
  const attr = (taskType: string) => ({ projectId: 'otk', applicationId: 'otk-ovn2-campaign', taskType, taskRunId: run });
  if (phase === 'cacheprobe') {
    const prompt = `Resuma em uma frase curta o texto a seguir.\n\n${syntheticText(160)}`;
    return [1, 2, 3].map((i) => ({ label: `cache-${i}`, stream: false, maxTokens: 24, prompt, expect: 'final' as const,
      synth: { script: 'ok' as const, tokens: [3200, 8] as [number, number], ...(i > 1 ? { cached: 2048 } : {}) }, meta: { cacheProbe: String(i) }, attribution: attr('cache-probe') }));
  }
  return generateCorpus(CAMPAIGN_CORPUS).map((d) => ({
    label: `cal-${d.id}`, stream: false, maxTokens: 24, prompt: `Resuma em uma frase curta o texto a seguir.\n\n${d.text}`, expect: 'final' as const,
    synth: { script: 'ok' as const, tokens: [Math.max(8, Math.ceil(d.text.length / 4) + 12), 8] as [number, number] },
    meta: { docId: d.id, group: d.group, split: splitOf(d.group), family: d.family, sizeBucket: d.sizeBucket }, attribution: attr('calibration-sample'),
  }));
}

function plan(phase: Phase, mode: Mode, besu: boolean): Case[] {
  if (phase === 'campaign' || phase === 'cacheprobe') return campaignCases(phase);
  const minimal: Case = { label: 'minimal', stream: false, prompt: ASK, maxTokens: 16, synth: { script: 'ok', tokens: [20, 5] }, expect: 'final' };
  const stream: Case = { label: 'stream', stream: true, prompt: ASK, maxTokens: 16, synth: { script: 'stream', tokens: [21, 6] }, expect: 'final' };
  const disconnect: Case = { label: 'disconnect', stream: true, disconnect: true, maxTokens: 160,
    prompt: 'Escreva os números de 1 a 40 por extenso, separados por vírgula.', synth: { script: 'stream', tokens: [30, 120] }, expect: 'final' };
  const sample: Case[] = [];
  for (const [size, n] of [['curto', 3], ['medio', 60]] as const) {
    for (const s of [false, true]) {
      sample.push({ label: `sample-${size}-${s ? 'stream' : 'nostream'}`, stream: s, maxTokens: 64,
        prompt: `Resuma em uma frase curta o texto a seguir.\n\n${syntheticText(n)}`,
        synth: { script: s ? 'stream' : 'ok', tokens: [n * 25, 40], ...(size === 'medio' && s ? { cached: 1024 } : {}) }, expect: 'final' });
    }
  }
  const besuCase: Case = { label: 'besu', stream: false, prompt: ASK, maxTokens: 16, chain: true, synth: { script: 'ok', tokens: [22, 4] }, expect: 'final' };
  const nousage: Case = { label: 'nousage', stream: true, prompt: ASK, maxTokens: 16, synth: { script: 'cut', tokens: [20, 5] }, expect: 'uncertain' };
  if (phase === 'gate') {
    if (mode !== 'synthetic') throw new Error('phase gate is synthetic only');
    return [minimal, stream, disconnect, nousage, ...sample, ...(besu ? [besuCase] : [])];
  }
  return { minimal: [minimal], stream: [stream], disconnect: [disconnect], sample, besu: [besuCase] }[phase];
}

// ───────────────────────────── independent oracles (data + arithmetic only) ─────────────────────────────
interface RawUsage { input: bigint; output: bigint; cacheWrite: bigint; cacheRead: bigint }
const table = JSON.parse(fs.readFileSync(path.join(ROOT, PRICE_TABLE_FILE), 'utf8')) as { version: string; entries: Array<{ provider: string; model: string; category: string; pricePerMTokMicroUsd: string }> };
/**
 * tariff of a category for this profile's model; null when the table has none (that category then must count 0)
 *
 * @param cat - Price category (`input`, `output`, `input_cache_write`, `input_cache_read`).
 * @returns Micro-USD per million tokens, or `null`.
 */
const priceOf = (cat: string): bigint | null => {
  const e = table.entries.find((x) => x.provider === PROFILE.provider && x.model === PROFILE.priceModelKey && x.category === cat);
  return e ? BigInt(e.pricePerMTokMicroUsd) : null;
};
const price = (cat: string) => { const v = priceOf(cat); if (v === null) throw new Error(`no tariff for ${PROFILE.provider}/${PROFILE.priceModelKey}/${cat}`); return v; };
/** RawUsage is DISJOINT per category (OpenAI cached tokens are carved out of the prompt before it gets here) */
const oracle = {
  cuMicro: (u: RawUsage) => (u.input + u.cacheWrite + u.cacheRead + u.output) * W_MODEL_MILLI * W_PROVIDER_MILLI,
  /**
   * pico-USD = tokens × (µUSD per MTok)
   *
   * @param u - Disjoint raw usage.
   * @returns Cost in pico-USD.
   */
  costPico: (u: RawUsage) => u.input * price('input') + u.output * price('output') + (u.cacheWrite === 0n ? 0n : u.cacheWrite * price('input_cache_write')) + (u.cacheRead === 0n ? 0n : u.cacheRead * price('input_cache_read')),
  reservePico: (maxTokens: number) => CONTEXT_WINDOW * [priceOf('input'), priceOf('input_cache_write'), priceOf('input_cache_read')].filter((v): v is bigint => v !== null).reduce((a, b) => (a > b ? a : b)) + BigInt(maxTokens) * price('output'),
};
/**
 * Gemini usageMetadata → disjoint categories. cachedContentTokenCount is INSIDE promptTokenCount; thoughts are billed
 * as output (fontes/pricing.md, thinking-gc.md). Zero-valued counts are omitted by the API's proto3 JSON: an omitted
 * cachedContentTokenCount/thoughtsTokenCount is 0 and an omitted candidatesTokenCount is total − prompt − thoughts
 * (the documented total = prompt + thoughts + candidates); an omitted prompt or total, a negative/fractional count,
 * cache above the prompt or an inconsistent total leave the usage unknown.
 *
 * @param u - Gemini `usageMetadata` object.
 * @returns Disjoint raw usage, or `null` when unknown.
 */
function geminiRaw(u: Record<string, unknown>): RawUsage | null {
  const n = (v: unknown): bigint | null | undefined => (v === undefined ? undefined : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);
  const prompt = n(u['promptTokenCount']); const total = n(u['totalTokenCount']);
  const cached = n(u['cachedContentTokenCount']); const thoughts = n(u['thoughtsTokenCount']); let cand = n(u['candidatesTokenCount']);
  if (prompt == null || total == null || cached === null || thoughts === null || cand === null) return null;
  const tool = n(u['toolUsePromptTokenCount']);
  if (tool === null || (tool ?? 0n) > 0n) return null; // tools are outside the scope: a tool-use prompt is not priced
  const c0 = cached ?? 0n; const t0 = thoughts ?? 0n;
  if (cand === undefined) cand = total - prompt - t0;
  if (cand < 0n || c0 > prompt || prompt + cand + t0 !== total) return null;
  return { input: prompt - c0, output: cand + t0, cacheWrite: 0n, cacheRead: c0 };
}
function rawFrom(u: Record<string, unknown> | null | undefined): RawUsage | null {
  if (!u) return null;
  if (GEMINI) return geminiRaw(u);
  if (OPENAI) {
    const n = (v: unknown) => (typeof v === 'number' ? BigInt(v) : null);
    const prompt = n(u['prompt_tokens']); const completion = n(u['completion_tokens']);
    if (prompt === null || completion === null) return null;
    // same rule as the ledger settlement: a missing or impossible cached count leaves the usage unknown
    const cached = n((u['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens']);
    if (cached === null || cached > prompt) return null;
    return { input: prompt - cached, output: completion, cacheWrite: 0n, cacheRead: cached };
  }
  const n = (k: string) => (typeof u[k] === 'number' ? BigInt(u[k] as number) : null);
  const input = n('input_tokens'); const output = n('output_tokens');
  if (input === null || output === null) return null;
  return { input, output, cacheWrite: n('cache_creation_input_tokens') ?? 0n, cacheRead: n('cache_read_input_tokens') ?? 0n };
}

// ───────────────────────────── process / services ─────────────────────────────
const freePort = () => new Promise<number>((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
async function poll<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 250): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timeout ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
}

interface Api { proc: ChildProcess; proxy: string; log: string[] }
function startApi(env: NodeJS.ProcessEnv, proxyPort: number): Api {
  // node + tsx loader directly (no cmd.exe layer: the pid IS the server, so it can always be stopped)
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/api/server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  proc.stdout?.on('data', (d) => log.push(String(d)));
  proc.stderr?.on('data', (d) => log.push(String(d)));
  return { proc, proxy: `http://127.0.0.1:${proxyPort}`, log };
}
async function stopApi(a: Api): Promise<void> {
  if (a.proc.exitCode !== null) return;
  const exited = new Promise<void>((r) => a.proc.once('exit', () => r()));
  a.proc.kill('SIGKILL');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  a.proc.stdout?.destroy(); a.proc.stderr?.destroy();
}

// ───────────────────────────── one call through the OTK proxy ─────────────────────────────
interface Observed {
  status?: number; error?: string; text: string; firstChunkMs?: number; latencyMs: number;
  messageId?: string; model?: string; usage?: Record<string, unknown>; stopped: boolean; aborted: boolean; requestId?: string;
  /** OpenAI/Gemini: tier that processed (and prices) the request, as the response reports it */
  serviceTier?: string;
  /** Gemini: first candidate's finishReason, or blocked:<reason> */
  finishReason?: string;
  /** Gemini: the last usageMetadata arrived in the finishing event or after it (only then it is the final usage) */
  usageAfterFinish?: boolean;
}
async function callProxy(proxy: string, token: string, opId: string, c: Case, synthetic: boolean): Promise<Observed> {
  const body: Record<string, unknown> = GEMINI
    ? { contents: [{ role: 'user', parts: [{ text: c.prompt }] }], generationConfig: { maxOutputTokens: c.maxTokens, thinkingConfig: PROFILE.thinkingConfig } }
    : { model: MODEL, max_tokens: c.maxTokens, messages: [{ role: 'user', content: c.prompt }], ...(c.stream ? { stream: true } : {}) };
  // Gemini: streaming is chosen by the route; the OTK adds alt=sse (the runner does not, so the product's handling is exercised)
  const route = GEMINI ? `${PROFILE.route}:${c.stream ? 'streamGenerateContent' : 'generateContent'}` : PROFILE.route;
  const headers: Record<string, string> = {
    'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-otk-provider': PROFILE.provider, ...PROFILE.providerHeaders, 'x-otk-operation-id': opId,
    ...(c.attribution ? { 'x-otk-project': c.attribution.projectId, 'x-otk-application': c.attribution.applicationId, 'x-otk-task-type': c.attribution.taskType, 'x-otk-task-run': c.attribution.taskRunId } : {}),
    ...(synthetic && c.synth ? { 'x-test-script': c.synth.script, 'x-test-tokens': c.synth.tokens.join(','), 'x-test-model': PROFILE.synthModel, ...PROFILE.synthHeaders, ...(OPENAI && c.synth.cached ? { 'x-test-openai-cached': String(c.synth.cached) } : {}), ...(GEMINI && c.synth.cached ? { 'x-test-gemini-cached': String(c.synth.cached) } : {}),
      ...(GEMINI && process.env['PV3_SYNTH_GEMINI_THOUGHTS'] ? { 'x-test-gemini-thoughts': process.env['PV3_SYNTH_GEMINI_THOUGHTS'] } : {}),
      ...(GEMINI && process.env['PV3_SYNTH_GEMINI_TIER'] ? { 'x-test-gemini-tier': process.env['PV3_SYNTH_GEMINI_TIER'] } : {}),
      // positive control of the tier check (synthetic only): the provider answers with another tier
      ...(OPENAI && process.env['PV3_SYNTH_OPENAI_TIER'] ? { 'x-test-openai-tier': process.env['PV3_SYNTH_OPENAI_TIER'] } : {}) } : {}),
  };
  const ac = new AbortController();
  const t0 = Date.now();
  const o: Observed = { text: '', latencyMs: 0, stopped: false, aborted: false };
  try {
    const r = await fetch(`${proxy}${route}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    o.status = r.status; o.requestId = r.headers.get('request-id') ?? undefined;
    if (!c.stream || r.status !== 200) {
      const j = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (j && GEMINI) {
        // independent reading of the Gemini body: responseId, modelVersion, usageMetadata, candidate text and finish
        o.messageId = j['responseId'] as string | undefined; o.model = j['modelVersion'] as string | undefined; o.usage = j['usageMetadata'] as Record<string, unknown> | undefined;
        const tier = (o.usage as Record<string, unknown> | undefined)?.['serviceTier']; if (typeof tier === 'string') o.serviceTier = tier;
        const cand = (j['candidates'] as Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> | undefined)?.[0];
        o.text = (cand?.content?.parts ?? []).map((pt) => pt.text ?? '').join('');
        o.finishReason = cand?.finishReason ?? (j['promptFeedback'] ? `blocked:${String((j['promptFeedback'] as Record<string, unknown>)['blockReason'])}` : undefined);
      } else if (j) { o.messageId = j['id'] as string; o.model = j['model'] as string; o.usage = j['usage'] as Record<string, unknown>;
        if (typeof j['service_tier'] === 'string') o.serviceTier = j['service_tier'] as string;
        o.text = OPENAI
          ? String(((j['choices'] as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content) ?? '')
          : Array.isArray(j['content']) ? (j['content'] as Array<{ type: string; text?: string }>).map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('') : ''; }
      if (r.status !== 200) o.error = `http ${r.status}: ${JSON.stringify(j).slice(0, 300)}`;
      o.stopped = r.status === 200;
    } else {
      // independent SSE aggregation: message_start usage, then cumulative message_delta usage
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (o.firstChunkMs === undefined) o.firstChunkMs = Date.now() - t0;
        buf += dec.decode(value, { stream: true });
        // event boundary: a blank line, with LF or CRLF line ends (Gemini sends CRLF)
        let m: RegExpExecArray | null;
        while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
          const block = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          if (OPENAI && data === '[DONE]') { o.stopped = true; continue; }
          let ev: Record<string, unknown>; try { ev = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          if (GEMINI) {
            // cumulative usageMetadata replaces the previous one; finishReason (or a blocked prompt) ends the generation;
            // the protocol has no [DONE]: the stream's end after a finish is the normal end
            if (typeof ev['responseId'] === 'string') o.messageId = ev['responseId'] as string;
            if (typeof ev['modelVersion'] === 'string') o.model = ev['modelVersion'] as string;
            const cand = (ev['candidates'] as Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> | undefined)?.[0];
            for (const pt of cand?.content?.parts ?? []) o.text += pt.text ?? '';
            if (cand?.finishReason) o.finishReason = cand.finishReason;
            if (ev['promptFeedback']) o.finishReason = `blocked:${String((ev['promptFeedback'] as Record<string, unknown>)['blockReason'])}`;
            if (ev['usageMetadata'] && typeof ev['usageMetadata'] === 'object') {
              o.usage = { ...(ev['usageMetadata'] as Record<string, unknown>) };
              const tier = o.usage['serviceTier']; if (typeof tier === 'string') o.serviceTier = tier;
              // review M3: only a usage in the finishing event or after it is the final one; an earlier snapshot is not
              o.usageAfterFinish = o.finishReason !== undefined;
            }
            continue;
          }
          if (OPENAI) {
            // independent aggregation: id/model of the chunks, text deltas, usage in the final (choices: []) chunk
            if (typeof ev['id'] === 'string' && !o.messageId) o.messageId = ev['id'] as string;
            if (typeof ev['model'] === 'string') o.model = ev['model'] as string;
            if (typeof ev['service_tier'] === 'string') o.serviceTier = ev['service_tier'] as string;
            const d = (ev['choices'] as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta;
            if (typeof d?.content === 'string') o.text += d.content;
            if (ev['usage'] && typeof ev['usage'] === 'object') o.usage = { ...(ev['usage'] as Record<string, unknown>) };
            continue;
          }
          if (ev['type'] === 'message_start') { const m = ev['message'] as Record<string, unknown>; o.messageId = m['id'] as string; o.model = m['model'] as string; o.usage = { ...(m['usage'] as Record<string, unknown>) }; }
          else if (ev['type'] === 'message_delta') { for (const [k, v] of Object.entries((ev['usage'] ?? {}) as Record<string, unknown>)) if (typeof v === 'number') (o.usage ??= {})[k] = v; }
          else if (ev['type'] === 'content_block_delta') { const d = ev['delta'] as Record<string, unknown>; if (d['type'] === 'text_delta') o.text += String(d['text'] ?? ''); }
          else if (ev['type'] === 'message_stop') o.stopped = true;
        }
        if (c.disconnect && o.messageId) { o.aborted = true; ac.abort(new Error('deliberate client disconnect')); break; }
      }
      if (GEMINI && o.finishReason && o.usageAfterFinish && !o.aborted) o.stopped = true;
      if (!o.stopped && !o.aborted) o.error = GEMINI ? 'stream ended without finishReason' : 'stream ended without message_stop';
    }
  } catch (e) {
    if (!o.aborted) o.error = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
  }
  o.latencyMs = Date.now() - t0;
  return o;
}

// ───────────────────────────── per-operation verification ─────────────────────────────
type Checks = Record<string, { ok: boolean; expected: unknown; observed: unknown }>;
/**
 * canonical form: object keys sorted, so key order never decides a comparison
 *
 * @param v - Any JSON-like value.
 * @returns Its canonical JSON text.
 */
const canon = (v: unknown): string => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v));
const chk = (checks: Checks, name: string, expected: unknown, observed: unknown, ok = canon(expected) === canon(observed)) => { checks[name] = { ok, expected, observed }; };
interface OpRow { execution: string; measurement: string; delivery: string; st: string; money: Record<string, unknown> | null; usage: { categories?: Array<{ name: string; count: string }>; modelReturned?: string; providerRequestId?: string; serviceTier?: string | null; finishReason?: string | null } | null;
  cu: { units: string; scale: string } | null; reserved_money: string | null; budget_ids: string[]; provider_request_id: string | null; tenant_id: string; limits: Record<string, unknown>; config: Record<string, unknown> }

async function verify(db: pg.Pool, proxy: string, token: string, opId: string, c: Case, o: Observed, budgetId: string, chain: ChainCtx | null): Promise<{ checks: Checks; row: OpRow | null; raw: RawUsage | null; conference?: unknown }> {
  const checks: Checks = {};
  let conference: unknown = undefined;
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p);
  // without a final usage the measurement stays 'partial' (intermediate usage seen) or 'uncertain' (none)
  // a provider refusal without usage (4xx) ends with measurement 'none' and the reservation released (live Gemini 404, 04/10)
  const terminal = (r: OpRow) => ['completed', 'upstream_failed', 'cancelled', 'process_lost'].includes(r.execution)
    && (['final', 'uncertain', 'partial'].includes(r.measurement) || (r.measurement === 'none' && r.st === 'released'))
    && (r.money === null || !['held'].includes(String(r.money['state'])));
  let row: OpRow | null = null;
  try {
    row = await poll('operation terminal', async () => {
      const r = (await q(`SELECT tenant_id, execution, measurement, delivery, reservation->>'state' AS st, money, usage, reservation->'cu' AS cu, reserved_money::text, budget_ids,
        provider_request_id, limits, config FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2`, [TENANT, opId])).rows[0] as OpRow | undefined;
      return r && terminal(r) ? r : null;
    }, 120_000);
  } catch (e) { chk(checks, 'operation_reaches_terminal_state', 'terminal within 120 s', String(e), false); return { checks, row: null, raw: null }; }
  chk(checks, 'tenant', TENANT, row.tenant_id);
  chk(checks, 'policy_strict', POLICY_ID, row.limits['moneyBoundPolicy']);
  chk(checks, 'weights_frozen_in_operation', WEIGHTS_REF_EXPECTED, row.config['cuWeights'] ?? null);
  chk(checks, 'development_profile_declared', true, row.config['developmentProfile']);
  chk(checks, 'price_table_frozen_in_operation', table.version, (row.config['priceTable'] as { version?: string } | null)?.version ?? null);
  chk(checks, 'money_reserved_v2_bound', oracle.reservePico(c.maxTokens).toString(), row.reserved_money);
  // a category the provider did not report has count null: absent, never zero
  const cats: Record<string, bigint> = Object.fromEntries((row.usage?.categories ?? []).filter((x) => x.count !== null && x.count !== undefined).map((x) => [x.name, BigInt(x.count)]));
  if (c.expect === 'uncertain') {
    chk(checks, 'execution', 'upstream_failed', row.execution);
    chk(checks, 'measurement_not_final', 'partial|uncertain', row.measurement, ['partial', 'uncertain'].includes(row.measurement));
    chk(checks, 'cu_exposure_kept', 'held_uncertain', row.st);
    chk(checks, 'money_exposure_kept', 'held_uncertain', row.money?.['state']);
    chk(checks, 'no_debit', '0', String((await q('SELECT count(*)::int AS n FROM otk_ledger WHERE tenant_id = $1 AND operation_id = $2', [TENANT, opId])).rows[0].n));
    chk(checks, 'no_receipt', '0', String((await q('SELECT count(*)::int AS n FROM otk_receipts_v3 WHERE tenant_id = $1 AND operation_id = $2', [TENANT, opId])).rows[0].n));
    return { checks, row, raw: null };
  }
  chk(checks, 'execution', 'completed', row.execution);
  chk(checks, 'measurement_final', 'final', row.measurement);
  chk(checks, 'delivery', c.disconnect ? 'client_disconnected' : 'delivered', row.delivery);
  chk(checks, 'returned_model_allowed', true, ALLOWED_RETURNED.includes(String(row.usage?.modelReturned ?? '').toLowerCase()));
  // OpenAI prices by the tier that processed the call; the frozen table is Standard ("default"). FECHAMENTO_GEMINI_AD
  // (G-OPENAI-TIER): "not observed" is no longer a PASS. The client's observation is checked when it saw the tier; the
  // SERVER's (the product reads every chunk, also after a disconnect, and persists it) is always checked.
  if (OPENAI) {
    if (o.serviceTier !== undefined || !c.disconnect) chk(checks, 'service_tier_standard_client', 'default', o.serviceTier ?? null);
    chk(checks, 'service_tier_standard_server', 'default', row.usage?.serviceTier ?? null);
  }
  if (GEMINI) {
    // the request omits serviceTier (Standard by the documented default); a reported tier must be standard
    const st = row.usage?.serviceTier ?? null;
    chk(checks, 'service_tier_standard_server', 'standard or not reported (documented default)', st ?? 'not reported',
      st === null || ['standard', 'unspecified', 'service_tier_standard'].includes(st.toLowerCase()));
    chk(checks, 'pricing_terms_frozen', PROFILE.pricingTerms ?? null, row.limits['pricingTerms'] ?? null);
    if (!PROFILE.thinkingAllowed) chk(checks, 'no_thinking_tokens', 'absent or 0', (row.usage?.categories ?? []).find((x) => x.name === 'output_reasoning')?.count ?? 'absent',
      ['absent', '0', null].includes((row.usage?.categories ?? []).find((x) => x.name === 'output_reasoning')?.count ?? 'absent'));
    if (!c.disconnect && o.finishReason) chk(checks, 'finish_reason_recorded', o.finishReason, row.usage?.finishReason ?? null);
  }
  if (o.messageId) chk(checks, 'provider_id_correlated', o.messageId, row.usage?.providerRequestId ?? row.provider_request_id);
  // usage: client-observed raw usage (complete responses) vs OTK's normalized categories
  const client = (!c.disconnect && o.stopped) ? rawFrom(o.usage) : null;
  // disjoint form: OpenAI reports cached tokens inside the prompt (subset_of_input), Anthropic as separate addends
  const otkRaw: RawUsage = GEMINI
    ? { input: (cats['input'] ?? 0n) - (cats['input_cache_read'] ?? 0n), output: (cats['output'] ?? 0n) + (cats['output_reasoning'] ?? 0n), cacheWrite: 0n, cacheRead: cats['input_cache_read'] ?? 0n }
    : OPENAI
    ? { input: (cats['input'] ?? 0n) - (cats['input_cache_read'] ?? 0n), output: cats['output'] ?? 0n, cacheWrite: 0n, cacheRead: cats['input_cache_read'] ?? 0n }
    : { input: cats['input'] ?? 0n, output: cats['output'] ?? 0n, cacheWrite: cats['input_cache_write'] ?? 0n, cacheRead: cats['input_cache_read'] ?? 0n };
  if (client) chk(checks, 'usage_matches_provider_response', Object.fromEntries(Object.entries(client).map(([k, v]) => [k, v.toString()])), Object.fromEntries(Object.entries(otkRaw).map(([k, v]) => [k, v.toString()])));
  const raw = client ?? otkRaw; // after a disconnect only the server saw the final usage
  chk(checks, 'cu_independent', oracle.cuMicro(raw).toString(), row.cu?.scale === '1000000' ? row.cu.units : `${row.cu?.units}/${row.cu?.scale}`);
  chk(checks, 'cu_settled', 'settled', row.st);
  chk(checks, 'money_settled', 'settled', row.money?.['state']);
  const conf = row.money?.['confirmed'] as { units?: string } | null | undefined;
  chk(checks, 'cost_independent_by_category', oracle.costPico(raw).toString(), conf?.units ?? null);
  const debit = (await q('SELECT count(*)::int AS n, COALESCE(sum(units),0)::text AS s FROM otk_ledger WHERE tenant_id = $1 AND operation_id = $2', [TENANT, opId])).rows[0];
  chk(checks, 'single_cu_debit', { n: 1, units: oracle.cuMicro(raw).toString() }, { n: debit.n, units: debit.s });
  const md = (await q('SELECT count(*)::int AS n, COALESCE(sum(units),0)::text AS s FROM otk_money_ledger WHERE tenant_id = $1 AND operation_id = $2', [TENANT, opId])).rows[0];
  chk(checks, 'single_money_settlement', { n: 1, units: oracle.costPico(raw).toString() }, { n: md.n, units: md.s });
  chk(checks, 'operation_in_budget', [budgetId], row.budget_ids);
  const b = (await q(`SELECT held_units::text AS h, spent_units::text AS s,
      (SELECT COALESCE(sum(reserved_money),0)::text FROM otk_operations WHERE $1 = ANY(budget_ids) AND money->>'state' IN ('held','held_uncertain','pending_price')) AS open,
      (SELECT COALESCE(sum(units),0)::text FROM otk_money_ledger WHERE budget_id = $1) AS led FROM otk_money_budget WHERE budget_id = $1`, [budgetId])).rows[0];
  chk(checks, 'budget_held_equals_open_reservations', b.open, b.h);
  chk(checks, 'budget_spent_equals_money_ledger', b.led, b.s);
  // receipt v3 (written by the outbox worker): exactly one, signed, CU bound
  try {
    await poll('receipt v3', async () => Number((await q('SELECT count(*)::int AS n FROM otk_receipts_v3 WHERE tenant_id = $1 AND operation_id = $2', [TENANT, opId])).rows[0].n) >= 1, 60_000);
    chk(checks, 'single_receipt_v3', 1, Number((await q('SELECT count(*)::int AS n FROM otk_receipts_v3 WHERE tenant_id = $1 AND operation_id = $2', [TENANT, opId])).rows[0].n));
    const exp = await (await fetch(`${proxy}/v1/operations/${encodeURIComponent(opId)}/conference`, { headers: { authorization: `Bearer ${token}` } })).json() as
      { receipt?: { digest?: string; payload?: { cu?: { cu?: { units?: string } }; publicCommitment?: string } }; verification?: { receipt?: { ok?: boolean } };
        conference?: { digest?: string; state?: string; payload?: { state?: string; verdict?: string; calibration?: unknown; comparisons?: Array<{ category: string; provider: string | null; local: string | null }> } } };
    conference = { receiptDigest: exp.receipt?.digest ?? null, digest: exp.conference?.digest ?? null, state: exp.conference?.payload?.state ?? exp.conference?.state ?? null, verdict: exp.conference?.payload?.verdict ?? null, calibration: exp.conference?.payload?.calibration ?? null,
      comparisons: (exp.conference?.payload?.comparisons ?? []).map((x) => ({ category: x.category, provider: x.provider, local: x.local })) };
    chk(checks, 'receipt_signature_verifies', true, exp.verification?.receipt?.ok === true);
    chk(checks, 'receipt_cu_equals_oracle', oracle.cuMicro(raw).toString(), exp.receipt?.payload?.cu?.cu?.units ?? null);
    if (c.chain && chain) await verifyChain(db, opId, exp.receipt?.payload?.publicCommitment ?? '', raw, checks, chain);
  } catch (e) { chk(checks, 'receipt_v3_written', 'within 60 s', String(e), false); }
  return { checks, row, raw, conference };
}

interface ChainCtx { rpc: import('ethers').JsonRpcProvider; registry: string; abi: readonly unknown[] }
async function verifyChain(db: pg.Pool, opId: string, commitment: string, raw: RawUsage, checks: Checks, chain: ChainCtx): Promise<void> {
  const { ethers } = await import('ethers');
  try {
    await poll('on-chain submission', async () => (await db.query("SELECT 1 FROM otk_outbox WHERE tenant_id = $1 AND operation_id = $2 AND kind = 'submit_onchain' AND state = 'done'", [TENANT, opId])).rowCount === 1, 300_000, 1000);
  } catch (e) { chk(checks, 'onchain_submitted', 'done within 300 s', String(e), false); return; }
  const sub = (await db.query("SELECT payload FROM otk_outbox WHERE tenant_id = $1 AND operation_id = $2 AND kind = 'submit_onchain'", [TENANT, opId])).rows[0].payload as
    { result?: { txHash: string }; auth: { operationRef: string; authorizationDigest: string; commitment: string } };
  const txHash = sub.result?.txHash ?? '';
  const reg = new ethers.Contract(chain.registry, chain.abi as string[], chain.rpc);
  chk(checks, 'registry_digest_matches', sub.auth.authorizationDigest.toLowerCase(), String(await reg.getFunction('registeredDigest')(sub.auth.operationRef)).toLowerCase());
  chk(checks, 'receipt_commitment_equals_authorization', commitment, sub.auth.commitment);
  const tx = await chain.rpc.getTransaction(txHash); const rc = await chain.rpc.getTransactionReceipt(txHash);
  chk(checks, 'tx_status_success', 1, rc?.status ?? null);
  const words = (hex: string) => hex.replace(/^0x/, '').match(/.{1,64}/g) ?? [];
  const pub = [...words(tx!.data.slice(10)), ...rc!.logs.flatMap((l) => [...l.topics.map((t) => t.slice(2)), ...words(l.data)])];
  const exact = [oracle.cuMicro(raw), raw.input + raw.output, raw.input, raw.output].map((v) => v.toString(16).padStart(64, '0'));
  chk(checks, 'no_exact_usage_on_chain', false, exact.some((w) => pub.includes(w)));
  const asText = Buffer.from(tx!.data.slice(2), 'hex').toString('latin1');
  chk(checks, 'no_tenant_or_operation_on_chain', false, asText.includes(TENANT) || asText.includes(opId));
  chk(checks, 'tx_hash', 'recorded', txHash ? 'recorded' : 'missing', !!txHash);
  (checks as Record<string, unknown>)['_chain'] = { ok: true, expected: null, observed: { txHash, block: rc?.blockNumber, gasUsed: rc?.gasUsed?.toString() } };
}

// ───────────────────────────── main ─────────────────────────────
async function main(): Promise<number> {
  const mode = arg('mode') as Mode | undefined; const phase = arg('phase') as Phase | undefined; const out = arg('out'); const besuDir = arg('besu-dir');
  if (!mode || !['synthetic', 'live'].includes(mode) || !phase || !['minimal', 'stream', 'disconnect', 'sample', 'besu', 'gate', 'campaign', 'cacheprobe'].includes(phase) || !out || !PROVIDER_KNOWN) {
    console.error('usage: [--provider=anthropic|openai|gemini] --mode=synthetic|live --phase=minimal|stream|disconnect|sample|besu|gate|campaign|cacheprobe --out=<dir> [--besu-dir=<dir>] [--start-index=K] [--max-calls=N] [--tenant-plan=STARTER]'); return 4;
  }
  if (phase === 'besu' && !besuDir) { console.error('phase besu needs --besu-dir'); return 4; }
  const adminUrl = process.env['OTK_PILOT_PG_URL'] ?? process.env['OTK_TEST_PG_URL'];
  if (!adminUrl) { console.error('environment: OTK_PILOT_PG_URL (or OTK_TEST_PG_URL) is required'); return 5; }
  const realKey = process.env[PROFILE.keyEnv];
  // audit OVN2 (MEDIUM): redact the key from every output from here on, including the preflight failure manifest
  if (realKey) secretsToRedact.push(realKey);
  if (mode === 'live' && !realKey) { console.error(`credential_missing: ${PROFILE.keyEnv} not set in this environment; no call made`); return 3; }
  let cases: Case[];
  try { cases = plan(phase, mode, !!besuDir); } catch (e) { console.error(String(e)); return 4; }
  // OVERNIGHT 2: bounded/resumable campaign slices (the slice is recorded in the manifest)
  const startIndex = Number(arg('start-index') ?? '0'); const maxCalls = arg('max-calls') === undefined ? Infinity : Number(arg('max-calls'));
  if (!Number.isInteger(startIndex) || startIndex < 0 || !(maxCalls === Infinity || (Number.isInteger(maxCalls) && maxCalls > 0))) { console.error('--start-index/--max-calls must be non-negative/positive integers'); return 4; }
  const allCases = cases.length;
  cases = cases.slice(startIndex, maxCalls === Infinity ? undefined : startIndex + maxCalls);
  // OVERNIGHT 2 (F-OVN2-08): labels excluded for a reason found OFFLINE and recorded in the manifest (e.g. a corpus text
  // with a lone UTF-16 surrogate that a provider rejects as invalid JSON); the same exclusion applies to every provider.
  const skipLabels = (arg('skip-labels') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const skipped = cases.filter((c) => skipLabels.includes(c.label)).map((c) => c.label);
  cases = cases.filter((c) => !skipLabels.includes(c.label));
  if (mode === 'live' && path.resolve(LIVE_LEDGER) !== path.resolve(CANONICAL_LEDGER) && process.env['OTK_PV3_TEST_HOOKS'] !== '1') {
    console.error(`ledger: live runs use only the canonical ledger ${CANONICAL_LEDGER}; refused ${LIVE_LEDGER}; no call made`); return 4;
  }
  fs.mkdirSync(out, { recursive: true });
  const runId = `pv3-${OPENAI ? 'openai-' : GEMINI ? `${PROFILE_NAME}-` : ''}${mode}-${phase}-${new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '').toLowerCase()}`;
  if (GEMINI) {
    // oracle of the weights ref: the published development table + the one documented addition, digested here
    const { developmentWeights } = await import('../../../src/operations/d1d8Ports.js');
    const ref = developmentWeights(PROFILE.weightsProfile).active()!.ref;
    if (ref.version !== PROFILE.weightsRef.version || ref.digest !== PROFILE.weightsRef.digest) { console.error(`weights profile ${PROFILE.weightsProfile} is ${ref.version}/${ref.digest}, expected ${PROFILE.weightsRef.version}/${PROFILE.weightsRef.digest}`); return 5; }
    WEIGHTS_REF_EXPECTED = PROFILE.weightsRef;
  }

  // git identity of the code under test
  const git = (a: string[]) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
  const manifest: Record<string, unknown> = { runId, provider: PROFILE.provider, mode, phase, commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), dirty: git(['status', '--porcelain']).split('\n').filter(Boolean).length,
    model: MODEL, policy: POLICY_ID, contextWindow: CONTEXT_WINDOW.toString(), maxOutput: MAX_OUTPUT.toString(), priceTable: { file: PRICE_TABLE_FILE, version: table.version, sha256: sha(fs.readFileSync(path.join(ROOT, PRICE_TABLE_FILE), 'utf8')) },
    weightsOracle: { ...WEIGHTS_REF_EXPECTED, profile: PROFILE.weightsProfile, provider: PROFILE.provider, wProviderMilli: W_PROVIDER_MILLI.toString(), model: PROFILE.priceModelKey, wModelMilli: W_MODEL_MILLI.toString(), developmentProfile: true, calibrated: false },
    ...(phase === 'campaign' || phase === 'cacheprobe' ? { campaign: { corpus: { ...CAMPAIGN_CORPUS, version: 'otk.calibration_corpus.synthetic.v1', sha256: corpusSha256(corpusToJsonl(generateCorpus(CAMPAIGN_CORPUS))) }, slice: { startIndex, maxCalls: maxCalls === Infinity ? null : maxCalls, of: allCases }, skippedLabels: skipped } } : {}),
    plannedCalls: cases.map((c) => ({ ...(c.meta ? { meta: c.meta } : {}), label: c.label, stream: c.stream, maxTokens: c.maxTokens, disconnect: !!c.disconnect, chain: !!c.chain, expect: c.expect, promptSha256: sha(c.prompt), promptChars: c.prompt.length,
      conservativeOtkReservePico: oracle.reservePico(c.maxTokens).toString() })) };

  // budget: canonical cumulative ledger (live) / run-local ledger (synthetic)
  const ledger = new BudgetLedger(mode === 'live' ? LIVE_LEDGER : path.join(out, `${runId}_synthetic_ledger.jsonl`));
  const before = ledger.summary();
  manifest['ledger'] = { file: mode === 'live' ? LIVE_LEDGER : 'run-local (synthetic, never the paid budget)', summaryBefore: before };
  const remainingPico = BigInt(Math.floor(before.remainingUsd * 1e6)) * 1_000_000n;

  // live preflight (free metadata call, no tokens): the model exists for this key
  if (mode === 'live') {
    const pf = PROFILE.preflight(realKey!);
    const mr = await fetch(pf.url, { headers: pf.headers }).catch((e) => ({ status: -1, json: async () => ({ error: redact(String(e)) }) }) as unknown as Response);
    const mj = await (mr as Response).json().catch(() => null) as Record<string, unknown> | null;
    const pid = GEMINI ? mj?.['name'] : mj?.['id'];
    manifest['preflightModelsApi'] = { url: pf.url, status: (mr as Response).status, id: pid ?? null, displayName: mj?.['display_name'] ?? mj?.['displayName'] ?? null,
      ...(GEMINI ? { version: mj?.['version'] ?? null, inputTokenLimit: mj?.['inputTokenLimit'] ?? null, outputTokenLimit: mj?.['outputTokenLimit'] ?? null, thinking: mj?.['thinking'] ?? null } : {}),
      ...(GEMINI && (mr as Response).status !== 200 ? { error: redact(JSON.stringify(mj?.['error'] ?? null)).slice(0, 400) } : {}) };
    if ((mr as Response).status !== 200 || pid !== PROFILE.preflightId) { fs.writeFileSync(path.join(out, `${runId}_manifest.json`), redact(JSON.stringify(manifest, null, 2))); console.error(`preflight: model ${MODEL} not available (status ${(mr as Response).status}); no paid call`); return 5; }
  }

  // isolated database + child entrypoint
  const dbName = `otk_pilot_v3_${runId.replace(/[^a-z0-9]/g, '_')}`.slice(0, 63);
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${dbName}"`); await admin.end();
  const u = new URL(adminUrl); u.pathname = `/${dbName}`; const dbUrl = String(u);
  manifest['database'] = dbName;
  const db = new pg.Pool({ connectionString: dbUrl, max: 4 }); db.on('error', () => {});
  const token = crypto.randomBytes(24).toString('hex'); secretsToRedact.push(token);
  const adminKey = crypto.randomBytes(16).toString('hex'); secretsToRedact.push(adminKey);
  const adminToken = crypto.randomBytes(24).toString('hex'); secretsToRedact.push(adminToken);
  const spoolDir = fs.mkdtempSync(path.join(path.resolve(out), 'spool-'));
  const [apiPort, proxyPort] = [await freePort(), await freePort()];
  let provider = null as SynthProvider | null;
  let chain: ChainCtx | null = null;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^OTK_|^PROVER_|_API_KEY$|_SECRET$|_TOKEN$/i.test(k)) env[k] = v;
  Object.assign(env, {
    // RUN-S (RV-RUNS-05/RV2-RUNS-02): unknown NODE_ENV labels now fail closed (PostgreSQL TLS, CSRF secret). This local
    // harness talks to a loopback test PostgreSQL; 'production-pilot' behaved as development in every check before, so
    // the label is now 'development' (same behaviour). Authentication stays on (OTK_TENANTS and OTK_ADMIN_KEY below).
    NODE_ENV: 'development', OTK_PROXY_ENABLED: '1', OTK_DB_URL: dbUrl, OTK_TENANTS: `${TENANT}/OPERATOR:${token},${TENANT}/ADMIN:${adminToken}`, API_PORT: String(apiPort), OTK_PROXY_PORT: String(proxyPort),
    OTK_ADMIN_KEY: adminKey, PROVER_URL: 'disabled', OTK_RECEIPT_LOG: '', OTK_SPOOL_DIR: spoolDir, OTK_INSTANCE_ID: `${runId}-i1`,
    OTK_CU_WEIGHTS_PROFILE: PROFILE.weightsProfile, OTK_PRICE_TABLE_FILES: PRICE_TABLE_FILE, OTK_OPERATION_RECOVERY_MS: '1000',
    OTK_MONEY_BOUND_POLICY: POLICY_ID,
  });
  // FINAL CLOSURE: calibration profiles for a TEST/DEMO run only (the parent's OTK_* variables are never inherited)
  const calibrationDir = arg('calibration-dir');
  if (calibrationDir) { env['OTK_CALIBRATION_PROFILES_DIR'] = path.resolve(calibrationDir); manifest['calibrationProfilesDir'] = { dir: path.resolve(calibrationDir), scope: 'demo/test environment only' }; }
  if (besuDir) {
    const netj = JSON.parse(fs.readFileSync(path.join(besuDir, 'network.json'), 'utf8')) as { rpc: string };
    const key = (n: string) => `0x${fs.readFileSync(path.join(besuDir, 'dev', `${n}.key`), 'utf8').trim()}`;
    const dep = JSON.parse(fs.readFileSync(path.join(besuDir, 'deploy_v3_besu.json'), 'utf8')) as { domain: { registry: string; chainId: string } };
    Object.assign(env, { OTK_V3_OPERATOR_KEY: key('operator'), OTK_V3_SUBMITTER_KEY: key('submitter'), OTK_V3_DEPLOYMENT_FILE: path.join(besuDir, 'deploy_v3_besu.json'), OTK_V3_RPC_URL: netj.rpc });
    secretsToRedact.push(key('operator').slice(2), key('submitter').slice(2));
    const { ethers } = await import('ethers');
    const { REGISTRY_V3_SUBMIT_ABI } = await import('../../../src/zk/v3/index.js');
    chain = { rpc: new ethers.JsonRpcProvider(netj.rpc, undefined, { staticNetwork: true }), registry: dep.domain.registry, abi: REGISTRY_V3_SUBMIT_ABI };
    manifest['chain'] = { rpc: netj.rpc, chainId: dep.domain.chainId, registry: dep.domain.registry, deployment: 'deploy_v3_besu.json (test deployment of this environment)' };
  } else {
    const ephemeral = `0x${crypto.randomBytes(32).toString('hex')}`; env['OTK_V3_OPERATOR_KEY'] = ephemeral; secretsToRedact.push(ephemeral.slice(2));
  }
  if (mode === 'synthetic') {
    const { ControllableProvider } = await import('../../../test/services/d1d8_c_provider.js');
    const p = new ControllableProvider() as unknown as SynthProvider;
    provider = p;
    await p.start();
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(p.url)) throw new Error(`synthetic provider is not loopback: ${p.url}`);
    Object.assign(env, { OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE: '1', [PROFILE.upstreamEnv]: p.url, [PROFILE.keyEnv]: PROFILE.fixtureKey, OTK_PROXY_FORWARD_HEADERS: PROFILE.forwardHeaders });
    const realKeyInChildEnv = !!realKey && Object.values(env).some((v) => typeof v === 'string' && v.includes(realKey));
    manifest['upstream'] = { kind: 'synthetic ControllableProvider (loopback)', url: p.url, realKeyInChildEnv };
    if (realKeyInChildEnv) { console.error('synthetic run aborted: the real key would reach the child'); await p.stop(); return 1; }
  } else {
    env[PROFILE.keyEnv] = realKey!;
    manifest['upstream'] = { kind: `${PROFILE.provider} API (real)`, override: 'none' };
  }

  let api = startApi(env, proxyPort);
  const results: Record<string, unknown>[] = [];
  let exit = 0;
  try {
    await poll('proxy health', async () => (await fetch(`${api.proxy}/health`).catch(() => null))?.ok, 120_000, 300);
    // OTK money budget of the run: strict mode under the profile's policy, ceiling = remaining cumulative balance
    const budgetId = `pilot-v3-${runId}`.slice(0, 120);
    await db.query('INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, money_policy) VALUES ($1, $2, $3::numeric, $4)', [budgetId, TENANT, remainingPico.toString(), POLICY_ID]);
    manifest['otkBudget'] = { budgetId, ceilingPico: remainingPico.toString(), correlation: 'same spend as the canonical ledger (not a second charge)' };
    // OVERNIGHT 2: the campaign tenant's plan (quota per epoch, counted in the legacy development CU) is raised explicitly
    // with --tenant-plan; the binding spend guard stays the money ceiling of the canonical ledger. Before any paid call.
    const tenantPlan = arg('tenant-plan');
    if (tenantPlan) {
      const pr = await fetch(`http://127.0.0.1:${apiPort}/admin/plans/assign`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': adminKey, authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ tenantId: TENANT, tier: tenantPlan }) });
      const pj = await pr.json().catch(() => null) as Record<string, unknown> | null;
      if (!pr.ok || pj?.['ok'] !== true) throw new Error(`tenant plan assignment failed: http ${pr.status} ${redact(JSON.stringify(pj)).slice(0, 200)} (before any paid call)`);
      manifest['tenantPlan'] = { tenantId: TENANT, tier: tenantPlan, why: 'campaign volume above the FREE quota of 10 000 legacy CU per epoch; spend still bounded by the canonical ledger and the OTK money budget' };
    }
    // OVERNIGHT 2 (DN-05): register the CLIENT_DECLARED project/application used by the campaign before any paid call
    const reg = cases.find((c) => c.attribution)?.attribution;
    if (reg) {
      for (const [what, body] of [['projects', { projectId: reg.projectId, label: 'OTK zk-Metering' }], ['applications', { applicationId: reg.applicationId, label: 'OVERNIGHT 2 campaign runner' }]] as const) {
        const rr = await fetch(`${api.proxy}/v1/attribution/${what}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        if (!rr.ok) throw new Error(`attribution ${what} registration failed: http ${rr.status} ${redact(await rr.text()).slice(0, 200)} (before any paid call)`);
      }
      manifest['attributionRegistered'] = { projectId: reg.projectId, applicationId: reg.applicationId, provenance: 'CLIENT_DECLARED' };
    }

    for (const c of cases) {
      const opId = `${runId}-${c.label}`.slice(0, 128);
      let reservation: { id: string; reservedUsd: number };
      try { reservation = ledger.reserve(`${runId}/${c.label}`, MODEL, maxInputTokensFor(MODEL), c.maxTokens); }
      catch (e) { console.error(`budget refusal before ${c.label}: ${(e as Error).message}`); exit = e instanceof BudgetError ? 2 : 1; break; }
      // synthetic disconnect: hold the provider's final event until the client is gone
      let barrier: { promise: Promise<void>; release(): void } | null = null;
      if (provider && c.disconnect) {
        let rel!: () => void; barrier = { promise: new Promise<void>((r) => { rel = r; }), release: () => rel() };
        provider.finalBarriers.push(barrier);
      }
      const callsBefore = provider?.calls.length ?? 0;
      const obs = await callProxy(api.proxy, token, opId, c, mode === 'synthetic');
      barrier?.release();
      const v = await verify(db, api.proxy, token, opId, c, obs, budgetId, c.chain ? chain : null);
      if (provider) chk(v.checks, 'synthetic_provider_called_once', 1, provider.calls.length - callsBefore);
      // canonical ledger: settled only from a provider-reported usage; anything else stays uncertain
      const st = settlementFor({ provider: PROFILE.provider, httpStatus: obs.status, clientComplete: obs.stopped && !obs.aborted, clientUsage: obs.usage,
        otkMeasurement: v.row?.measurement ?? null, otkMoneyState: (v.row?.money?.['state'] as string | undefined) ?? null, otkCategories: v.row?.usage?.categories ?? null });
      const settled = ledger.settle(reservation.id, { httpStatus: st.httpStatus, usage: st.usage,
        errorBody: !!obs.error && (obs.status ?? 0) >= 400, note: obs.error ? redact(obs.error) : undefined, providerMessageId: obs.messageId, providerRequestId: obs.requestId });
      chk(v.checks, 'ledger_settlement', c.expect === 'final' ? 'ok' : 'uncertain', settled.outcome);
      const allOk = Object.entries(v.checks).every(([k, x]) => k.startsWith('_') || x.ok);
      const record = { runId, label: c.label, opId, stream: c.stream, disconnect: !!c.disconnect, expect: c.expect, httpStatus: obs.status, error: obs.error ? redact(obs.error) : undefined,
        latencyMs: obs.latencyMs, firstChunkMs: obs.firstChunkMs, aborted: obs.aborted, providerMessageId: obs.messageId, returnedModel: obs.model, clientUsage: obs.usage ?? null,
        responseTextSha256: sha(obs.text), responseChars: obs.text.length, meta: c.meta ?? null, attribution: c.attribution ?? null,
        conference: v.conference ?? null, otkUsageCategories: v.row?.usage?.categories ?? null, otkModelReturned: v.row?.usage?.modelReturned ?? null, ledgerReservation: { id: reservation.id, reservedUsd: reservation.reservedUsd, settlement: settled.outcome, settlementSource: st.source, costUsd: settled.costUsd ?? null },
        otk: v.row ? { execution: v.row.execution, measurement: v.row.measurement, delivery: v.row.delivery, cuState: v.row.st, moneyState: v.row.money?.['state'] ?? null, reservedMoneyPico: v.row.reserved_money } : null,
        oracle: v.raw ? { cuMicro: oracle.cuMicro(v.raw).toString(), costPico: oracle.costPico(v.raw).toString() } : null,
        checks: v.checks, consistent: allOk };
      fs.appendFileSync(path.join(out, `${runId}_calls.jsonl`), redact(JSON.stringify(record)) + '\n');
      results.push(record);
      console.log(`${c.label}: http=${obs.status ?? '-'} otk=${v.row?.execution}/${v.row?.measurement}/${v.row?.money?.['state'] ?? '-'} ledger=${settled.outcome} consistent=${allOk}`);
      if (!allOk) { exit = 1; break; }
    }

    if (exit === 0 && cases.some((c) => c.attribution)) {
      const sm = await fetch(`${api.proxy}/v1/attribution/summary`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
      fs.writeFileSync(path.join(out, `${runId}_attribution_summary.json`), redact(JSON.stringify(sm, null, 2)));
    }
    // restart: same database, spool and instance id; nothing may be duplicated, re-sent or released. Synthetic only:
    // there the provider counts every request, so a re-send would be seen; in live it could not be observed.
    if (exit === 0 && mode === 'synthetic' && (phase === 'gate' || phase === 'sample')) {
      const snap = async () => (await db.query(`SELECT (SELECT count(*) FROM otk_operations WHERE tenant_id = $1)::int AS ops, (SELECT count(*) FROM otk_ledger WHERE tenant_id = $1)::int AS debits,
        (SELECT count(*) FROM otk_money_ledger WHERE tenant_id = $1)::int AS money, (SELECT count(*) FROM otk_receipts_v3 WHERE tenant_id = $1)::int AS receipts,
        (SELECT count(*) FROM otk_operations WHERE tenant_id = $1 AND money->>'state' = 'held_uncertain')::int AS uncertain`, [TENANT])).rows[0];
      const s0 = await snap(); const calls0 = provider?.calls.length ?? null;
      await stopApi(api);
      api = startApi(env, proxyPort);
      await poll('proxy health after restart', async () => (await fetch(`${api.proxy}/health`).catch(() => null))?.ok, 120_000, 300);
      await new Promise((r) => setTimeout(r, 5_000)); // let at least one recovery pass (OTK_OPERATION_RECOVERY_MS=1000) and outbox pass run
      const s1 = await snap();
      const calls1 = provider?.calls.length ?? null;
      const restart = { before: s0, after: s1, providerCalls: { before: calls0, after: calls1 }, ok: JSON.stringify(s0) === JSON.stringify(s1) && calls0 === calls1 };
      fs.writeFileSync(path.join(out, `${runId}_restart.json`), JSON.stringify(restart, null, 2));
      console.log(`restart: ${restart.ok ? 'no duplicate/re-send/release' : 'DIVERGENCE'} ${JSON.stringify(s1)}`);
      if (!restart.ok) exit = 1;
    }
  } catch (e) {
    console.error(`run aborted: ${redact(String(e))}`); exit = exit || 1;
  } finally {
    await stopApi(api);
    const logText = redact(api.log.join(''));
    fs.writeFileSync(path.join(out, `${runId}_entrypoint.log.txt`), logText);
    const leaked = secretsToRedact.some((s) => s && api.log.join('').includes(s));
    manifest['entrypointLogRedactedSecrets'] = leaked ? 'secret values were present in the child log and were redacted in the evidence' : 'no secret value in the child log';
    manifest['ledgerAfter'] = ledger.summary();
    if (provider) {
      manifest['syntheticProviderCalls'] = provider.calls.length;
      const seen = !!realKey && provider.calls.some((pc) => JSON.stringify(pc).includes(realKey));
      (manifest['upstream'] as Record<string, unknown>)['realKeySeenByProvider'] = seen;
      if (seen) { console.error('the real key reached the synthetic provider'); exit = 1; }
      await provider.stop();
    }
    chain?.rpc.destroy();
    await db.end();
  }
  const summary = { runId, mode, phase, calls: results.length, planned: cases.length, consistent: results.filter((r) => r['consistent']).length, exit, ledgerAfter: manifest['ledgerAfter'] };
  fs.writeFileSync(path.join(out, `${runId}_manifest.json`), redact(JSON.stringify(manifest, null, 2)));
  fs.writeFileSync(path.join(out, `${runId}_summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  return exit;
}

main().then((code) => process.exit(code), (e) => { console.error(redact(String((e as Error)?.stack ?? e))); process.exit(1); });
