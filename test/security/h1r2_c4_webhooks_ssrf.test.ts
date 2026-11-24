/**
 * H1R2 lane C4 (docs/_ops/H1_FINAL_CLOSURE_R2_20261013/lanes/C4_WEBHOOKS_LEGACY.md)
 *
 * S21-F01: webhook list/create stay DISABLED (role policy M24-DYN-09 pending) but answer an explicit 501
 *   `webhook_management_disabled` at every spelling instead of a 404; the SSRF destination policy that their activation
 *   needs is delivered and tested here, and the default delivery transport (used by the price.updated dispatch) now
 *   goes through it. Negative tests use a fake DNS resolver and local HTTP servers only: no external network.
 * S21-F03: OTK_STRICT_VERSIONING=1 answers 308 (method and body preserved) for methods other than GET/HEAD; GET/HEAD
 *   keep 301. A real fetch that follows the redirect delivers the POST body to /v1/...
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];
delete process.env['OTK_STRICT_VERSIONING'];

import {
  blockedAddressCategory, parseWebhookUrl, validateWebhookDestination, createSafeWebhookHttpPost,
  WebhookDestinationError, type ResolvedAddress,
} from '../../src/webhooks/destinationPolicy.js';
import { WebhookDelivery, verifyWebhookSignature } from '../../src/webhooks/WebhookDelivery.js';
import { MemoryWebhookStore, createWebhookEndpoint } from '../../src/webhooks/WebhookRegistry.js';
import {
  registerWebhookEndpoint, listWebhookEndpointsForTenant, WEBHOOK_MANAGEMENT_HTTP_ENABLED,
  PROPOSED_WEBHOOK_MANAGER_ROLES, MAX_WEBHOOK_ENDPOINTS_PER_TENANT,
} from '../../src/webhooks/WebhookManagement.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const refusal = async (p: Promise<unknown>, reason: string) => {
  await assert.rejects(p, (e: unknown) => e instanceof WebhookDestinationError && e.reason === reason, reason);
};
const fakeDns = (table: Record<string, ResolvedAddress[] | Error>) => {
  const calls: string[] = [];
  const resolver = async (h: string) => {
    calls.push(h);
    const v = table[h];
    if (v instanceof Error) throw v;
    if (!v) throw new Error(`ENOTFOUND ${h}`);
    return v;
  };
  return { resolver, calls };
};
const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });

type Hit = { method: string; url: string; host: string; headers: http.IncomingHttpHeaders; body: string };
async function receiver(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += String(d); });
    req.on('end', () => { hits.push({ method: req.method ?? '', url: req.url ?? '', host: String(req.headers.host), headers: req.headers, body }); handler(req, res, body); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, hits, port, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
/** Test policy for a local plain-HTTP receiver: only 127.0.0.1 is allowed (everything else is classified normally). */
const localOnly = (a: string) => a === '127.0.0.1';

describe('C4 S21-F01 destination policy: address classification', () => {
  it('refuses loopback, private, link-local/metadata, CGNAT, multicast, reserved and documentation IPv4', () => {
    for (const a of ['127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '169.254.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.2.10', '198.18.0.1']) {
      assert.notEqual(blockedAddressCategory(a), null, a);
    }
  });
  it('refuses ::1, ::, ULA (incl. AWS IMDS fd00:ec2::254), link-local, multicast, IPv4-mapped/compatible, NAT64/6to4 to internal, Teredo, zone ids', () => {
    for (const a of ['::1', '::', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '::ffff:8.8.8.8', '::127.0.0.1', '64:ff9b::a9fe:a9fe',
      '64:ff9b::10.0.0.1', '2002:7f00:1::1', '2002:a9fe:a9fe::', '2001::1', '2001:db8::1', 'fe80::1%eth0', 'not-an-ip',
      // H1R2 review H2: local-use NAT64 (RFC 8215) whose embedded IPv4 is internal
      '64:ff9b:1::a00:1', '64:ff9b:1:0:0:0:a00:1']) {
      assert.notEqual(blockedAddressCategory(a), null, a);
    }
  });
  it('allows public unicast addresses (positive control)', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '169.253.255.255', '2606:4700:4700::1111', '64:ff9b::808:808', '2002:808:808::1']) {
      assert.equal(blockedAddressCategory(a), null, a);
    }
  });
});

