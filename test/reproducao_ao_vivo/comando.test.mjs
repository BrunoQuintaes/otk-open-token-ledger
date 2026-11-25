/**
 * Tests the command `npm run reproduzir-ao-vivo -- --sem-navegador` end to end (`reproducao/ao_vivo/reproduzir_ao_vivo.mjs`).
 *
 * Strategy:
 * - full run: the real reproduction through the live command and the plain `reproduzir-tudo`; same exit code (0)
 *   and the same OK lines on standard output; the SSE events arrive in order (start, lines, end, receipts);
 * - failure runs: a stand-in that fails (exit 1) and the real script with a non-empty output folder (exit 2);
 *   the live command must exit with the same code and send the failing lines;
 * - `--com-testes`: with a fast stand-in suite, the tests run without any click and their result is sent; a suite
 *   that ends in "TESTES OK, com aviso" is reported as OK with the warning;
 * - the tests action is refused (409) until the reproduction and the receipt check end;
 * - a failing receipt check keeps the reproduction's exit code and still sends the end and receipts events;
 * - machine paths in the forms C:\..., C:/..., file:///C:/... and lower-case drive never reach the page;
 * - an option without its value stops the command with a clear message.
 * Needs: `npm ci` done; no internet. The full run takes 20 s to 3 min (twice, for the comparison). One test hides
 * test/verifier/vetores/esperado.json for a few seconds and always puts it back (same bytes).
 *
 * @module test/reproducao_ao_vivo/comando.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { FIXTURES, REPO_ROOT, readEvents, runPlainReproduction, stableLines, startLiveCommand } from './ajuda.mjs';

/**
 * Asks the live server to run the tests, as the page button does.
 *
 * @param url - Page address.
 * @returns A promise of `{ status, body }`.
 */
function postTests(url) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/testes', url);
    const req = http.request(target, { method: 'POST', headers: { Origin: target.origin } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Tells whether a text contains a machine path in any of its forms, including the JSON-escaped one (inside JSON
 * every backslash is doubled, so a plain search would never find a Windows path).
 *
 * @param text - Text to search, e.g. `JSON.stringify(events)`.
 * @param machinePath - Absolute path.
 * @returns `true` when any form is found (case-insensitive).
 */
function containsMachinePath(text, machinePath) {
  const lower = text.toLowerCase();
  const forms = [machinePath, JSON.stringify(machinePath).slice(1, -1), machinePath.split(path.sep).join('/')];
  return forms.some((form) => lower.includes(form.toLowerCase()));
}

/** Generous limit for the full reproduction on a slow machine, in milliseconds. */
const FULL_RUN_TIMEOUT_MS = 8 * 60_000;

test('full run: same exit code (0), same OK lines as reproduzir-tudo, and SSE events in order', { timeout: FULL_RUN_TIMEOUT_MS }, async () => {
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '0']);
  const url = await live.url;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const eventsPromise = readEvents(url, (e) => e.some((x) => x.type === 'recibos'));
  const [result, events] = await Promise.all([live.done, eventsPromise]);
  const plain = await runPlainReproduction();

  assert.equal(result.code, 0);
  assert.equal(result.code, plain.code);
  const liveLines = stableLines(result.stdout);
  assert.deepEqual(liveLines, stableLines(plain.stdout));
  assert.equal(liveLines.filter((l) => l.startsWith('OK ')).length, 13);
  assert.equal(liveLines.at(-1), 'TUDO OK: 13 de 13 itens.');

  const ids = events.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'inicio');
  assert.ok(types.indexOf('fim') > types.lastIndexOf('linha'));
  assert.ok(types.indexOf('recibos') > types.indexOf('fim'));
  const items = events.filter((e) => e.type === 'linha' && e.data.kind === 'item');
  assert.equal(items.length, 13);
  assert.ok(items.every((e) => e.data.ok === true));
  assert.deepEqual(events.find((e) => e.type === 'fim').data.exitCode, 0);
  const receipts = events.find((e) => e.type === 'recibos').data;
  assert.deepEqual(receipts.totals, { verde: 9, amarelo: 11, vermelho: 33 });
  assert.equal(receipts.reportSha256, 'bbcfeed1d0cfb3beb9685eb8157331ca3bd21d8186985f22676a0a18e5d19f01');
  for (const machinePath of [REPO_ROOT, os.homedir()]) assert.ok(!containsMachinePath(JSON.stringify(events), machinePath), `a machine path reached the page (${path.basename(machinePath)})`);
});

test('privacy check really fails on a Windows path inside JSON (the escaped form is searched too)', () => {
  const leaked = JSON.stringify({ text: `${REPO_ROOT}${path.sep}x` });
  assert.ok(containsMachinePath(leaked, REPO_ROOT));
});

test('machine paths in every form (C:\\, C:/, file:///, lower-case drive) are removed before the page', { timeout: 120_000 }, async () => {
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '0', '--reproducao', path.join(FIXTURES, 'vaza_caminho.mjs')]);
  const url = await live.url;
  const [result, events] = await Promise.all([live.done, readEvents(url, (e) => e.some((x) => x.type === 'recibos'))]);
  assert.equal(result.code, 0);
  assert.ok(containsMachinePath(result.stdout, REPO_ROOT), 'the stand-in did not print the path (the terminal keeps the raw line)');
  const lines = events.filter((e) => e.type === 'linha').map((e) => e.data.text);
  assert.ok(lines.length >= 5);
  for (const line of lines) {
    assert.ok(!containsMachinePath(line, REPO_ROOT) && !line.includes('file:'), `machine path on the page: ${line.slice(0, 40)}`);
  }
});

