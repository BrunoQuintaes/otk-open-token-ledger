/**
 * Tests the step states and the follow-scroll of the live page (`reproducao/ao_vivo/pagina.html`) in a real
 * headless browser (Playwright with the Edge or Chrome already installed; nothing is downloaded).
 *
 * Strategy:
 * - initial state: the page served before any event shows the 13 items as "para rodar", nothing "conferido", every
 *   part pending, the day counters at 0 and no total; it uses no browser storage and every answer is `no-store`;
 * - transitions: with a slow stand-in reproduction, every item goes "para rodar" -> "rodando" -> "conferido", one
 *   after the other in the fixed order; a failing item turns "falhou" in red;
 * - follow mode: the running item and then part 2 stay inside the window; a manual wheel scroll pauses it and shows
 *   "Voltar ao vivo", and the button resumes it on the current part; no horizontal bar at 1366 and 1280 px wide.
 * - real-size lines (copied from a real run): the running item is inside the window in every sample taken outside a
 *   smooth scroll, at 1366x768 and 1280x720, and in every sample with reduced motion (instant scroll);
 * Needs: `npm ci` done, Edge or Chrome installed; no internet. Skipped (with the reason) when no browser starts.
 *
 * @module test/reproducao_ao_vivo/estados.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { summarizeBothDays } from '../../reproducao/ao_vivo/dados_dias.mjs';
import { startLiveServer } from '../../reproducao/ao_vivo/servidor.mjs';
import { FIXTURES, REPO_ROOT, startLiveCommand } from './ajuda.mjs';

const PAGE_FILE = path.join(REPO_ROOT, 'reproducao', 'ao_vivo', 'pagina.html');
/** Background of a failed item badge (--vermelho-fundo, #fde7e7). */
const RED_BACKGROUND = 'rgb(253, 231, 231)';

/**
 * Starts a headless system browser, trying Edge first and then Chrome.
 *
 * @returns A promise of the browser, or `null` when none could be started.
 */
async function launchSystemBrowser() {
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* try the next channel */ }
  }
  return null;
}

/**
 * Tells whether an element is inside the visible window (below the fixed index bar).
 *
 * @param page - Playwright page.
 * @param selector - CSS selector of the element.
 * @returns A promise of `true` when its top edge is on screen.
 */
const isOnScreen = (page, selector) => page.evaluate((sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  return r.top >= 0 && r.top < window.innerHeight;
}, selector);

test('the page never uses browser storage or cookies (source check)', () => {
  const html = fs.readFileSync(PAGE_FILE, 'utf8');
  for (const api of ['localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'caches.open']) assert.ok(!html.includes(api), `the page mentions ${api}`);
});

test('before the first event: 13 items "para rodar", 0 "conferido", parts pending, counters at 0, no total; no-store; no storage', async (t) => {
  const browser = await launchSystemBrowser();
  if (!browser) { t.skip('nem o Edge nem o Chrome puderam ser abertos pelo Playwright'); return; }
  const server = await startLiveServer({
    pageHtml: fs.readFileSync(PAGE_FILE, 'utf8'),
    daysJson: JSON.stringify(summarizeBothDays(REPO_ROOT)),
    verifierPageBytes: fs.readFileSync(path.join(REPO_ROOT, 'web', 'verificador', 'verificador-otk.html')),
  });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
    const cacheHeaders = [];
    page.on('response', (r) => cacheHeaders.push([r.url(), r.headers()['cache-control']]));
    await page.goto(server.url);
    await page.locator('[data-testid="d07-total"]').waitFor();
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('[data-testid="item"]').count(), 13);
    assert.equal(await page.locator('[data-testid="item"][data-estado="pendente"]').count(), 13);
    assert.equal(await page.locator('[data-testid="item"][data-estado="ok"]').count(), 0);
    assert.deepEqual(await page.locator('[data-testid="item"]').evaluateAll((ns) => ns.map((n) => n.getAttribute('data-parte')).join('')), 'AABBCCCCDDDDD');
    assert.equal(await page.getByTestId('rep-veredito').textContent(), 'PARA RODAR');
    for (const part of [1, 2, 3, 4, 5]) {
      assert.equal(await page.getByTestId(`estado-${part}`).getAttribute('data-estado'), 'pendente');
      assert.equal(await page.getByTestId(`nav-${part}`).getAttribute('data-estado'), 'pendente');
    }
    assert.deepEqual(await page.locator('[data-testid="d07-total"] td.num').allTextContents(), ['0', '0', '0', '0']);
    assert.deepEqual(await page.locator('[data-testid="d23-total"] td.num').allTextContents(), ['0', '0', '0', '0', '0']);
    const mainText = await page.locator('main').innerText();
    for (const total of ['662', '1.720', '1.505', '1.719']) assert.ok(!mainText.includes(total), `the total ${total} shows before the replay`);
    assert.equal(await page.getByTestId('rec-estado').textContent(), 'PARA RODAR');
    assert.equal(await page.getByTestId('tes-estado').textContent(), 'PARA RODAR');
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);
    const local = cacheHeaders.filter(([u]) => u.startsWith(server.url));
    assert.ok(local.length >= 2);
    assert.ok(local.every(([, c]) => c === 'no-store'), JSON.stringify(local));
  } finally {
    await server.close();
    await browser.close();
  }
});

