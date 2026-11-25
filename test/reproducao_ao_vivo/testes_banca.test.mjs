/**
 * Tests the final verdict of `reproducao/testes_banca.mjs` (`decideVerdict`, `listFailures`, `SPEED_TESTS`).
 *
 * Strategy: the stand-ins are real `node --test` runs of tiny temporary test files, so the verdict is checked on the
 * exact output format of node:test (the spec reporter used by the suite):
 * - only the listed speed test fails (8439 ms against 5 s) -> `TESTES OK, com aviso: ...`, exit code 0;
 * - the speed test plus another test fail -> `HOUVE FALHA`, exit code 1, and the failing lines stay in the output;
 * - another test fails alone -> `HOUVE FALHA`; nothing fails -> `TESTES OK`; a cancelled test -> `HOUVE FALHA`.
 * Also checks that the speed list has exactly the verifier speed test, by its name in the verifier test file.
 * Needs: no network; writes only to a new temporary folder, removed at the end.
 *
 * @module test/reproducao_ao_vivo/testes_banca.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SPEED_TESTS, decideVerdict, listFailures } from '../../reproducao/testes_banca.mjs';
import { REPO_ROOT } from './ajuda.mjs';

const SPEED_NAME = 'desempenho: 1.000 recibos verificados em menos de 5 s';

/**
 * Runs a tiny test file with node:test (spec reporter) and returns its output, as the suite sees it.
 *
 * @param source - Test file contents.
 * @returns `{ status, output }`.
 */
function runTinyTests(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testes-banca-duble-'));
  try {
    const file = path.join(dir, 'duble.test.mjs');
    fs.writeFileSync(file, source);
    // A child started inside a test would report to this runner (NODE_TEST_CONTEXT) instead of printing; drop it.
    const { NODE_TEST_CONTEXT: _ignored, ...childEnv } = { ...process.env, NODE_OPTIONS: '' };
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], { encoding: 'utf8', env: childEnv });
    return { status: r.status, output: (r.stdout ?? '') + (r.stderr ?? '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SPEED_FAILS = `import test from 'node:test'; import assert from 'node:assert/strict';
test(${JSON.stringify(SPEED_NAME)}, () => { const ms = 8439; assert.ok(ms < 5000, \`\${ms} ms\`); });`;
const OTHER_FAILS = `import test from 'node:test'; import assert from 'node:assert/strict';
test('conta os tokens do pedido', () => { assert.equal(1 + 1, 3); });
test('passa sempre', () => {});`;

test('the speed list has exactly the verifier speed test, by its exact name, with a 5 s limit', () => {
  assert.deepEqual(SPEED_TESTS, [{ name: SPEED_NAME, limitSeconds: 5 }]);
  const verifierTests = fs.readFileSync(path.join(REPO_ROOT, 'test', 'verifier', 'verificador.test.ts'), 'utf8');
  assert.ok(verifierTests.includes(`test('${SPEED_NAME}'`));
});

test('only the speed test over its limit: TESTES OK, com aviso, with the measured time, and exit code 0', () => {
  const speed = runTinyTests(SPEED_FAILS);
  assert.notEqual(speed.status, 0);
  const verdict = decideVerdict({ counts: { falharam: 1, cancelados: 0 }, mainStatus: 0, speedStatus: speed.status, output: speed.output });
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.lines.length, 1);
  assert.equal(verdict.lines[0], `TESTES OK, com aviso: o teste de tempo "${SPEED_NAME}" passou do limite (8,4 s; limite 5 s). Ele mede velocidade, não correção; com o computador ocupado isso acontece. Feche outros programas e rode de novo se quiser vê-lo passar.`);
});

test('the speed test plus another failure: HOUVE FALHA and exit code 1, and the failing line stays in the output', () => {
  const speed = runTinyTests(SPEED_FAILS);
  const other = runTinyTests(OTHER_FAILS);
  const output = `${other.output}\n${speed.output}`;
  const verdict = decideVerdict({ counts: { falharam: 2, cancelados: 0 }, mainStatus: other.status, speedStatus: speed.status, output });
  assert.equal(verdict.exitCode, 1);
  assert.deepEqual(verdict.lines, ['HOUVE FALHA (veja testes-banca-saida.txt)']);
  assert.deepEqual(listFailures(output).map((f) => f.name).sort(), ['conta os tokens do pedido', SPEED_NAME].sort());
  assert.ok(output.split('\n').some((l) => /^✖ conta os tokens do pedido/.test(l.trim())));
});

test('the speed test failing on a wrong result (999 green receipts) is a real failure: HOUVE FALHA and exit code 1', () => {
  const wrongResult = runTinyTests(`import test from 'node:test'; import assert from 'node:assert/strict';
test(${JSON.stringify(SPEED_NAME)}, () => { assert.equal(999, 1000); });`);
  assert.notEqual(wrongResult.status, 0);
  const verdict = decideVerdict({ counts: { falharam: 1, cancelados: 0 }, mainStatus: 0, speedStatus: wrongResult.status, output: wrongResult.output });
  assert.equal(verdict.exitCode, 1);
  assert.deepEqual(verdict.lines, ['HOUVE FALHA (veja testes-banca-saida.txt)']);
});

test('another failure alone: HOUVE FALHA; nothing failing: TESTES OK; a cancelled test: HOUVE FALHA', () => {
  const other = runTinyTests(OTHER_FAILS);
  assert.equal(decideVerdict({ counts: { falharam: 1, cancelados: 0 }, mainStatus: other.status, speedStatus: 0, output: other.output }).exitCode, 1);
  assert.deepEqual(decideVerdict({ counts: { falharam: 0, cancelados: 0 }, mainStatus: 0, speedStatus: 0, output: '' }), { exitCode: 0, lines: ['TESTES OK'] });
  const speed = runTinyTests(SPEED_FAILS);
  assert.equal(decideVerdict({ counts: { falharam: 1, cancelados: 1 }, mainStatus: 1, speedStatus: speed.status, output: speed.output }).exitCode, 1);
});
