/**
 * R10 / RV02 + RV03 — streamed usage reaches the receipt and the accounting layer intact.
 *
 * RV02: Anthropic/Gemini streams carrying 25/15 tokens were stored as 0/0, because the
 *       gateway rebuilt an OpenAI-shaped body and handed it to the provider's extractor.
 * RV03: the gateway wrote into the StreamTapper Transform without consuming its output;
 *       after ~16 KB the transform stalled and the final usage event was never parsed
 *       (HTTP 200, full body delivered, receipt missing).
 *
 * Upstream = fetch stub returning a ReadableStream (no network, no paid call).
 *
 * Modules under test: `src/proxy/ProxyGateway.ts` and `src/proxy/StreamTapper.ts`, checked through
 * `src/api/receiptStore.ts` and the accounting layer of `src/security/talRuntime.ts`; the expected cost units
 * come from `src/operations/knownCu.ts`.
 *
 * Strategy / partitions: one streamed call per provider format (OpenAI, Anthropic, Gemini); 256 chunks of
 * about 1 KB; a usage event split across chunks with multi-byte text; a slow client (backpressure); a slow
 * client that aborts while the gateway waits; the tapper used as a parser with no consumer.
 *
 * Needs: no external network. The gateway listens on a random port of 127.0.0.1; the global `fetch` is
 * replaced for https URLs and restored in `after`. Sets the receipt log and database URL to empty, the prover
 * to disabled and the three provider key variables to fixture values before importing; uses short real waits.
 *
 * Run just this file: `npx tsx --test test/unit/proxy_stream_metering_rv02_rv03.test.ts`
 *
 * @module test/unit/proxy_stream_metering_rv02_rv03.test
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OPENAI_API_KEY'] = 'provider-key-fixture';
process.env['ANTHROPIC_API_KEY'] = 'provider-key-fixture';
process.env['GEMINI_API_KEY'] = 'provider-key-fixture';

let gw: typeof import('../../src/proxy/ProxyGateway.js');
let registry: typeof import('../../src/api/tenantKeyRegistry.js');
let store: typeof import('../../src/api/receiptStore.js');
let talRuntime: typeof import('../../src/security/talRuntime.js');
// D5-G04: the proxy debits the exact server-side CU (operations/knownCu), not the SDK's
// published bucket (defaultCostNormalizer, unchanged until S4 swaps it for B's computeCuFromTotals)
let defaultCostNormalizer: (provider: string, model: string, input: number, output: number) => number;
let StreamTapper: typeof import('../../src/proxy/StreamTapper.js').StreamTapper;
let deriveEpoch: (ts: number) => bigint;

let server: Server;
let base: string;
let port: number;
const realFetch = globalThis.fetch;
let upstreamReply: () => Response;

const TOKEN = 'rv02-fixture-token';
const TENANT = 'tenant-rv02';
const enc = new TextEncoder();
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));
const nowEpoch = () => String(deriveEpoch(Math.floor(Date.now() / 1000)));

before(async () => {
  gw = await import('../../src/proxy/ProxyGateway.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  store = await import('../../src/api/receiptStore.js');
  talRuntime = await import('../../src/security/talRuntime.js');
  const { computeKnownCu } = await import('../../src/operations/knownCu.js');
  defaultCostNormalizer = (provider, model, inputTokens, outputTokens) => {
    const r = computeKnownCu({ provider, model, inputTokens, outputTokens });
    if (r.status !== 'computed') throw new Error(r.detail);
    return r.costUnits;
  };
  StreamTapper = (await import('../../src/proxy/StreamTapper.js')).StreamTapper;
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) return upstreamReply();
    return realFetch(input as string, init);
  }) as typeof fetch;
  server = gw.startProxyGateway({ port: 0 });
  await new Promise<void>(r => (server.listening ? r() : server.once('listening', () => r())));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
});

beforeEach(() => {
  talRuntime.resetAccountingLayerForTest();
  registry.loadTenantsFromString(`${TENANT}/MEMBER:${TOKEN}`);
});

/**
 * Upstream SSE response made of the given byte chunks.
 * @param chunks - Byte chunks enqueued in order, each one delivered as a separate read.
 */