describe('C4 S21-F01 destination policy: URL and DNS', () => {
  it('https only; no userinfo; no low ports other than 443; no internal host names; IP literals in any notation are classified', async () => {
    assert.throws(() => parseWebhookUrl('http://hooks.example.com/x'), (e: any) => e.reason === 'scheme_not_allowed');
    assert.throws(() => parseWebhookUrl('ftp://hooks.example.com/x'), (e: any) => e.reason === 'scheme_not_allowed');
    assert.throws(() => parseWebhookUrl('file:///etc/passwd'), (e: any) => e.reason === 'scheme_not_allowed');
    assert.throws(() => parseWebhookUrl('not a url'), (e: any) => e.reason === 'invalid_url');
    assert.throws(() => parseWebhookUrl('https://user:pw@hooks.example.com/'), (e: any) => e.reason === 'credentials_not_allowed');
    assert.throws(() => parseWebhookUrl('https://hooks.example.com:22/'), (e: any) => e.reason === 'port_not_allowed');
    for (const h of ['localhost', 'api.localhost', 'metadata.google.internal', 'printer.local', 'localhost.']) {
      assert.throws(() => parseWebhookUrl(`https://${h}/x`), (e: any) => e.reason === 'host_not_allowed', h);
    }
    assert.equal(parseWebhookUrl('https://hooks.example.com:8443/x').port, 8443);
    for (const u of ['https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f.1/', 'https://017700000001/',
      'https://169.254.169.254/latest/meta-data', 'https://[::ffff:169.254.169.254]/', 'https://[fd00:ec2::254]/']) {
      await refusal(validateWebhookDestination(u, { resolver: async () => { throw new Error('must not resolve a literal'); } }), 'address_not_allowed');
    }
  });
  it('resolves the host: every answer must be public (one internal answer refuses); resolution failure refuses', async () => {
    const { resolver } = fakeDns({
      'meta.attacker.test': [v4('169.254.169.254')],
      'mixed.attacker.test': [v4('93.184.216.34'), v4('10.0.0.5')],
      'v6.attacker.test': [{ address: '::1', family: 6 }],
      'mapped.attacker.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
      'empty.attacker.test': [],
      'fail.attacker.test': new Error('SERVFAIL'),
      'ok.example.test': [v4('93.184.216.34'), { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
    });
    for (const h of ['meta', 'mixed', 'v6', 'mapped']) await refusal(validateWebhookDestination(`https://${h}.attacker.test/x`, { resolver }), 'address_not_allowed');
    await refusal(validateWebhookDestination('https://empty.attacker.test/x', { resolver }), 'dns_resolution_failed');
    await refusal(validateWebhookDestination('https://fail.attacker.test/x', { resolver }), 'dns_resolution_failed');
    const ok = await validateWebhookDestination('https://ok.example.test/hook?a=1', { resolver });
    assert.deepEqual(ok.pinned, v4('93.184.216.34'));
    assert.equal(ok.port, 443);
  });
});

describe('C4 S21-F01 safe delivery transport (local receivers, fake DNS)', () => {
  it('DNS rebinding: the connection goes to the validated address; a rebound answer on the next delivery is refused before connecting', async () => {
    const rx = await receiver((_q, s) => { s.writeHead(204).end(); });
    try {
      let n = 0; const seen: string[] = [];
      const resolver = async (h: string) => { seen.push(h); n++; return [v4(n === 1 ? '127.0.0.1' : '169.254.169.254')]; };
      const post = createSafeWebhookHttpPost({ requireHttps: false, resolver, isAddressAllowed: localOnly });
      const url = `http://rebind.attacker.test:${rx.port}/hook`;
      assert.equal((await post(url, { 'content-type': 'application/json' }, '{"a":1}')).status, 204);
      assert.equal(seen.length, 1, 'one resolution per delivery: the socket used the pinned address, not a second lookup');
      assert.equal(rx.hits.length, 1);
      assert.equal(rx.hits[0]!.host, `rebind.attacker.test:${rx.port}`, 'Host header keeps the registered name');
      assert.equal(rx.hits[0]!.body, '{"a":1}');
      await refusal(post(url, {}, '{}'), 'address_not_allowed');
      assert.equal(rx.hits.length, 1, 'no connection after the rebound answer');
    } finally { await rx.close(); }
  });
  it('a host resolving to an internal address is refused with the default classification (no connection)', async () => {
    const rx = await receiver((_q, s) => { s.writeHead(200).end(); });
    try {
      const { resolver } = fakeDns({ 'internal.attacker.test': [v4('127.0.0.1')] });
      const post = createSafeWebhookHttpPost({ requireHttps: false, resolver });
      await refusal(post(`http://internal.attacker.test:${rx.port}/x`, {}, '{}'), 'address_not_allowed');
      assert.equal(rx.hits.length, 0);
    } finally { await rx.close(); }
  });
  it('redirects are not followed: a 302 to an internal URL is returned as a failed delivery, the Location is never requested', async () => {
    const rx = await receiver((q, s) => {
      if (q.url === '/hook') s.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
      else s.writeHead(200).end();
    });
    try {
      const { resolver } = fakeDns({ 'redir.attacker.test': [v4('127.0.0.1')] });
      const post = createSafeWebhookHttpPost({ requireHttps: false, resolver, isAddressAllowed: localOnly });
      const ep = createWebhookEndpoint('tA', `http://redir.attacker.test:${rx.port}/hook`, ['*'], 'sec');
      const r = await new WebhookDelivery(post).deliver(ep, 'price.updated', {});
      assert.equal(r.ok, false); assert.equal(r.statusCode, 302);
      assert.deepEqual(rx.hits.map((h) => h.url), ['/hook']);
    } finally { await rx.close(); }
  });
  it('timeout bounds a receiver that never answers; the response body is not consumed (size limit); oversized payloads are refused before connecting', async () => {
    let streamed = 0;
    const rx = await receiver((q, s) => {
      if (q.url === '/hang') return; // never answers
      s.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024);
      const pump = () => { if (s.destroyed || streamed > 64 * 1024 * 1024) { s.end(); return; } streamed += chunk.length; if (s.write(chunk)) setImmediate(pump); else s.once('drain', pump); };
      pump();
    });
    try {
      const { resolver } = fakeDns({ 'slow.attacker.test': [v4('127.0.0.1')] });
      const post = createSafeWebhookHttpPost({ requireHttps: false, resolver, isAddressAllowed: localOnly, timeoutMs: 200, maxRequestBytes: 1024 });
      const t0 = Date.now();
      await assert.rejects(post(`http://slow.attacker.test:${rx.port}/hang`, {}, '{}'), /timed out|socket hang up/);
      assert.ok(Date.now() - t0 < 3000);
      assert.equal((await post(`http://slow.attacker.test:${rx.port}/big`, {}, '{}')).status, 200);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(streamed < 64 * 1024 * 1024, `body not drained (${streamed} bytes written before the socket closed)`);
      const before = rx.hits.length;
      await assert.rejects(post(`http://slow.attacker.test:${rx.port}/x`, {}, 'x'.repeat(2048)), /too large/);
      assert.equal(rx.hits.length, before);
    } finally { await rx.close(); }
  });
  it('the payload is HMAC-signed (X-OTK-Signature verifiable with the endpoint secret)', async () => {
    const rx = await receiver((_q, s) => { s.writeHead(200).end(); });
    try {
      const { resolver } = fakeDns({ 'ok.receiver.test': [v4('127.0.0.1')] });
      const post = createSafeWebhookHttpPost({ requireHttps: false, resolver, isAddressAllowed: localOnly });
      const ep = createWebhookEndpoint('tA', `http://ok.receiver.test:${rx.port}/in`, ['*'], 'c4-secret');
      assert.equal((await new WebhookDelivery(post).deliver(ep, 'price.updated', { x: 1 })).ok, true);
      const h = rx.hits[0]!;
      assert.equal(verifyWebhookSignature('c4-secret', h.body, Number(h.headers['x-otk-timestamp']), String(h.headers['x-otk-signature'])), true);
      assert.equal(verifyWebhookSignature('other', h.body, Number(h.headers['x-otk-timestamp']), String(h.headers['x-otk-signature'])), false);
    } finally { await rx.close(); }
  });
  it('the DEFAULT delivery transport (price.updated dispatch) enforces the policy: http, loopback literal and internal names are refused, nothing is hit', async () => {
    const rx = await receiver((_q, s) => { s.writeHead(200).end(); });
    try {
      const d = new WebhookDelivery();
      for (const [u, reason] of [[`http://127.0.0.1:${rx.port}/x`, 'scheme_not_allowed'], [`https://127.0.0.1:${rx.port}/x`, 'address_not_allowed'],
        ['https://169.254.169.254/latest/meta-data', 'address_not_allowed'], ['https://metadata.google.internal/x', 'host_not_allowed'],
        ['https://[::1]:8443/x', 'address_not_allowed']] as const) {
        const r = await d.deliver(createWebhookEndpoint('tA', u, ['*'], 's'), 'price.updated', {});
        assert.equal(r.ok, false, u); assert.match(String(r.error), new RegExp(reason), u);
      }
      assert.equal(rx.hits.length, 0);
    } finally { await rx.close(); }
  });
});

describe('C4 S21-F01 guarded management service (not wired to HTTP)', () => {
  const resolver = fakeDns({ 'hooks.customer.test': [v4('93.184.216.34')], 'evil.attacker.test': [v4('10.0.0.1')] }).resolver;
  it('the HTTP activation flag is off; the role set is a PENDING_HUMAN_POLICY proposal (OWNER/ADMIN)', () => {
    assert.equal(WEBHOOK_MANAGEMENT_HTTP_ENABLED, false);
    assert.deepEqual([...PROPOSED_WEBHOOK_MANAGER_ROLES].sort(), ['ADMIN', 'OWNER']);
  });
  it('proposal: OWNER/ADMIN register; MEMBER/VIEWER/OPERATOR refused 403; nothing stored on refusal', async () => {
    const store = new MemoryWebhookStore();
    for (const role of ['VIEWER', 'MEMBER', 'OPERATOR']) {
      const r = await registerWebhookEndpoint(store, { tenantId: 'tA', role }, { url: 'https://hooks.customer.test/x' }, { resolver });
      assert.equal(r.ok, false); assert.equal((r as any).status, 403, role);
      assert.equal((await listWebhookEndpointsForTenant(store, { tenantId: 'tA', role })).ok, false, role);
    }
    for (const role of ['OWNER', 'ADMIN']) {
      const r = await registerWebhookEndpoint(store, { tenantId: 'tA', role }, { url: 'https://hooks.customer.test/x' }, { resolver });
      assert.equal(r.ok, true, role);
    }
    assert.equal((await store.listEndpoints('tA')).length, 2);
  });
  it('destination refused → 422 webhook_destination_not_allowed, nothing stored', async () => {
    const store = new MemoryWebhookStore();
    for (const url of ['https://evil.attacker.test/x', 'http://hooks.customer.test/x', 'https://169.254.169.254/', 'https://localhost/x']) {
      const r = await registerWebhookEndpoint(store, { tenantId: 'tA', role: 'OWNER' }, { url }, { resolver });
      assert.equal(r.ok, false, url); assert.equal((r as any).status, 422, url); assert.equal((r as any).error, 'webhook_destination_not_allowed');
    }
    assert.equal((await store.listEndpoints()).length, 0);
  });
  it('per-tenant endpoint limit; tenant isolation of the list; the secret is returned once and never listed', async () => {
    const store = new MemoryWebhookStore();
    const owner = { tenantId: 'tA', role: 'OWNER' };
    let secret = '';
    for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS_PER_TENANT; i++) {
      const r = await registerWebhookEndpoint(store, owner, { url: `https://hooks.customer.test/${i}` }, { resolver });
      assert.equal(r.ok, true); if (r.ok && i === 0) secret = r.value.secret;
    }
    const over = await registerWebhookEndpoint(store, owner, { url: 'https://hooks.customer.test/over' }, { resolver });
    assert.equal(over.ok, false); assert.equal((over as any).status, 409);
    assert.equal((await registerWebhookEndpoint(store, { tenantId: 'tB', role: 'OWNER' }, { url: 'https://hooks.customer.test/b' }, { resolver })).ok, true, 'limit is per tenant');
    const listA = await listWebhookEndpointsForTenant(store, owner);
    const listB = await listWebhookEndpointsForTenant(store, { tenantId: 'tB', role: 'ADMIN' });
    assert.ok(listA.ok && listB.ok);
    if (listA.ok && listB.ok) {
      assert.equal(listA.value.length, MAX_WEBHOOK_ENDPOINTS_PER_TENANT); assert.ok(listA.value.every((e) => e.tenantId === 'tA'));
      assert.equal(listB.value.length, 1); assert.equal(listB.value[0]!.tenantId, 'tB');
      assert.ok(secret.length >= 32);
      assert.ok(!JSON.stringify([listA.value, listB.value]).includes(secret)); assert.ok(listA.value.every((e) => !('secret' in e)));
    }
  });
});

