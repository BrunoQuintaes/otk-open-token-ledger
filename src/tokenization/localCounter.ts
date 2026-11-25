/**
 * Auxiliary local counter (D4 §7, D8 §1–2; front B). Implements CreateLocalCounterFn.
 *
 * What it counts — and what it does not:
 *  - input: the text parts of the request, each part tokenized separately and summed
 *    (assembly 'otk.assembly.text_parts@1'). Message envelopes, role markers and provider
 *    templates are NOT reproduced: a provider total includes them, so even an exact tokenizer
 *    differs by a model-dependent overhead. That gap is what a calibration (scripts/calibration)
 *    estimates; it is never hidden by adding constants here.
 *  - output: visible text deltas, counted incrementally with BPE boundaries preserved.
 *  - anything non-text (images, audio, files, tool definitions/calls/results) makes the side
 *    uncovered, and the counter reports 'incomplete' instead of a misleading number.
 * Content is kept only in memory, bounded by maxTextBytes, and never persisted or logged.
 * The counter is an auxiliary observation: it does not replace provider usage or decide billing.
 *
 * @module src/tokenization/localCounter
 */
import type {
  AssembledInput, LocalCountResult, LocalCounter, ModelSupport, TokenCategoryName, UsageApi,
} from '../types/d1d8/index.js';
import { IncrementalCounter } from './incrementalCounter.js';
import { countWith, hasOversizedPiece, loadEncoding, type LocalEncoding } from './tokenizerIdentity.js';

/**
 * Version of this counter; a calibration profile must name the same version to be compatible.
 */
export const COUNTER_VERSION = 'otk.local_counter.b3@1';

/**
 * Text extracted from a request or response, and whether something non-text was left out.
 */
export interface TextExtraction {
  texts: string[];
  /** Non-text parts or tools present: the text count does not cover this side. */
  nonText: boolean;
  /** Short machine reasons, e.g. 'tools', 'image_part' (never content). */
  reasons: string[];
}

function textOfParts(content: unknown, textTypes: readonly string[], out: TextExtraction): void {
  if (typeof content === 'string') {
    out.texts.push(content);
    return;
  }
  if (!Array.isArray(content)) {
    if (content !== undefined && content !== null) { out.nonText = true; out.reasons.push('unknown_content_shape'); }
    return;
  }
  for (const part of content) {
    if (typeof part === 'string') { out.texts.push(part); continue; }
    const p = part as Record<string, unknown>;
    const type = typeof p?.['type'] === 'string' ? (p['type'] as string) : '';
    if (textTypes.includes(type) && typeof p['text'] === 'string') out.texts.push(p['text'] as string);
    else { out.nonText = true; out.reasons.push(`${type || 'untyped'}_part`); }
  }
}

/**
 * Text parts of a request body under assembly otk.assembly.text_parts@1.
 *
 *
 * @param api - Usage API of the request.
 * @param body - Parsed request body (not modified).
 * @returns The text parts in order, with `nonText` and reasons when coverage is incomplete.
 */
export function extractInputText(api: UsageApi, body: unknown): TextExtraction {
  const out: TextExtraction = { texts: [], nonText: false, reasons: [] };
  if (!body || typeof body !== 'object') { out.nonText = true; out.reasons.push('no_body'); return out; }
  const b = body as Record<string, unknown>;
  const hasTools = Array.isArray(b['tools']) && (b['tools'] as unknown[]).length > 0;
  if (hasTools) { out.nonText = true; out.reasons.push('tools'); }
  switch (api) {
    case 'openai.chat_completions':
    case 'deepseek.chat_completions':
    case 'mistral.chat_completions':
    case 'cohere.chat': {
      for (const m of Array.isArray(b['messages']) ? (b['messages'] as Record<string, unknown>[]) : []) {
        if (m['tool_calls'] || m['role'] === 'tool' || m['tool_call_id']) { out.nonText = true; out.reasons.push('tool_message'); }
        textOfParts(m['content'], ['text'], out);
      }
      break;
    }
    case 'openai.responses': {
      if (typeof b['instructions'] === 'string') out.texts.push(b['instructions'] as string);
      const input = b['input'];
      if (typeof input === 'string') out.texts.push(input);
      else if (Array.isArray(input)) {
        for (const item of input as Record<string, unknown>[]) {
          if (item['type'] && item['type'] !== 'message') { out.nonText = true; out.reasons.push(`${String(item['type'])}_item`); continue; }
          textOfParts(item['content'], ['input_text', 'output_text', 'text'], out);
        }
      }
      break;
    }
    case 'anthropic.messages': {
      textOfParts(b['system'], ['text'], out);
      for (const m of Array.isArray(b['messages']) ? (b['messages'] as Record<string, unknown>[]) : []) {
        textOfParts(m['content'], ['text'], out);
      }
      break;
    }
    case 'gemini.generate_content': {
      const sys = b['systemInstruction'] as Record<string, unknown> | undefined;
      const geminiParts = (parts: unknown) => {
        for (const part of Array.isArray(parts) ? (parts as Record<string, unknown>[]) : []) {
          if (typeof part['text'] === 'string' && Object.keys(part).every((k) => k === 'text')) out.texts.push(part['text'] as string);
          else { out.nonText = true; out.reasons.push(`${Object.keys(part).find((k) => k !== 'text') ?? 'unknown'}_part`); }
        }
      };
      if (sys) geminiParts(sys['parts']);
      for (const c of Array.isArray(b['contents']) ? (b['contents'] as Record<string, unknown>[]) : []) geminiParts(c['parts']);
      break;
    }
    default:
      out.nonText = true;
      out.reasons.push('api_not_supported');
  }
  return out;
}

