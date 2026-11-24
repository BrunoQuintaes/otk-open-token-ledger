/** R14: ex ante estimators. Text = OTK counter imported from H1; image = official formulas (EXPERIMENTAL, values from the documentation's own examples); everything else UNSUPPORTED_FOR_ESTIMATION. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { estimateExAnte, estimateOpenAiImageTokens, estimateAnthropicImageTokens, readPngSize, GOOGLE_AUDIO_REFERENCE_FIGURE } from '../../../scripts/h2eval/modal/estimators/index.js';
import { openAiResizedDims } from '../../../scripts/h2eval/modal/estimators/image_openai_tiles.js';
import { buildOpenAiChatRequest, buildAnthropicMessagesRequest, buildGoogleGenerateContentRequest } from '../../../scripts/h2eval/modal/adapters/index.js';
import { loadEncoding, countWith } from '../../../src/tokenization/tokenizerIdentity.js';

const TXT = 'Resuma em uma frase: o gato subiu no telhado e desceu pela escada.';

describe('text estimator = OTK local counter (EXISTENTE)', () => {
  it('openai: exact o200k_base count of the text parts, label EXISTENTE', () => {
    const r = buildOpenAiChatRequest({ model: 'gpt-4o-mini-2024-07-18', messages: [{ role: 'user', parts: [{ kind: 'text', text: TXT }] }], maxOutputTokens: 24 });
    const e = estimateExAnte('gpt-4o-mini-2024-07-18', r.api, 'text', { requestBody: r.body });
    assert.equal(e.status, 'ESTIMATED'); assert.equal(e.label, 'EXISTENTE'); assert.equal(e.counter!.encoding, 'o200k_base'); assert.equal(e.counter!.exact, true);
    assert.equal(e.tokens, BigInt(countWith(loadEncoding('o200k_base').encoder, TXT)));
    assert.equal(e.counter!.version, 'otk.local_counter.b3@1');
  });
  it('anthropic / gemini: cl100k approximation; haiku-5-5 flagged uncalibrated', () => {
    const a = buildAnthropicMessagesRequest({ model: 'claude-haiku-5-5', messages: [{ role: 'user', parts: [{ kind: 'text', text: TXT }] }], maxOutputTokens: 24 });
    const e = estimateExAnte('claude-haiku-5-5', a.api, 'text', { requestBody: a.body });
    assert.equal(e.status, 'ESTIMATED'); assert.equal(e.counter!.exact, false); assert.equal(e.counter!.encoding, 'cl100k_base'); assert.ok(e.reasons.includes('haiku_5_5_new_tokenizer_approx_cl100k_uncalibrated'));
    const g = buildGoogleGenerateContentRequest({ model: 'gemini-3.5-flash-lite', contents: [{ role: 'user', parts: [{ kind: 'text', text: TXT }] }], maxOutputTokens: 24 });
    assert.equal(estimateExAnte('gemini-3.5-flash-lite', g.api, 'text', { requestBody: g.body }).status, 'ESTIMATED');
  });
  it('a request with an image or audio part => UNSUPPORTED_FOR_ESTIMATION (counter incomplete), no L0 invented', () => {
    const r = buildOpenAiChatRequest({ model: 'gpt-4o-mini-2024-07-18', messages: [{ role: 'user', parts: [{ kind: 'text', text: TXT }, { kind: 'image', dataUrlOrUrl: 'data:image/png;base64,AAAA', detail: 'low' }] }], maxOutputTokens: 24 });
    const e = estimateExAnte('gpt-4o-mini-2024-07-18', r.api, 'text', { requestBody: r.body });
    assert.equal(e.status, 'UNSUPPORTED_FOR_ESTIMATION'); assert.equal(e.tokens, null); assert.equal(e.label, 'NONE'); assert.ok(e.reasons.some((x) => /image_url_part|incomplete/.test(x)));
    const g = buildGoogleGenerateContentRequest({ model: 'gemini-3.5-flash-lite', contents: [{ role: 'user', parts: [{ kind: 'text', text: TXT }, { kind: 'audio', mimeType: 'audio/wav', base64: 'AAAA' }] }], maxOutputTokens: 24 });
    assert.equal(estimateExAnte('gemini-3.5-flash-lite', g.api, 'text', { requestBody: g.body }).status, 'UNSUPPORTED_FOR_ESTIMATION');
  });
});

describe('openai image tiles (EXPERIMENTAL; openai/images-vision.html)', () => {
  it('detail low = base tokens only, regardless of dimensions', () => {
    for (const [w, h] of [[16, 16], [4000, 3000]] as const) { const e = estimateOpenAiImageTokens({ width: w, height: h, detail: 'low', model: 'gpt-4o-mini-2024-07-18' }); assert.equal(e.tokens, 2833n); assert.equal(e.label, 'EXPERIMENTAL'); }
  });
  it('resizing rule: fit 2048 square (no enlarging), shortest side > 768 -> 768 with the other side rounded down', () => {
    assert.deepEqual(openAiResizedDims(512, 512), { w: 512, h: 512 });
    assert.deepEqual(openAiResizedDims(1024, 1024), { w: 768, h: 768 });
    assert.deepEqual(openAiResizedDims(2048, 4096), { w: 768, h: 1536 });
    assert.deepEqual(openAiResizedDims(1920, 1080), { w: 1365, h: 768 }); // 1920*768/1080 = 1365.33 rounded down
    assert.deepEqual(openAiResizedDims(100, 50), { w: 100, h: 50 });
  });
  it('tiles = 512px squares needed to cover; tokens = base + tiles x tile', () => {
    assert.equal(estimateOpenAiImageTokens({ width: 512, height: 512, detail: 'high', model: 'gpt-4o-mini-2024-07-18' }).tokens, 2833n + 5667n);
    assert.equal(estimateOpenAiImageTokens({ width: 1024, height: 1024, detail: 'auto', model: 'gpt-4o-mini-2024-07-18' }).tokens, 2833n + 4n * 5667n);
    assert.equal(estimateOpenAiImageTokens({ width: 2048, height: 4096, detail: 'high', model: 'gpt-4o-mini-2024-07-18' }).tokens, 2833n + 6n * 5667n); // 768x1536 -> 2x3
    assert.equal(estimateOpenAiImageTokens({ width: 1920, height: 1080, detail: 'high', model: 'gpt-4o-mini-2024-07-18' }).tokens, 2833n + 6n * 5667n); // 1365x768 -> 3x2
    const e = estimateOpenAiImageTokens({ width: 513, height: 1, detail: 'high', model: 'gpt-4o-mini-2024-07-18' }); assert.equal(e.tokens, 2833n + 2n * 5667n); assert.ok(e.reasons.includes('billing_may_differ_by_one_token'));
  });
  it('detail original and invalid dimensions => UNSUPPORTED', () => {
    assert.equal(estimateOpenAiImageTokens({ width: 10, height: 10, detail: 'original', model: 'gpt-4o-mini-2024-07-18' }).status, 'UNSUPPORTED_FOR_ESTIMATION');
    assert.equal(estimateOpenAiImageTokens({ width: 0, height: 10, detail: 'high', model: 'gpt-4o-mini-2024-07-18' }).status, 'UNSUPPORTED_FOR_ESTIMATION');
  });
});

describe('anthropic image patches (EXPERIMENTAL; anthropic/vision.html documented table)', () => {
  it('documented values, both tiers, "Not resized": 200x200=64, 1000x1000=1,296, 1092x1092=1,521', () => {
    for (const m of ['claude-haiku-4-5-20251001', 'claude-haiku-5-5'] as const) {
      assert.equal(estimateAnthropicImageTokens({ width: 200, height: 200, model: m }).tokens, 64n);
      assert.equal(estimateAnthropicImageTokens({ width: 1000, height: 1000, model: m }).tokens, 1296n);
      const e = estimateAnthropicImageTokens({ width: 1092, height: 1092, model: m }); assert.equal(e.tokens, 1521n); assert.equal(e.status, 'ESTIMATED');
    }
  });
  it('high-resolution tier (Haiku 5.5): 1920x1080 = 2,691 and 2000x1500 = 3,888 not resized; 3840x2160 capped at 4,784', () => {
    assert.equal(estimateAnthropicImageTokens({ width: 1920, height: 1080, model: 'claude-haiku-5-5' }).tokens, 2691n);
    assert.equal(estimateAnthropicImageTokens({ width: 2000, height: 1500, model: 'claude-haiku-5-5' }).tokens, 3888n);
    const big = estimateAnthropicImageTokens({ width: 3840, height: 2160, model: 'claude-haiku-5-5' }); assert.equal(big.status, 'ESTIMATED_UPPER_BOUND'); assert.equal(big.tokens, 4784n);
  });
  it('standard tier (Haiku 4.5): oversized => only the documented cap 1,568 as an upper bound (resize page not archived); doc values 1,560 / 1,564 stay under it', () => {
    for (const [w, h] of [[1920, 1080], [2000, 1500], [3840, 2160]] as const) {
      const e = estimateAnthropicImageTokens({ width: w, height: h, model: 'claude-haiku-4-5-20251001' });
      assert.equal(e.status, 'ESTIMATED_UPPER_BOUND'); assert.equal(e.tokens, 1568n); assert.ok(e.reasons.includes('resize_rule_page_not_archived'));
    }
    assert.ok(1560n <= 1568n && 1564n <= 1568n);
  });
  it('pricing example of the page: 1000x1000 on Haiku 4.5 at $1/MTok = about $1.30 per thousand images', () => { assert.equal(1296n * 1000000n * 1000n, 1296000000000n); /* 1.296 USD per 1000 images, pico-USD */ });
});

