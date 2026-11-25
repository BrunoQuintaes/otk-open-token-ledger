/**
 * D1–D8 front B — catalog, incremental counter, local counter and conference report
 * (D4-G03/G04/G05, D8-G01 local part, U2-01/U2-02/U2-03/U2-09).
 * Whole-text counts are the reference for the incremental counter: every split of the same
 * text must give the same number (property checked over many deterministic pseudo-random splits).
 *
 * Modules under test: `src/providers/catalog/modelCatalog.ts`, `src/tokenization/tokenizerIdentity.ts`,
 * `src/tokenization/incrementalCounter.ts`, `src/tokenization/localCounter.ts`,
 * `src/tokenization/conferenceReport.ts`, `src/providers/usage/normalizeUsage.ts` and the legacy
 * `src/tokenization/TokenizerRegistry.ts`.
 *
 * Strategy / partitions: catalog ids against the installed tiktoken model table, dated
 * snapshots, unlisted ids, approximate providers and unsupported combinations; the tokenizer
 * identity record; incremental counting vs whole-text counting under random splits, oversized
 * pieces, a known cut-point regression, a 3000-string fuzz, safe cut points and memory bounds;
 * local counter coverage for text, tools/images, missing output, oversized input, unsupported
 * models and per-API text extraction; conference report verdicts from the shared vectors and
 * for missing usage, counter failure, approximate tokenizers, hidden reasoning, and the relative
 * delta rule.
 *
 * Needs: must be run from the repository root, because it reads
 * `test/fixtures/d1d8/common_vectors.json` and `package-lock.json` by relative path. No network.
 *
 * Run just this file: `npx tsx --test test/unit/d1d8_b_counter.test.ts`
 *
 * @module test/unit/d1d8_b_counter.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getEncodingNameForModel } from 'js-tiktoken';
import { resolveModelSupport, listedOpenAiIds, MODEL_CATALOG_VERSION } from '../../src/providers/catalog/modelCatalog.js';
import { loadEncoding, countWith, tiktokenPackageVersion, MAX_PIECE_CHARS } from '../../src/tokenization/tokenizerIdentity.js';
import { IncrementalCounter, lastSafeCut } from '../../src/tokenization/incrementalCounter.js';
import { createLocalCounter, extractInputText, extractOutputText } from '../../src/tokenization/localCounter.js';
import { buildConferenceReport, HEURISTIC_THRESHOLD_V0, relativeDeltaString } from '../../src/tokenization/conferenceReport.js';
import { normalizeUsage } from '../../src/providers/usage/normalizeUsage.js';
import { TokenizerRegistry } from '../../src/tokenization/TokenizerRegistry.js';
import type { ConferenceThreshold, LocalCountResult, NormalizedUsage } from '../../src/types/d1d8/index.js';

const vectors = JSON.parse(readFileSync('test/fixtures/d1d8/common_vectors.json', 'utf8')) as { vectors: Array<Record<string, any>> };
const V = (id: string) => vectors.vectors.find((v) => v.id === id)!;
const NOW = '2026-09-30T12:00:00.000Z';

/**
 * Deterministic PRNG (mulberry32) so failures are reproducible.
 *
 * @param seed - Any integer; the same seed gives the same sequence.
 * @returns A function returning the next value in [0, 1) on each call.
 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLES = [
  'Reconciliação de consumo: informações financeiras e recuperação de serviços.',
  'hello world\n\nThis is   a test.\r\nNew line with trailing spaces   \n  indented\tline',
  "It's what we're doing; they'll see. Don't stop — 12345678 numbers 3.14159!",
  'função calcular(x) {\n  return x * 2; // comentário\n}\n\nconst ç = "ação";\n',
  'emoji 😀😃 family 👨‍👩‍👧 flags 🇧🇷 and CJK 中文字符测试 日本語 한국어 and Ünïcödé',
  '{"a":1,"b":[true,false,null],"c":"x\\ny"}\n{"d":"<|endoftext|> treated as text"}',
  'x = 1;\n// comment after newline\n/* block */\n.\n//\n(\n/path/to/file\nreturn a / b;\n'.repeat(20),
  'CamelCaseWordsHereAndTHEREandHTTPServer2Go mixedCASE\n\n\n\nSpaces    before\n- bullet\n- list',
  'a'.repeat(300) + ' ' + 'b '.repeat(400) + '\n' + 'z'.repeat(10) + '\n\n' + 'word '.repeat(300),
];

