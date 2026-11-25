/**
 * PROXY-03 — StreamTapper
 * Extracts usage from SSE chunks (OpenAI, Anthropic, Gemini formats).
 *
 * Two ways to use it:
 *   - as a parser: observe(chunk) for each chunk, then finish(). Synchronous, keeps no
 *     output, so usage is final as soon as finish() returns (RV03, used by the gateway);
 *   - as a Transform (pass-through), when its readable side is consumed (e.g. pipeline).
 * Before RV03 the gateway wrote into the Transform without reading it: after ~16 KB the
 * transform stalled and the final usage event was never parsed.
 *
 * Used by `src/proxy/ProxyGateway.ts` and `src/operations/measurementPorts.ts` on streamed responses. It
 * parses only `data:` lines; it does not decide whether the usage is final (callers check `usageSeen`).
 *
 * @module src/proxy/StreamTapper
 */

import { Transform, TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * Token usage read from an SSE stream (counts as reported; a missing count is 0).
 */
export interface TappedUsage {
  /** Input tokens. */
  promptTokens: number;
  /** Output tokens. */
  completionTokens: number;
  /** Anthropic prompt-cache categories (N8); absent for other providers. */
  cacheCreationInputTokens?: number;
  /** Anthropic cache-read input tokens; absent when not reported. */
  cacheReadInputTokens?: number;
}

/**
 * Attach cache categories only when the provider reported them.
 *
 * @param base - Input and output counts.
 * @param creation - Cache-creation tokens, or `undefined` when not reported.
 * @param read - Cache-read tokens, or `undefined` when not reported.
 * @returns A new usage object; `base` is not modified.
 */
function withCache(base: TappedUsage, creation: number | undefined, read: number | undefined): TappedUsage {
  const out: TappedUsage = { ...base };
  if (creation !== undefined) out.cacheCreationInputTokens = creation;
  if (read !== undefined) out.cacheReadInputTokens = read;
  return out;
}

/**
 * Reads token usage (and the model and response IDs) from SSE chunks of OpenAI, Anthropic or Gemini.
 *
 * Later usage events replace earlier ones; the last one seen wins.
 */
export class StreamTapper extends Transform {
  /** Populated once any SSE chunk with a `usage` key is parsed (even if tokens are zero). */
  usage: TappedUsage | null = null;
  /** True once a `usage` key has been observed in any SSE chunk. Disambiguates null. */
  usageSeen = false;
  /** Model id reported by the provider in the stream (Anthropic message_start), if any. */
  model: string | undefined = undefined;
  /** Provider response id (Anthropic message_start.message.id, OpenAI chunk id), if any. */
  messageId: string | undefined = undefined;

  private _buf = '';
  // UTF-8 sequences may be split across chunks
  private readonly _decoder = new StringDecoder('utf8');

  /**
   * Parse one chunk (no pass-through).
   *
   * @param chunk - Next chunk of the response body, as bytes or already-decoded text.
   */
  observe(chunk: Buffer | string): void {
    this._buf += typeof chunk === 'string' ? chunk : this._decoder.write(chunk);
    this._parseLines();
  }

  /** Parse whatever remains after the last chunk (a final line without newline). */
  finish(): void {
    this._buf += this._decoder.end();
    if (this._buf.length > 0) {
      this._buf += '\n';
      this._parseLines();
    }
  }

  /**
   * Pass-through: parses the chunk, then pushes it unchanged to the readable side.
   *
   * @param chunk - Chunk from the writable side.
   * @param _encoding - Ignored.
   * @param callback - Called once the chunk is handled.
   */
  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.observe(chunk);
    this.push(chunk);
    callback();
  }

  /**
   * Parses the remaining buffered text when the writable side ends.
   *
   * @param callback - Called once the remainder is parsed.
   */
  override _flush(callback: TransformCallback): void {
    this.finish();
    callback();
  }

  private _parseLines(): void {
    const lines = this._buf.split('\n');
    // Keep last (potentially incomplete) line in buffer
    this._buf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        // OpenAI chunks repeat the completion id at top level
        if (this.messageId === undefined && typeof parsed['id'] === 'string' && parsed['id']) this.messageId = parsed['id'];
        if (this._tapOtherFormats(parsed)) continue;
        const usage = parsed['usage'] as Record<string, unknown> | undefined;
        if (usage != null) {
          this.usageSeen = true;
          const pt =
            typeof usage['prompt_tokens'] === 'number'
              ? usage['prompt_tokens']
              : 0;
          const ct =
            typeof usage['completion_tokens'] === 'number'
              ? usage['completion_tokens']
              : 0;
          // Always populate usage when the key is present (even zero-token responses).
          // Callers use `usageSeen` to distinguish "no usage chunk" from "zero tokens".
          this.usage = { promptTokens: pt, completionTokens: ct };
        }
      } catch {
        // Non-JSON SSE line — skip
      }
    }
  }

  /**
   * R10: provider-specific streaming usage. Returns true when the event was handled.
   *   Anthropic: message_start.message.usage.input_tokens, message_delta.usage.output_tokens
   *   Gemini:    usageMetadata.promptTokenCount / candidatesTokenCount (cumulative)
   * @param parsed - One parsed SSE `data:` payload.
   */
  private _tapOtherFormats(parsed: Record<string, unknown>): boolean {
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
    const type = parsed['type'];
    if (type === 'message_start') {
      const message = parsed['message'] as Record<string, unknown> | undefined;
      if (typeof message?.['model'] === 'string' && message['model']) this.model = message['model'];
      if (typeof message?.['id'] === 'string' && message['id']) this.messageId = message['id'];
      const u = message?.['usage'] as Record<string, unknown> | undefined;
      if (u) {
        this.usageSeen = true;
        this.usage = withCache(
          { promptTokens: num(u['input_tokens']) ?? 0, completionTokens: num(u['output_tokens']) ?? 0 },
          num(u['cache_creation_input_tokens']), num(u['cache_read_input_tokens']),
        );
      }
      return true;
    }
    if (type === 'message_delta') {
      // Documented as cumulative; input/cache fields may repeat there (newer API versions).
      const u = parsed['usage'] as Record<string, unknown> | undefined;
      const out = num(u?.['output_tokens']);
      if (out !== undefined) {
        this.usageSeen = true;
        const prev = this.usage;
        this.usage = withCache(
          { promptTokens: num(u?.['input_tokens']) ?? prev?.promptTokens ?? 0, completionTokens: out },
          num(u?.['cache_creation_input_tokens']) ?? prev?.cacheCreationInputTokens,
          num(u?.['cache_read_input_tokens']) ?? prev?.cacheReadInputTokens,
        );
      }
      return true;
    }
    const meta = parsed['usageMetadata'] as Record<string, unknown> | undefined;
    if (meta) {
      this.usageSeen = true;
      this.usage = { promptTokens: num(meta['promptTokenCount']) ?? 0, completionTokens: num(meta['candidatesTokenCount']) ?? 0 };
      return true;
    }
    return false;
  }
}