// ── HTTP: routes ──
/* eslint-disable @typescript-eslint/no-explicit-any */
let routes: any; let registry: any; let whMod: any;
let api: http.Server; let apiBase = '';
const RUN = Date.now().toString(36);
const A = `c4a-${RUN}`;
const OWNER_A = `c4-owner-a-${RUN}-0123456789`; const VIEWER_A = `c4-viewer-a-${RUN}-0123456789`;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

before(async () => {
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  whMod = await import('../../src/webhooks/WebhookRegistry.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest();
  registry.registerToken(OWNER_A, A, 'OWNER'); registry.registerToken(VIEWER_A, A, 'VIEWER');
  api = http.createServer((q, s) => { void routes.handleRequest(q, s); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(async () => { api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r())); });

describe('C4 S21-F01 HTTP: list/create answer an explicit 501 at every spelling (feature disabled)', () => {
  it('authenticated GET/POST → 501 webhook_management_disabled; no endpoint is created; by-id routes unchanged', async () => {
    const before = (await whMod.getWebhookStore().listEndpoints()).length;
    const body = JSON.stringify({ url: 'https://hooks.example.invalid/c4', events: ['*'] });
    for (const p of ['/webhooks', '/webhooks/', '/v1/webhooks', '/v1/webhooks/', '/v1/v1/webhooks', '/v1/v1/webhooks/']) {
      for (const tok of [OWNER_A, VIEWER_A]) {
        const g = await fetch(`${apiBase}${p}`, { headers: auth(tok) });
        assert.equal(g.status, 501, `GET ${p}`); assert.equal(((await g.json()) as any).error, 'webhook_management_disabled');
        const c = await fetch(`${apiBase}${p}`, { method: 'POST', headers: { ...auth(tok), 'content-type': 'application/json' }, body });
        assert.equal(c.status, 501, `POST ${p}`); assert.equal(((await c.json()) as any).error, 'webhook_management_disabled');
      }
    }
    assert.equal((await whMod.getWebhookStore().listEndpoints()).length, before);
    // a by-id route of an unknown endpoint still answers 404 (denyForeignResource / not found), not 501
    assert.equal((await fetch(`${apiBase}/v1/v1/webhooks/no-such-${RUN}/deliveries`, { headers: auth(OWNER_A) })).status, 404);
  });
  it('without a credential every spelling answers 401 first (authentication before the 501)', async () => {
    for (const p of ['/webhooks', '/v1/webhooks', '/v1/v1/webhooks']) {
      assert.equal((await fetch(`${apiBase}${p}`)).status, 401, `GET ${p}`);
      assert.equal((await fetch(`${apiBase}${p}`, { method: 'POST', body: '{}' })).status, 401, `POST ${p}`);
    }
  });
  it('the Stripe webhook keeps its own handler', async () => {
    const r = await fetch(`${apiBase}/v1/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: '{}' });
    assert.notEqual(r.status, 501); assert.notEqual(r.status, 401);
  });
});

describe('C4 S21-F03 strict versioning: 308 for methods with a body, 301 kept for GET/HEAD', () => {
  const strict = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env['OTK_STRICT_VERSIONING'] = '1';
    try { return await fn(); } finally { delete process.env['OTK_STRICT_VERSIONING']; }
  };
  it('POST/PUT/PATCH/DELETE → 308 with the same relative Location; GET/HEAD → 301', async () => {
    await strict(async () => {
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await fetch(`${apiBase}/receipts?x=1`, { method: m, redirect: 'manual', body: m === 'DELETE' ? undefined : '{}' });
        assert.equal(r.status, 308, m); assert.equal(r.headers.get('location'), '/v1/receipts?x=1', m);
      }
      for (const m of ['GET', 'HEAD']) {
        const r = await fetch(`${apiBase}/receipts?x=1`, { method: m, redirect: 'manual' });
        assert.equal(r.status, 301, m); assert.equal(r.headers.get('location'), '/v1/receipts?x=1', m);
      }
    });
  });
  it('a client that follows the redirect keeps method and body (POST /ping echo arrives at /v1/ping)', async () => {
    await strict(async () => {
      const payload = JSON.stringify({ c4: RUN });
      const r = await fetch(`${apiBase}/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      assert.equal(r.status, 200);
      assert.ok(r.redirected);
      const j = (await r.json()) as any;
      assert.equal(j.echo, payload, 'body preserved through the redirect');
    });
  });
});
