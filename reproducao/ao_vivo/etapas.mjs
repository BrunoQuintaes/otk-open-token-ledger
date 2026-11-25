/**
 * The child processes the live reproduction runs besides `reproduzir_tudo.mjs`: the receipt verifier on the
 * example receipts, and (optionally) the automated test suite `reproducao/testes_banca.mjs`.
 *
 * Where it fits: `reproduzir_ao_vivo.mjs` calls {@link runVerifierOnExamples} after the reproduction and
 * {@link runTestSuite} when the page button is clicked or `--com-testes` is given. Every child runs with the
 * network lock `reproducao/ferramentas/sem_rede.mjs`, so none of them can reach the internet.
 *
 * Also exported: {@link forwardLines}, the line splitter shared by all steps.
 *
 * What it does NOT do: it never changes `web/verificador/`, `src/verifier/` or the example receipts; it only
 * reads them and runs the verifier's command-line entry point, the same one as `npm run otk -- verify`.
 *
 * Environment variables: none of its own; children inherit the environment.
 *
 * @module reproducao/ao_vivo/etapas
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

/** Example receipts folder, keyring and expected results, relative to the repository root. */
export const VECTORS_DIR = path.join('test', 'verifier', 'vetores');
/** Original verifier page, relative to the repository root. */
export const VERIFIER_PAGE = path.join('web', 'verificador', 'verificador-otk.html');
/** Default automated test suite script, relative to the repository root. */
export const DEFAULT_TEST_SUITE = path.join('reproducao', 'testes_banca.mjs');

/** Matches the summary line of `testes_banca.mjs`: `Resultado: 3549 testes — 3546 passaram, 0 falharam, 0 cancelados, ...`. */
const TEST_RESULT_LINE = /^Resultado: (\d+) testes — (\d+) passaram, (\d+) falharam, (\d+) cancelados/;

/**
 * SHA-256 of a buffer, as lowercase hex.
 *
 * @param bytes - Data to hash.
 * @returns 64 hex characters.
 */
export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Forwards a child stream to a target stream byte for byte and calls `onLine` for every complete line
 * (UTF-8 decoded, without the line ending).
 *
 * @param source - The child's stdout or stderr.
 * @param target - Where the raw bytes go (`process.stdout`, `process.stderr`), or `null` to only collect.
 * @param onLine - Called once per line, in order.
 * @returns A promise of all bytes read, resolved when the source ends (after the last partial line).
 */