describe('d1d8_b catalog (D4-G03, U2-01, U2-09)', () => {
  it('every listed OpenAI id matches tiktoken\'s own model table in the installed package', () => {
    for (const { id, encoding } of listedOpenAiIds()) {
      assert.equal(getEncodingNameForModel(id as never), encoding, id);
    }
  });
  it('TOK-01: gpt-4o-mini and its dated snapshot use the same encoding and count', () => {
    const v = V('TOK-01');
    const a = resolveModelSupport('openai', 'openai.chat_completions', v.models[0]);
    const b = resolveModelSupport('openai', 'openai.responses', v.models[1]);
    assert.equal(a.support, 'exact');
    assert.equal(b.support, 'alias_known');
    assert.equal(b.catalogKey, 'gpt-4o-mini');
    assert.equal(a.tokenizer!.encoding, v.expected.encoding);
    assert.deepEqual(a.tokenizer, b.tokenizer);
    const enc = loadEncoding('o200k_base').encoder;
    assert.equal(countWith(enc, v.text), Number(v.expected.count));
    assert.equal(countWith(loadEncoding('cl100k_base').encoder, v.text), Number(v.expected.historical_dated_count_cl100k));
  });
  it('legacy TokenizerRegistry: the dated alias no longer falls back to cl100k (U2-01 fixed in place)', () => {
    const reg = new TokenizerRegistry();
    const v = V('TOK-01');
    const plain = reg.countClientTokens('openai', 'gpt-4o-mini', v.text, '');
    const dated = reg.countClientTokens('openai', 'gpt-4o-mini-2024-07-18', v.text, '');
    assert.equal(plain.tokenizerId, dated.tokenizerId);
    assert.equal(dated.inputTokens, 13);
  });
  it('unlisted dated id of a known family is generic_fallback, never exact', () => {
    const s = resolveModelSupport('openai', 'openai.chat_completions', 'gpt-4o-mini-2099-01-01');
    assert.equal(s.support, 'generic_fallback');
    assert.equal(s.catalogKey, null);
  });
  it('approximate providers are generic_fallback (OpenAI-compatible wire ≠ same tokenizer)', () => {
    for (const [p, api, m] of [['anthropic', 'anthropic.messages', 'claude-haiku-4-5'], ['gemini', 'gemini.generate_content', 'gemini-2.0-flash'], ['deepseek', 'deepseek.chat_completions', 'deepseek-chat']] as const) {
      const s = resolveModelSupport(p, api, m);
      assert.equal(s.support, 'generic_fallback', p);
      assert.equal(s.tokenizer!.encoding, 'cl100k_base');
    }
  });
  it('unknown provider, provider/api mismatch and unknown OpenAI family are unsupported', () => {
    assert.equal(resolveModelSupport('acme', 'openai.chat_completions', 'x').support, 'unsupported');
    assert.equal(resolveModelSupport('anthropic', 'openai.responses', 'claude-haiku-4-5').support, 'unsupported');
    assert.equal(resolveModelSupport('openai', 'openai.chat_completions', 'davinci-002').support, 'unsupported');
    assert.equal(resolveModelSupport('openai', 'openai.chat_completions', 'davinci-002').tokenizer, null);
    // review HIGH-4: prototype names are not catalog entries
    for (const id of ['constructor', '__proto__', 'toString']) {
      assert.equal(resolveModelSupport('openai', 'openai.chat_completions', id).support, 'unsupported');
      assert.equal(resolveModelSupport(id, 'openai.chat_completions', 'gpt-4o').support, 'unsupported');
    }
  });
  it('D4-G05: identity carries package version, encoding, vocabulary digest and assembly rule', () => {
    const s = resolveModelSupport('openai', 'openai.chat_completions', 'gpt-4o');
    assert.equal(s.catalogVersion, MODEL_CATALOG_VERSION);
    assert.equal(s.tokenizer!.package, 'js-tiktoken');
    assert.equal(s.tokenizer!.packageVersion, tiktokenPackageVersion());
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    assert.equal(s.tokenizer!.packageVersion, lock.packages['node_modules/js-tiktoken'].version);
    assert.match(s.tokenizer!.vocabularyDigest!, /^0x[0-9a-f]{64}$/);
    assert.notEqual(loadEncoding('o200k_base').identity.vocabularyDigest, loadEncoding('cl100k_base').identity.vocabularyDigest);
    assert.deepEqual(s.tokenizer!.messageAssembly, { id: 'otk.assembly.text_parts', version: '1' });
  });
});