describe('UNSUPPORTED_FOR_ESTIMATION: Google image, all audio, no error ever computed', () => {
  it('google image => UNSUPPORTED (formula "rough"); audio => UNSUPPORTED on every model', () => {
    const gi = estimateExAnte('gemini-3.5-flash-lite', 'gemini.generate_content', 'image', { image: { width: 960, height: 540 } }); assert.equal(gi.status, 'UNSUPPORTED_FOR_ESTIMATION'); assert.equal(gi.tokens, null); assert.match(gi.citation ?? '', /rough/);
    for (const [m, api] of [['gpt-4o-mini-2024-07-18', 'openai.chat_completions'], ['claude-haiku-4-5-20251001', 'anthropic.messages'], ['claude-haiku-5-5', 'anthropic.messages'], ['gemini-3.5-flash-lite', 'gemini.generate_content']] as const) {
      const e = estimateExAnte(m, api, 'audio', { audioSeconds: 60 }); assert.equal(e.status, 'UNSUPPORTED_FOR_ESTIMATION'); assert.equal(e.tokens, null); assert.equal(e.label, 'NONE');
    }
    assert.match(GOOGLE_AUDIO_REFERENCE_FIGURE, /reference only/);
  });
  it('a comparison helper must refuse an UNSUPPORTED estimate (guard the analysis never computes an error)', () => {
    const errorAgainst = (est: { status: string; tokens: bigint | null }, declared: bigint): bigint | 'NOT_COMPARABLE' => (est.status === 'ESTIMATED' && est.tokens !== null ? est.tokens - declared : 'NOT_COMPARABLE');
    assert.equal(errorAgainst(estimateExAnte('gemini-3.5-flash-lite', 'gemini.generate_content', 'audio', { audioSeconds: 10 }), 320n), 'NOT_COMPARABLE');
    assert.equal(errorAgainst(estimateAnthropicImageTokens({ width: 3840, height: 2160, model: 'claude-haiku-4-5-20251001' }), 1560n), 'NOT_COMPARABLE'); // upper bound is not an estimate
    assert.equal(errorAgainst(estimateAnthropicImageTokens({ width: 1000, height: 1000, model: 'claude-haiku-4-5-20251001' }), 1296n), 0n);
  });
});

describe('PNG dimensions from the synthetic fixtures', () => {
  it('reads IHDR of every committed PNG and matches MANIFEST.json', () => {
    const dir = fileURLToPath(new URL('./fixtures/images/', import.meta.url));
    const man = JSON.parse(readFileSync(dir + 'MANIFEST.json', 'utf8')) as { images: Array<{ file: string; width: number; height: number }> };
    assert.equal(man.images.length, 10);
    for (const im of man.images) { const d = readPngSize(readFileSync(dir + im.file)); assert.deepEqual(d, { width: im.width, height: im.height }, im.file); }
    assert.ok(man.images.some((i) => i.width === 960 && i.height === 540)); // the Google documentation example size (960x540 -> 6 tiles "rough"); kept for exploratory usage only
    assert.equal(readPngSize(Buffer.from('not a png')), null);
    const e = estimateExAnte('claude-haiku-4-5-20251001', 'anthropic.messages', 'image', { image: { png: readFileSync(dir + 'synthetic_1000x1000_flat.png') } }); assert.equal(e.tokens, 1296n);
  });
});