test('slow run: each item goes para rodar -> rodando -> conferido in order; the page follows part 1 then part 2; manual scroll pauses and "Voltar ao vivo" resumes; no horizontal bar', { timeout: 240_000 }, async (t) => {
  const browser = await launchSystemBrowser();
  if (!browser) { t.skip('nem o Edge nem o Chrome puderam ser abertos pelo Playwright'); return; }
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '120', '--reproducao', path.join(FIXTURES, 'reproducao_lenta.mjs'), '--atraso-ms', '900']);
  try {
    const url = await live.url;
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url);
    await page.locator('[data-testid="item"]').first().waitFor();
    assert.equal(await page.locator('[data-testid="item"][data-estado="ok"]').count(), 0, 'an item was already checked at load');

    // Record, every 100 ms, the order in which items become "conferido" and whether the running item is on screen.
    const order = [];
    let runningOffScreen = 0;
    while (!(await page.getByTestId('rep-veredito').textContent()).startsWith('TUDO OK')) {
      const snapshot = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[data-testid="item"]')];
        const running = items.find((n) => n.getAttribute('data-estado') === 'rodando');
        const r = running ? running.getBoundingClientRect() : null;
        return { states: items.map((n) => n.getAttribute('data-estado')), runningOnScreen: r ? r.top >= 0 && r.bottom <= window.innerHeight : true };
      });
      snapshot.states.forEach((s, i) => { if (s === 'ok' && !order.includes(i)) order.push(i); });
      if (!snapshot.runningOnScreen) runningOffScreen++;
      await page.waitForTimeout(100);
    }
    const final = await page.locator('[data-testid="item"]').evaluateAll((ns) => ns.map((n) => n.getAttribute('data-historico')));
    for (const history of final) assert.match(history, /^pendente(,pendente)*,rodando(,pendente,rodando)*,ok$/);
    assert.ok(order.length >= 3);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'items were checked out of order');
    assert.equal(runningOffScreen, 0, 'the running item left the window');

    // Part 2 starts after part 1 and the page scrolls down to it.
    await page.getByTestId('estado-2').and(page.locator('[data-estado="rodando"]')).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    assert.ok(await isOnScreen(page, '#dia07'), 'part 2 is not on screen');

    // Manual scroll pauses following; part 3 starts without moving the page; the button resumes on part 3.
    await page.getByTestId('d07-velocidade').selectOption('80');
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, -300);
    await page.getByTestId('ao-vivo').waitFor({ state: 'visible' });
    assert.equal(await page.locator('body').getAttribute('data-seguindo'), 'false');
    await page.waitForTimeout(500);
    const pausedAt = await page.evaluate(() => window.scrollY);
    await page.getByTestId('estado-3').and(page.locator('[data-estado="rodando"]')).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => window.scrollY), pausedAt, 'the page moved while following was paused');
    await page.getByTestId('ao-vivo').click();
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('body').getAttribute('data-seguindo'), 'true');
    assert.ok(await page.getByTestId('ao-vivo').isHidden());
    assert.ok(await isOnScreen(page, '#dia23'), 'part 3 is not on screen after "Voltar ao vivo"');

    for (const [width, height] of [[1366, 768], [1280, 720]]) {
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `horizontal bar at ${width}px`);
    }
    assert.deepEqual(errors, []);
  } finally {
    live.child.kill();
    await browser.close();
  }
});

