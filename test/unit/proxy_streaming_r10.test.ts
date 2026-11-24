/**
 * R10 — MITM streaming: incremental delivery, one receipt per completed stream, and
 * explicit metering outcomes (usage missing, client abort, upstream error).
 *
 * Upstream provider = fetch stub returning a ReadableStream (no network, no paid call).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OPENAI_API_KEY'] = 'provider-key-fixture';

let gw: typeof import('../../src/proxy/ProxyGateway.js');
let registry: typeof import('../../src/api/tenantKeyRegistry.js');
let store: typeof import('../../src/api/receiptStore.js');
let talRuntime: typeof import('../../src/security/talRuntime.js');
let StreamTapper: typeof import('../../src/proxy/StreamTapper.js').StreamTapper;
let deriveEpoch: (ts: number) => bigint;

let server: Server;
let base: string;
const realFetch = globalThis.fetch;
let upstreamHeaders: Record<string, string> = {};
let upstreamBody = '';
let upstreamReply: () => Response;

const TOKEN = 'r10-fixture-token';
const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const nowEpoch = () => String(deriveEpoch(Math.floor(Date.now() / 1000)));

before(async () => {
  gw = await import('../../src/proxy/ProxyGateway.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  store = await import('../../src/api/receiptStore.js');
  talRuntime = await import('../../src/security/talRuntime.js');
  StreamTapper = (await import('../../src/proxy/StreamTapper.js')).StreamTapper;
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) {
      upstreamHeaders = { ...(init?.headers as Record<string, string>) };
      upstreamBody = String(init?.body ?? '');
      return upstreamReply();
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
  server = gw.startProxyGateway({ port: 0 });
  await new Promise<void>(r => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>(r => server.close(() => r()));
});

beforeEach(() => {
  talRuntime.resetAccountingLayerForTest();
  registry.loadTenantsFromString(`tenant-r10/MEMBER:${TOKEN}`);
});

const call = (body: Record<string, unknown>, signal?: AbortSignal) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'content-length': String(JSON.stringify(body).length) },
  body: JSON.stringify(body),
  signal,
});
const receipts = () => talRuntime.getAccountingLayer().entries('tenant-r10', nowEpoch()).map(e => store.getReceipt(e.requestId)!);
const sseResponse = (stream: ReadableStream<Uint8Array>) =>
  new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('R10 — incremental relay and metering outcomes', () => {
  it('first chunk reaches the client before the upstream finishes; one receipt at the end', async () => {
    let release!: () => void;
    const released = new Promise<void>(r => { release = r; });
    let upstreamClosed = false;
    upstreamReply = () => sseResponse(new ReadableStream({
      async start(c) {
        c.enqueue(sse({ choices: [{ delta: { content: 'hello' } }] }));
        await released;
        c.enqueue(sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        upstreamClosed = true;
        c.close();
      },
    }));
    const before = gw.proxyMeteringCounts().receipt_created;
    const res = await call({ model: 'gpt-4o', messages: [], stream: true });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.ok(first.includes('hello'), 'first chunk delivered');
    assert.equal(upstreamClosed, false, 'delivered while the upstream is still open');
    release();
    while (!(await reader.read()).done) { /* drain */ }
    await tick();
    const rs = receipts();
    assert.equal(rs.length, 1, 'exactly one receipt');
    assert.equal(rs[0]!.model, 'gpt-4o');
    assert.equal(rs[0]!.inputTokens, 12);
    assert.equal(rs[0]!.outputTokens, 7);
    assert.equal(rs[0]!.tenantId, 'tenant-r10');
    assert.equal(gw.proxyMeteringCounts().receipt_created, before + 1);
  });

  it('rewritten body is sent without the client content-length', async () => {
    upstreamReply = () => sseResponse(new ReadableStream({ start(c) { c.enqueue(sse({ usage: { prompt_tokens: 1, completion_tokens: 1 } })); c.close(); } }));
    const res = await call({ model: 'gpt-4o', messages: [], stream: true });
    await res.text();
    const keys = Object.keys(upstreamHeaders).map(k => k.toLowerCase());
    assert.ok(!keys.includes('content-length'), 'stale content-length not forwarded');
    assert.ok(upstreamBody.includes('"include_usage":true'), 'stream_options injected');
  });

  it('stream without a usage event → usage_missing, no zero-token receipt', async () => {
    upstreamReply = () => sseResponse(new ReadableStream({ start(c) { c.enqueue(sse({ choices: [{ delta: { content: 'x' } }] })); c.enqueue(enc.encode('data: [DONE]\n\n')); c.close(); } }));
    const before = gw.proxyMeteringCounts().usage_missing;
    const res = await call({ model: 'gpt-4o', messages: [], stream: true });
    assert.equal(res.status, 200, 'HTTP success is independent from metering');
    await res.text();
    await tick();
    assert.equal(receipts().length, 0);
    assert.equal(gw.proxyMeteringCounts().usage_missing, before + 1);
  });

  it('non-stream response without usage field → usage_missing', async () => {
    upstreamReply = () => new Response(JSON.stringify({ id: 'x', model: 'gpt-4o', choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const before = gw.proxyMeteringCounts().usage_missing;
    await (await call({ model: 'gpt-4o', messages: [] })).text();
    await tick();
    assert.equal(receipts().length, 0);
    assert.equal(gw.proxyMeteringCounts().usage_missing, before + 1);
  });

  it('client disconnects mid-stream → client_aborted, upstream cancelled, no receipt', async () => {
    let cancelled = false;
    upstreamReply = () => sseResponse(new ReadableStream({
      async start(c) {
        c.enqueue(sse({ choices: [{ delta: { content: 'part' } }] }));
        for (let i = 0; i < 20 && !cancelled; i++) { await tick(30); try { c.enqueue(sse({ choices: [{ delta: { content: String(i) } }] })); } catch { return; } }
      },
      cancel() { cancelled = true; },
    }));
    const before = gw.proxyMeteringCounts().client_aborted;
    const ac = new AbortController();
    const res = await call({ model: 'gpt-4o', messages: [], stream: true }, ac.signal);
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await tick(300);
    assert.equal(gw.proxyMeteringCounts().client_aborted, before + 1);
    assert.equal(cancelled, true, 'upstream read cancelled');
    assert.equal(receipts().length, 0);
  });

  it('upstream error mid-stream → upstream_error, no receipt', async () => {
    upstreamReply = () => sseResponse(new ReadableStream({
      async start(c) { c.enqueue(sse({ choices: [{ delta: { content: 'a' } }] })); await tick(20); c.error(new Error('provider reset')); },
    }));
    const before = gw.proxyMeteringCounts().upstream_error;
    const res = await call({ model: 'gpt-4o', messages: [], stream: true });
    await res.text().catch(() => '');
    await tick();
    assert.equal(gw.proxyMeteringCounts().upstream_error, before + 1);
    assert.equal(receipts().length, 0);
  });
});

describe('R10 — StreamTapper provider formats', () => {
  const feed = (lines: string[]) => {
    const t = new StreamTapper();
    t.write(lines.join(''));
    t.end();
    return t;
  };

  it('Anthropic: input from message_start, output from message_delta', () => {
    const t = feed([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15}}\n\n',
    ]);
    assert.equal(t.usageSeen, true);
    assert.deepEqual(t.usage, { promptTokens: 25, completionTokens: 15 });
  });

  it('Gemini: cumulative usageMetadata, last one wins', () => {
    const t = feed([
      'data: {"candidates":[],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2}}\n\n',
      'data: {"candidates":[],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":9}}\n\n',
    ]);
    assert.deepEqual(t.usage, { promptTokens: 8, completionTokens: 9 });
  });

  it('OpenAI format unchanged', () => {
    const t = feed(['data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n', 'data: [DONE]\n\n']);
    assert.deepEqual(t.usage, { promptTokens: 3, completionTokens: 4 });
  });
});
