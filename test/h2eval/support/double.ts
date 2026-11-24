/**
 * Test doubles (OFFLINE only): a pure ProviderAdapter over the anthropic.messages shape, an in-memory ContentStore, a price table
 * fixture and an egress double that answers from a script. No network, no credential, no content in logs.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Hex } from '../../../scripts/h2eval/core/canon.js';
import { loadPriceTable } from '../../../scripts/h2eval/record/prices.js';
import { cacheObservedOf } from '../../../scripts/h2eval/record/usage.js';
import { H2EVAL_SCHEMA, type BuiltRequest, type ContentStore, type Count, type NormalizedUsageH2, type OperationPlan, type ParsedRefusal, type ProviderAdapter, type ResolvedContent } from '../../../scripts/h2eval/types.js';
import type { ModelSupport } from '../../../src/types/d1d8/index.js';

export const MODEL = 'sim-haiku';
export const OFFICIAL_HOST = 'api.anthropic.com';

export function tmp(prefix: string): string { return mkdtempSync(path.join(tmpdir(), `h2eval-${prefix}-`)); }

/** Price fixture (otk.price_table.v1): input 1.00, output 5.00, cache read 0.10, cache write 1.25 USD/MTok (micro-USD) — synthetic. */
export function writePriceFixture(dir: string, over: { omit?: string[] } = {}): string {
  const entries = [
    { provider: 'anthropic', model: MODEL, category: 'input', pricePerMTokMicroUsd: '1000000' },
    { provider: 'anthropic', model: MODEL, category: 'output', pricePerMTokMicroUsd: '5000000' },
    { provider: 'anthropic', model: MODEL, category: 'input_cache_read', pricePerMTokMicroUsd: '100000' },
    { provider: 'anthropic', model: MODEL, category: 'input_cache_write', pricePerMTokMicroUsd: '1250000' },
  ].filter((e) => !(over.omit ?? []).includes(e.category)).map((e) => ({ ...e, effectiveFrom: '2026-10-01T00:00:00.000Z', effectiveUntil: null, source: 'SYNTHETIC test fixture' }));
  const p = path.join(dir, 'prices.json');
  writeFileSync(p, JSON.stringify({ schema: 'otk.price_table.v1', version: 'h2eval-test-fixture-v1', currency: 'USD', capturedUtc: '2026-10-01T00:00:00.000Z', entries }));
  return p;
}
export const prices = (dir: string, over?: { omit?: string[] }) => loadPriceTable(writePriceFixture(dir, over));

export function memoryContentStore(texts: Record<string, string>): ContentStore & { sha: Record<string, string> } {
  const byHash: Record<string, ResolvedContent> = {}; const sha: Record<string, string> = {};
  for (const [name, text] of Object.entries(texts)) {
    const h = sha256Hex(text); sha[name] = h;
    byHash[h] = { promptSha256: h, messages: [{ role: 'user', parts: [{ type: 'text', text }] }], prefixMessages: 'NOT_APPLICABLE' };
  }
  return { sha, get: async (h) => { const c = byHash[h]; if (!c) throw new Error('content not found'); return c; }, getBytes: async () => new Uint8Array() };
}

export const PROTOCOL = 'a'.repeat(64);
export function plan(over: Partial<OperationPlan> & { promptSha256: string }): OperationPlan {
  return {
    schema: H2EVAL_SCHEMA.plan, studyId: 'h2eval-test', protocolHash: PROTOCOL, manifestSha256: 'b'.repeat(64), batchId: 'batch1', phase: 'PILOT', cellId: 'C1', groupId: 'G1', promptId: 'P1', rep: 1, variant: 'v1', split: 'NONE',
    provider: 'anthropic', api: 'anthropic.messages', endpoint: 'POST /v1/messages', modelRequested: MODEL, task: 'summary', sizeBucket: 'S', structure: 'S1', modality: 'text', plannedCacheArm: 'S1',
    prefixSha256: 'NOT_APPLICABLE', nonce: 'NOT_APPLICABLE', params: { maxTokens: 64, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'standard_only', cacheDirectives: 'NONE', thinking: { mode: 'none' }, cacheTtlRequested: 'NOT_APPLICABLE' }, ...over,
  };
}

export type ScriptedBody = { kind: 'ok'; input?: number; output?: number; read?: number; write?: number } | { kind: 'refuse_with_usage'; input: number } | { kind: 'error_no_usage' } | { kind: 'usage_missing_fields' };

/** Anthropic-like bodies the double adapter understands. */
export function bodyOf(s: ScriptedBody): { status: number; body: unknown } {
  if (s.kind === 'ok') return { status: 200, body: { id: 'msg_sim', type: 'message', model: MODEL, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: s.input ?? 300, output_tokens: s.output ?? 20, cache_read_input_tokens: s.read ?? 0, cache_creation_input_tokens: s.write ?? 0, service_tier: 'standard' } } };
  if (s.kind === 'refuse_with_usage') return { status: 200, body: { id: 'msg_sim', type: 'message', model: MODEL, content: [], stop_reason: 'refusal', usage: { input_tokens: s.input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' } } };
  if (s.kind === 'error_no_usage') return { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'SYN' } } };
  return { status: 200, body: { id: 'msg_sim', type: 'message', model: MODEL, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10 } } };
}

const c = (v: unknown): Count => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 'UNKNOWN');