/**
 * Runs the stand-in with real-size lines and samples, every 100 ms, whether the "rodando" item is inside the window
 * (below the fixed index bar and above the bottom edge). Samples taken while a smooth scroll is still moving
 * (`<body data-rolando="true">`) are counted apart: the item is on its way into view.
 *
 * @param browser - Playwright browser.
 * @param viewport - `{ width, height }`.
 * @param reducedMotion - `'reduce'` or `'no-preference'`.
 * @returns A promise of `{ inView, outOfView, whileScrolling, offenders }`.
 */
async function sampleRunningItem(browser, viewport, reducedMotion) {
  const live = startLiveCommand(['--sem-navegador', '--esperar-pagina', '30', '--manter-segundos', '30', '--reproducao', path.join(FIXTURES, 'reproducao_tamanho_real.mjs'), '--atraso-ms', '600']);
  try {
    const context = await browser.newContext({ viewport, reducedMotion });
    const page = await context.newPage();
    await page.goto(await live.url);
    const result = { inView: 0, outOfView: 0, whileScrolling: 0, offenders: [] };
    while (!(await page.getByTestId('rep-veredito').textContent()).startsWith('TUDO OK')) {
      const s = await page.evaluate(() => {
        const running = document.querySelector('[data-testid="item"][data-estado="rodando"]');
        if (!running) return null;
        const nav = document.querySelector('nav.indice').getBoundingClientRect().height;
        const r = running.getBoundingClientRect();
        return { index: [...document.querySelectorAll('[data-testid="item"]')].indexOf(running), top: Math.round(r.top), bottom: Math.round(r.bottom), nav, height: window.innerHeight, scrolling: document.body.getAttribute('data-rolando') === 'true' };
      });
      if (s) {
        if (s.scrolling) result.whileScrolling++;
        else if (s.top >= s.nav - 1 && s.bottom <= s.height + 1) result.inView++;
        else { result.outOfView++; result.offenders.push(s); }
      }
      await page.waitForTimeout(100);
    }
    await context.close();
    return result;
  } finally {
    live.child.kill();
  }
}

test('real-size lines: the "rodando" item is inside the window in 100% of the samples, at 1366x768 and 1280x720 (smooth and reduced motion)', { timeout: 240_000 }, async (t) => {
  const browser = await launchSystemBrowser();
  if (!browser) { t.skip('nem o Edge nem o Chrome puderam ser abertos pelo Playwright'); return; }
  try {
    for (const [width, height, motion] of [[1366, 768, 'no-preference'], [1280, 720, 'no-preference'], [1280, 720, 'reduce']]) {
      const r = await sampleRunningItem(browser, { width, height }, motion);
      t.diagnostic(`${width}x${height} ${motion}: ${r.inView} amostras dentro, ${r.outOfView} fora, ${r.whileScrolling} durante a rolagem suave`);
      assert.ok(r.inView >= 40, `poucas amostras a ${width}x${height}`);
      assert.deepEqual(r.offenders, [], `item rodando fora da janela a ${width}x${height} (${motion})`);
      if (motion === 'reduce') assert.equal(r.whileScrolling, 0, 'with reduced motion the scroll must be instant');
    }
  } finally {
    await browser.close();
  }
});

test('a failing item turns "falhou" in red, and the items that never ran are marked "não rodou"', { timeout: 120_000 }, async (t) => {
  const browser = await launchSystemBrowser();
  if (!browser) { t.skip('nem o Edge nem o Chrome puderam ser abertos pelo Playwright'); return; }
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '60', '--reproducao', path.join(FIXTURES, 'reproducao_falha.mjs')]);
  try {
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
    await page.goto(await live.url);
    await page.getByTestId('estado-1').and(page.locator('[data-estado="falhou"]')).waitFor({ timeout: 60_000 });
    const failed = page.locator('[data-testid="item"][data-estado="falhou"]');
    assert.equal(await failed.count(), 1);
    assert.equal(await failed.getAttribute('data-parte'), 'B');
    assert.equal(await failed.locator('.selo-estado').evaluate((n) => getComputedStyle(n).backgroundColor), RED_BACKGROUND);
    assert.equal(await page.locator('[data-testid="item"][data-estado="ok"]').count(), 1);
    assert.equal(await page.locator('[data-testid="item"][data-estado="nao-rodou"]').count(), 11);
    assert.equal(await page.getByTestId('nav-1').getAttribute('data-estado'), 'falhou');
    assert.match(await page.getByTestId('rep-veredito').textContent(), /^FALHOU/);
  } finally {
    live.child.kill();
    await browser.close();
  }
});
