/**
 * `npm run reproduzir-ao-vivo`: runs exactly the same offline reproduction as `npm run reproduzir-tudo` and, at
 * the same time, shows it on one local web page that opens by itself in the default browser, together with the
 * path of the OTK on the two collection days, the receipt check and (optionally) the automated tests.
 *
 * Flow:
 * 1. summarizes the stored records of the 7 Oct and 23 Nov collections (`dados_dias.mjs`), offline;
 * 2. starts the local server on 127.0.0.1 with a port chosen by the system (`servidor.mjs`);
 * 3. opens the page in the default browser (Windows `cmd /c start`, macOS `open`, Linux `xdg-open`), unless
 *    `--sem-navegador` is given, in which case it only prints the address (mode used by the tests);
 * 4. runs `reproducao/reproduzir_tudo.mjs` as a child process, unchanged, with the same network lock
 *    (`reproducao/ferramentas/sem_rede.mjs`), copies its standard output and error to this terminal byte for
 *    byte, and sends each line to the page as a Server-Sent Event;
 * 5. runs the verifier on the example receipts (`etapas.mjs`) and shows the result on the page and here;
 * 6. runs the automated tests if `--com-testes` is given, or when the page button is clicked;
 * 7. keeps serving the page for `--manter-segundos` seconds (default 120; longer while the tests run; Ctrl+C
 *    ends it sooner) and exits with the exit code of the reproduction (step 4).
 *
 * Standard output carries only the reproduction's own output, so it is identical to `reproduzir-tudo`. Everything
 * else (address, day summaries, receipt table, test output) goes to standard error, lines of this command with
 * the prefix `[ao vivo]`; in PowerShell both appear, so the terminal shows everything the page shows.
 *
 * Arguments:
 * - `--sem-navegador`       do not open a browser; just print the address.
 * - `--com-testes`          run the automated tests right after the receipt check, without the click.
 * - `--manter-segundos N`   seconds to keep serving the page after the end (0 exits at once, unless tests run).
 * - `--reproducao <arq>`    script to run instead of `reproducao/reproduzir_tudo.mjs` (failure test only).
 * - `--testes-script <arq>` script to run instead of `reproducao/testes_banca.mjs` (quick tests only).
 * - `--esperar-pagina N`    with `--sem-navegador`, wait up to N seconds for a page to open before starting, so
 *                           the page sees every step from "para rodar" (used to record the page).
 * - any other argument (e.g. `--out <pasta>`) is passed to the reproduction script unchanged.
 *
 * Exit codes: the reproduction's exit code; 70 when this command itself fails before the reproduction ends.
 * Environment variables: none of its own (children inherit the environment, as with `reproduzir-tudo`).
 *
 * @module reproducao/ao_vivo/reproduzir_ao_vivo
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeBothDays } from './dados_dias.mjs';
import { startLiveServer } from './servidor.mjs';
import { DEFAULT_TEST_SUITE, VERIFIER_PAGE, runLockedNode, runTestSuite, runVerifierOnExamples, sha256Hex } from './etapas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_REPRODUCTION = path.join(REPO_ROOT, 'reproducao', 'reproduzir_tudo.mjs');

/** Seconds the page stays available after the end, when `--manter-segundos` is not given. */
const DEFAULT_KEEP_SECONDS = 120;
/** How long to wait for the browser to connect before starting the reproduction anyway, in milliseconds. */
const WAIT_FOR_BROWSER_MS = 5_000;
/** How long an open page shows every step as "para rodar" before the reproduction starts, in milliseconds. */
const SHOW_PENDING_MS = 1_500;
/** Pause before closing, so the last SSE frames leave the socket, in milliseconds. */
const FLUSH_BEFORE_CLOSE_MS = 200;
/** Exit code when this command fails before the reproduction ends (EX_SOFTWARE from sysexits). */
const EXIT_INTERNAL_ERROR = 70;

/** Matches an item line printed by the reproduction: `OK      A. name — detail` or `FALHOU  B. ...`. */
const ITEM_LINE = /^(OK|FALHOU)\s+([A-D])\.\s+(.*)$/;
/** Matches the reproduction's final line: `TUDO OK: 13 de 13 itens...` or `ALGO FALHOU: 12 de 13 itens...`. */
const FINAL_LINE = /^(TUDO OK|ALGO FALHOU): (\d+) de (\d+) itens/;
/** Portuguese labels of the verifier verdicts, the same words as the verifier page cards. */
const VERDICT_LABELS = { verde: 'OK', amarelo: 'Atenção', vermelho: 'Falhou' };

