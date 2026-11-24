/**
 * Incremental SSE usage accumulator per API (D5-G03, D8 §2, U2-03; front B; C integrates it
 * in ProxyGateway). Implements CreateStreamUsageAccumulatorFn.
 *
 * - Bytes are decoded with a streaming UTF-8 decoder, so a code point split across chunks is
 *   never corrupted; events are dispatched on blank lines (multi-line data joined by '\n').
 * - Usage events REPLACE the previous value (cumulative semantics): they are never summed.
 * - Completeness: 'complete' only after the API's final usage signal; usage seen without it
 *   is 'partial'; no usage at all is 'missing'. The result never invents zeros.
 * - Lines end at CRLF, LF or a lone CR. Memory is bounded by maxBufferedBytes for the pending
 *   line and event: an oversized non-data line is discarded, an oversized data line feeds a
 *   bounded tail. An event larger than that
 *   (e.g. Responses `response.completed`, which repeats the whole output) keeps only a bounded
 *   tail, from which the last unescaped "usage" object is recovered; when recovery fails the
 *   usage is not trusted (partial/missing).
 *
 * Final usage signal per API (sources in usageDocRefs.ts / USAGE_MATRIX.md):
 *   openai.chat_completions / deepseek / mistral: the chunk whose `usage` is non-null (OpenAI
 *     needs stream_options.include_usage; without it usage is missing, as documented).
 *   openai.responses: response.completed | response.incomplete | response.failed with usage.
 *   anthropic.messages: message_start/message_delta usage (cumulative) + message_stop.
 *   gemini.generate_content: usageMetadata in a chunk at or after a candidate finishReason
 *     (cumulative-vs-final semantics UNVERIFIED in the docs; replacing covers both).
 *   cohere.chat: message-end with delta.usage.
 */
import type { NormalizedUsage, UsageApi, UsageCompleteness } from '../../types/d1d8/index.js';
import type { StreamUsageAccumulator, UsageContext } from '../../types/d1d8/index.js';
import { normalizeUsageDetailed, type UsageIssue } from './normalizeUsage.js';

export interface StreamCallbacks {
  /** Visible output text delta, in order (feed LocalCounter.observeOutputText). */
  onTextDelta?: (text: string) => void;
  /** Non-text output observed (tool call, hidden reasoning, media): output is uncovered. */
  onNonTextOutput?: (reason: string) => void;
}

export interface StreamUsageAccumulatorImpl extends StreamUsageAccumulator {
  /** Issues of the last finish(), plus stream-level ones (overflow, parse errors). */
  readonly issues: readonly UsageIssue[];
  readonly eventsSeen: number;
}

interface Synth {
  /** Body shaped like the non-streaming response, so the same normalizer applies. */
  body: Record<string, unknown>;
  usageSeen: boolean;
  final: boolean;
  /** Gemini: a candidate finishReason was seen. */
  finishSeen: boolean;
  /** Anthropic: a message_delta with usage was seen. */
  deltaSeen: boolean;
}

const TAIL_BYTES_MIN = 4096;
const HEAD_CHARS = 512;

/** Last unescaped `"usage":{...}` object in a (possibly truncated) JSON text. */
export function recoverUsageFromTail(text: string, key = 'usage'): unknown | null {
  const needle = `"${key}":`;
  let idx = text.lastIndexOf(needle);
  while (idx >= 0) {
    let bs = 0;
    for (let j = idx - 1; j >= 0 && text[j] === '\\'; j--) bs++;
    if (bs % 2 === 0) {
      let i = idx + needle.length;
      while (text[i] === ' ') i++;
      if (text[i] === '{') {
        let depth = 0;
        let inStr = false;
        for (let k = i; k < text.length; k++) {
          const ch = text[k];
          if (inStr) {
            if (ch === '\\') k++;
            else if (ch === '"') inStr = false;
          } else if (ch === '"') inStr = true;
          else if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              try { return JSON.parse(text.slice(i, k + 1)); } catch { break; }
            }
          }
        }
      }
      // Not an object (e.g. a string-valued "usage" in metadata) or not parseable: keep looking.
    }
    idx = text.lastIndexOf(needle, idx - 1);
  }
  return null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Applies one parsed SSE event to the synthetic body (unknown event shapes are ignored). */