test('the tests action is refused (409) until the reproduction and the receipts end, then accepted', { timeout: 120_000 }, async () => {
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '20', '--reproducao', path.join(FIXTURES, 'reproducao_lenta.mjs'), '--atraso-ms', '300',
    '--testes-script', path.join(FIXTURES, 'testes_banca_duble.mjs')]);
  try {
    const url = await live.url;
    const early = await postTests(url);
    assert.equal(early.status, 409);
    assert.equal(early.body.message, 'Espere a reprodução e os recibos terminarem.');
    const before = await readEvents(url, (e) => e.some((x) => x.type === 'recibos'));
    assert.ok(!before.some((e) => e.type === 'testes-inicio'), 'the tests started before the receipts');
    const later = await postTests(url);
    assert.equal(later.status, 202);
    const after = await readEvents(url, (e) => e.some((x) => x.type === 'testes-fim'));
    assert.ok(after.findIndex((e) => e.type === 'testes-inicio') > after.findIndex((e) => e.type === 'recibos'));
  } finally {
    live.child.kill();
  }
});

test('a failing receipt check keeps the reproduction\'s exit code (0) and still sends the end and receipts events', { timeout: 120_000 }, async () => {
  const expectedFile = path.join(REPO_ROOT, 'test', 'verifier', 'vetores', 'esperado.json');
  const bytes = fs.readFileSync(expectedFile);
  fs.rmSync(expectedFile);
  try {
    const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '0', '--reproducao', path.join(FIXTURES, 'reproducao_ok.mjs')]);
    const url = await live.url;
    const [result, events] = await Promise.all([live.done, readEvents(url, (e) => e.some((x) => x.type === 'recibos'))]);
    assert.equal(result.code, 0);
    assert.equal(events.find((e) => e.type === 'fim').data.exitCode, 0);
    const receipts = events.find((e) => e.type === 'recibos');
    assert.ok(receipts, 'no receipts event');
    assert.match(receipts.data.error, /esperado\.json|ENOENT|no such file/i);
    assert.ok(!containsMachinePath(receipts.data.error, REPO_ROOT), 'a machine path reached the page');
  } finally {
    fs.writeFileSync(expectedFile, bytes);
  }
});

test('an option without its value stops the command with a clear message (the next option is not taken as the value)', { timeout: 60_000 }, async () => {
  const result = await startLiveCommand(['--reproducao', '--sem-navegador']).done;
  assert.equal(result.code, 70);
  assert.match(result.stderr, /--reproducao precisa de um valor/);
});

test('failure: when the reproduction fails (exit 1), the page gets FALHOU and the command exits with 1', { timeout: 120_000 }, async () => {
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '0', '--reproducao', path.join(FIXTURES, 'reproducao_falha.mjs')]);
  const url = await live.url;
  const [result, events] = await Promise.all([live.done, readEvents(url, (e) => e.some((x) => x.type === 'recibos'))]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^FALHOU {2}B\./m);
  const failed = events.filter((e) => e.type === 'linha' && e.data.kind === 'item' && e.data.ok === false);
  assert.equal(failed.length, 1);
  assert.equal(events.find((e) => e.type === 'fim').data.exitCode, 1);
});

test('failure: the real script refusing a non-empty output folder (exit 2) gives exit 2 here too', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-vivo-'));
  fs.writeFileSync(path.join(dir, 'ocupado.txt'), 'x');
  try {
    const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '0', '--out', dir]);
    const result = await live.done;
    assert.equal(result.code, 2);
    assert.match(result.stderr, /A pasta de saída já tem arquivos/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--com-testes runs the test suite without a click (fast stand-in) and sends its result', { timeout: 120_000 }, async () => {
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '0', '--com-testes',
    '--reproducao', path.join(FIXTURES, 'reproducao_ok.mjs'), '--testes-script', path.join(FIXTURES, 'testes_banca_duble.mjs')]);
  const url = await live.url;
  const [result, events] = await Promise.all([live.done, readEvents(url, (e) => e.some((x) => x.type === 'testes-fim'))]);
  assert.equal(result.code, 0);
  const end = events.find((e) => e.type === 'testes-fim');
  assert.ok(end, 'no testes-fim event');
  assert.equal(end.data.ok, true);
  assert.match(end.data.resultLine, /^Resultado: 3 testes — 3 passaram, 0 falharam/);
  assert.match(result.stderr, /TESTES OK/);
  assert.ok(events.findIndex((e) => e.type === 'testes-inicio') > events.findIndex((e) => e.type === 'recibos'));
});

test('a suite that ends in "TESTES OK, com aviso" (only the speed test over its limit) is reported as OK with the warning', { timeout: 120_000 }, async () => {
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '0', '--com-testes',
    '--reproducao', path.join(FIXTURES, 'reproducao_ok.mjs'), '--testes-script', path.join(FIXTURES, 'testes_banca_duble_aviso.mjs')]);
  const url = await live.url;
  const [result, events] = await Promise.all([live.done, readEvents(url, (e) => e.some((x) => x.type === 'testes-fim'))]);
  assert.equal(result.code, 0);
  const end = events.find((e) => e.type === 'testes-fim').data;
  assert.equal(end.ok, true);
  assert.match(end.warning, /passou do limite \(8,4 s; limite 5 s\)/);
  assert.match(result.stderr, /TESTES OK, com aviso/);
});
