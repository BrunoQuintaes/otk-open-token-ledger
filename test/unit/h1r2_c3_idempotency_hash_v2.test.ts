/**
 * H1R2 C3 (S24-F09): Idempotency-Key body fingerprint.
 *
 * The legacy fingerprint (`bodyHash`) is a 32-bit FNV-1a-like hash computed with a float64 multiply
 * (`(h * 0x01000193) >>> 0`), which loses low bits above 2^53: it is not even standard FNV-1a ("foobar" →
 * 0ee3c7f0 instead of bf9cf968) and collides far more often than an ideal 32-bit hash. A collision under the same
 * tenant-scoped key made the server replay the FIRST answer for a DIFFERENT body (the second receipt was silently
 * dropped) instead of answering 409 OTK-4091.
 *
 * Fix (versioned, backward/forward compatible): entries now also carry `bodyHashV2 = "v2:" + SHA-256(body)` and the
 * check uses it when present; entries written by older replicas (legacy field only) are still honored by the legacy
 * comparison until they expire (TTL), and the legacy field is still written so older replicas keep working during a
 * rolling deploy. The HTTP contract (header, 200/201 replay, 409 OTK-4091) does not change.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['PROVER_URL'] = 'disabled';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];

const idem = await import('../../src/api/idempotency.js');
const { handleRequest } = await import('../../src/api/routes.js');
const { bodyHash, checkIdempotency, storeIdempotencyResponse, getIdempotencyStore, resetIdempotencyStoreForTest } = idem;
// Optional export added by the fix; undefined before it (tests that need it fail with a clear message).
const bodyHashV2 = (idem as Record<string, unknown>)['bodyHashV2'] as ((b: string) => string) | undefined;

const RUN = Date.now().toString(36);

/** Fixed synthetic collision of the legacy fingerprint (found by a birthday search over 6 084 bodies). */
const COLL_A = '{"requestId":"req-4365","provider":"openai","model":"gpt-4o","inputTokens":100,"outputTokens":50}';
const COLL_B = '{"requestId":"req-6083","provider":"openai","model":"gpt-4o","inputTokens":100,"outputTokens":50}';

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers: { ...headers }, destroy() { em.removeAllListeners(); } }) as unknown as IncomingMessage;
  process.nextTick(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); });
  return req;
}
function mockRes() {
  const res = {
    statusCode: 200, body: '', headers: {} as Record<string, string>,
    getHeader(k: string) { return res.headers[k.toLowerCase()]; },
    setHeader(k: string, v: string | number) { res.headers[k.toLowerCase()] = String(v); },
    end(data?: string) { res.body = data ?? ''; },
  };
  return res;
}
async function post(body: string, key: string) {
  const res = mockRes();
  await handleRequest(mockReq('POST', '/receipts', body, { 'idempotency-key': key }), res as unknown as ServerResponse);
  return res;
}

describe('H1R2 C3 legacy fingerprint (frozen for compatibility with stored entries)', () => {
  it('legacy vectors are bit-for-bit unchanged (non-standard FNV-1a: float64 multiply)', () => {
    assert.equal(bodyHash(''), '811c9dc5');
    assert.equal(bodyHash('a'), 'e40c292c');
    assert.equal(bodyHash('foobar'), '0ee3c7f0', 'standard FNV-1a32("foobar") would be bf9cf968');
  });
  it('synthetic collision: two different receipt bodies share the legacy fingerprint', () => {
    assert.notEqual(COLL_A, COLL_B);
    assert.equal(bodyHash(COLL_A), bodyHash(COLL_B));
    assert.equal(bodyHash(COLL_A), 'b21fb3a0');
  });
  it('collision rate is far above an ideal 32-bit hash (≥10x the birthday expectation over 10^5 bodies)', () => {
    const N = 100_000; const seen = new Map<string, number>(); let pairs = 0;
    for (let i = 0; i < N; i++) {
      const h = bodyHash(JSON.stringify({ requestId: `req-${i}`, provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 }));
      const c = seen.get(h) ?? 0; pairs += c; seen.set(h, c + 1);
    }
    const ideal = (N * (N - 1)) / 2 / 2 ** 32; // ≈ 1.16
    assert.ok(pairs >= 10 * ideal, `legacy colliding pairs=${pairs}, ideal≈${ideal.toFixed(2)}`);
  });
});

