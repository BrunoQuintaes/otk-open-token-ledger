/**
 * Tests the local server of the live page (`reproducao/ao_vivo/servidor.mjs`).
 *
 * Strategy: starts the server in-process with small fake content and checks its safety properties: bound to
 * 127.0.0.1 only (a connection to another interface of this machine is refused), `Host` header check, the
 * test-suite action accepted only from this machine with the right `Origin` and never with parameters, the CSP
 * header, the verifier page served byte for byte (sha256 2bef5dd8...), and SSE history replay in order.
 * Needs: no internet. The "other interface" check opens a TCP connection from a separate Node process to this
 * machine's own non-loopback address (it never leaves the machine); it is skipped when the machine has none.
 *
 * @module test/reproducao_ao_vivo/servidor.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startLiveServer, VERIFIER_PAGE_PATH } from '../../reproducao/ao_vivo/servidor.mjs';
import { REPO_ROOT, readEvents } from './ajuda.mjs';

/** sha256 recorded for the verifier page (the same value item D of the reproduction checks). */
const VERIFIER_PAGE_SHA256 = '2bef5dd84fcf7289ae5e76cf74e329eb6bda55f479415b898da364786efdc2fc';

/**
 * Sends one request to the server and collects the answer.
 *
 * @param port - Server port.
 * @param options - `{ method, path, headers }`.
 * @returns A promise of `{ status, headers, body }` (body as a Buffer).
 */
function request(port, { method = 'GET', path: urlPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn, extra = {}) {
  let runs = 0;
  const server = await startLiveServer({
    pageHtml: '<!doctype html><title>t</title><style>p{}</style><script>1</script>',
    daysJson: '{"ok":true}',
    verifierPageBytes: fs.readFileSync(path.join(REPO_ROOT, 'web', 'verificador', 'verificador-otk.html')),
    onRunTests: () => { runs++; return { started: true, message: 'ok' }; },
    ...extra,
  });
  try { await fn(server, () => runs); } finally { await server.close(); }
}

test('listens only on 127.0.0.1, on a port chosen by the system', async () => {
  await withServer(async (server) => {
    assert.equal(server.address, '127.0.0.1');
    assert.ok(server.port > 0);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  });
});

test('a connection to another interface of this machine is refused', async (t) => {
  const other = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
  if (!other) { t.skip('esta máquina não tem outra interface IPv4'); return; }
  await withServer(async (server) => {
    // Separate process without the network lock: the lock would block the attempt before it reaches the socket.
    const probe = `const s=require('net').connect(${server.port},'${other.address}');s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('error',e=>console.log(e.code));setTimeout(()=>{console.log('TIMEOUT');process.exit()},3000).unref()`;
    const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    assert.notEqual(r.stdout.trim(), 'CONNECTED');
  });
});

test('refuses a Host header that is not the loopback address it listens on', async () => {
  await withServer(async (server) => {
    const r = await request(server.port, { headers: { Host: `exemplo.invalido:${server.port}` } });
    assert.equal(r.status, 403);
  });
});

test('sends the page with the restrictive Content-Security-Policy', async () => {
  await withServer(async (server) => {
    const r = await request(server.port);
    assert.equal(r.status, 200);
    const csp = r.headers['content-security-policy'];
    assert.equal(csp, server.pageCsp);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.ok(!csp.includes('unsafe-inline'), 'the CSP still allows any inline code');
  });
});

test('serves the original verifier page byte for byte (sha256 2bef5dd8...)', async () => {
  await withServer(async (server) => {
    const r = await request(server.port, { path: VERIFIER_PAGE_PATH });
    assert.equal(r.status, 200);
    assert.equal(crypto.createHash('sha256').update(r.body).digest('hex'), VERIFIER_PAGE_SHA256);
  });
});

test('the tests action needs POST, this machine and the page origin (127.0.0.1 or localhost); it never runs on a foreign origin', async () => {
  await withServer(async (server, runs) => {
    assert.equal((await request(server.port, { path: '/api/testes' })).status, 405);
    assert.equal((await request(server.port, { method: 'POST', path: '/api/testes' })).status, 403);
    assert.equal((await request(server.port, { method: 'POST', path: '/api/testes', headers: { Origin: 'http://exemplo.invalido' } })).status, 403);
    assert.equal(runs(), 0);
    const ok = await request(server.port, { method: 'POST', path: '/api/testes?comando=outro', headers: { Origin: `http://127.0.0.1:${server.port}` } });
    assert.equal(ok.status, 202);
    assert.equal(runs(), 1);
    const viaLocalhost = await request(server.port, { method: 'POST', path: '/api/testes', headers: { Host: `localhost:${server.port}`, Origin: `http://localhost:${server.port}` } });
    assert.equal(viaLocalhost.status, 202);
    assert.equal(runs(), 2);
    assert.equal((await request(server.port, { method: 'POST', path: '/api/testes', headers: { Origin: `http://localhost:${server.port + 1}` } })).status, 403);
    assert.equal(runs(), 2);
  });
});

test('SSE: a page that connects late gets the whole history, in order', async () => {
  await withServer(async (server) => {
    server.publish('inicio', {});
    server.publish('linha', { n: 1 });
    server.publish('linha', { n: 2 });
    server.publish('fim', { exitCode: 0 });
    const events = await readEvents(server.url, (e) => e.length === 4);
    assert.deepEqual(events.map((e) => e.id), [1, 2, 3, 4]);
    assert.deepEqual(events.map((e) => e.type), ['inicio', 'linha', 'linha', 'fim']);
  });
});