const sseFrom = (chunks: Uint8Array[]) => new Response(new ReadableStream({
  start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const call = (provider: string, model: string) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-otk-provider': provider },
  body: JSON.stringify({ model, messages: [], stream: true }),
});

const entries = () => talRuntime.getAccountingLayer().entries(TENANT, nowEpoch());

/**
 * The single receipt of this test, checked through receipt store and accounting layer.
 * @param provider - Expected provider name on the receipt.
 * @param model - Expected model name on the receipt.
 * @param input - Expected input tokens on the receipt and the accounting entry.
 * @param output - Expected output tokens on the receipt and the accounting entry.
 */
function assertOneReceipt(provider: string, model: string, input: number, output: number): void {
  const es = entries();
  assert.equal(es.length, 1, 'exactly one accounting entry');
  const e = es[0]!;
  const r = store.getReceipt(e.requestId);
  assert.ok(r, 'receipt stored');
  assert.equal(r.provider, provider);
  assert.equal(r.model, model);
  assert.deepEqual([r.inputTokens, r.outputTokens], [input, output], 'receipt tokens');
  assert.deepEqual([e.inputTokens, e.outputTokens], [input, output], 'accounting tokens');
  // Published CU is bucketed (100 CU, round-half-up): 25/15 tokens may publish 0 CU.
  const expectedCU = defaultCostNormalizer(provider, model, input, output);
  assert.equal(r.costUnits, expectedCU, 'receipt CU = current formula applied to the streamed tokens');
  assert.equal(e.cu, BigInt(Math.floor(expectedCU)), 'debit = receipt CU');
  assert.equal(r.tenantId, TENANT);
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
/**
 * Provider-native streaming usage events for `inp` input and `out` output tokens.
 * @param inp - Input tokens reported by the usage event.
 * @param out - Output tokens reported by the final usage event.
 */
const usageFrames = (inp: number, out: number): Record<string, { model: string; text: string }> => ({
  openai: { model: 'gpt-4o', text: frame({ choices: [], usage: { prompt_tokens: inp, completion_tokens: out } }) },
  anthropic: {
    model: 'claude-3-sonnet',
    text: 'event: message_start\n' + frame({ type: 'message_start', message: { usage: { input_tokens: inp, output_tokens: 1 } } }) +
      'event: content_block_delta\n' + frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }) +
      'event: message_delta\n' + frame({ type: 'message_delta', usage: { output_tokens: out } }),
  },
  gemini: {
    model: 'gemini-pro',
    text: frame({ candidates: [], usageMetadata: { promptTokenCount: inp, candidatesTokenCount: 4 } }) +
      frame({ candidates: [], usageMetadata: { promptTokenCount: inp, candidatesTokenCount: out } }),
  },
});
const USAGE_FRAMES = usageFrames(25, 15);

describe('RV02 — provider usage survives up to receipt and accounting', () => {
  for (const [inp, out] of [[25, 15], [2500, 1500]] as const) {
    for (const [provider, { model, text }] of Object.entries(usageFrames(inp, out))) {
      it(`${provider}/${model}: streamed ${inp}/${out} → receipt and debit ${inp}/${out}`, async () => {
        upstreamReply = () => sseFrom([enc.encode(text)]);
        const before = gw.proxyMeteringCounts().receipt_created;
        const res = await call(provider, model);
        assert.equal(res.status, 200);
        await res.text();
        await tick();
        assert.equal(gw.proxyMeteringCounts().receipt_created, before + 1);
        assertOneReceipt(provider, model, inp, out);
        if (inp === 2500) assert.ok(store.getReceipt(entries()[0]!.requestId)!.costUnits > 0, 'non-trivial CU check');
      });
    }
  }
});

