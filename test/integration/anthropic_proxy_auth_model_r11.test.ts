/**
 * R11 (Anthropic part) and N8 — the transparent proxy with the request rules of the real
 * Anthropic Messages API, enforced by a local stand-in (fixtures/anthropicLikeServer.ts).
 *
 * Before this fix (observed 2026-09-29 on ab0df9d):
 *   - the proxy sent the provider key as `Authorization: Bearer` (Anthropic expects `x-api-key`);
 *   - the client's `x-api-key` header (the OTK token, for an unmodified Anthropic SDK) was
 *     forwarded to the provider, and the proxy did not accept it as the OTK credential;
 *   - the dated model id returned by Anthropic (claude-haiku-4-5-20251001) was an
 *     "Unknown model" for the CU engine: no receipt.
 *
 * No network and no paid call: the upstream host is redirected to the local stand-in.
 * This does not validate authentication against the real provider (that needs a key).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { startAnthropicLikeServer, type AnthropicLikeServer } from './fixtures/anthropicLikeServer.js';

const PROVIDER_KEY = 'sk-ant-fixture-provider-key';
const TOKEN = 'r11-otk-tenant-token';
const TENANT = 'tenant-r11';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['ANTHROPIC_API_KEY'] = PROVIDER_KEY;

let gw: typeof import('../../src/proxy/ProxyGateway.js');
let registry: typeof import('../../src/api/tenantKeyRegistry.js');
let store: typeof import('../../src/api/receiptStore.js');
let talRuntime: typeof import('../../src/security/talRuntime.js');
// D5-G04: the proxy debits the exact server-side CU (operations/knownCu), not the SDK's
// published bucket (defaultCostNormalizer, unchanged until S4 swaps it for B's computeCuFromTotals)
let normalizer: (provider: string, model: string, input: number, output: number) => number;
let deriveEpoch: (ts: number) => bigint;

let fake: AnthropicLikeServer;
let server: Server;
let base: string;
const realFetch = globalThis.fetch;
const tick = (ms = 120) => new Promise(r => setTimeout(r, ms));

before(async () => {
  fake = await startAnthropicLikeServer(PROVIDER_KEY);
  gw = await import('../../src/proxy/ProxyGateway.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  store = await import('../../src/api/receiptStore.js');
  talRuntime = await import('../../src/security/talRuntime.js');
  const { computeKnownCu } = await import('../../src/operations/knownCu.js');
  normalizer = (provider, model, inputTokens, outputTokens) => {
    const r = computeKnownCu({ provider, model, inputTokens, outputTokens });
    if (r.status !== 'computed') throw new Error(r.detail);
    return r.costUnits;
  };
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch;
  // Redirect only the provider host; method, headers and body go through unchanged.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.anthropic.com')) {
      return realFetch(fake.url + url.slice('https://api.anthropic.com'.length), init);
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
  server = gw.startProxyGateway({ port: 0 });
  await new Promise<void>(r => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  await fake.close();
});

beforeEach(() => {
  talRuntime.resetAccountingLayerForTest();
  registry.loadTenantsFromString(`${TENANT}/MEMBER:${TOKEN}`);
  fake.received.length = 0;
  fake.reply.model = 'claude-haiku-4-5-20251001';
  fake.reply.usage = { input_tokens: 2500, output_tokens: 1500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  fake.reply.omitUsage = false;
});

const nowEpoch = () => String(deriveEpoch(Math.floor(Date.now() / 1000)));
const entries = () => talRuntime.getAccountingLayer().entries(TENANT, nowEpoch());

/** An unmodified Anthropic SDK client: base URL = proxy, api key = OTK token. */
const sdk = () => new Anthropic({
  apiKey: TOKEN, baseURL: base, maxRetries: 0, timeout: 10_000,
  defaultHeaders: { 'x-otk-provider': 'anthropic' },
});

/** What reached the provider: the provider key in x-api-key, nothing of the OTK token. */
function assertUpstreamCredentials(): void {
  assert.equal(fake.received.length, 1, 'exactly one upstream request');
  const h = fake.received[0]!.headers;
  assert.equal(h['x-api-key'], PROVIDER_KEY, 'provider key sent as x-api-key');
  assert.equal(h['authorization'], undefined, 'no Authorization header upstream');
  assert.ok(h['anthropic-version'], 'anthropic-version forwarded');
  for (const [k, v] of Object.entries(h)) {
    assert.ok(!String(v).includes(TOKEN), `OTK token leaked upstream in header ${k}`);
  }
}

function assertOneReceipt(model: string, input: number, output: number): void {
  const es = entries();
  assert.equal(es.length, 1, 'exactly one accounting entry');
  const r = store.getReceipt(es[0]!.requestId);
  assert.ok(r, 'receipt stored');
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.model, model, 'receipt keeps the model id returned by the provider');
  assert.deepEqual([r.inputTokens, r.outputTokens], [input, output]);
  // Weights of the snapshot family (dated suffix stripped only when the family is known)
  assert.equal(r.costUnits, normalizer('anthropic', 'claude-haiku-4-5', input, output));
  assert.equal(r.tenantId, TENANT);
}

