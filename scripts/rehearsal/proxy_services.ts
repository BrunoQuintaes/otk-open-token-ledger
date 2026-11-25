/**
 * Transparent proxy with real PostgreSQL and Redis (session 2026-09-30).
 *
 * The proxy has no production entry point (N9), so this script starts it in its own process
 * with the real bootstrap (secrets, stores → RedisTAL, Postgres receipt store in its own
 * database). The provider is the local Anthropic stand-in (no paid call); the client is the
 * official SDK, unmodified.
 *
 *   P1  non-streaming and streaming calls → rows in Postgres (tenant, dated model id) and
 *       the shared (Redis) balance equal to the receipts' CU;
 *   P2  quota through the proxy with the Redis balance (FREE 10000 CU);
 *   P3  PostgreSQL stopped during a call: the provider answer is relayed (it cannot be taken
 *       back), the receipt is NOT stored and the loss is counted (persistence_failed).
 *
 *   npx tsx scripts/rehearsal/proxy_services.ts --out=<dir>
 *
 * Environment: `OTK_TEST_PG_URL` and `OTK_TEST_REDIS_URL` (defaults point at the local test containers with
 * test-only passwords). P3 runs `docker stop` / `docker start` on the PostgreSQL test container (also restarted if
 * the script fails). Exit: 0 every check matched; 1 at least one did not; 2 usage or setup error.
 *
 * @module scripts/rehearsal/proxy_services
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import IORedis from 'ioredis';
import Anthropic from '@anthropic-ai/sdk';

const PG_URL = process.env['OTK_TEST_PG_URL'] ?? 'postgres://otk:otk-test-only@127.0.0.1:55432/otk';
const REDIS_URL = process.env['OTK_TEST_REDIS_URL'] ?? 'redis://:otk-test-only@127.0.0.1:56379';
const PG_CONTAINER = 'otk-test-postgres-1';
const RUN = Date.now().toString(36);
const TOKEN = `px-token-${RUN}`;
const TENANT = `px-${RUN}`;
const PROVIDER_KEY = 'sk-ant-proxy-rehearsal-fixture';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Check { id: string; expected: unknown; observed: unknown; matched: boolean }
const checks: Check[] = [];
const log: string[] = [];
const check = (id: string, expected: unknown, observed: unknown) => {
  const matched = JSON.stringify(expected) === JSON.stringify(observed);
  checks.push({ id, expected, observed, matched });
  console.log(`  [${matched ? 'match' : 'DIFF '}] ${id}: expected=${JSON.stringify(expected)} observed=${JSON.stringify(observed)}`);
};

async function main(): Promise<number> {
  const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
  if (!out) { console.error('usage: --out=<dir>'); return 2; }
  fs.mkdirSync(out, { recursive: true });
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  const db = `otk_proxy_${RUN}`;
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
  const DB_URL = PG_URL.replace(/[/][^/]+$/, `/${db}`);

  Object.assign(process.env, {
    NODE_ENV: 'test', OTK_DB_URL: DB_URL, OTK_REDIS_URL: REDIS_URL, OTK_RECEIPT_LOG: '',
    OTK_TENANTS: `${TENANT}/MEMBER:${TOKEN}`, ANTHROPIC_API_KEY: PROVIDER_KEY, PROVER_URL: 'disabled',
    OTK_ADMIN_KEY: 'px-admin-fixture', OTK_PG_WRITE_TIMEOUT_MS: '3000',
  });
  const { startAnthropicLikeServer } = await import('../../test/integration/fixtures/anthropicLikeServer.js');
  const fake = await startAnthropicLikeServer(PROVIDER_KEY);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.anthropic.com')) return realFetch(fake.url + url.slice('https://api.anthropic.com'.length), init);
    return realFetch(input as string, init);
  }) as typeof fetch;

  const { bootstrapSecrets } = await import('../../src/infra/secretsBootstrap.js');
  const { bootstrapStores } = await import('../../src/infra/storeBootstrap.js');
  await bootstrapSecrets();
  const boot = await bootstrapStores();
  log.push(`stores: ${JSON.stringify(boot.stores)}`);
  const gw = await import('../../src/proxy/ProxyGateway.js');
  const { persistenceStatus } = await import('../../src/api/receiptStore.js');
  const { defaultCostNormalizer } = await import('../../src/sdk/OTKSDK.js');
  const { deriveEpoch } = await import('../../src/types/receipt.js');
  log.push(`persistence: ${JSON.stringify(persistenceStatus())}`);
  const server = gw.startProxyGateway({ port: 0 });
  await new Promise<void>(r => (server.listening ? r() : server.once('listening', () => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Anthropic({ apiKey: TOKEN, baseURL: base, maxRetries: 0, timeout: 20_000, defaultHeaders: { 'x-otk-provider': 'anthropic' } });
  const p2 = new pg.Pool({ connectionString: DB_URL, max: 1 });
  p2.on('error', () => {});
  const redis = new IORedis(REDIS_URL);
  const epoch = String(deriveEpoch(Math.floor(Date.now() / 1000)));
  const rows = async () => (await p2.query('SELECT request_id, receipt_json FROM otk_receipts ORDER BY created_at')).rows as { request_id: string; receipt_json: Record<string, unknown> }[];
  const redisTotal = async () => (await redis.hgetall(`otk:tal:${TENANT}:${epoch}`))['totalCU'] ?? '0';

  try {
    console.log('P1: non-streaming + streaming through the proxy');
    fake.reply.usage = { input_tokens: 2500, output_tokens: 1500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const m1 = await client.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] });
    const m2 = await client.messages.stream({ model: 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }).finalMessage();
    await sleep(1500);
    const rs = await rows();
    const cu = defaultCostNormalizer('anthropic', 'claude-haiku-4-5-20251001', 2500, 1500);
    check('P1 rows in Postgres', 2, rs.length);
    check('P1 rows keep provider message ids', [m1.id, m2.id].sort(), rs.map(r => r.request_id).sort());
    check('P1 tenant and dated model on both rows', [[TENANT, 'claude-haiku-4-5-20251001'], [TENANT, 'claude-haiku-4-5-20251001']],
      rs.map(r => [r.receipt_json['tenantId'], r.receipt_json['model']]));
    check('P1 Redis balance = 2 × receipt CU', String(2 * cu), await redisTotal());

    console.log('P2: quota through the proxy (FREE 10000 CU, shared balance)');
    fake.reply.usage = { input_tokens: 5000, output_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01', 'x-otk-provider': 'anthropic' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] }) });
      statuses.push(r.status); await r.text(); await sleep(800);
    }
    log.push(`P2 Redis balance after: ${await redisTotal()}`);
    // 2×3500 = 7000 before; call 1 admitted → 7000+8800; call 2 refused (≥ 10000)
    check('P2 statuses (balance 7000 → admitted, then ≥ 10000 → 429)', [200, 429, 429], statuses);

    console.log('P3: PostgreSQL stopped during a proxied call');
    fake.reply.usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    // TENANT is over quota after P2; P3 uses a second tenant configured now
    const { loadTenantsFromString } = await import('../../src/api/tenantKeyRegistry.js');
    const TOKEN2 = `px2-${RUN}`;
    loadTenantsFromString(`${TENANT}/MEMBER:${TOKEN},${TENANT}-b/MEMBER:${TOKEN2}`);
    const before = gw.proxyMeteringCounts();
    const rowsBefore = (await rows()).length;
    spawnSync('docker', ['stop', PG_CONTAINER], { stdio: 'ignore' });
    let status = 0;
    try {
      const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': TOKEN2, 'anthropic-version': '2023-06-01', 'x-otk-provider': 'anthropic' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] }) });
      status = r.status; await r.text();
      await sleep(5000);
    } finally {
      spawnSync('docker', ['start', PG_CONTAINER], { stdio: 'ignore' });
    }
    for (let i = 0; i < 40; i++) { try { await p2.query('SELECT 1'); break; } catch { await sleep(500); } }
    const after = gw.proxyMeteringCounts();
    check('P3 provider answer relayed to the client', 200, status);
    check('P3 receipt not stored (no new row)', rowsBefore, (await rows()).length);
    check('P3 loss counted as persistence_failed', before.persistence_failed + 1, after.persistence_failed);
  } finally {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    await fake.close();
    await p2.end(); redis.disconnect();
    const { shutdownStores } = await import('../../src/infra/storeBootstrap.js');
    await shutdownStores().catch(() => {});
  }
  fs.writeFileSync(path.join(out, `proxy_services_${RUN}.json`), JSON.stringify({ run: RUN, database: db, log, checks }, null, 2));
  return checks.every(c => c.matched) ? 0 : 1;
}

main().then(c => process.exit(c), e => { console.error(e); spawnSync('docker', ['start', PG_CONTAINER], { stdio: 'ignore' }); process.exit(2); });
