/**
 * Dublês OFFLINE dos provedores para o estudo de cache (R13). Simulam só a SEMÂNTICA de cache descrita no R08 §4, sobre o corpo do pedido
 * (sem rede, sem relógio: o tempo é um argumento). Cada dublê devolve o objeto de uso no formato cru da API:
 *   OpenAI    usage.prompt_tokens(_details.cached_tokens), múltiplos de 128, automático, mínimo configurável
 *   Anthropic usage.input_tokens / cache_creation_input_tokens / cache_read_input_tokens / cache_creation.ephemeral_*, exige cache_control, mínimo e TTL
 *   Gemini    usageMetadata.promptTokenCount (+ cachedContentTokenCount só quando > 0, como na H1), implícito
 * Modos de falha: ignoreMarks (provedor ignora a marcação), partialFraction (hit parcial), noUsage (resposta sem uso), stripNonce (controle contaminado).
 *
 * English summary: offline test doubles of the OpenAI, Anthropic and Gemini prompt caches. A {@link SimProvider}
 * receives a request body exactly as the cache planner renders it and returns a raw `usage` object in that
 * provider's own shape, so the cache classifier can be exercised end to end without network or a real clock
 * (time is an argument in seconds). Only cache semantics are simulated: a stable prefix at or above
 * `minPrefixTokens` is stored on the first call and read on later calls until its TTL expires; OpenAI rounds the
 * cached count down to a multiple of 128 and Gemini to a multiple of 16; Anthropic caches only when a block carries
 * `cache_control` (TTL `1h` = 3600 s, otherwise `ttlSeconds`). Token counts come from `tokensOf` or a cheap
 * `ceil(chars / 4)` estimate, never from a real tokenizer.
 *
 * Used by `test/h2eval/cache/sim_e2e.test.ts`.
 *
 * @module test/h2eval/cache/doubles
 */
import { createHash } from 'node:crypto';
import type { Provider } from '../../../scripts/h2eval/cache/classify.js';

/**
 * Behaviour of one simulated provider cache.
 *
 * `minPrefixTokens` is the smallest cacheable prefix (tokens); `ttlSeconds` is how long a stored prefix stays
 * readable (seconds, refreshed on every hit). The optional flags inject failure modes: `ignoreMarks` (Anthropic
 * ignores `cache_control`), `partialFraction` (fraction 0..1 of the prefix reported as cached on a hit, OpenAI and
 * Gemini only), `noUsage` (the call returns no usage object), and `outputTokens` (fixed output count; default 24
 * for OpenAI and Anthropic, 20 for Gemini).
 */
export interface SimConfig {
  provider: Provider;
  minPrefixTokens: number; ttlSeconds: number;
  ignoreMarks?: boolean; partialFraction?: number; noUsage?: boolean;
  /** contaminação: o provedor "normaliza" o início removendo a linha [ref ...], então o nonce NÃO quebra o prefixo */
  stripNonce?: boolean;
  /** contador de tokens do dublê (barato e determinístico) */
  tokensOf?: (text: string) => number;
  outputTokens?: number;
}

const approx = (t: string): number => Math.ceil(t.length / 4);
const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const stripRef = (s: string): string => s.replace(/^\[ref [0-9a-f]{16}\]\n/, '');

interface Entry { expiresAt: number; ttl: number; tokens: number }

/**
 * In-memory simulation of one provider's prompt cache, keyed by the sha256 of the cacheable prefix.
 *
 * Every call is appended to `calls` (time and raw usage) so a test can inspect the sequence. State lives only in
 * this instance; create a new one per scenario.
 */
export class SimProvider {
  private store = new Map<string, Entry>();
  readonly calls: Array<{ at: number; usage: unknown }> = [];
  constructor(readonly cfg: SimConfig) {}
  private tok(t: string): number { return (this.cfg.tokensOf ?? approx)(t); }
  private alive(k: string, now: number): Entry | null { const e = this.store.get(k); return e && now <= e.expiresAt ? e : null; }

  /**
   * Envia um corpo no instante `nowSeconds`; devolve o uso cru da API (ou undefined se `noUsage`).
   *
   * @param body - Request body in the provider's own shape (Anthropic `system` blocks plus `messages`, OpenAI
   *   `messages`, Gemini `systemInstruction` plus `contents`); not mutated.
   * @param nowSeconds - Simulated time of the call in seconds; used to expire and refresh cache entries.
   * @returns The raw usage object the real API would return, or `undefined` when `noUsage` is set (the call is
   *   still recorded in `calls` and still updates the cache).
   */
  send(body: Record<string, unknown>, nowSeconds: number): unknown {
    let usage: unknown;
    if (this.cfg.provider === 'anthropic') usage = this.anthropic(body, nowSeconds);
    else if (this.cfg.provider === 'openai') usage = this.openai(body, nowSeconds);
    else usage = this.gemini(body, nowSeconds);
    this.calls.push({ at: nowSeconds, usage });
    return this.cfg.noUsage ? undefined : usage;
  }

