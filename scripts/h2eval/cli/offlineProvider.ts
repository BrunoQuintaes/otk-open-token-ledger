/**
 * R15 — OFFLINE simulated provider for `run --mode offline` (the only executable mode). Produces COMPLETE response bodies in the
 * documented shapes the MET-02 parsers read (R08), with the cache semantics of R08 §4 simulated over the request body:
 *   anthropic: explicit cache_control (system block or last prefix message), TTL 5m/1h, minimum prefix; writes/reads reported
 *   openai   : implicit prefix cache, cached_tokens rounded down to 128, minimum prefix
 *   gemini   : implicit prefix cache, cachedContentTokenCount only when > 0 (as observed in the H1)
 * Token counts are a deterministic local approximation (ceil(chars/4)) — never a provider count. Time is the planned offset, not a
 * clock. Fault injection (by operation index) lets the rehearsal show error-without-usage, refusal-with-usage and send failure.
 * No network, no credential, no logging of content.
 *
 * Created by `./run.ts` for offline runs and plugged into the egress (`../core/egress.ts`) as an `EgressDouble`, so the runner exercises the same request,
 * parsing, journal and ledger path as a real run while nothing leaves the machine. The cache store lives in memory
 * and lasts for one provider instance.
 *
 * @module scripts/h2eval/cli/offlineProvider
 */
import { createHash } from 'node:crypto';
import type { BuiltRequest } from '../types.js';
import type { EgressDouble, EgressResponse } from '../core/egress.js';

/** Behaviour of the simulated provider; every field is optional and has a default. */
export interface OfflineProviderConfig {
  /** Minimum cacheable prefix per provider, in simulated tokens (default 1024 each). */
  minPrefixTokens?: Partial<Record<'openai' | 'anthropic' | 'google', number>>;
  /** Cache TTL in seconds (default 300); an Anthropic block marked `ttl: '1h'` uses 3600. */
  ttlSeconds?: number;
  /** Output tokens reported by every successful call (default 24). */
  outputTokens?: number;
  /** reasoning tokens reported for models that think (haiku-5-5 thinking_tokens, gemini thoughtsTokenCount) */
  thinkingTokens?: number;
  /** seconds between consecutive calls (planned interval) */
  intervalSeconds?: number;
  /** fault injection by 0-based call index */
  /** fault injection by 0-based call index; VNEXT-7: 'tls' reproduces the R17-001 send failure (fetch failed, cause.code UNABLE_TO_VERIFY_LEAF_SIGNATURE) */
  faults?: Record<number, 'error_no_usage' | 'refusal_with_usage' | 'throw' | 'rate_limit' | 'hang' | 'tls' | 'reject_disabled' | 'no_stop_reason'>;
  /** VNEXT-7 (C151 item 7): reproduce the behaviours OBSERVED in the real R17 pilot: the provider counts ~inputTokenFactor x the local cl100k estimate
   * (1.45-1.58 observed on Haiku 5.5), and adaptive thinking on a single-turn prompt without system (S1) consumes the whole max_tokens
   * (output_tokens = thinking_tokens = max_tokens, visible 0, stop_reason max_tokens) unless the request disabled thinking. */
  realism?: { inputTokenFactor?: number; thinkingConsumesCapOnSingleTurnNoSystem?: boolean };
  /** Token counter for the simulated usage; default ceil(characters / 4). */
  tokensOf?: (text: string) => number;
  /** send timeout handed to the egress (R15-M5); a fault 'hang' never resolves so the timeout fires */
  timeoutMs?: number;
}

const approx = (t: string): number => Math.ceil(t.length / 4);
const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
interface Entry { expiresAt: number; ttl: number }