/**
 * Prints a message of this command (not of the reproduction) to standard error.
 *
 * @param message - Text without machine paths.
 */
function say(message) {
  process.stderr.write(`[ao vivo] ${message}\n`);
}

/**
 * Splits this command's own options from the arguments that go to the reproduction script.
 *
 * @param argv - `process.argv.slice(2)`.
 * @returns `{ openBrowser, runTestsAtOnce, keepSeconds, waitForPageSeconds, reproductionScript, testSuiteScript, childArgs }`.
 * @throws {Error} When `--manter-segundos` is not a non-negative integer or a script option has no value.
 */
function parseArguments(argv) {
  const options = {
    openBrowser: true, runTestsAtOnce: false, keepSeconds: DEFAULT_KEEP_SECONDS, waitForPageSeconds: 0,
    reproductionScript: DEFAULT_REPRODUCTION, testSuiteScript: path.join(REPO_ROOT, DEFAULT_TEST_SUITE), childArgs: [],
  };
  const valueAfter = (i, name) => {
    if (!argv[i + 1]) throw new Error(`PAROU: ${name} precisa de um valor.`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--sem-navegador') options.openBrowser = false;
    else if (arg === '--com-testes') options.runTestsAtOnce = true;
    else if (arg === '--manter-segundos') {
      const value = valueAfter(i++, arg);
      if (!/^\d+$/.test(value)) throw new Error('PAROU: --manter-segundos precisa de um número inteiro de segundos (0 ou mais).');
      options.keepSeconds = Number(value);
    } else if (arg === '--reproducao') options.reproductionScript = path.resolve(valueAfter(i++, arg));
    else if (arg === '--esperar-pagina') {
      const value = valueAfter(i++, arg);
      if (!/^\d+$/.test(value)) throw new Error('PAROU: --esperar-pagina precisa de um número inteiro de segundos.');
      options.waitForPageSeconds = Number(value);
    } else if (arg === '--testes-script') options.testSuiteScript = path.resolve(valueAfter(i++, arg));
    else options.childArgs.push(arg);
  }
  return options;
}

/**
 * Removes machine paths from a line before it goes to the page; the terminal always gets the raw line.
 *
 * @param line - One output line.
 * @returns The line with the repository root shown as `.` and the home folder as `~`.
 */
function stripMachinePaths(line) {
  let clean = line;
  for (const [absolute, shown] of [[REPO_ROOT + path.sep, ''], [REPO_ROOT, '.'], [os.homedir(), '~']]) {
    if (absolute.length > 1) clean = clean.split(absolute).join(shown);
  }
  return clean;
}

/**
 * Classifies one reproduction line for the page.
 *
 * @param line - One line of the reproduction's output, without the newline.
 * @returns `{ kind: 'item', ok, part, text }`, `{ kind: 'final', ok, passed, total, text }` or `{ kind: 'log', text }`.
 */
function classifyLine(line) {
  const text = stripMachinePaths(line);
  const item = ITEM_LINE.exec(text);
  if (item) return { kind: 'item', ok: item[1] === 'OK', part: item[2], text: item[3] };
  const final = FINAL_LINE.exec(text);
  if (final) return { kind: 'final', ok: final[1] === 'TUDO OK', passed: Number(final[2]), total: Number(final[3]), text };
  return { kind: 'log', text };
}

/**
 * Opens a URL in the default browser of the operating system, without waiting for the browser.
 *
 * @param url - The local page address (`http://127.0.0.1:<port>/`).
 * @returns A promise of `true` when the opener program started and exited with 0, `false` otherwise.
 */
function openInBrowser(url) {
  const isWindows = process.platform === 'win32';
  // `start` is a cmd built-in; the empty "" is the window title, so the URL is not taken as the title.
  const [command, args] = isWindows ? ['cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: isWindows });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
    child.unref();
  });
}