  private anthropic(body: Record<string, unknown>, now: number): unknown {
    const sysBlocks = body['system'] as Array<{ text: string; cache_control?: { type: string; ttl?: string } }>; // prefixo = bloco(s) de system
    const msgs = body['messages'] as Array<{ role: string; content: Array<{ text: string }> }>;
    const all = [...sysBlocks.map((b) => b.text), ...msgs.flatMap((m) => m.content.map((b) => b.text))].join('\n');
    const total = this.tok(all); const out = this.cfg.outputTokens ?? 24;
    const first = sysBlocks; const markIdx = first.findIndex((b) => b.cache_control);
    let write = 0; let read = 0; let w5 = 0; let w1 = 0;
    if (markIdx >= 0 && !this.cfg.ignoreMarks) {
      const prefix = first.slice(0, markIdx + 1).map((b) => stripRef2(b.text, this.cfg.stripNonce)).join('\n'); const pt = this.tok(prefix);
      if (pt >= this.cfg.minPrefixTokens) {
        const ttl = first[markIdx]!.cache_control!.ttl === '1h' ? 3600 : this.cfg.ttlSeconds; const key = `A|${h(prefix)}`;
        const e = this.alive(key, now);
        if (e) { read = pt; e.expiresAt = now + e.ttl; } else { write = pt; if (ttl === 3600) w1 = pt; else w5 = pt; this.store.set(key, { expiresAt: now + ttl, ttl, tokens: pt }); }
      }
    }
    return { input_tokens: total - read - write, cache_creation_input_tokens: write, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens: out };
  }

  private openai(body: Record<string, unknown>, now: number): unknown {
    const msgs = body['messages'] as Array<{ role: string; content: string }>;
    const total = this.tok(msgs.map((m) => m.content).join('\n')); const first = stripRef2(msgs[0]!.content, this.cfg.stripNonce); const ft = this.tok(first);
    let cached = 0;
    if (ft >= this.cfg.minPrefixTokens) {
      const key = `O|${h(first)}`; const e = this.alive(key, now);
      if (e) { cached = Math.floor((ft * (this.cfg.partialFraction ?? 1)) / 128) * 128; e.expiresAt = now + e.ttl; } else this.store.set(key, { expiresAt: now + this.cfg.ttlSeconds, ttl: this.cfg.ttlSeconds, tokens: ft });
    }
    return { prompt_tokens: total, completion_tokens: this.cfg.outputTokens ?? 24, total_tokens: total + (this.cfg.outputTokens ?? 24), prompt_tokens_details: { cached_tokens: cached, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };
  }

  private gemini(body: Record<string, unknown>, now: number): unknown {
    const contents = body['contents'] as Array<{ role: string; parts: Array<{ text: string }> }>;
    const si = (body['systemInstruction'] as { parts: Array<{ text: string }> }).parts[0]!.text; // prefixo
    const total = this.tok([si, ...contents.flatMap((c) => c.parts.map((p) => p.text))].join('\n')); const first = stripRef2(si, this.cfg.stripNonce); const ft = this.tok(first);
    let cached = 0;
    if (ft >= this.cfg.minPrefixTokens) {
      const key = `G|${h(first)}`; const e = this.alive(key, now);
      if (e) { cached = Math.floor((ft * (this.cfg.partialFraction ?? 1)) / 16) * 16; e.expiresAt = now + e.ttl; } else this.store.set(key, { expiresAt: now + this.cfg.ttlSeconds, ttl: this.cfg.ttlSeconds, tokens: ft });
    }
    const um: Record<string, unknown> = { promptTokenCount: total, candidatesTokenCount: this.cfg.outputTokens ?? 20, totalTokenCount: total + (this.cfg.outputTokens ?? 20), promptTokensDetails: [{ modality: 'TEXT', tokenCount: total }], serviceTier: 'standard' };
    if (cached > 0) { um['cachedContentTokenCount'] = cached; um['cacheTokensDetails'] = [{ modality: 'TEXT', tokenCount: cached }]; }
    return um;
  }
}

function stripRef2(s: string, strip?: boolean): string { return strip ? stripRef(s) : s; }