describe('d1d8_b incremental counter (U2-03, D8 §2)', () => {
  it('TOK-02: naive per-chunk sum differs, incremental equals whole', () => {
    const v = V('TOK-02');
    for (const enc of ['o200k_base', 'cl100k_base'] as const) {
      const e = loadEncoding(enc).encoder;
      assert.equal(countWith(e, v.text), Number(v.expected.whole));
      assert.equal(v.split.reduce((s: number, p: string) => s + countWith(e, p), 0), Number(v.expected.naive_sum));
      const c = new IncrementalCounter(e, { maxTextBytes: 1 << 20, flushAtChars: 1 });
      for (const p of v.split) c.push(p);
      assert.equal(c.finish().count, Number(v.expected.incremental));
    }
  });

  for (const enc of ['o200k_base', 'cl100k_base'] as const) {
    it(`${enc}: 60 random splits per sample equal the whole-text count (eager flushing)`, () => {
      const e = loadEncoding(enc).encoder;
      const r = rng(enc === 'o200k_base' ? 1 : 2);
      for (const text of SAMPLES) {
        const whole = countWith(e, text);
        for (let k = 0; k < 60; k++) {
          const c = new IncrementalCounter(e, { maxTextBytes: 1 << 20, flushAtChars: 1 + Math.floor(r() * 64) });
          let i = 0;
          while (i < text.length) {
            const n = 1 + Math.floor(r() * 40);
            c.push(text.slice(i, i + n));
            i += n;
          }
          assert.equal(c.finish().count, whole, `split mismatch in ${JSON.stringify(text.slice(0, 30))}`);
        }
      }
    });
  }

  it('a regex piece above MAX_PIECE_CHARS is not counted (bounded CPU), it truncates explicitly', () => {
    const e = loadEncoding('o200k_base').encoder;
    const c = new IncrementalCounter(e, { maxTextBytes: 1 << 20 });
    const t0 = Date.now();
    c.push('x'.repeat(MAX_PIECE_CHARS + 1));
    const r = c.finish();
    assert.equal(r.truncated, true);
    assert.equal(r.truncationReason, 'max_piece_chars');
    assert.equal(r.count, 0);
    assert.ok(Date.now() - t0 < 1000);
    const lc = createLocalCounter(resolveModelSupport('openai', 'openai.chat_completions', 'gpt-4o'), { maxTextBytes: 1 << 20 });
    lc.observeInput({ api: 'openai.chat_completions', body: { messages: [{ role: 'user', content: 'y'.repeat(5000) }] } });
    assert.ok(lc.finish().uncovered.includes('input'));
    assert.ok(lc.reasons.includes('input_max_piece_chars'));
  });

  it('review regression: no cut between "\\n" and "/" (o200k continues a punctuation piece into "/")', () => {
    for (const enc of ['o200k_base', 'cl100k_base'] as const) {
      const e = loadEncoding(enc).encoder;
      for (const text of ['.\n//', '"\n/', '(\n/x', '*\n/B!_', 'a;\n// comment\nb']) {
        const c = new IncrementalCounter(e, { maxTextBytes: 1 << 20, flushAtChars: 1 });
        for (const ch of text) c.push(ch);
        assert.equal(c.finish().count, countWith(e, text), `${enc} ${JSON.stringify(text)}`);
      }
    }
    assert.equal(lastSafeCut('.\n//'), 0);
  });

  it('adversarial fuzz: 3000 random strings over punctuation/newline/unicode alphabet, char-by-char pushes', () => {
    const alphabet = ['\n', '\r', '\t', ' ', '  ', '/', '.', ';', '"', "'", "'s", '(', ')', '*', '-', '_', '!', 'a', 'B', 'é', 'ç', '中', '1', '23', '😀', '—', '<|endoftext|>', '\u0085', '\u2028', '\u2029', '\v', '\f', '\u00a0', 'e\u0301', '\u200d'];
    for (const enc of ['o200k_base', 'cl100k_base'] as const) {
      const e = loadEncoding(enc).encoder;
      const r = rng(enc === 'o200k_base' ? 11 : 12);
      for (let k = 0; k < 1500; k++) {
        let text = '';
        const n = 1 + Math.floor(r() * 30);
        for (let i = 0; i < n; i++) text += alphabet[Math.floor(r() * alphabet.length)];
        const c = new IncrementalCounter(e, { maxTextBytes: 1 << 20, flushAtChars: 1 });
        let i = 0;
        while (i < text.length) { const step = 1 + Math.floor(r() * 3); c.push(text.slice(i, i + step)); i += step; }
        assert.equal(c.finish().count, countWith(e, text), `${enc} ${JSON.stringify(text)}`);
      }
    }
  });

  it('safe cut points never split a surrogate pair or a newline run', () => {
    assert.equal(lastSafeCut('abc\n\n'), 0);
    assert.equal(lastSafeCut('abc\n\nx'), 5);
    assert.equal(lastSafeCut('ab cd'), 2);
    assert.equal(lastSafeCut('😀 😀'), 0);
  });

  it('max_text_bytes and max_pending_chars truncate explicitly (bounded memory)', () => {
    const e = loadEncoding('o200k_base').encoder;
    const a = new IncrementalCounter(e, { maxTextBytes: 10 });
    a.push('12345');
    a.push('678901');
    const ra = a.finish();
    assert.equal(ra.truncated, true);
    assert.equal(ra.truncationReason, 'max_text_bytes');
    const b = new IncrementalCounter(e, { maxTextBytes: 1 << 20, maxPendingChars: 500, flushAtChars: 100 });
    b.push('x'.repeat(800));
    const rb = b.finish();
    assert.equal(rb.truncated, true);
    assert.equal(rb.truncationReason, 'max_pending_chars');
    assert.ok(rb.peakPendingBytes <= 800);
  });
});