describe('RV03 — long and fragmented streams keep the final usage event', () => {
  const content = frame({ choices: [{ delta: { content: 'x'.repeat(1024) } }] });

  it('256 × ~1 KB chunks then usage: all bytes delivered and receipt 25/15', async () => {
    const chunks = Array.from({ length: 256 }, () => enc.encode(content));
    chunks.push(enc.encode(USAGE_FRAMES['openai']!.text));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    upstreamReply = () => sseFrom(chunks);
    const before = gw.proxyMeteringCounts();
    const res = await call('openai', 'gpt-4o');
    const body = await res.text();
    await tick();
    assert.equal(Buffer.byteLength(body), total, 'relay unchanged');
    assert.equal(gw.proxyMeteringCounts().usage_missing, before.usage_missing, 'usage not lost');
    assertOneReceipt('openai', 'gpt-4o', 25, 15);
  });

  it('variable fragmentation (usage event split across chunks, multi-byte text): receipt 25/15', async () => {
    const text = frame({ choices: [{ delta: { content: 'ação ✓ '.repeat(3000) } }] }).repeat(20) + USAGE_FRAMES['anthropic']!.text;
    const bytes = enc.encode(text);
    const chunks: Uint8Array[] = [];
    let seed = 7;
    for (let i = 0; i < bytes.length;) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const size = 1 + (seed % 5000);
      chunks.push(bytes.subarray(i, i + size));
      i += size;
    }
    upstreamReply = () => sseFrom(chunks);
    const res = await call('anthropic', 'claude-3-sonnet');
    const body = await res.text();
    await tick();
    assert.equal(body, text, 'relay is byte-exact, including split UTF-8 sequences');
    assertOneReceipt('anthropic', 'claude-3-sonnet', 25, 15);
  });

  it('slow client: upstream reading follows the client (backpressure) and usage is still recorded', async (t) => {
    const CHUNK = enc.encode(frame({ choices: [{ delta: { content: 'y'.repeat(16 * 1024) } }] }));
    // M24-R03 (RUN-M1-24H): N was 600; the loopback TCP buffers hold ~20 chunks on Windows but ~325 on Linux, so N/2 = 300
    // failed on Linux although reading had stopped. With N = 2000 (≈ 33 MB) the same N/2 rule holds on both, and the
    // plateau check below asserts directly that reading stopped while the client was paused.
    const N = 2000;
    let pulled = 0;
    upstreamReply = () => new Response(new ReadableStream({
      pull(c) {
        if (pulled < N) { pulled++; c.enqueue(CHUNK); return; }
        c.enqueue(enc.encode(USAGE_FRAMES['openai']!.text));
        c.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    // BP-02: observe the gateway's OWN response buffer (bytes queued in the process, not yet handed to the kernel) and
    // how many provider chunks it has handed to the response (writes)
    let maxQueued = 0; let hwm = 0; let writes = 0;
    const observe = (_req: http.IncomingMessage, res: http.ServerResponse): void => {
      hwm = res.writableHighWaterMark;
      const write = res.write.bind(res) as (...a: unknown[]) => boolean;
      (res as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => {
        writes++;
        const ok = write(...a);
        if (res.writableLength > maxQueued) maxQueued = res.writableLength;
        return ok;
      };
    };
    server.on('request', observe);
    let received: { bytes: number; pulledWhilePaused: number; writtenWhilePaused: number; stalled: boolean };
    try {
      received = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } }, (res) => {
          res.pause();
          // while paused: sample every 50 ms; reading has stopped once no chunk is pulled for 200 ms (at most 2 s)
          const t0 = Date.now(); let last = pulled; let lastChange = t0;
          const timer = setInterval(() => {
            const now = Date.now();
            if (pulled !== last) { last = pulled; lastChange = now; }
            const stalled = now - lastChange >= 200;
            if (!stalled && now - t0 < 2000) return;
            clearInterval(timer);
            const pulledWhilePaused = pulled; const writtenWhilePaused = writes;
            let bytes = 0;
            res.on('data', (d: Buffer) => { bytes += d.length; });
            res.on('end', () => resolve({ bytes, pulledWhilePaused, writtenWhilePaused, stalled }));
            res.resume();
          }, 50);
        });
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'gpt-4o', messages: [], stream: true }));
      });
    } finally {
      server.off('request', observe); // ADV-R2-S6: removed even when the request fails
    }
    await tick();
    t.diagnostic(`provider chunks read while the client was paused: ${received.pulledWhilePaused}/${N}; handed to the response: ${received.writtenWhilePaused}`);
    assert.ok(received.pulledWhilePaused < N / 2,
      `gateway stops reading the provider while the client is not reading (pulled ${received.pulledWhilePaused}/${N})`);
    assert.ok(received.stalled, `reading from the provider stalls (200 ms without a new chunk) while the client is paused (pulled ${received.pulledWhilePaused}/${N})`);
    // BP-02 (RUN-M1-RESUME-R2-20261012): backpressure is judged on the memory the GATEWAY holds, not on how many chunks the
    // kernel's loopback buffers absorb (~20 on Windows, ~325 on Linux, and unstable between connections on Linux, so any
    // chunk-count bound was a calibration). Two invariants:
    // (1) Node's writable contract: write() returns false once the queue reaches highWaterMark; a writer that waits for
    //     'drain' never queues more than highWaterMark + one chunk (+ chunked-encoding framing) in the response;
    // (2) ADV-R2-S3: read-ahead OUTSIDE the response (an internal array or transform) is caught by the gap between chunks
    //     pulled from the provider and chunks handed to the response: a relay reads one chunk, writes it, and only then
    //     reads the next, so at most one chunk is in hand plus the provider stream's own queue (highWaterMark 1).
    const allowed = hwm + CHUNK.length + 64;
    t.diagnostic(`gateway response queue peak: ${maxQueued} bytes (allowed ${allowed}: highWaterMark ${hwm} + one ${CHUNK.length}-byte chunk + framing)`);
    assert.ok(hwm > 0, 'the gateway response was observed');
    assert.ok(maxQueued <= allowed, `the gateway's own response buffer stays bounded while the client is slow: ${maxQueued} <= ${allowed} bytes`);
    assert.ok(received.pulledWhilePaused - received.writtenWhilePaused <= 2,
      `no read-ahead outside the response: pulled ${received.pulledWhilePaused}, handed to the response ${received.writtenWhilePaused} (gap <= 2)`);
    assert.equal(received.bytes, N * CHUNK.length + enc.encode(USAGE_FRAMES['openai']!.text).length, 'every byte delivered');
    assertOneReceipt('openai', 'gpt-4o', 25, 15);
  });
});