describe('H1R2 C3 v2 fingerprint (SHA-256, versioned)', () => {
  beforeEach(() => resetIdempotencyStoreForTest());

  it('bodyHashV2 is exported and matches fixed SHA-256 vectors with the "v2:" prefix', () => {
    assert.equal(typeof bodyHashV2, 'function', 'bodyHashV2 must be exported');
    assert.equal(bodyHashV2!(''), 'v2:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(bodyHashV2!('abc'), 'v2:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // UTF-8 bytes, not UTF-16 code units
    assert.equal(bodyHashV2!('é'), 'v2:4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
    assert.notEqual(bodyHashV2!(COLL_A), bodyHashV2!(COLL_B));
  });

  it('stored entries carry both fingerprints (legacy field kept for older replicas)', async () => {
    await storeIdempotencyResponse('k-both', 201, '{"ok":true}', COLL_A);
    const e = await getIdempotencyStore().get('k-both') as unknown as Record<string, unknown>;
    assert.equal(e['bodyHash'], bodyHash(COLL_A));
    assert.equal(e['bodyHashV2'], bodyHashV2?.(COLL_A));
  });

  it('REGRESSION: same key + legacy-colliding different body → conflict, not replay', async () => {
    await storeIdempotencyResponse('k-coll', 201, '{"ok":true,"requestId":"req-4365"}', COLL_A);
    const r = await checkIdempotency('k-coll', COLL_B);
    assert.equal(r.cached, false, 'a different body must never be served the cached answer');
    assert.equal('conflict' in r && r.conflict, true);
    const same = await checkIdempotency('k-coll', COLL_A);
    assert.equal(same.cached, true);
  });

  it('compat: an entry written by an older replica (legacy field only) is still honored', async () => {
    await getIdempotencyStore().set('k-old', { status: 201, body: '{"ok":true}', bodyHash: bodyHash('body-1') }, 60);
    const replay = await checkIdempotency('k-old', 'body-1');
    assert.equal(replay.cached, true);
    const other = await checkIdempotency('k-old', 'body-2');
    assert.equal('conflict' in other && other.conflict, true);
  });

  it('v2 is authoritative when present: matching legacy but different v2 → conflict', async () => {
    await getIdempotencyStore().set('k-v2', { status: 201, body: '{}', bodyHash: bodyHash(COLL_B), bodyHashV2: bodyHashV2?.(COLL_A) } as never, 60);
    const r = await checkIdempotency('k-v2', COLL_B);
    assert.equal('conflict' in r && r.conflict, true);
  });
});

describe('H1R2 C3 POST /receipts end-to-end with a legacy-colliding pair', () => {
  it('second receipt with the same Idempotency-Key and a colliding body → 409 OTK-4091 (was: replay of the first, receipt dropped)', async () => {
    // Birthday search for two VALID receipt bodies with the same legacy fingerprint (typically < 20 000 tries).
    const mk = (i: number) => JSON.stringify({ requestId: `c3-coll-${RUN}-${i}`, provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50 });
    const seen = new Map<string, number>(); let pair: [string, string] | null = null;
    for (let i = 0; i < 500_000 && !pair; i++) {
      const b = mk(i); const h = bodyHash(b); const j = seen.get(h);
      if (j !== undefined) pair = [mk(j), b]; else seen.set(h, i);
    }
    assert.ok(pair, 'found a legacy collision among valid receipt bodies');
    const [a, b] = pair!;
    const key = `c3-ik-${RUN}`;
    const r1 = await post(a, key);
    assert.equal(r1.statusCode, 201, r1.body);
    const r2 = await post(b, key);
    assert.equal(r2.statusCode, 409, `expected 409, got ${r2.statusCode} ${r2.body}`);
    assert.match(r2.body, /OTK-4091/);
    // the documented replay still works
    const r3 = await post(a, key);
    assert.equal(r3.statusCode, 201);
    assert.equal(r3.body, r1.body);
  });
});