describe('d1d8_b local counter — coverage (D4 §7, D8 §1)', () => {
  const support = resolveModelSupport('openai', 'openai.chat_completions', 'gpt-4o-mini');
  it('text-only input and output → ok, counts per part summed', () => {
    const c = createLocalCounter(support, { maxTextBytes: 1 << 20 });
    c.observeInput({ api: 'openai.chat_completions', body: { messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] }] } });
    c.observeOutputText('hel');
    c.observeOutputText('lo');
    const r = c.finish();
    const e = loadEncoding('o200k_base').encoder;
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.covered, ['input', 'output']);
    assert.equal(r.counts.find((x) => x.category === 'input')!.count, BigInt(countWith(e, 'You are terse.') + countWith(e, 'hello') + countWith(e, ' world')));
    assert.equal(r.counts.find((x) => x.category === 'output')!.count, BigInt(countWith(e, 'hello')));
    assert.ok(r.cost.cpuMicros !== null && r.cost.cpuMicros >= 0n);
  });
  it('tools or images make input uncovered; tool-call output marked uncovered', () => {
    const c = createLocalCounter(support, { maxTextBytes: 1 << 20 });
    c.observeInput({ api: 'openai.chat_completions', body: { tools: [{ type: 'function' }], messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'hi' }] }] } });
    c.observeOutputText('ok');
    c.markOutputUncovered('tool_calls');
    const r = c.finish();
    assert.equal(r.status, 'incomplete');
    assert.deepEqual(r.uncovered.sort(), ['input', 'output']);
    assert.ok(c.reasons.includes('tools') && c.reasons.includes('image_url_part'));
  });
  it('output never observed → uncovered, not zero', () => {
    const c = createLocalCounter(support, { maxTextBytes: 1 << 20 });
    c.observeInput({ api: 'openai.chat_completions', body: { messages: [{ role: 'user', content: 'x' }] } });
    const r = c.finish();
    assert.ok(r.uncovered.includes('output'));
    assert.equal(r.counts.find((x) => x.category === 'output'), undefined);
  });
  it('input larger than maxTextBytes → uncovered, no number', () => {
    const c = createLocalCounter(support, { maxTextBytes: 4 });
    c.observeInput({ api: 'openai.chat_completions', body: { messages: [{ role: 'user', content: 'too long' }] } });
    const r = c.finish();
    assert.ok(r.uncovered.includes('input'));
    assert.equal(r.counts.find((x) => x.category === 'input'), undefined);
  });
  it('unsupported model → status unsupported', () => {
    const c = createLocalCounter(resolveModelSupport('acme', 'openai.chat_completions', 'x'), { maxTextBytes: 10 });
    assert.equal(c.finish().status, 'unsupported');
  });
  it('per-API assembly extracts text parts and flags non-text', () => {
    assert.deepEqual(extractInputText('anthropic.messages', { system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', source: {} }] }] }).texts, ['sys', 'a']);
    assert.equal(extractInputText('gemini.generate_content', { contents: [{ parts: [{ text: 'a' }, { inlineData: {} }] }] }).nonText, true);
    assert.deepEqual(extractInputText('openai.responses', { instructions: 'i', input: [{ role: 'user', content: [{ type: 'input_text', text: 'q' }] }] }).texts, ['i', 'q']);
    assert.deepEqual(extractOutputText('openai.responses', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ans' }] }] }).texts, ['ans']);
    assert.equal(extractOutputText('openai.responses', { output: [{ type: 'reasoning' }, { type: 'message', content: [] }] }).nonText, true);
    assert.equal(extractOutputText('gemini.generate_content', { candidates: [{ content: { parts: [{ text: 't', thought: true }] } }] }).nonText, true);
  });
});

function usageOf(input: number, output: number, extra: Record<string, unknown> = {}): NormalizedUsage {
  return normalizeUsage('openai.chat_completions', { model: 'gpt-4o-mini', usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, ...extra } },
    { provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_response', observedAt: NOW });
}
function localOf(input: number, output: number, status: LocalCountResult['status'] = 'ok'): LocalCountResult {
  return { counts: [{ category: 'input', count: BigInt(input) }, { category: 'output', count: BigInt(output) }], covered: ['input', 'output'], uncovered: [], status, counterVersion: 'test', cost: { cpuMicros: 0n, peakBufferedBytes: 0 } };
}
const KEY = { tenantId: 't1', operationId: 'op1' };
const DIGEST = `0x${'ab'.repeat(32)}` as const;
const thr = (v: Record<string, any>): ConferenceThreshold => ({ absoluteTokens: BigInt(v.absoluteTokens), relative: v.relative, calibrationVersion: null, calibrated: v.calibrated });

describe('d1d8_b conference report (D4-G04, D3 §4, U2-02)', () => {
  const exact = resolveModelSupport('openai', 'openai.chat_completions', 'gpt-4o-mini');
  for (const id of ['CONF-ZERO-01', 'CONF-WITHIN-01', 'CONF-REL-01']) {
    it(id, () => {
      const v = V(id);
      const rep = buildConferenceReport({
        key: KEY, receiptDigest: DIGEST, support: exact, now: NOW, threshold: thr(v.threshold),
        usage: usageOf(Number(v.provider_counts.input), Number(v.provider_counts.output)),
        local: localOf(Number(v.local_counts.input), Number(v.local_counts.output)),
      });
      assert.equal(rep.state, v.expected.state);
      assert.equal(rep.verdict, v.expected.verdict);
      for (const cat of ['input', 'output'] as const) {
        if (!v.expected[cat]) continue;
        const c = rep.comparisons.find((x) => x.category === cat)!;
        assert.equal(c.absoluteDelta, BigInt(v.expected[cat].absoluteDelta));
        assert.equal(c.relativeDelta, v.expected[cat].relativeDelta);
      }
      assert.equal(rep.threshold.calibrated, false);
      assert.equal(rep.threshold.calibrationVersion, null);
      assert.equal(rep.receiptDigest, DIGEST);
    });
  }
  it('legacy detectDiscrepancy now flags provider 0 with local 100 (U2-02 fixed in place)', () => {
    const reg = new TokenizerRegistry();
    const d = reg.detectDiscrepancy(0, 0, { inputTokens: 100, outputTokens: 20, totalTokens: 120, tokenizerId: 'x' });
    assert.equal(d.flagged, true);
    assert.equal(d.deltaInput, -100);
  });
  it('missing provider usage → observed, no verdict', () => {
    const u = normalizeUsage('openai.chat_completions', {}, { provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_response', observedAt: NOW });
    const rep = buildConferenceReport({ key: KEY, receiptDigest: DIGEST, support: exact, now: NOW, threshold: HEURISTIC_THRESHOLD_V0, usage: u, local: localOf(10, 2) });
    assert.equal(rep.state, 'observed');
    assert.equal(rep.verdict, 'not_applicable');
  });
  it('counter failed → unavailable; unsupported model → unsupported', () => {
    const failed = buildConferenceReport({ key: KEY, receiptDigest: DIGEST, support: exact, now: NOW, threshold: HEURISTIC_THRESHOLD_V0, usage: usageOf(10, 2), local: { ...localOf(0, 0, 'failed'), counts: [] } });
    assert.equal(failed.state, 'unavailable');
    const unsup = buildConferenceReport({ key: KEY, receiptDigest: DIGEST, support: resolveModelSupport('acme', 'openai.chat_completions', 'x'), now: NOW, threshold: HEURISTIC_THRESHOLD_V0, usage: usageOf(10, 2), local: localOf(10, 2) });
    assert.equal(unsup.state, 'unsupported');
    assert.equal(unsup.verdict, 'not_applicable');
  });
  it('approximate tokenizer without calibration: numbers but no verdict (incomplete)', () => {
    const approx = resolveModelSupport('anthropic', 'anthropic.messages', 'claude-haiku-4-5');
    const u = normalizeUsage('anthropic.messages', { model: 'claude-haiku-4-5', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 } }, { provider: 'anthropic', modelRequested: 'claude-haiku-4-5', origin: 'provider_response', observedAt: NOW });
    const rep = buildConferenceReport({ key: KEY, receiptDigest: DIGEST, support: approx, now: NOW, threshold: HEURISTIC_THRESHOLD_V0, usage: u, local: localOf(139, 20) });
    assert.equal(rep.state, 'incomplete');
    assert.equal(rep.verdict, 'not_applicable');
    assert.equal(rep.comparisons.find((c) => c.category === 'input')!.provider, 140n); // 100 + cache 40 (T_entrada)
    const calibrated = buildConferenceReport({ key: KEY, receiptDigest: DIGEST, support: approx, now: NOW, threshold: { ...HEURISTIC_THRESHOLD_V0, calibrated: true, calibrationVersion: 'cal-test' }, usage: u, local: localOf(139, 20) });
    assert.equal(calibrated.state, 'compared');
    assert.deepEqual(calibrated.coveredCategories, ['input', 'input_cache_read', 'output']);
  });
  it('hidden reasoning inside output makes output uncovered (only input compared)', () => {
    const rep = buildConferenceReport({ key: KEY, receiptDigest: DIGEST, support: exact, now: NOW, threshold: HEURISTIC_THRESHOLD_V0, usage: usageOf(100, 50, { completion_tokens_details: { reasoning_tokens: 30 } }), local: localOf(100, 20) });
    assert.equal(rep.state, 'compared');
    assert.deepEqual(rep.comparisons.map((c) => c.category), ['input']);
    assert.ok(rep.uncoveredCategories.includes('output') && rep.uncoveredCategories.includes('output_reasoning'));
  });
  it('relative delta rule: floor to 6 digits, null for provider 0', () => {
    assert.equal(relativeDeltaString(1n, 3n), '0.333333');
    assert.equal(relativeDeltaString(-2n, 3n), '0.666666');
    assert.equal(relativeDeltaString(5n, 0n), null);
  });
});