describe('RV03 — slow client that aborts while the gateway waits for drain', () => {
  it('upstream is cancelled, outcome client_aborted, no receipt, no hang', async () => {
    const CHUNK = enc.encode(frame({ choices: [{ delta: { content: 'z'.repeat(16 * 1024) } }] }));
    let pulled = 0;
    let cancelled = false;
    upstreamReply = () => new Response(new ReadableStream({
      // "endless" provider, capped: a gateway that ignores backpressure reads an in-memory stream in a microtask loop that
      // never yields, so it never sees the client leave and buffers without limit (this exhausted the host's memory during
      // the BP mutation runs of RUN-M1-RESUME-20261012). The cap (~64 MB) turns that regression into a test failure.
      pull(c) {
        if (++pulled > 4000) { c.error(new Error('test cap: the gateway kept reading a provider the client was not reading')); return; }
        c.enqueue(CHUNK);
      },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const before = gw.proxyMeteringCounts().client_aborted;
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.pause();
        setTimeout(() => { req.destroy(); resolve(); }, 300); // never reads, then goes away
      });
      req.on('error', () => {});
      req.on('close', () => {});
      req.end(JSON.stringify({ model: 'gpt-4o', messages: [], stream: true }));
      setTimeout(() => reject(new Error('client setup timeout')), 5000);
    });
    const deadline = Date.now() + 3000;
    while (!cancelled && Date.now() < deadline) await tick(50);
    assert.equal(cancelled, true, 'provider stream cancelled after the client left');
    const pulledAtCancel = pulled;
    await tick(200);
    assert.equal(pulled, pulledAtCancel, 'no more provider reads after cancel');
    assert.equal(gw.proxyMeteringCounts().client_aborted, before + 1);
    assert.equal(entries().length, 0);
  });
});

describe('RV03 — StreamTapper as a parser does not depend on a consumer', () => {
  it('observe()/finish() parse 256 KB without anyone reading the transform side', () => {
    const t = new StreamTapper();
    const part = Buffer.from(frame({ choices: [{ delta: { content: 'x'.repeat(1024) } }] }));
    for (let i = 0; i < 256; i++) t.observe(part);
    t.observe(Buffer.from('data: {"usage":{"prompt_tokens":25,"com'));
    t.observe(Buffer.from('pletion_tokens":15}}'));
    assert.equal(t.usageSeen, false, 'incomplete line not parsed yet');
    t.finish();
    assert.deepEqual(t.usage, { promptTokens: 25, completionTokens: 15 });
  });
});
