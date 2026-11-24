/**
 * Dublês OFFLINE dos provedores para o estudo de cache (R13). Simulam só a SEMÂNTICA de cache descrita no R08 §4, sobre o corpo do pedido
 * (sem rede, sem relógio: o tempo é um argumento). Cada dublê devolve o objeto de uso no formato cru da API:
 *   OpenAI    usage.prompt_tokens(_details.cached_tokens), múltiplos de 128, automático, mínimo configurável
 *   Anthropic usage.input_tokens / cache_creation_input_tokens / cache_read_input_tokens / cache_creation.ephemeral_*, exige cache_control, mínimo e TTL
 *   Gemini    usageMetadata.promptTokenCount (+ cachedContentTokenCount só quando > 0, como na H1), implícito
 * Modos de falha: ignoreMarks (provedor ignora a marcação), partialFraction (hit parcial), noUsage (resposta sem uso), stripNonce (controle contaminado).
 */
import { createHash } from 'node:crypto';
import type { Provider } from '../../../scripts/h2eval/cache/classify.js';

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

export class SimProvider {
  private store = new Map<string, Entry>();
  readonly calls: Array<{ at: number; usage: unknown }> = [];
  constructor(readonly cfg: SimConfig) {}
  private tok(t: string): number { return (this.cfg.tokensOf ?? approx)(t); }
  private alive(k: string, now: number): Entry | null { const e = this.store.get(k); return e && now <= e.expiresAt ? e : null; }

  /** Envia um corpo no instante `nowSeconds`; devolve o uso cru da API (ou undefined se `noUsage`). */
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