function applyEvent(api: UsageApi, ev: Record<string, unknown>, s: Synth, cb: StreamCallbacks): void {
  switch (api) {
    case 'openai.chat_completions':
    case 'deepseek.chat_completions':
    case 'mistral.chat_completions': {
      if (typeof ev['id'] === 'string' && !s.body['id']) s.body['id'] = ev['id'];
      if (typeof ev['model'] === 'string') s.body['model'] = ev['model'];
      // v1.3: the tier that processed the request (read by the server even when the client is gone)
      if (typeof ev['service_tier'] === 'string') s.body['service_tier'] = ev['service_tier'];
      for (const ch of Array.isArray(ev['choices']) ? (ev['choices'] as Record<string, unknown>[]) : []) {
        const d = obj(ch['delta']) ?? {};
        if (typeof d['content'] === 'string' && d['content']) cb.onTextDelta?.(d['content'] as string);
        if (d['tool_calls']) cb.onNonTextOutput?.('tool_calls');
        if (typeof d['reasoning_content'] === 'string' && d['reasoning_content']) cb.onNonTextOutput?.('reasoning_content');
        if (d['audio']) cb.onNonTextOutput?.('audio');
      }
      if (obj(ev['usage'])) {
        s.body['usage'] = ev['usage'];
        s.usageSeen = true;
        s.final = true;
      }
      return;
    }
    case 'openai.responses': {
      const type = ev['type'];
      if (type === 'response.output_text.delta' && typeof ev['delta'] === 'string') cb.onTextDelta?.(ev['delta'] as string);
      else if (typeof type === 'string' && /^response\.(function_call|reasoning|audio|image|file_search|web_search|code_interpreter|mcp|custom_tool)/.test(type)) {
        cb.onNonTextOutput?.(type);
      }
      const resp = obj(ev['response']);
      if (resp) {
        if (typeof resp['id'] === 'string') s.body['id'] = resp['id'];
        if (typeof resp['model'] === 'string') s.body['model'] = resp['model'];
        if (obj(resp['usage'])) {
          s.body['usage'] = resp['usage'];
          s.usageSeen = true;
        }
        if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
          s.final = s.usageSeen;
        }
      }
      return;
    }
    case 'anthropic.messages': {
      const type = ev['type'];
      if (type === 'message_start') {
        const msg = obj(ev['message']) ?? {};
        if (typeof msg['id'] === 'string') s.body['id'] = msg['id'];
        if (typeof msg['model'] === 'string') s.body['model'] = msg['model'];
        if (obj(msg['usage'])) { s.body['usage'] = { ...(msg['usage'] as object) }; s.usageSeen = true; }
      } else if (type === 'message_delta') {
        const u = obj(ev['usage']);
        // Cumulative: non-null fields replace the previous ones; absent or null fields keep theirs.
        if (u) {
          const merged: Record<string, unknown> = { ...(obj(s.body['usage']) ?? {}) };
          for (const [k, v] of Object.entries(u)) if (v !== null && v !== undefined) merged[k] = v;
          s.body['usage'] = merged;
          s.usageSeen = true;
          s.deltaSeen = true;
        }
      } else if (type === 'message_stop') {
        // message_start carries a provisional output count; final usage needs a message_delta.
        s.final = s.usageSeen && s.deltaSeen;
      } else if (type === 'content_block_delta') {
        const d = obj(ev['delta']) ?? {};
        if (d['type'] === 'text_delta' && typeof d['text'] === 'string') cb.onTextDelta?.(d['text'] as string);
        else if (d['type'] === 'thinking_delta' || d['type'] === 'input_json_delta' || d['type'] === 'signature_delta') cb.onNonTextOutput?.(String(d['type']));
      } else if (type === 'content_block_start') {
        const b = obj(ev['content_block']) ?? {};
        if (b['type'] && b['type'] !== 'text') cb.onNonTextOutput?.(`${String(b['type'])}_block`);
      } else if (type === 'error') {
        s.final = false;
      }
      return;
    }
    case 'gemini.generate_content': {
      if (typeof ev['responseId'] === 'string') s.body['responseId'] = ev['responseId'];
      if (typeof ev['modelVersion'] === 'string') s.body['modelVersion'] = ev['modelVersion'];
      // v1.3: a blocked prompt ends the stream without any candidate; its usage is final (nothing more comes)
      const blockReason = obj(ev['promptFeedback'])?.['blockReason'];
      if (typeof blockReason === 'string' && blockReason) { s.body['promptFeedback'] = { blockReason }; s.finishSeen = true; }
      for (const cand of Array.isArray(ev['candidates']) ? (ev['candidates'] as Record<string, unknown>[]) : []) {
        if (typeof cand['finishReason'] === 'string' && cand['finishReason']) { s.finishSeen = true; s.body['candidates'] = [{ finishReason: cand['finishReason'] }]; }
        const content = obj(cand['content']) ?? {};
        for (const part of Array.isArray(content['parts']) ? (content['parts'] as Record<string, unknown>[]) : []) {
          if (part['thought'] === true) { cb.onNonTextOutput?.('thought_part'); continue; }
          if (typeof part['text'] === 'string') cb.onTextDelta?.(part['text'] as string);
          else cb.onNonTextOutput?.('non_text_part');
        }
      }
      // Final only when usage arrives in the finishing chunk or after it. The usage of each chunk REPLACES the
      // previous one (cumulative counts, never summed as deltas); a usage seen before the finish keeps it partial.
      // The protocol has no [DONE] sentinel (FECHAMENTO_GEMINI_AD/fontes/gen-content.md).
      if (obj(ev['usageMetadata'])) {
        s.body['usageMetadata'] = ev['usageMetadata'];
        s.usageSeen = true;
        s.final = s.finishSeen;
      }
      return;
    }
    case 'cohere.chat': {
      const type = ev['type'];
      if (type === 'message-start' && typeof ev['id'] === 'string') s.body['id'] = ev['id'];
      if (type === 'content-delta') {
        const t = obj(obj(obj(ev['delta'])?.['message'] ?? null)?.['content'] ?? null)?.['text'];
        if (typeof t === 'string') cb.onTextDelta?.(t);
      } else if (typeof type === 'string' && type.startsWith('tool-')) cb.onNonTextOutput?.(type);
      if (type === 'message-end') {
        const u = obj(obj(ev['delta'])?.['usage'] ?? null);
        if (u) { s.body['usage'] = u; s.usageSeen = true; s.final = true; }
      }
      return;
    }
    default:
      return;
  }
}