/**
 * Creates a simulated provider that answers built requests offline with complete, documented response bodies.
 *
 * The provider is chosen from the request host (`api.openai.com`, `api.anthropic.com`, anything else is Gemini). The
 * simulated time of call `i` is `i * intervalSeconds`, so cache expiry is deterministic.
 *
 * @param cfg - Simulation settings and fault injection.
 * @returns `double`, the egress double to hand to the runner; `calls`, the number of calls received so far; and
 *   `log`, one entry per answered call with the cache key and the simulated read/write tokens.
 * @example
 * const sim = createOfflineProvider({ faults: { 2: 'rate_limit' } });
 * // pass sim.double to the runner as its egress double; after the run, sim.log has one entry per call
 */
export function createOfflineProvider(cfg: OfflineProviderConfig = {}): { double: EgressDouble; calls: number; readonly log: Array<{ index: number; api: string; cacheKey: string | null; read: number; write: number }> } {
  const store = new Map<string, Entry>();
  const baseTok = cfg.tokensOf ?? approx; const factor = cfg.realism?.inputTokenFactor ?? 1;
  const tok = (t: string): number => Math.ceil(baseTok(t) * factor);
  const minP = { openai: 1024, anthropic: 1024, google: 1024, ...(cfg.minPrefixTokens ?? {}) };
  const ttl = cfg.ttlSeconds ?? 300; const out = cfg.outputTokens ?? 24; const think = cfg.thinkingTokens ?? 16; const interval = cfg.intervalSeconds ?? 20;
  const log: Array<{ index: number; api: string; cacheKey: string | null; read: number; write: number }> = [];
  let index = 0;
  const alive = (k: string, now: number): Entry | null => { const e = store.get(k); return e && now <= e.expiresAt ? e : null; };

  const anthropic = (body: Record<string, unknown>, now: number) => {
    const model = String(body['model']);
    const sysRaw = body['system'];
    const sysBlocks: Array<{ text: string; cache_control?: { type: string; ttl?: string } }> = typeof sysRaw === 'string' ? [{ text: sysRaw }] : Array.isArray(sysRaw) ? (sysRaw as Array<{ text: string; cache_control?: { type: string; ttl?: string } }>) : [];
    const msgs = (body['messages'] as Array<{ role: string; content: Array<{ text?: string; cache_control?: { type: string; ttl?: string } }> | string }>) ?? [];
    const blocks: Array<{ text: string; cache_control?: { type: string; ttl?: string } }> = [...sysBlocks];
    for (const m of msgs) { if (typeof m.content === 'string') blocks.push({ text: m.content }); else for (const b of m.content) blocks.push({ text: b.text ?? '', cache_control: b.cache_control }); }
    const total = tok(blocks.map((b) => b.text).join('\n'));
    const markIdx = blocks.findIndex((b) => b.cache_control);
    let write = 0; let read = 0; let w5 = 0; let w1 = 0; let key: string | null = null;
    if (markIdx >= 0) {
      const prefix = blocks.slice(0, markIdx + 1).map((b) => b.text).join('\n'); const pt = tok(prefix);
      if (pt >= minP.anthropic) {
        const t = blocks[markIdx]!.cache_control!.ttl === '1h' ? 3600 : ttl; key = `A|${h(prefix)}`;
        const e = alive(key, now);
        if (e) { read = pt; e.expiresAt = now + e.ttl; } else { write = pt; if (t === 3600) w1 = pt; else w5 = pt; store.set(key, { expiresAt: now + t, ttl: t }); }
      }
    }
    const disabled = (body['thinking'] as { type?: string } | undefined)?.type === 'disabled';
    const adaptive = (model === 'claude-haiku-5-5' || model === 'claude-sonnet-5-5' || model === 'claude-opus-5-5') && !disabled; // adaptive thinking is on by default on Haiku 5.5 (with or without output_config)
    const singleTurnNoSystem = sysBlocks.length === 0 && msgs.length === 1;
    const maxTokens = typeof body['max_tokens'] === 'number' ? (body['max_tokens'] as number) : 256;
    if (adaptive && cfg.realism?.thinkingConsumesCapOnSingleTurnNoSystem && singleTurnNoSystem) {
      // R17 observed: 6/6 S1 calls spent the whole ceiling on thinking and returned no visible text
      const usageT: Record<string, unknown> = { input_tokens: total - read - write, cache_creation_input_tokens: write, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens: maxTokens, output_tokens_details: { thinking_tokens: maxTokens }, service_tier: 'standard', inference_geo: 'global', speed: 'standard' };
      return { key, read, write, body: { id: 'msg_offline', type: 'message', role: 'assistant', model, content: [], stop_reason: 'max_tokens', stop_sequence: null, usage: usageT } };
    }
    const thinks = adaptive && !singleTurnNoSystem ? false : adaptive; // R17 observed: dialogues (system + turns) did not think
    const usage: Record<string, unknown> = { input_tokens: total - read - write, cache_creation_input_tokens: write, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens: out + (thinks ? think : 0), service_tier: 'standard', inference_geo: 'global', speed: 'standard' };
    if (adaptive) usage['output_tokens_details'] = { thinking_tokens: thinks ? think : 0 }; // adaptive models report the detail (0 when they did not think); disabled/manual-only do not
    return { key, read, write, body: { id: 'msg_offline', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Resposta simulada.' }], stop_reason: 'end_turn', stop_sequence: null, usage } };
  };
  const openai = (body: Record<string, unknown>, now: number) => {
    const msgs = body['messages'] as Array<{ role: string; content: string | Array<{ text?: string }> }>;
    const txt = (c: string | Array<{ text?: string }>) => (typeof c === 'string' ? c : c.map((p) => p.text ?? '').join(''));
    const total = tok(msgs.map((m) => txt(m.content)).join('\n')); const first = txt(msgs[0]!.content); const ft = tok(first);
    let cached = 0; let key: string | null = null;
    if (ft >= minP.openai) { key = `O|${h(first)}`; const e = alive(key, now); if (e) { cached = Math.floor(ft / 128) * 128; e.expiresAt = now + e.ttl; } else store.set(key, { expiresAt: now + ttl, ttl }); }
    const r0 = { key, read: cached, write: 0, body: { id: 'chatcmpl-offline', object: 'chat.completion', model: String(body['model']), service_tier: 'default', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Resposta simulada.' } }], usage: { prompt_tokens: total, completion_tokens: out, total_tokens: total + out, prompt_tokens_details: { cached_tokens: cached, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } } } };
    if (body['model'] === 'gpt-6-luna') { // E3G4 (B5): o luna informa a escrita de cache (DR-208; mesmo campo do Bot); sem ela a usage nao fecha. Sem escrita no simulador => 0
      ((r0.body.usage as Record<string, unknown>)['prompt_tokens_details'] as Record<string, unknown>)['cache_write_tokens'] = 0;
    }
    return r0;
  };
  const gemini = (body: Record<string, unknown>, now: number, url = '') => {
    const contents = body['contents'] as Array<{ role: string; parts: Array<{ text?: string }> }>;
    const si = ((body['systemInstruction'] as { parts: Array<{ text: string }> } | undefined)?.parts ?? []).map((p) => p.text).join('\n');
    const total = tok([si, ...contents.flatMap((c) => c.parts.map((p) => p.text ?? ''))].join('\n')); const ft = tok(si);
    let cached = 0; let key: string | null = null;
    if (ft >= minP.google) { key = `G|${h(si)}`; const e = alive(key, now); if (e) { cached = Math.floor(ft / 16) * 16; e.expiresAt = now + e.ttl; } else store.set(key, { expiresAt: now + ttl, ttl }); }
    const um: Record<string, unknown> = { promptTokenCount: total, candidatesTokenCount: out, thoughtsTokenCount: think, totalTokenCount: total + out + think, promptTokensDetails: [{ modality: 'TEXT', tokenCount: total }], serviceTier: 'standard' };
    if (cached > 0) { um['cachedContentTokenCount'] = cached; um['cacheTokensDetails'] = [{ modality: 'TEXT', tokenCount: cached }]; }
    return { key, read: cached, write: 0, body: { candidates: [{ content: { parts: [{ text: 'Resposta simulada.' }], role: 'model' }, finishReason: 'STOP', index: 0 }], usageMetadata: um, modelVersion: /\/models\/gemini-3\.1-flash-lite:/.test(url) ? 'gemini-3.1-flash-lite' : 'gemini-3.5-flash-lite', responseId: 'offline' } }; // E3G4 (B5): o modelo do braco responde com o proprio id
  };

  const double: EgressDouble = async (req: BuiltRequest): Promise<EgressResponse> => {
    const i = index; index += 1; const now = i * interval;
    const fault = cfg.faults?.[i];
    if (fault === 'throw') throw new Error('OFFLINE_SIMULATED_SEND_FAILURE');
    if (fault === 'tls') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
    if (fault === 'hang') return new Promise<EgressResponse>(() => { /* never resolves: the egress timeout classifies it as TIMEOUT_UNCERTAIN */ });
    const host = new URL(req.url).hostname;
    const api = host === 'api.openai.com' ? 'openai' : host === 'api.anthropic.com' ? 'anthropic' : 'google';
    // VNEXT-8: R4 contingency rehearsal — the account rejects thinking: {type: disabled} with HTTP 400 (invalid_request_error), no usage
    if (fault === 'reject_disabled' && api === 'anthropic' && (req.body as { thinking?: { type?: string } }).thinking?.type === 'disabled') { log.push({ index: i, api, cacheKey: null, read: 0, write: 0 }); return { httpStatus: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'simulated: thinking.type disabled not supported' } } }; }
    if (fault === 'error_no_usage' || fault === 'rate_limit') {
      const status = fault === 'rate_limit' ? 429 : 500;
      log.push({ index: i, api, cacheKey: null, read: 0, write: 0 });
      if (api === 'anthropic') return { httpStatus: status, body: { type: 'error', error: { type: fault === 'rate_limit' ? 'rate_limit_error' : 'api_error', message: 'simulated' } } };
      if (api === 'openai') return { httpStatus: status, body: { error: { message: 'simulated', type: fault === 'rate_limit' ? 'rate_limit_error' : 'server_error', code: fault === 'rate_limit' ? 'rate_limit_exceeded' : null } } };
      return { httpStatus: status, body: { error: { code: status, message: 'simulated', status: fault === 'rate_limit' ? 'RESOURCE_EXHAUSTED' : 'INTERNAL' } } };
    }
    const r = api === 'anthropic' ? anthropic(req.body as Record<string, unknown>, now) : api === 'openai' ? openai(req.body as Record<string, unknown>, now) : gemini(req.body as Record<string, unknown>, now, req.url);
    log.push({ index: i, api, cacheKey: r.key, read: r.read, write: r.write });
    if (fault === 'no_stop_reason') { const b = r.body as Record<string, unknown>; delete b['stop_reason']; for (const c of (b['choices'] as Array<Record<string, unknown>> | undefined) ?? []) delete c['finish_reason']; for (const c of (b['candidates'] as Array<Record<string, unknown>> | undefined) ?? []) delete c['finishReason']; }
    if (fault === 'refusal_with_usage') {
      const b = r.body as Record<string, unknown>;
      if (api === 'anthropic') { b['content'] = []; b['stop_reason'] = 'refusal'; }
      else if (api === 'openai') (b['choices'] as Array<Record<string, unknown>>)[0]!['finish_reason'] = 'content_filter';
      else (b['candidates'] as Array<Record<string, unknown>>)[0]!['finishReason'] = 'SAFETY';
    }
    return { httpStatus: 200, body: r.body };
  };
  return { double, get calls() { return index; }, log };
}
