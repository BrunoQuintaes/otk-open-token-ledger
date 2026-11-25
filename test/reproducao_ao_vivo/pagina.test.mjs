/**
 * Tests the live page in a real headless browser (Playwright from node_modules, with the Edge or Chrome already
 * installed on the machine: channels `msedge`, then `chrome`; nothing is downloaded).
 *
 * Strategy:
 * - full run (`--sem-navegador`, page kept open): the page shows the 13 OK items and "TUDO OK: 13 de 13"; the two
 *   replays, skipped to the end, show 662 / 658 / 0 / 4 and 1,720 / 1,720 / 1,505 / 215 / 1,719 with declared usage (gpt-6-luna without
 *   count); part 4 shows 9 / 11 / 33 and the report sha256 bbcfeed1...; the embedded verifier page loads;
 *   the tests button runs a fast stand-in suite and shows TESTES OK;
 * - failure run: with a stand-in reproduction that fails, the page shows FALHOU;
 * - in both: zero requests to anything other than 127.0.0.1 and zero console errors.
 * Needs: `npm ci` done and Edge or Chrome installed; no internet. Skipped (with the reason) when neither browser
 * can be started. The full run takes 20 s to 3 min.
 *
 * @module test/reproducao_ao_vivo/pagina.test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FIXTURES, launchSystemBrowser, startLiveCommand } from './ajuda.mjs';

/** Generous limit for the full reproduction on a slow machine, in milliseconds. */
const FULL_RUN_TIMEOUT_MS = 8 * 60_000;

/**
 * Opens the page and records every request and console error.
 *
 * @param browser - Playwright browser.
 * @param url - Page address.
 * @returns `{ page, requests, consoleErrors }`.
 */
async function openWatched(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const requests = [];
  const consoleErrors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(url);
  return { page, requests, consoleErrors };
}

const outsideLoopback = (requests) => requests.filter((u) => !/^(http:\/\/127\.0\.0\.1:\d+\/|data:|about:)/.test(u));

test('page: 13 OK items, the right day counters, the receipt check and the tests button; no outside request, no console error', { timeout: FULL_RUN_TIMEOUT_MS }, async (t) => {
  const browser = await launchSystemBrowser();
  if (!browser) { t.skip('nem o Edge nem o Chrome puderam ser abertos pelo Playwright'); return; }
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '600', '--testes-script', path.join(FIXTURES, 'testes_banca_duble.mjs')]);
  try {
    const url = await live.url;
    const { page, requests, consoleErrors } = await openWatched(browser, url);

    await page.getByTestId('rep-veredito').filter({ hasText: 'TUDO OK: 13 de 13' }).waitFor({ timeout: FULL_RUN_TIMEOUT_MS });
    assert.equal(await page.locator('[data-testid="item"][data-ok="true"]').count(), 13);
    assert.equal(await page.locator('[data-testid="item"][data-ok="false"]').count(), 0);

    await page.getByTestId('d07-fim').click();
    const total07 = page.getByTestId('d07-total');
    assert.deepEqual(await total07.locator('td.num').allTextContents(), ['662', '658', '0', '4']);
    assert.equal(await page.getByTestId('estado-2').getAttribute('data-estado'), 'ok');
    await page.getByTestId('d23-fim').click();
    const total23 = page.getByTestId('d23-total');
    assert.deepEqual(await total23.locator('td.num').allTextContents(), ['1.720', '1.720', '1.505', '215', '1.719']);
    const luna = page.locator('#d23-contadores tr[data-grupo="gpt-6-luna"] td.num');
    assert.deepEqual(await luna.allTextContents(), ['215', '215', '0', '215', '214']);
    for (const gemini of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']) {
      assert.equal(await page.locator(`#d23-contadores tr[data-grupo="${gemini}"] td.num`).last().textContent(), '215');
    }
    assert.match(await page.getByTestId('d23-fonte-declarado').textContent(), /TENTATIVAS_CMP8.jsonl/);
    assert.equal(await page.getByTestId('estado-3').getAttribute('data-estado'), 'ok');
    assert.equal(await page.locator('[data-testid="item"][data-estado="ok"]').count(), 13);
    assert.match(await page.getByTestId('d23-aviso').textContent(), /não passou pelo proxy e não gerou recibo/);
    assert.equal(await page.locator('#t-dia23').textContent(), '3. O caminho de cada envio em 23 de novembro de 2026 (programa de coleta, sem o proxy)');
    assert.match(await page.locator('#d07-nota').textContent(), /4 sem a checagem: 3 barradas pela cota do próprio OTK \(HTTP 429\) e 1 recusada pela OpenAI \(HTTP 400\)/);
    for (const key of ['d07', 'd23']) assert.equal(await page.getByTestId(`${key}-col-otk`).textContent(), 'Contagem do OTK, sem a correção por modelo');
    assert.match(await page.locator('#testes').textContent(), /refaz os números listados na parte 1/);

    await page.getByTestId('rec-estado').filter({ hasText: 'CONFERIDO' }).waitFor({ timeout: 120_000 });
    assert.equal(await page.getByTestId('rec-verde').textContent(), '9');
    assert.equal(await page.getByTestId('rec-amarelo').textContent(), '11');
    assert.equal(await page.getByTestId('rec-vermelho').textContent(), '33');
    assert.equal(await page.getByTestId('rec-sha').textContent(), 'bbcfeed1d0cfb3beb9685eb8157331ca3bd21d8186985f22676a0a18e5d19f01');
    assert.equal(await page.getByTestId('rec-pagina-sha').textContent(), '2bef5dd84fcf7289ae5e76cf74e329eb6bda55f479415b898da364786efdc2fc');
    await page.locator('#rec-iframe').scrollIntoViewIfNeeded();
    await page.frameLocator('#rec-iframe').locator('body').waitFor();

    assert.equal(await page.getByTestId('tes-botao').isDisabled(), false, 'the tests button stays off after the receipts');
    await page.getByTestId('tes-botao').click();
    await page.getByTestId('tes-estado').filter({ hasText: 'TESTES OK' }).waitFor({ timeout: 60_000 });
    assert.match(await page.getByTestId('tes-resultado').textContent(), /^Resultado: 3 testes — 3 passaram, 0 falharam/);

    assert.deepEqual(outsideLoopback(requests), []);
    assert.deepEqual(consoleErrors, []);
  } finally {
    live.child.kill();
    await browser.close();
  }
});

test('page: when the reproduction fails, the page shows FALHOU', { timeout: 180_000 }, async (t) => {
  const browser = await launchSystemBrowser();
  if (!browser) { t.skip('nem o Edge nem o Chrome puderam ser abertos pelo Playwright'); return; }
  const live = startLiveCommand(['--sem-navegador', '--manter-segundos', '60', '--reproducao', path.join(FIXTURES, 'reproducao_falha.mjs')]);
  try {
    const url = await live.url;
    const { page, requests, consoleErrors } = await openWatched(browser, url);
    await page.getByTestId('rep-veredito').filter({ hasText: 'FALHOU' }).waitFor({ timeout: 60_000 });
    assert.equal(await page.locator('[data-testid="item"][data-ok="false"]').count(), 1);
    assert.match(await page.locator('[data-testid="item"][data-ok="false"]').textContent(), /falhou/);
    assert.match(await page.locator('#rep-codigo').textContent(), /Código de saída: 1/);
    assert.deepEqual(outsideLoopback(requests), []);
    assert.deepEqual(consoleErrors, []);
  } finally {
    live.child.kill();
    await browser.close();
  }
});