/** CreateStreamUsageAccumulatorFn (extra optional callbacks for the local counter). */
export function createStreamUsageAccumulator(api: UsageApi, ctx: UsageContext, limits: { maxBufferedBytes: number },
  callbacks: StreamCallbacks = {}): StreamUsageAccumulatorImpl {
  const decoder = new TextDecoder('utf-8');
  const synth: Synth = { body: {}, usageSeen: false, final: false, finishSeen: false, deltaSeen: false };
  const streamIssues: UsageIssue[] = [];
  let lastIssues: UsageIssue[] = [];
  let lineBuf = '';
  let dataLines: string[] = [];
  let dataBytes = 0;
  let overflow = false;
  let tail = '';
  let head = '';
  let bytesSeen = 0;
  let eventsSeen = 0;
  let finished = false;
  const tailMax = Math.max(TAIL_BYTES_MIN, limits.maxBufferedBytes);

  const dispatch = () => {
    if (dataLines.length === 0 && !overflow) return;
    eventsSeen++;
    let ev: Record<string, unknown> | null = null;
    if (!overflow) {
      const data = dataLines.join('\n');
      if (data.trim() !== '[DONE]') {
        try { ev = obj(JSON.parse(data)); } catch { streamIssues.push({ kind: 'invalid_type', field: 'sse.data', detail: 'unparseable_event' }); }
      }
    } else {
      // Bounded recovery: event type and usage from the kept tail only.
      const usage = recoverUsageFromTail(tail, api === 'gemini.generate_content' ? 'usageMetadata' : 'usage');
      // Text deltas inside the dropped part were not delivered: the local count is not complete.
      callbacks.onNonTextOutput?.('event_exceeded_buffer');
      if (usage && api === 'openai.responses') {
        // The event type sits at the start of the event: it is kept in a bounded head.
        const type = /"type":\s*"(response\.(completed|incomplete|failed))"/.exec(head)?.[1] ?? null;
        ev = { type, response: { usage } };
      } else if (usage && api === 'gemini.generate_content') {
        ev = { usageMetadata: usage };
      } else if (usage && api === 'anthropic.messages') {
        // Cumulative usage; merged like a message_delta (non-null fields only).
        ev = { type: 'message_delta', usage };
      } else if (usage && api === 'cohere.chat') {
        ev = /"type":\s*"message-end"/.test(head) ? { type: 'message-end', delta: { usage } } : null;
      } else if (usage) {
        ev = { usage };
      }
      // Reported as recovered only when the recovered usage was actually applied.
      streamIssues.push({ kind: 'out_of_range', field: 'sse.event', detail: ev ? 'event_exceeded_buffer_usage_recovered_from_tail' : 'event_exceeded_buffer_usage_lost' });
    }
    if (ev) applyEvent(api, ev, synth, callbacks);
    dataLines = [];
    dataBytes = 0;
    overflow = false;
    tail = '';
    head = '';
  };

  const handleLine = (raw: string) => {
    const line = raw;
    if (line === '') { dispatch(); return; }
    if (line.startsWith(':')) return; // comment
    if (!line.startsWith('data:')) return; // event:/id:/retry: carry no usage
    const value = line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5);
    const bytes = Buffer.byteLength(value, 'utf8');
    if (!overflow && dataBytes + bytes > limits.maxBufferedBytes) {
      overflow = true;
      tail = dataLines.join('\n');
      head = (tail || value).slice(0, HEAD_CHARS);
      dataLines = [];
    }
    if (overflow) {
      tail = (tail + '\n' + value).slice(-tailMax);
    } else {
      dataLines.push(value);
      dataBytes += bytes;
    }
  };

  // Line framing per SSE: CRLF, LF or a lone CR end a line. A CR at the end of a chunk may be
  // the first half of CRLF, so it waits for the next chunk (or finish()).
  let pendingCR = false;
  // An unterminated line that exceeded the budget: 'data' keeps feeding the bounded tail,
  // 'discard' drops a non-data line (event:/id:/garbage carry no usage) until it ends.
  let continuing: null | 'data' | 'discard' = null;

  const endLine = (text: string) => {
    if (continuing === 'data') { tail = (tail + text).slice(-tailMax); continuing = null; return; }
    if (continuing === 'discard') { continuing = null; return; }
    handleLine(text);
  };

  const boundLineBuf = () => {
    if (continuing === 'data') { tail = (tail + lineBuf).slice(-tailMax); lineBuf = ''; return; }
    if (continuing === 'discard') { lineBuf = ''; return; }
    if (Buffer.byteLength(lineBuf, 'utf8') <= limits.maxBufferedBytes) return;
    if (lineBuf.startsWith('data:')) {
      const value = lineBuf.slice(5).startsWith(' ') ? lineBuf.slice(6) : lineBuf.slice(5);
      if (!overflow) {
        overflow = true;
        const prev = dataLines.join('\n');
        head = (prev || value).slice(0, HEAD_CHARS);
        tail = prev ? `${prev}\n${value}` : value;
        dataLines = [];
      } else {
        tail = `${tail}\n${value}`;
      }
      tail = tail.slice(-tailMax);
      continuing = 'data';
    } else {
      streamIssues.push({ kind: 'out_of_range', field: 'sse.line', detail: 'non_data_line_exceeded_buffer_discarded' });
      continuing = 'discard';
    }
    lineBuf = '';
  };

  const feed = (text: string, final = false) => {
    const buf = (pendingCR ? '\r' : '') + text;
    pendingCR = false;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      if (c === 13 && i === buf.length - 1 && !final) {
        lineBuf += buf.slice(start, i);
        pendingCR = true;
        start = buf.length;
        break;
      }
      lineBuf += buf.slice(start, i);
      const line = lineBuf;
      lineBuf = '';
      endLine(line);
      if (c === 13 && buf.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
    if (start < buf.length) lineBuf += buf.slice(start);
    boundLineBuf();
  };

  return {
    get bytesSeen() { return bytesSeen; },
    get eventsSeen() { return eventsSeen; },
    get issues() { return [...streamIssues, ...lastIssues]; },
    push(chunk: Uint8Array | string) {
      if (finished) throw new Error('stream accumulator already finished');
      if (typeof chunk === 'string') {
        bytesSeen += Buffer.byteLength(chunk, 'utf8');
        feed(chunk);
      } else {
        bytesSeen += chunk.byteLength;
        feed(decoder.decode(chunk, { stream: true }));
      }
    },
    finish(): NormalizedUsage {
      if (!finished) {
        finished = true;
        feed(decoder.decode(), true);
        if (lineBuf.length > 0 || continuing) { const rest = lineBuf; lineBuf = ''; endLine(rest); }
        dispatch();
      }
      const completeness: UsageCompleteness = !synth.usageSeen ? 'missing' : synth.final ? 'complete' : 'partial';
      const r = normalizeUsageDetailed(api, synth.usageSeen ? synth.body : {}, { ...ctx, origin: 'provider_stream' },
        completeness === 'complete' ? {} : { completeness });
      lastIssues = r.issues;
      // contract 1.1.0 (R-B2): stream-level and normalization issues travel with the usage
      const all = [...streamIssues, ...lastIssues];
      return all.length > 0 ? { ...r.usage, issues: all } : r.usage;
    },
  };
}
