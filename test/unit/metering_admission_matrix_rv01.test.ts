/**
 * R09 / RV01 — every entry that creates a receipt applies the same permission and quota
 * rule before any effect (receipt, accounting debit, provider call).
 *
 * Entries: gateway MITM (/v1/chat/completions), gateway legacy event (/proxy) and the API
 * (POST /receipts). Before RV01 a VIEWER token created a receipt through /proxy (HTTP 200),
 * and POST /receipts read its quota from a budget tracker that nothing ever debited.
 *
 * Provider = fetch stub (no network, no paid call). Accounting = real TAL in memory.
 *
 * Modules under test (imported after the environment is set): `src/proxy/ProxyGateway.ts`
 * (started on a random loopback port), `handleRequest` in `src/api/routes.ts`,
 * `src/api/receiptStore.ts`, `src/security/talRuntime.ts`, `src/billing/PlanRegistry.ts` and
 * `src/api/tenantKeyRegistry.ts`.
 *
 * Strategy / partitions: for each of the three entries, no token and an unknown token (401), a
 * VIEWER (403), a MEMBER whose free quota is already used up (429), each with no receipt, no
 * debit and no provider call; MEMBER and OWNER within quota (one debit for their own tenant,
 * even when the payload names another tenant);
 * the legacy gateway route with authentication off still applies the effective tenant's quota.
 *
 * Needs: a free loopback port for the gateway; short real waits (50 ms) before checking that no
 * effect happened. Sets `OTK_RECEIPT_LOG` and `OTK_DB_URL` to empty, `PROVER_URL=disabled` and a
 * fake `OPENAI_API_KEY` at load time, deletes `OTK_PROXY_ALLOW_UNAUTHENTICATED` before each test,
 * and replaces `globalThis.fetch` (HTTPS calls get a canned provider answer) until `after`.
 *
 * Run just this file: `npx tsx --test test/unit/metering_admission_matrix_rv01.test.ts`
 *
 * @module test/unit/metering_admission_matrix_rv01.test
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
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
let routes: typeof import('../../src/api/routes.js');
let deriveEpoch: (ts: number) => bigint;

let server: Server;
let base: string;
let upstreamCalls = 0;
const realFetch = globalThis.fetch;
const tick = () => new Promise(r => setTimeout(r, 50));
const nowEpoch = () => String(deriveEpoch(Math.floor(Date.now() / 1000)));
let seq = 0;

before(async () => {
  gw = await import('../../src/proxy/ProxyGateway.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  store = await import('../../src/api/receiptStore.js');
  talRuntime = await import('../../src/security/talRuntime.js');
  plans = await import('../../src/billing/PlanRegistry.js');
  routes = await import('../../src/api/routes.js');
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) {
      upstreamCalls++;
      return new Response(JSON.stringify({ id: `up-${++seq}`, model: 'gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
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

const TOKENS = { MEMBER: 'rv01-member', VIEWER: 'rv01-viewer', OWNER: 'rv01-owner', FULL: 'rv01-full' } as const;

beforeEach(() => {
  upstreamCalls = 0;
  talRuntime.resetAccountingLayerForTest();
  plans.resetPlanStoreForTest();
  registry.loadTenantsFromString(
    `t-member/MEMBER:${TOKENS.MEMBER},t-view/VIEWER:${TOKENS.VIEWER},t-owner/OWNER:${TOKENS.OWNER},t-full/MEMBER:${TOKENS.FULL}`);
  delete process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'];
  // t-full has exhausted the FREE quota (10,000 CU per epoch)
  talRuntime.getAccountingLayer().debit({
    tenantId: 't-full', epochId: nowEpoch(), requestId: 'prefill', provider: 'openai', model: 'gpt-4o', cu: 10_000n, ts: Date.now(),
  });
});

type Entry = 'mitm' | 'legacy' | 'api';

/**
 * Call one entry; returns HTTP status and the requestId that would identify the receipt.
 *
 * @param entry - Which entry to call: the gateway chat route, the gateway legacy event route or the API.
 * @param token - Tenant token to present; omitted means no credential header.
 * @param extra - Fields merged into the usage event (legacy and API entries only).
 * @returns The HTTP status and the request id under which a receipt would be stored.
 */
