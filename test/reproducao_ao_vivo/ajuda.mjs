/**
 * Shared helpers of the live reproduction tests: start the command as a child process, read the page address
 * it prints, and read the Server-Sent Events of the local server.
 *
 * Not a test file itself (no `.test.` in the name). Everything stays on 127.0.0.1.
 *
 * @module test/reproducao_ao_vivo/ajuda
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

/** Absolute repository root. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Absolute folder of the test stand-in scripts. */
export const FIXTURES = path.join(REPO_ROOT, 'test', 'reproducao_ao_vivo', 'fixtures');
/** Matches the address line printed on standard error. */
const ADDRESS_LINE = /\[ao vivo\] página da reprodução: (http:\/\/127\.0\.0\.1:\d+\/)/;

/**
 * Starts `reproduzir_ao_vivo.mjs` with the network lock, exactly as `npm run reproduzir-ao-vivo` does.
 *
 * @param args - Extra arguments (e.g. `['--sem-navegador', '--manter-segundos', '0']`).
 * @returns `{ child, url, done }`: `url` resolves to the page address once printed; `done` resolves to
 *   `{ code, stdout, stderr }` when the command exits.
 */
export function startLiveCommand(args) {
  const lock = pathToFileURL(path.join(REPO_ROOT, 'reproducao', 'ferramentas', 'sem_rede.mjs')).href;
  const child = spawn(process.execPath, ['--import', lock, path.join(REPO_ROOT, 'reproducao', 'ao_vivo', 'reproduzir_ao_vivo.mjs'), ...args], {
    cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let resolveUrl;
  const url = new Promise((resolve) => { resolveUrl = resolve; });
  child.stdout.setEncoding('utf8').on('data', (t) => { stdout += t; });
  child.stderr.setEncoding('utf8').on('data', (t) => {
    stderr += t;
    const match = ADDRESS_LINE.exec(stderr);
    if (match) resolveUrl(match[1]);
  });
  const done = new Promise((resolve) => child.on('close', (code) => { resolveUrl(null); resolve({ code, stdout, stderr }); }));
  return { child, url, done };
}

/**
 * Runs `reproducao/reproduzir_tudo.mjs` the plain way (`npm run reproduzir-tudo`), to compare outputs.
 *
 * @returns A promise of `{ code, stdout }`.
 */
export function runPlainReproduction() {
  const lock = pathToFileURL(path.join(REPO_ROOT, 'reproducao', 'ferramentas', 'sem_rede.mjs')).href;
  const child = spawn(process.execPath, ['--import', lock, path.join(REPO_ROOT, 'reproducao', 'reproduzir_tudo.mjs')], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (t) => { stdout += t; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout })));
}

/**
 * Reads the SSE stream of the local server until the connection ends or `stopWhen` returns true.
 *
 * @param url - Page address, e.g. `http://127.0.0.1:1234/`.
 * @param stopWhen - Called after each event with the list so far; return `true` to stop reading.
 * @returns A promise of the events, `[{ id, type, data }]`, in arrival order.
 */
export function readEvents(url, stopWhen = () => false) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(new URL('/eventos', url), (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (text) => {
        buffer += text;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const fields = Object.fromEntries(block.split('\n').filter((l) => !l.startsWith(':') && l.includes(': ')).map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
          if (!fields.event) continue;
          events.push({ id: Number(fields.id), type: fields.event, data: JSON.parse(fields.data) });
          if (stopWhen(events)) { req.destroy(); resolve(events); return; }
        }
      });
      res.on('end', () => resolve(events));
      res.on('error', () => resolve(events));
    });
    req.on('error', (err) => (events.length ? resolve(events) : reject(err)));
  });
}

/**
 * Keeps only the reproduction lines that do not depend on the run (drops the output-folder name, which carries a timestamp).
 *
 * @param stdout - Standard output of the reproduction.
 * @returns The `OK`/`FALHOU` lines and the final line with the folder part removed.
 */
export function stableLines(stdout) {
  return stdout.split(/\r?\n/)
    .filter((l) => /^(OK|FALHOU) /.test(l) || /^(TUDO OK|ALGO FALHOU):/.test(l))
    .map((l) => l.replace(/ Detalhes em .*$/, ''));
}

/**
 * Starts a headless system browser (Playwright from node_modules, with the Edge or Chrome already installed; nothing
 * is downloaded), trying Edge first and then Chrome.
 *
 * @returns A promise of the browser, or `null` when none could be started (the browser tests are then skipped).
 */
export async function launchSystemBrowser() {
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* try the next channel */ }
  }
  return null;
}