/**
 * Visible output text of a non-streaming response body. Hidden reasoning, tool calls and media
 * set nonText; the conference then treats output as uncovered.
 * @param api - Usage API of the response.
 * @param body - Parsed response body (not modified).
 * @returns The visible output text parts, with `nonText` and reasons when coverage is incomplete.
 */
export function extractOutputText(api: UsageApi, body: unknown): TextExtraction {
  const out: TextExtraction = { texts: [], nonText: false, reasons: [] };
  if (!body || typeof body !== 'object') { out.nonText = true; out.reasons.push('no_body'); return out; }
  const b = body as Record<string, unknown>;
  switch (api) {
    case 'openai.chat_completions':
    case 'deepseek.chat_completions':
    case 'mistral.chat_completions': {
      for (const ch of Array.isArray(b['choices']) ? (b['choices'] as Record<string, unknown>[]) : []) {
        const msg = (ch['message'] ?? {}) as Record<string, unknown>;
        if (msg['tool_calls'] || msg['audio']) { out.nonText = true; out.reasons.push('tool_calls_or_audio'); }
        if (typeof msg['reasoning_content'] === 'string') { out.nonText = true; out.reasons.push('reasoning_content'); }
        textOfParts(msg['content'] ?? '', ['text'], out);
      }
      break;
    }
    case 'openai.responses': {
      for (const item of Array.isArray(b['output']) ? (b['output'] as Record<string, unknown>[]) : []) {
        if (item['type'] !== 'message') { out.nonText = true; out.reasons.push(`${String(item['type'])}_item`); continue; }
        textOfParts(item['content'], ['output_text'], out);
      }
      break;
    }
    case 'anthropic.messages':
      textOfParts(b['content'], ['text'], out);
      break;
    case 'gemini.generate_content': {
      for (const cand of Array.isArray(b['candidates']) ? (b['candidates'] as Record<string, unknown>[]) : []) {
        const content = (cand['content'] ?? {}) as Record<string, unknown>;
        for (const part of Array.isArray(content['parts']) ? (content['parts'] as Record<string, unknown>[]) : []) {
          if (part['thought'] === true) { out.nonText = true; out.reasons.push('thought_part'); continue; }
          if (typeof part['text'] === 'string') out.texts.push(part['text'] as string);
          else { out.nonText = true; out.reasons.push('non_text_part'); }
        }
      }
      break;
    }
    case 'cohere.chat': {
      const msg = (b['message'] ?? {}) as Record<string, unknown>;
      if (msg['tool_calls']) { out.nonText = true; out.reasons.push('tool_calls'); }
      textOfParts(msg['content'], ['text'], out);
      break;
    }
    default:
      out.nonText = true;
      out.reasons.push('api_not_supported');
  }
  return out;
}

/**
 * Local counter with extra methods used by the stream path.
 */
export interface LocalCounterImpl extends LocalCounter {
  /** Declare that output had non-text content (tool calls, media, hidden reasoning). */
  markOutputUncovered(reason: string): void;
  /** Reasons collected so far (machine ids only). */
  readonly reasons: readonly string[];
}

