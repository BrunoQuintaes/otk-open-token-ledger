/**
 * R09 — MITM proxy path: identity, permission and quota before the provider key is used.
 *
 * The upstream provider is a fetch stub (no network, no paid call). The gateway is the
 * real ProxyGateway on an ephemeral port; receipts go to the real receiptStore/TAL.
 *
 * Modules under test: `src/proxy/ProxyGateway.ts` (admission on the provider-compatible path), with
 * `src/api/tenantKeyRegistry.ts`, `src/api/receiptStore.ts`, `src/security/talRuntime.ts` and
 * `src/billing/PlanRegistry.ts`.
 *
 * Strategy / partitions: no token, unknown token, a role without the receipt-write permission, a valid token
 * (key swap, internal headers stripped, receipt tenant), a streamed response, an exhausted plan quota, and
 * authentication not configured with and without the explicit unauthenticated-relay opt-in.
 *
 * Needs: no external network. The gateway listens on a random port of 127.0.0.1; the global `fetch` is
 * replaced for https URLs and restored in `after`. Sets `OTK_RECEIPT_LOG` and `OTK_DB_URL` to empty,
 * `PROVER_URL` to disabled and `OPENAI_API_KEY` to a fixture value, and removes
 * `OTK_PROXY_ALLOW_UNAUTHENTICATED`, before the modules are imported.
 *
 * Run just this file: `npx tsx --test test/unit/proxy_mitm_admission_r09.test.ts`
 *
 * @module test/unit/proxy_mitm_admission_r09.test
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OPENAI_API_KEY'] = 'provider-key-fixture';
delete process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'];

let gw: typeof import('../../src/proxy/ProxyGateway.js');
let registry: typeof import('../../src/api/tenantKeyRegistry.js');
let store: typeof import('../../src/api/receiptStore.js');
let talRuntime: typeof import('../../src/security/talRuntime.js');
let plans: typeof import('../../src/billing/PlanRegistry.js');
let deriveEpoch: (ts: number) => bigint;

let server: Server;
let base: string;
const upstreamCalls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let upstreamReply: () => Response;
const realFetch = globalThis.fetch;

const TOKEN = 'r09-fixture-token';
const nowEpoch = () => String(deriveEpoch(Math.floor(Date.now() / 1000)));
/** M24 INV-06 (RUN-M1-24H): the receipt is written after the response; RUN-S saw one FLAKY failure of the fixed 50 ms
 * wait under load. Wait for the condition itself (up to 2 s) instead of a longer sleep; the assertions stay the same.
 * @param cond - Condition polled every 10 ms.
 * @param ms - Maximum wait in milliseconds; on timeout the function returns without throwing.
 */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
}

before(async () => {
  gw = await import('../../src/proxy/ProxyGateway.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  store = await import('../../src/api/receiptStore.js');
  talRuntime = await import('../../src/security/talRuntime.js');
  plans = await import('../../src/billing/PlanRegistry.js');
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) {
      upstreamCalls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? '') });
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
  upstreamCalls.length = 0;
  talRuntime.resetAccountingLayerForTest();
  plans.resetPlanStoreForTest();
  registry.loadTenantsFromString(`tenant-r09/MEMBER:${TOKEN},tenant-view/VIEWER:r09-viewer-token`);
  delete process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'];
  upstreamReply = () => new Response(JSON.stringify({
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`, model: 'gpt-4o',
    usage: { prompt_tokens: 1000, completion_tokens: 2000 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});

const call = (headers: Record<string, string> = {}, body = { model: 'gpt-4o', messages: [] as unknown[] }) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

function tenantReceipts(tenantId: string) {
  return talRuntime.getAccountingLayer().entries(tenantId, nowEpoch()).map(e => store.getReceipt(e.requestId)!);
}

describe('R09 — MITM admission before the upstream call', () => {
  it('no token → 401 and the provider is never called', async () => {
    const res = await call();
    assert.equal(res.status, 401);
    assert.equal(upstreamCalls.length, 0);
  });

  it('unknown token → 401 and the provider is never called', async () => {
    const res = await call({ authorization: 'Bearer not-a-tenant' });
    assert.equal(res.status, 401);
    assert.equal(upstreamCalls.length, 0);
  });

  it('role without receipts:write → 403 before upstream', async () => {
    const res = await call({ authorization: 'Bearer r09-viewer-token' });
    assert.equal(res.status, 403);
    assert.equal(upstreamCalls.length, 0);
  });

  it('valid token: provider key replaces the OTK token, x-otk headers are not forwarded, receipt carries the tenant', async () => {
    const res = await call({ authorization: `Bearer ${TOKEN}`, 'x-otk-team-id': 'team-1' });
    assert.equal(res.status, 200);
    assert.equal(upstreamCalls.length, 1);
    const h = Object.fromEntries(Object.entries(upstreamCalls[0]!.headers).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(h['authorization'], 'Bearer provider-key-fixture');
    assert.ok(!Object.keys(h).some(k => k.startsWith('x-otk-')), 'OTK headers stay inside');
    await until(() => tenantReceipts('tenant-r09').length > 0);
    const [r] = tenantReceipts('tenant-r09');
    assert.ok(r, 'receipt stored for the admitted tenant');
    assert.equal(r.tenantId, 'tenant-r09');
    assert.equal(r.model, 'gpt-4o');
    assert.equal(r.inputTokens, 1000);
    assert.equal(r.outputTokens, 2000);
    assert.equal(r.cwVersion, 'static');
    assert.equal(tenantReceipts('default').length, 0);
  });

  it('streamed response: receipt uses the model named in the request', async () => {
    upstreamReply = () => new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const res = await call({ authorization: `Bearer ${TOKEN}` }, { model: 'gpt-4o', messages: [], stream: true } as never);
    assert.equal(res.status, 200);
    await res.text();
    await until(() => tenantReceipts('tenant-r09').length > 0);
    const [r] = tenantReceipts('tenant-r09');
    assert.ok(r);
    assert.equal(r.model, 'gpt-4o', 'not "unknown"');
    assert.equal(r.inputTokens, 10);
    assert.equal(r.outputTokens, 5);
  });

  it('exhausted plan quota → 429 before upstream', async () => {
    talRuntime.getAccountingLayer().debit({
      tenantId: 'tenant-r09', epochId: nowEpoch(), requestId: 'prefill', provider: 'openai',
      model: 'gpt-4o', cu: 10_000n, ts: Date.now(), // FREE quota = 10,000 CU per epoch
    });
    const res = await call({ authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 429);
    assert.equal(upstreamCalls.length, 0);
  });

  it('auth not configured → 503 unless unauthenticated relay is explicitly allowed', async () => {
    registry.loadTenantsFromString('');
    assert.equal((await call()).status, 503);
    assert.equal(upstreamCalls.length, 0);

    process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'] = '1';
    assert.equal((await call()).status, 200);
    assert.equal(upstreamCalls.length, 1);
    await until(() => tenantReceipts('default').length > 0);
    assert.equal(tenantReceipts('default').length, 1);
  });
});