async function callEntry(entry: Entry, token?: string, extra: Record<string, unknown> = {}): Promise<{ status: number; requestId: string }> {
  const requestId = `rv01-${entry}-${++seq}`;
  const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  if (entry === 'mitm') {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });
    await res.text();
    return { status: res.status, requestId: `up-${seq}` };
  }
  const event = { requestId, provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5, costUnits: 15, userId: '1', nonce: String(seq), ...extra };
  if (entry === 'legacy') {
    const res = await fetch(`${base}/proxy`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(event) });
    await res.text();
    return { status: res.status, requestId };
  }
  const em = new EventEmitter();
  const req = Object.assign(em, { method: 'POST', url: '/receipts', headers: { ...auth } }) as unknown as IncomingMessage;
  process.nextTick(() => { em.emit('data', Buffer.from(JSON.stringify(event))); em.emit('end'); });
  let status = 0;
  const res = { statusCode: 200, setHeader: () => {}, end: () => { status = (res as { statusCode: number }).statusCode; } } as unknown as ServerResponse;
  await routes.handleRequest(req, res);
  return { status, requestId };
}

const debits = (tenantId: string) => talRuntime.getAccountingLayer().entries(tenantId, nowEpoch()).filter(e => e.requestId !== 'prefill').length;

async function assertNoEffect(entry: Entry, tenantId: string, requestId: string): Promise<void> {
  await tick();
  assert.equal(store.getReceipt(requestId), undefined, `${entry}: no receipt`);
  assert.equal(debits(tenantId), 0, `${entry}: no accounting debit`);
  assert.equal(upstreamCalls, 0, `${entry}: provider not called`);
}

describe('RV01 — permission and quota matrix, checked before effects', () => {
  for (const entry of ['mitm', 'legacy', 'api'] as const) {
    it(`${entry}: no token → 401, no effect`, async () => {
      const r = await callEntry(entry);
      assert.equal(r.status, 401);
      await assertNoEffect(entry, 'default', r.requestId);
    });

    it(`${entry}: unknown token → 401, no effect`, async () => {
      const r = await callEntry(entry, 'not-a-tenant-token');
      assert.equal(r.status, 401);
      await assertNoEffect(entry, 'default', r.requestId);
    });

    it(`${entry}: VIEWER (no receipts:write) → 403, no effect`, async () => {
      const r = await callEntry(entry, TOKENS.VIEWER);
      assert.equal(r.status, 403);
      await assertNoEffect(entry, 't-view', r.requestId);
    });

    it(`${entry}: MEMBER with exhausted quota → 429, no effect`, async () => {
      const r = await callEntry(entry, TOKENS.FULL);
      assert.equal(r.status, 429);
      await assertNoEffect(entry, 't-full', r.requestId);
    });

    for (const role of ['MEMBER', 'OWNER'] as const) {
      it(`${entry}: ${role} within quota → success, one receipt for its own tenant`, async () => {
        const tenant = role === 'MEMBER' ? 't-member' : 't-owner';
        const r = await callEntry(entry, TOKENS[role], { tenantId: 'someone-else' });
        assert.equal(r.status, entry === 'api' ? 201 : 200);
        await tick();
        assert.equal(debits(tenant), 1, 'debited once to the authenticated tenant');
        assert.equal(debits('someone-else'), 0, 'payload tenantId does not override the token');
        assert.equal(upstreamCalls, entry === 'mitm' ? 1 : 0);
      });
    }
  }

  it('legacy /proxy with auth disabled: quota of the effective tenant still applies', async () => {
    registry.loadTenantsFromString('');
    const r = await callEntry('legacy', undefined, { tenantId: 't-full' });
    assert.equal(r.status, 429);
    await assertNoEffect('legacy', 't-full', r.requestId);
    const ok = await callEntry('legacy', undefined, { tenantId: 't-free' });
    assert.equal(ok.status, 200);
    assert.equal(debits('t-free'), 1);
  });
});
