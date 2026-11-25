/**
 * Tests the command `npm run reproduzir-ao-vivo -- --sem-navegador` end to end (`reproducao/ao_vivo/reproduzir_ao_vivo.mjs`).
 *
 * Strategy:
 * - full run: the real reproduction through the live command and the plain `reproduzir-tudo`; same exit code (0)
 *   and the same OK lines on standard output; the SSE events arrive in order (start, lines, end, receipts);
 * - failure runs: a stand-in that fails (exit 1) and the real script with a non-empty output folder (exit 2);
 *   the live command must exit with the same code and send the failing lines;
 * - `--com-testes`: with a fast stand-in suite, the tests run without any click and their result is sent.
 * Needs: `npm ci` done; no internet. The full run takes 20 s to 3 min (twice, for the comparison).
 *
 * @module test/reproducao_ao_vivo/comando.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURES, readEvents, runPlainReproduction, stableLines, startLiveCommand } from './ajuda.mjs';

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
  assert.ok(!JSON.stringify(events).includes(os.homedir()), 'a machine path reached the page');
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