export function forwardLines(source, target, onLine) {
  const decoder = new StringDecoder('utf8');
  const chunks = [];
  let pending = '';
  const emit = (text) => {
    pending += text;
    const parts = pending.split('\n');
    pending = parts.pop();
    for (const part of parts) onLine(part.replace(/\r$/, ''));
  };
  source.on('data', (chunk) => { chunks.push(chunk); target?.write(chunk); emit(decoder.write(chunk)); });
  return new Promise((resolve) => {
    source.on('end', () => {
      emit(decoder.end());
      if (pending !== '') onLine(pending.replace(/\r$/, ''));
      pending = '';
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Runs a Node.js script as a child with the network lock and waits for it.
 *
 * @param repoRoot - Absolute repository root (the child's working folder).
 * @param args - Arguments after `node --import <lock>`.
 * @param io - `{ stdoutTarget, stderrTarget, onLine(stream, line) }`; targets may be `null` to only collect.
 * @returns A promise of `{ exitCode, stdout }`, `stdout` being the raw bytes; `exitCode` is 1 when the child
 *   was killed by a signal, and 70 when it could not start.
 */
export function runLockedNode(repoRoot, args, { stdoutTarget = null, stderrTarget = null, onLine = () => {} } = {}) {
  const lock = pathToFileURL(path.join(repoRoot, 'reproducao', 'ferramentas', 'sem_rede.mjs')).href;
  const child = spawn(process.execPath, ['--import', lock, ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  const outDone = forwardLines(child.stdout, stdoutTarget, (line) => onLine('stdout', line));
  const errDone = forwardLines(child.stderr, stderrTarget, (line) => onLine('stderr', line));
  return new Promise((resolve) => {
    child.once('error', () => resolve({ exitCode: 70, stdout: Buffer.alloc(0) }));
    child.once('close', async (code) => {
      const [stdout] = await Promise.all([outDone, errDone]);
      resolve({ exitCode: code ?? 1, stdout });
    });
  });
}

/**
 * Runs the verifier's command line on the example receipts, with the test keyring and its fingerprint
 * (the same check as `npm run otk -- verify test/verifier/vetores/recibos --keyring ... --fingerprint ... --json`).
 *
 * The fingerprint and the expected report hash come from `test/verifier/vetores/esperado.json`, the file the
 * verifier's own tests use; nothing is hard-coded here.
 *
 * @param repoRoot - Absolute repository root.
 * @returns A promise of the result shown on the page:
 *   `{ command, fingerprint, exitCode, expectedExitCode, reportSha256, expectedReportSha256, totals, items, error }`,
 *   where `totals` is `{ verde, amarelo, vermelho }` from the report and `items` lists, per item,
 *   `{ id, file, line, verdict, code, reasonPt }`. `error` is a message when the report is not valid JSON.
 * @throws {Error} When `esperado.json` is missing or has no fingerprint.
 */
export async function runVerifierOnExamples(repoRoot) {
  const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, VECTORS_DIR, 'esperado.json'), 'utf8'));
  const fingerprint = expected.impressaoDigital;
  if (!/^[0-9a-f]{64}$/.test(fingerprint ?? '')) throw new Error(`PAROU: ${VECTORS_DIR.split(path.sep).join('/')}/esperado.json não traz a impressão digital do chaveiro de teste`);
  const receipts = path.join(VECTORS_DIR, 'recibos');
  const keyring = path.join(VECTORS_DIR, 'chaveiro.json');
  const tsx = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliArgs = ['verify', receipts, '--keyring', keyring, '--fingerprint', fingerprint, '--json'];
  const { exitCode, stdout } = await runLockedNode(repoRoot, [tsx, path.join('scripts', 'verify', 'otk.ts'), ...cliArgs]);
  const slash = (p) => p.split(path.sep).join('/');
  const result = {
    command: `npm run otk -- ${cliArgs.map(slash).join(' ')}`,
    fingerprint,
    exitCode,
    expectedExitCode: expected.exitCode?.comImpressaoDigital ?? null,
    reportSha256: sha256Hex(stdout),
    expectedReportSha256: expected.relatorioSha256?.comImpressaoDigital ?? null,
    totals: null,
    items: [],
    error: null,
  };
  try {
    const report = JSON.parse(stdout.toString('utf8'));
    result.totals = report.summary?.total ?? null;
    result.items = (report.items ?? []).map((item) => ({
      id: item.id,
      file: item.source?.file ?? null,
      line: item.source?.line ?? null,
      verdict: item.verdict,
      code: item.code,
      reasonPt: item.reasonPt ?? null,
    }));
  } catch (err) {
    result.error = `o relatório do verificador não é JSON (${err.message})`;
  }
  return result;
}

/**
 * Reads the summary line printed by `testes_banca.mjs`.
 *
 * @param line - One output line.
 * @returns `{ total, passed, failed, cancelled, ok }` when it is the summary line, otherwise `null`.
 *   `ok` is `true` only when nothing failed or was cancelled.
 */
export function parseTestResultLine(line) {
  const match = TEST_RESULT_LINE.exec(line);
  if (!match) return null;
  const [total, passed, failed, cancelled] = match.slice(1).map(Number);
  return { total, passed, failed, cancelled, ok: failed === 0 && cancelled === 0 };
}

/**
 * Runs the automated test suite (or a stand-in script given by the tests) and reports every line.
 *
 * The verdict needs both the `Resultado:` line (nothing failed or cancelled) and exit code 0; a missing line or a
 * non-zero exit code counts as a failure, whichever version of `testes_banca.mjs` is in the repository.
 *
 * @param repoRoot - Absolute repository root.
 * @param script - Absolute path of the suite script.
 * @param onLine - Called with each output line (both streams), in order.
 * @param stderrTarget - Where the raw output is copied (the terminal), or `null`.
 * @returns A promise of `{ exitCode, result, ok, resultLine }`.
 */
export async function runTestSuite(repoRoot, script, onLine, stderrTarget = null) {
  let result = null;
  let resultLine = null;
  const { exitCode } = await runLockedNode(repoRoot, [script], {
    stdoutTarget: stderrTarget,
    stderrTarget,
    onLine: (stream, line) => {
      const parsed = parseTestResultLine(line);
      if (parsed) { result = parsed; resultLine = line; }
      onLine(stream, line);
    },
  });
  return { exitCode, result, resultLine, ok: exitCode === 0 && result?.ok === true };
}