function failed(): LocalCountResult {
  return {
    counts: [], covered: [], uncovered: ['input', 'output'], status: 'failed', counterVersion: COUNTER_VERSION,
    cost: { cpuMicros: null, peakBufferedBytes: 0 },
  };
}

function unsupportedCounter(): LocalCounterImpl {
  return {
    reasons: ['unsupported_model'],
    observeInput() {},
    observeOutputText() {},
    markOutputUncovered() {},
    finish: (): LocalCountResult => ({
      counts: [], covered: [], uncovered: ['input', 'output'], status: 'unsupported', counterVersion: COUNTER_VERSION,
      cost: { cpuMicros: 0n, peakBufferedBytes: 0 },
    }),
  };
}

/**
 * CreateLocalCounterFn. One counter per operation; not reusable.
 *
 *
 * Never throws: an unsupported model gives a counter that reports `unsupported`, and an encoder that cannot
 * be loaded gives one that reports `failed`.
 *
 * @param support - Tokenizer coverage of the operation's model (from `resolveModelSupport`).
 * @param limits - `maxTextBytes`: UTF-8 bytes of text kept per side before counting stops.
 * @returns A new counter for one operation.
 */
export function createLocalCounter(support: ModelSupport, limits: { maxTextBytes: number }): LocalCounterImpl {
  if (support.support === 'unsupported' || !support.tokenizer) return unsupportedCounter();
  let encoder: ReturnType<typeof loadEncoding>['encoder'];
  try {
    encoder = loadEncoding(support.tokenizer.encoding as LocalEncoding).encoder;
  } catch {
    return { ...unsupportedCounter(), reasons: ['tokenizer_load_failed'], finish: () => failed() };
  }
  const reasons: string[] = [];
  let inputCount: number | null = null;
  let inputCovered = false;
  let inputCpu = 0n;
  let inputBytes = 0;
  let outputObserved = false;
  let outputUncovered = false;
  let failure: string | null = null;
  const output = new IncrementalCounter(encoder, { maxTextBytes: limits.maxTextBytes });


  return {
    get reasons() { return reasons; },
    observeInput(input: AssembledInput) {
      if (failure) return;
      try {
        const t0 = process.cpuUsage();
        const ex = extractInputText(input.api, input.body);
        reasons.push(...ex.reasons);
        inputBytes = ex.texts.reduce((s, t) => s + Buffer.byteLength(t, 'utf8'), 0);
        if (inputBytes > limits.maxTextBytes) {
          reasons.push('input_exceeds_max_text_bytes');
          inputCount = null;
          inputCovered = false;
        } else if (ex.texts.some(hasOversizedPiece)) {
          reasons.push('input_max_piece_chars');
          inputCount = null;
          inputCovered = false;
        } else {
          inputCount = ex.texts.reduce((s, t) => s + countWith(encoder, t), 0);
          inputCovered = !ex.nonText;
        }
        const d = process.cpuUsage(t0);
        inputCpu += BigInt(d.user + d.system);
      } catch {
        failure = 'input_count_failed';
      }
    },
    observeOutputText(chunk: string) {
      if (failure) return;
      outputObserved = true;
      try {
        output.push(chunk);
      } catch {
        failure = 'output_count_failed';
      }
    },
    markOutputUncovered(reason: string) {
      outputUncovered = true;
      reasons.push(reason);
    },
    finish(): LocalCountResult {
      if (failure) { reasons.push(failure); return failed(); }
      let out;
      try {
        out = output.finish();
      } catch {
        reasons.push('output_count_failed');
        return failed();
      }
      if (out.truncated) reasons.push(`output_${out.truncationReason}`);
      const counts: LocalCountResult['counts'] = [];
      const covered: TokenCategoryName[] = [];
      const uncovered: TokenCategoryName[] = [];
      if (inputCount !== null) counts.push({ category: 'input', count: BigInt(inputCount) });
      (inputCount !== null && inputCovered ? covered : uncovered).push('input');
      const outputOk = outputObserved && !out.truncated;
      if (outputOk) counts.push({ category: 'output', count: BigInt(out.count) });
      (outputOk && !outputUncovered ? covered : uncovered).push('output');
      return {
        counts,
        covered,
        uncovered,
        status: uncovered.length === 0 ? 'ok' : 'incomplete',
        counterVersion: COUNTER_VERSION,
        cost: { cpuMicros: inputCpu + out.cpuMicros, peakBufferedBytes: Math.max(inputBytes, out.peakPendingBytes) },
      };
    },
  };
}