/**
 * Resolves after `ms` milliseconds.
 *
 * @param ms - Delay in milliseconds.
 * @returns A promise.
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until `isDone()` is true, polling every 100 ms, or until the timeout.
 *
 * @param isDone - Condition to wait for.
 * @param timeoutMs - Longest wait, in milliseconds (`Infinity` waits forever).
 * @returns A promise resolved when the condition holds or the time is up.
 */
async function waitUntil(isDone, timeoutMs) {
  const started = Date.now();
  while (!isDone() && Date.now() - started < timeoutMs) await delay(100);
}

/**
 * Prints to the terminal the same day counters the page shows.
 *
 * @param days - Result of `summarizeBothDays`.
 */
function printDaySummaries(days) {
  const oct = days.oct07.counters;
  const calls = (n) => `${n} ${n === 1 ? 'chamada' : 'chamadas'}`;
  const sends = (n) => `${n} ${n === 1 ? 'envio' : 'envios'}`;
  say(`7 de outubro de 2026: ${calls(oct.total.calls)} reais; assinatura do recibo conferida: ${oct.total.signatureYes} sim, ${oct.total.signatureNo} não; ${oct.total.withoutCheck} sem a checagem (recusadas pelo provedor: ${Object.entries(days.oct07.refusedHttpStatuses).map(([s, n]) => `${n} com HTTP ${s}`).join(', ')}).`);
  for (const g of oct.groups) say(`  ${g.group}: ${calls(g.calls)}; assinatura conferida: ${g.signatureYes} sim, ${g.signatureNo} não; ${g.withoutCheck} sem checagem`);
  const nov = days.nov23.counters;
  say(`23 de novembro de 2026: ${sends(nov.total.sent)}, ${nov.total.recordedBefore} com o registro gravado antes; ${nov.total.withOtkCount} com a contagem do OTK, ${nov.total.withoutOtkCount} sem contagem; ${nov.total.withDeclared} com uso declarado; ${nov.groups.length} modelos.`);
  for (const g of nov.groups) say(`  ${g.group}: ${sends(g.sent)}, ${g.recordedBefore} registro antes, ${g.withOtkCount} com contagem, ${g.withoutOtkCount} sem contagem, ${g.withDeclared} com uso declarado`);
  say('  Nesta coleta, o programa de coleta não passou pelo proxy e não gerou recibo.');
  say('  O declarado vem do uso bruto do provedor em TENTATIVAS_CMP8.jsonl, pela regra da parte C; no diário do Google o uso lido ficou UNKNOWN.');
}

/**
 * Prints to the terminal the same receipt check the page shows.
 *
 * @param check - Result of `runVerifierOnExamples`, plus `verifierPageSha256`.
 */
function printReceiptCheck(check) {
  say(`Conferindo os recibos de exemplo: ${check.command}`);
  if (check.error) say(`  ${check.error}`);
  const t = check.totals ?? {};
  say(`  Itens: ${t.verde ?? '?'} OK, ${t.amarelo ?? '?'} Atenção, ${t.vermelho ?? '?'} Falhou (código de saída ${check.exitCode}).`);
  for (const item of check.items) say(`  ${(VERDICT_LABELS[item.verdict] ?? item.verdict).padEnd(8)} ${item.id} (${item.file}:${item.line}): ${item.reasonPt ?? item.code}`);
  say(`  sha256 do relatório: ${check.reportSha256} (${check.reportSha256 === check.expectedReportSha256 ? 'igual ao esperado' : `DIFERENTE do esperado ${check.expectedReportSha256}`}).`);
  say('  Nos exemplos, vermelho é o esperado: eles foram alterados de propósito para testar o verificador.');
  say(`  Página original do verificador servida sem mudança; sha256 ${check.verifierPageSha256}.`);
}

/**
 * Builds the handler of the "run the tests" action, shared by the page button and `--com-testes`.
 *
 * @param options - From {@link parseArguments}.
 * @param publish - Sends one event to the page.
 * @returns `{ requestRun, isRunning }`; `requestRun()` returns `{ started, message }` and never runs two at once.
 */