describe('R11/N8 — Anthropic through the transparent proxy', () => {
  it('unmodified SDK, non-streaming: provider auth, dated model id, one receipt', async () => {
    const msg = await sdk().messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(msg.model, 'claude-haiku-4-5-20251001');
    assert.equal(msg.usage.input_tokens, 2500);
    await tick();
    assertUpstreamCredentials();
    assertOneReceipt('claude-haiku-4-5-20251001', 2500, 1500);
  });

  it('unmodified SDK, streaming: usage from message_start/message_delta, model from message_start', async () => {
    const stream = sdk().messages.stream({
      model: 'claude-haiku-4-5', max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const final = await stream.finalMessage();
    assert.equal(final.usage.output_tokens, 1500);
    await tick();
    assertUpstreamCredentials();
    assert.equal(entries()[0]?.requestId, final.id, 'streamed receipt correlated with the provider message id');
    // The request named the alias; the receipt records the snapshot the provider served.
    assertOneReceipt('claude-haiku-4-5-20251001', 2500, 1500);
  });

  it('Bearer OTK token (documented proxy style) also works and is not forwarded', async () => {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: `Bearer ${TOKEN}`,
        'anthropic-version': '2023-06-01', 'x-otk-provider': 'anthropic',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(r.status, 200);
    await r.text();
    await tick();
    assertUpstreamCredentials();
    assertOneReceipt('claude-haiku-4-5-20251001', 2500, 1500);
  });

  it('OTK token in ?key= is not forwarded; other query parameters are', async () => {
    const r = await fetch(`${base}/v1/messages?key=${TOKEN}&beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01', 'x-otk-provider': 'anthropic' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(r.status, 200);
    await r.text();
    const p = fake.received[0]!.path;
    assert.ok(!p.includes(TOKEN), `token leaked in upstream URL: ${p}`);
    assert.ok(p.includes('beta=true'), 'other parameters kept');
  });

  it('invalid OTK token in x-api-key: 401 before any upstream request', async () => {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'not-a-tenant-token', 'anthropic-version': '2023-06-01', 'x-otk-provider': 'anthropic' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: [] }),
    });
    assert.equal(r.status, 401);
    await r.text();
    assert.equal(fake.received.length, 0, 'provider never contacted');
    assert.equal(entries().length, 0);
  });

  it('unknown model family stays unknown: no receipt, explicit metering_failed (not remapped)', async () => {
    fake.reply.model = 'claude-nonexistent-9-20251001';
    const before = gw.proxyMeteringCounts().metering_failed;
    await sdk().messages.create({ model: 'claude-nonexistent-9-20251001', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
    await tick();
    assert.equal(entries().length, 0, 'no receipt for an unknown model');
    assert.equal(gw.proxyMeteringCounts().metering_failed, before + 1);
  });

  it('usage absent in the provider response: usage_missing, not a zero-token receipt', async () => {
    fake.reply.omitUsage = true;
    const before = gw.proxyMeteringCounts().usage_missing;
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01', 'x-otk-provider': 'anthropic' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: [] }),
    });
    await r.text();
    await tick();
    assert.equal(entries().length, 0);
    assert.equal(gw.proxyMeteringCounts().usage_missing, before + 1);
  });

  it('cache token categories are counted as not represented in CU (visible, not dropped silently)', async () => {
    fake.reply.usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 4000, cache_read_input_tokens: 9000 };
    const before = gw.proxyMeteringCounts().cache_tokens_outside_cu;
    await sdk().messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] });
    await tick();
    // The receipt keeps the current fields (input/output); the formula decision is pending (D5).
    assertOneReceipt('claude-haiku-4-5-20251001', 100, 50);
    assert.equal(gw.proxyMeteringCounts().cache_tokens_outside_cu, before + 1);
  });
});

describe('R11 — client credentials never reach any provider', () => {
  it('openai-style upstream: Bearer provider key only; client x-api-key/authorization dropped', async () => {
    const { openUpstream } = await import('../../src/proxy/ProxyForwarder.js');
    const http = await import('node:http');
    let seen: Record<string, string | string[] | undefined> = {};
    const echo = http.createServer((req, res) => { seen = { ...req.headers }; req.resume(); req.on('end', () => res.end('{}')); });
    await new Promise<void>(r => echo.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/v1/chat/completions`;
    try {
      const up = await openUpstream(url, 'POST',
        { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-api-key': TOKEN, 'x-goog-api-key': TOKEN },
        '{}', 'provider-openai-key', 'openai');
      await up.body?.cancel();
    } finally {
      await new Promise<void>(r => echo.close(() => r()));
    }
    assert.equal(seen['authorization'], 'Bearer provider-openai-key');
    assert.equal(seen['x-api-key'], undefined);
    assert.equal(seen['x-goog-api-key'], undefined);
  });
});