export function doubleAdapter(): ProviderAdapter {
  const support: ModelSupport = { provider: 'anthropic', api: 'anthropic.messages', modelRequested: MODEL, catalogKey: MODEL, support: 'generic_fallback', catalogVersion: 'test', tokenizer: { package: 'js-tiktoken', packageVersion: '1.0.21', encoding: 'cl100k_base', vocabularyDigest: null, messageAssembly: { id: 'otk.assembly.text_parts', version: '1' } } };
  return {
    provider: 'anthropic', api: 'anthropic.messages', adapterVersion: 'test-double-v1', officialHosts: [OFFICIAL_HOST],
    buildRequest(p: OperationPlan, content: ResolvedContent): BuiltRequest {
      const messages = content.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.parts.map((x) => (x.type === 'text' ? { type: 'text', text: x.text } : { type: x.type })) }));
      const body = { model: p.modelRequested, max_tokens: p.params.maxTokens, service_tier: p.params.serviceTier, messages, ...(p.nonce !== 'NOT_APPLICABLE' ? { metadata: { user_id: p.nonce } } : {}) };
      const nonText = content.messages.flatMap((m) => m.parts).filter((x) => x.type !== 'text').map((x) => ({ kind: x.type as 'image' | 'audio', units: 'UNKNOWN' as const, unit: x.type === 'audio' ? 'seconds' : 'pixels' }));
      return { url: `https://${OFFICIAL_HOST}/v1/messages`, method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, credentialHeader: 'x-api-key', credentialFormat: 'raw', body, textParts: content.messages.flatMap((m) => m.parts).filter((x) => x.type === 'text').map((x) => (x as { text: string }).text), nonTextParts: nonText };
    },
    parseRefusal(status, body): ParsedRefusal {
      const b = body as Record<string, unknown> | null;
      if (status >= 400) return { refused: true, code: status === 429 ? 'rate_limit' : 'http_error', httpStatus: status, usagePresent: Boolean(b && typeof b['usage'] === 'object') };
      if (b && b['stop_reason'] === 'refusal') return { refused: true, code: 'policy', httpStatus: status, usagePresent: true };
      return { refused: false, code: 'NONE', httpStatus: status, usagePresent: Boolean(b && typeof b['usage'] === 'object') };
    },
    parseUsage(body): NormalizedUsageH2 {
      const b = body as Record<string, unknown> | null; const u = (b && typeof b['usage'] === 'object' ? b['usage'] : null) as Record<string, unknown> | null;
      const base = { schema: H2EVAL_SCHEMA.usage, cacheWrite5m: 'NOT_APPLICABLE' as const, cacheWrite1h: 'NOT_APPLICABLE' as const, imageUnits: 'NOT_APPLICABLE' as const, audioUnits: 'NOT_APPLICABLE' as const, toolTokens: 'NOT_APPLICABLE' as const, usageSource: 'provider_response' as const, serviceTierServed: 'UNKNOWN' as const, stopReason: 'UNKNOWN' as const, completion: 'UNKNOWN' as const, outputTotal: 'UNKNOWN' as const };
      if (!u) return { ...base, inputUncached: 'UNKNOWN', cacheRead: 'UNKNOWN', cacheWrite: 'UNKNOWN', outputVisible: 'UNKNOWN', reasoning: 'UNKNOWN', U: 'UNKNOWN', usageCompleteness: 'MISSING', rawUsageSanitized: {}, modelServed: typeof b?.['model'] === 'string' ? (b['model'] as string) : 'UNKNOWN', cacheObserved: 'UNKNOWN' };
      const inputUncached = c(u['input_tokens']); const cacheRead = c(u['cache_read_input_tokens']); const cacheWrite = c(u['cache_creation_input_tokens']); const outputVisible = c(u['output_tokens']);
      const complete = [inputUncached, cacheRead, cacheWrite, outputVisible].every((x) => typeof x === 'number');
      const U: Count = complete ? (inputUncached as number) + (cacheRead as number) + (cacheWrite as number) : 'UNKNOWN';
      const raw: Record<string, number> = {}; for (const [k, v] of Object.entries(u)) if (typeof v === 'number') raw[k] = v;
      const partial = { ...base, inputUncached, cacheRead, cacheWrite, outputVisible, reasoning: 'NOT_APPLICABLE' as const, U, usageCompleteness: complete ? 'COMPLETE' as const : 'PARTIAL' as const, rawUsageSanitized: raw, modelServed: typeof b?.['model'] === 'string' ? (b['model'] as string) : 'UNKNOWN' as const, serviceTierServed: typeof u['service_tier'] === 'string' ? (u['service_tier'] as string) : 'UNKNOWN' as const };
      const stopReason = typeof b?.['stop_reason'] === 'string' ? (b['stop_reason'] as string) : 'UNKNOWN';
      return { ...partial, cacheObserved: cacheObservedOf(partial), stopReason, completion: stopReason === 'max_tokens' ? 'TRUNCATED_MAX_TOKENS' : stopReason === 'end_turn' ? 'COMPLETE' : stopReason === 'refusal' ? 'REFUSED' : stopReason === 'UNKNOWN' ? 'UNKNOWN' : 'OTHER', outputTotal: outputVisible };
    },
    modelSupport: () => support,
    modelDeprecation: (m) => (m === MODEL ? 'LEGACY' : 'UNKNOWN'),
  };
}

/** Egress double: answers from a script, in order; a step may be 'throw' (send failure => UNCERTAIN). Never reads the credential. */
export function scriptedDouble(steps: Array<ScriptedBody | 'throw'>) {
  const seen: BuiltRequest[] = [];
  return { seen, double: async (req: BuiltRequest) => { seen.push(req); const s = steps.shift() ?? ({ kind: 'ok' } as ScriptedBody); if (s === 'throw') throw new Error('SYN_SEND_FAILURE'); const { status, body } = bodyOf(s); return { httpStatus: status, body }; } };
}