function createTestRunner(options, publish) {
  let running = false;
  let finished = false;
  const requestRun = () => {
    if (running) return { started: false, message: 'Os testes já estão rodando.' };
    if (finished) return { started: false, message: 'Os testes já rodaram nesta sessão; o resultado está na página.' };
    running = true;
    const startedMs = Date.now();
    say(`Rodando os testes automáticos (${path.relative(REPO_ROOT, options.testSuiteScript).split(path.sep).join('/')}); leva de 2 a 5 minutos.`);
    publish('testes-inicio', {});
    runTestSuite(REPO_ROOT, options.testSuiteScript, (stream, line) => publish('testes-linha', { stream, text: stripMachinePaths(line) }), process.stderr)
      .then((outcome) => {
        say(outcome.ok ? 'TESTES OK' : 'HOUVE FALHA nos testes automáticos');
        publish('testes-fim', { ...outcome, resultLine: outcome.resultLine && stripMachinePaths(outcome.resultLine), elapsedMs: Date.now() - startedMs });
      })
      .finally(() => { running = false; finished = true; });
    return { started: true, message: 'Testes iniciados.' };
  };
  return { requestRun, isRunning: () => running };
}

/**
 * Entry point: see the module comment for the full flow.
 *
 * @returns A promise of the exit code to use.
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const days = summarizeBothDays(REPO_ROOT);
  const pageHtml = fs.readFileSync(path.join(HERE, 'pagina.html'), 'utf8');
  const verifierPageBytes = fs.readFileSync(path.join(REPO_ROOT, VERIFIER_PAGE));
  let connected = 0;
  let publish = () => {};
  const tests = createTestRunner(options, (type, data) => publish(type, data));
  const server = await startLiveServer({
    pageHtml, daysJson: JSON.stringify(days), verifierPageBytes, onClient: () => { connected++; }, onRunTests: tests.requestRun,
  });
  publish = server.publish;
  say(`página da reprodução: ${server.url}`);
  publish('inicio', { script: path.relative(REPO_ROOT, options.reproductionScript).split(path.sep).join('/'), node: process.version, testsAtOnce: options.runTestsAtOnce });
  printDaySummaries(days);

  if (options.openBrowser) {
    if (!(await openInBrowser(server.url))) say(`abra este endereço no navegador: ${server.url}`);
    await waitUntil(() => connected > 0, WAIT_FOR_BROWSER_MS);
  } else {
    say(`--sem-navegador: abra este endereço no navegador, se quiser: ${server.url}`);
    if (options.waitForPageSeconds > 0) {
      say(`--esperar-pagina: a reprodução começa quando a página abrir (no máximo ${options.waitForPageSeconds} s).`);
      await waitUntil(() => connected > 0, options.waitForPageSeconds * 1000);
    }
  }
  // When a page is open, it first shows every step as "para rodar" for a moment before the run starts.
  if (connected > 0) await delay(SHOW_PENDING_MS);

  const startedMs = Date.now();
  publish('reproducao-inicio', {});
  const { exitCode } = await runLockedNode(REPO_ROOT, [options.reproductionScript, ...options.childArgs], {
    stdoutTarget: process.stdout,
    stderrTarget: process.stderr,
    onLine: (stream, line) => publish('linha', { stream, elapsedMs: Date.now() - startedMs, ...classifyLine(line) }),
  });
  publish('fim', { exitCode, elapsedMs: Date.now() - startedMs });

  publish('recibos-inicio', {});
  const check = { ...(await runVerifierOnExamples(REPO_ROOT)), verifierPageSha256: sha256Hex(verifierPageBytes), verifierPagePath: VERIFIER_PAGE.split(path.sep).join('/') };
  printReceiptCheck(check);
  publish('recibos', check);

  if (options.runTestsAtOnce) tests.requestRun();
  if (options.keepSeconds > 0) say(`terminado (código de saída ${exitCode}). A página fica no ar por ${options.keepSeconds} s em ${server.url} (Ctrl+C encerra antes).`);
  let interrupted = false;
  process.once('SIGINT', () => { interrupted = true; });
  await waitUntil(() => interrupted, options.keepSeconds * 1000);
  // Tests started by the button or by --com-testes keep the page alive until they finish.
  await waitUntil(() => interrupted || !tests.isRunning(), Infinity);
  await delay(FLUSH_BEFORE_CLOSE_MS);
  await server.close();
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(`PAROU: ${stripMachinePaths(err.message)}`);
    say('O que fazer: confira se rodou `npm ci` e se as pastas reproducao/, test/verifier/ e web/verificador/ estão completas (seções 5 e 6 do README).');
    process.exit(EXIT_INTERNAL_ERROR);
  },
);
