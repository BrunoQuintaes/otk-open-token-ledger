/**
 * D1–D8 front B — streaming usage accumulator (D5-G03, D8 §2, U2-03).
 * SSE fixtures are synthetic and follow the documented event shapes (usageDocRefs.ts); they do
 * not prove a live integration. Every stream is replayed with several chunkings, including one
 * byte at a time, and must give the same usage and the same text.
 *
 * Modules under test: `src/providers/usage/streamUsageAccumulator.ts` (with `recoverUsageFromTail`)
 * and, for the counting case, `src/tokenization/localCounter.ts`.
 *
 * Strategy / partitions: per API (OpenAI Chat Completions and Responses, Anthropic Messages,
 * Gemini, Cohere) a complete stream, a stream without usage or cut early (missing or partial,
 * never zero) and non-text output (tool calls, thinking, thought parts); framing with LF, CRLF and
 * lone CR; split UTF-8 characters; events larger than the buffer (usage recovered from the
 * bounded tail, or left missing); unparseable lines; a final event without a trailing blank
 * line; null fields in cumulative Anthropic deltas; pushing after `finish()` is refused.
 *
 * Needs: nothing external (synthetic server-sent event text built in the test).
 *
 * Run just this file: `npx tsx --test test/unit/d1d8_b_stream.test.ts`
 *
 * @module test/unit/d1d8_b_stream.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamUsageAccumulator, recoverUsageFromTail } from '../../src/providers/usage/streamUsageAccumulator.js';
import { createLocalCounter } from '../../src/tokenization/localCounter.js';
import { resolveModelSupport } from '../../src/providers/catalog/modelCatalog.js';
import { loadEncoding, countWith } from '../../src/tokenization/tokenizerIdentity.js';
import type { NormalizedUsage, UsageApi } from '../../src/types/d1d8/index.js';

const NOW = '2026-09-30T12:00:00.000Z';
const sse = (events: unknown[], opts: { done?: boolean; crlf?: boolean } = {}) => {
  const nl = opts.crlf ? '\r\n' : '\n';
  return events.map((e) => `data: ${JSON.stringify(e)}${nl}${nl}`).join('') + (opts.done ? `data: [DONE]${nl}${nl}` : '');
};

function chunkings(bytes: Uint8Array): Uint8Array[][] {
  const out: Uint8Array[][] = [[bytes]];
  for (const size of [1, 2, 3, 7, 64]) {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += size) parts.push(bytes.slice(i, i + size));
    out.push(parts);
  }
  return out;
}

function replay(api: UsageApi, provider: string, model: string, stream: string, maxBufferedBytes = 1 << 16) {
  const bytes = new TextEncoder().encode(stream);
  return chunkings(bytes).map((parts) => {
    let text = '';
    const nonText: string[] = [];
    const acc = createStreamUsageAccumulator(api, { provider, modelRequested: model, origin: 'provider_stream', observedAt: NOW }, { maxBufferedBytes },
      { onTextDelta: (t) => { text += t; }, onNonTextOutput: (r) => nonText.push(r) });
    for (const p of parts) acc.push(p);
    const usage = acc.finish();
    assert.equal(acc.bytesSeen, bytes.length);
    return { usage, text, nonText, issues: acc.issues };
  });
}

function allSame(results: Array<{ usage: NormalizedUsage; text: string }>) {
  for (const r of results.slice(1)) {
    assert.deepEqual(r.usage, results[0]!.usage);
    assert.equal(r.text, results[0]!.text);
  }
  return results[0]!;
}

const UNICODE = 'Olá, mundo! Ação 😀👨‍👩‍👧 中文 — fim.';

describe('d1d8_b stream — OpenAI Chat Completions', () => {
  const events = [
    { id: 'chatcmpl-1', model: 'gpt-4o-mini-2024-07-18', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }], usage: null },
    { id: 'chatcmpl-1', model: 'gpt-4o-mini-2024-07-18', choices: [{ index: 0, delta: { content: UNICODE.slice(0, 9) } }], usage: null },
    { id: 'chatcmpl-1', model: 'gpt-4o-mini-2024-07-18', choices: [{ index: 0, delta: { content: UNICODE.slice(9) }, finish_reason: 'stop' }], usage: null },
    { id: 'chatcmpl-1', model: 'gpt-4o-mini-2024-07-18', choices: [], usage: { prompt_tokens: 12, completion_tokens: 17, total_tokens: 29, prompt_tokens_details: { cached_tokens: 0 } } },
  ];
  it('include_usage final chunk → complete; split UTF-8 and every chunking agree', () => {
    const r = allSame(replay('openai.chat_completions', 'openai', 'gpt-4o-mini', sse(events, { done: true })));
    assert.equal(r.usage.completeness, 'complete');
    assert.equal(r.usage.origin, 'provider_stream');
    assert.equal(r.usage.tIn, 12n);
    assert.equal(r.usage.tOut, 17n);
    assert.equal(r.usage.modelReturned, 'gpt-4o-mini-2024-07-18');
    assert.equal(r.usage.providerRequestId, 'chatcmpl-1');
    assert.equal(r.text, UNICODE);
  });
  it('CRLF framing gives the same result', () => {
    const a = replay('openai.chat_completions', 'openai', 'gpt-4o-mini', sse(events, { done: true }))[0]!;
    const b = replay('openai.chat_completions', 'openai', 'gpt-4o-mini', sse(events, { done: true, crlf: true }))[0]!;
    assert.deepEqual(a.usage, b.usage);
  });
  it('stream without usage (no include_usage, or cut before the last chunk) → missing, never zero', () => {
    const r = allSame(replay('openai.chat_completions', 'openai', 'gpt-4o-mini', sse(events.slice(0, 3))));
    assert.equal(r.usage.completeness, 'missing');
    assert.equal(r.usage.tIn, null);
    assert.equal(r.usage.tOut, null);
  });
  it('tool call deltas are reported as non-text output', () => {
    const r = replay('openai.chat_completions', 'openai', 'gpt-4o-mini', sse([{ id: 'x', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] }]))[0]!;
    assert.deepEqual(r.nonText, ['tool_calls']);
  });
  it('local counter fed by text deltas equals the whole-text count (no per-chunk summing)', () => {
    for (const parts of chunkings(new TextEncoder().encode(sse(events, { done: true })))) {
      const counter = createLocalCounter(resolveModelSupport('openai', 'openai.chat_completions', 'gpt-4o-mini'), { maxTextBytes: 1 << 16 });
      const acc = createStreamUsageAccumulator('openai.chat_completions', { provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_stream', observedAt: NOW }, { maxBufferedBytes: 1 << 16 },
        { onTextDelta: (t) => counter.observeOutputText(t), onNonTextOutput: (r) => counter.markOutputUncovered(r) });
      for (const p of parts) acc.push(p);
      acc.finish();
      const out = counter.finish().counts.find((c) => c.category === 'output')!;
      assert.equal(out.count, BigInt(countWith(loadEncoding('o200k_base').encoder, UNICODE)));
    }
  });
});

describe('d1d8_b stream — OpenAI Responses', () => {
  const completed = { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-4o-mini', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi there' }] }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, output_tokens_details: { reasoning_tokens: 0 } } } };
  const base = [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-4o-mini', usage: null } },
    { type: 'response.output_text.delta', delta: 'Hi ' },
    { type: 'response.output_text.delta', delta: 'there' },
  ];
  it('U2-04 in streaming: response.completed 100/20 → complete, not 0/0', () => {
    const r = allSame(replay('openai.responses', 'openai', 'gpt-4o-mini', sse([...base, completed])));
    assert.equal(r.usage.completeness, 'complete');
    assert.equal(r.usage.tIn, 100n);
    assert.equal(r.usage.tOut, 20n);
    assert.equal(r.text, 'Hi there');
  });
  it('no terminal event → missing', () => {
    assert.equal(replay('openai.responses', 'openai', 'gpt-4o-mini', sse(base))[0]!.usage.completeness, 'missing');
  });
  it('response.incomplete with usage is final usage of an incomplete response', () => {
    const r = replay('openai.responses', 'openai', 'gpt-4o-mini', sse([...base, { ...completed, type: 'response.incomplete' }]))[0]!;
    assert.equal(r.usage.completeness, 'complete');
  });
  it('terminal event larger than the buffer: usage recovered from the bounded tail', () => {
    const big = { ...completed, response: { ...completed.response, output: [{ type: 'message', content: [{ type: 'output_text', text: 'x"usage":{"input_tokens":1}'.repeat(2000) }] }] } };
    const stream = sse([...base, big]);
    for (const r of replay('openai.responses', 'openai', 'gpt-4o-mini', stream, 8192)) {
      assert.equal(r.usage.completeness, 'complete');
      assert.equal(r.usage.tIn, 100n);
      assert.ok(r.issues.some((i) => i.detail === 'event_exceeded_buffer_usage_recovered_from_tail'));
    }
  });
  it('tail recovery ignores an escaped "usage" inside a JSON string', () => {
    assert.deepEqual(recoverUsageFromTail('{"t":"a \\"usage\\":{\\"x\\":9}","usage":{"input_tokens":3}}'), { input_tokens: 3 });
    assert.equal(recoverUsageFromTail('{"t":"no usage here"}'), null);
  });
});

describe('d1d8_b stream — Anthropic Messages (cumulative usage)', () => {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: UNICODE } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
    { type: 'message_delta', delta: {}, usage: { output_tokens: 15 } },
    { type: 'message_stop' },
  ];
  it('message_delta replaces output (cumulative, 15 not 1+10+15); cache kept; complete at message_stop', () => {
    const r = allSame(replay('anthropic.messages', 'anthropic', 'claude-haiku-4-5', sse(events)));
    assert.equal(r.usage.completeness, 'complete');
    assert.equal(r.usage.tOut, 15n);
    assert.equal(r.usage.tIn, 35n); // 25 + cache read 10 + cache write 0
    assert.equal(r.usage.modelReturned, 'claude-haiku-4-5-20251001');
    assert.equal(r.text, UNICODE);
  });
  it('cut before message_stop → partial (usage seen, not final)', () => {
    const r = replay('anthropic.messages', 'anthropic', 'claude-haiku-4-5', sse(events.slice(0, 4)))[0]!;
    assert.equal(r.usage.completeness, 'partial');
  });
  it('thinking and tool_use blocks are non-text output', () => {
    const r = replay('anthropic.messages', 'anthropic', 'claude-haiku-4-5', sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '...' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } },
    ]))[0]!;
    assert.deepEqual(r.nonText, ['thinking_block', 'thinking_delta', 'tool_use_block']);
  });
});

describe('d1d8_b stream — Gemini and Cohere', () => {
  it('Gemini: usage at/after finishReason → complete; thought parts non-text', () => {
    const events = [
      { responseId: 'g1', modelVersion: 'gemini-2.0-flash', candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, totalTokenCount: 10 } },
      { candidates: [{ content: { parts: [{ text: 'Ola' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 4, totalTokenCount: 16 } },
      { candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 4, totalTokenCount: 17 } },
    ];
    const r = allSame(replay('gemini.generate_content', 'gemini', 'gemini-2.0-flash', sse(events)));
    assert.equal(r.usage.completeness, 'complete');
    assert.equal(r.usage.tIn, 10n);
    assert.equal(r.usage.tOut, 7n);
    assert.equal(r.text, 'Ola!');
    const cut = replay('gemini.generate_content', 'gemini', 'gemini-2.0-flash', sse(events.slice(0, 2)))[0]!;
    assert.equal(cut.usage.completeness, 'partial');
  });
  it('Cohere: message-end usage → complete', () => {
    const events = [
      { type: 'message-start', id: 'co1' },
      { type: 'content-delta', delta: { message: { content: { text: 'Hello' } } } },
      { type: 'message-end', delta: { finish_reason: 'COMPLETE', usage: { billed_units: { input_tokens: 5, output_tokens: 26 }, tokens: { input_tokens: 71, output_tokens: 26 } } } },
    ];
    const r = allSame(replay('cohere.chat', 'cohere', 'command-r', sse(events)));
    assert.equal(r.usage.completeness, 'complete');
    assert.equal(r.usage.tIn, 71n);
    assert.equal(r.text, 'Hello');
  });
});

describe('d1d8_b stream — robustness and bounds', () => {
  it('unparseable data lines are reported, not fatal', () => {
    const acc = createStreamUsageAccumulator('openai.chat_completions', { provider: 'openai', modelRequested: 'gpt-4o', origin: 'provider_stream', observedAt: NOW }, { maxBufferedBytes: 1024 });
    acc.push('data: {not json}\n\n: keepalive comment\n\nevent: x\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
    const u = acc.finish();
    assert.equal(u.completeness, 'complete');
    assert.ok(acc.issues.some((i) => i.detail === 'unparseable_event'));
  });
  it('a huge event without recoverable usage leaves usage missing (not trusted), memory bounded', () => {
    const acc = createStreamUsageAccumulator('openai.chat_completions', { provider: 'openai', modelRequested: 'gpt-4o', origin: 'provider_stream', observedAt: NOW }, { maxBufferedBytes: 4096 });
    acc.push(`data: {"choices":[{"delta":{"content":"${'y'.repeat(200_000)}"}}]}\n\n`);
    const u = acc.finish();
    assert.equal(u.completeness, 'missing');
    assert.ok(acc.issues.some((i) => i.detail === 'event_exceeded_buffer_usage_lost'));
  });
  it('final event without trailing blank line is still dispatched at finish()', () => {
    const acc = createStreamUsageAccumulator('openai.chat_completions', { provider: 'openai', modelRequested: 'gpt-4o', origin: 'provider_stream', observedAt: NOW }, { maxBufferedBytes: 1024 });
    acc.push('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}');
    assert.equal(acc.finish().tOut, 4n);
  });
  it('review HIGH-2: oversized non-data line (no newline) is discarded, bounded, and later usage still parsed', () => {
    const acc = createStreamUsageAccumulator('openai.chat_completions', { provider: 'openai', modelRequested: 'gpt-4o', origin: 'provider_stream', observedAt: NOW }, { maxBufferedBytes: 4096 });
    for (let i = 0; i < 200; i++) acc.push('event: ' + 'g'.repeat(50_000)); // 10 MB without a line end
    acc.push('\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n');
    const u = acc.finish();
    assert.equal(u.completeness, 'complete');
    assert.equal(u.tOut, 3n);
    assert.ok(acc.issues.some((i) => i.detail === 'non_data_line_exceeded_buffer_discarded'));
  });
  it('review HIGH-2: lone CR line endings frame events like LF (every chunking)', () => {
    const events = [
      { id: 'c', model: 'gpt-4o', choices: [{ delta: { content: 'oi' } }], usage: null },
      { id: 'c', choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } },
    ];
    const lf = replay('openai.chat_completions', 'openai', 'gpt-4o', sse(events));
    const cr = replay('openai.chat_completions', 'openai', 'gpt-4o', events.map((e) => `data: ${JSON.stringify(e)}\r\r`).join(''));
    for (const r of cr) { assert.deepEqual(r.usage, lf[0]!.usage); assert.equal(r.text, 'oi'); }
  });
  it('review HIGH-3: Anthropic message_delta with null fields keeps message_start values', () => {
    const r = allSame(replay('anthropic.messages', 'anthropic', 'claude-haiku-4-5', sse([
      { type: 'message_start', message: { id: 'm', model: 'claude-haiku-4-5', usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 10 } } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 15, input_tokens: null, cache_read_input_tokens: null } },
      { type: 'message_stop' },
    ])));
    assert.equal(r.usage.completeness, 'complete');
    assert.equal(r.usage.tIn, 35n);
    assert.equal(r.usage.tOut, 15n);
  });
  it('Anthropic message_stop without any message_delta → partial (start count is provisional)', () => {
    const r = replay('anthropic.messages', 'anthropic', 'claude-haiku-4-5', sse([
      { type: 'message_start', message: { id: 'm', usage: { input_tokens: 25, output_tokens: 1 } } },
      { type: 'message_stop' },
    ]))[0]!;
    assert.equal(r.usage.completeness, 'partial');
  });
  it('review MEDIUM-4: an event above the buffer signals non-text output (counter not complete)', () => {
    const big = { type: 'response.completed', response: { id: 'r', model: 'gpt-4o', output: [{ type: 'message', content: [{ type: 'output_text', text: 'z'.repeat(20_000) }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } };
    for (const r of replay('openai.responses', 'openai', 'gpt-4o', sse([big]), 4096)) {
      assert.equal(r.usage.completeness, 'complete');
      assert.ok(r.nonText.includes('event_exceeded_buffer'));
    }
  });
  it('re-audit LOW: oversized Anthropic message_delta has its recovered usage applied (not just reported)', () => {
    const events = [
      { type: 'message_start', message: { id: 'm', model: 'claude-haiku-4-5', usage: { input_tokens: 25, output_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', padding: 'p'.repeat(20_000) }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    for (const r of replay('anthropic.messages', 'anthropic', 'claude-haiku-4-5', sse(events), 4096)) {
      assert.equal(r.usage.completeness, 'complete');
      assert.equal(r.usage.tOut, 7n);
      assert.ok(r.issues.some((i) => i.detail === 'event_exceeded_buffer_usage_recovered_from_tail'));
    }
  });

  it('review MEDIUM-4: tail recovery skips a later string-valued "usage" key', () => {
    assert.deepEqual(recoverUsageFromTail('{"usage":{"input_tokens":3},"metadata":{"usage":"internal"}}'), { input_tokens: 3 });
  });

  it('push after finish is refused', () => {
    const acc = createStreamUsageAccumulator('openai.chat_completions', { provider: 'openai', modelRequested: 'gpt-4o', origin: 'provider_stream', observedAt: NOW }, { maxBufferedBytes: 1024 });
    acc.finish();
    assert.throws(() => acc.push('data: {}\n\n'));
  });
});
