// Utilitários dos testes da página (VERIFICADOR_WEB, C160). Sem rede, sem variável de ambiente.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(RAIZ, '..', '..');
export const NM = path.join(REPO, 'node_modules');
export const req = createRequire(path.join(NM, 'x.js'));
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Vetores do núcleo: test/verifier/vetores (otk.verifier_vectors.v1) ou os gerados por gerar_vetores.mts. */
export const VETORES_NUCLEO = path.join(REPO, 'test', 'verifier', 'vetores');
export function lerEsperado(dir) {
  const e = JSON.parse(fs.readFileSync(path.join(dir, 'esperado.json'), 'utf8'));
  if (e.schema === 'otk.verifier_vectors.v1') return { fingerprint: e.impressaoDigital, keyring: 'chaveiro.json', expect: e.vereditos, shaCom: e.relatorioSha256.comImpressaoDigital, shaSem: e.relatorioSha256.semImpressaoDigital };
  return { ...e, shaCom: null, shaSem: null };
}

export function arg(n, d) { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; }

/** Extrai o único <script> inline da página. */
export function scriptDaPagina(html) {
  const m = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (m.length !== 1) throw new Error(`esperava 1 script inline, achei ${m.length}`);
  return m[0][1];
}

/** Roda o script EXATO da página no Node (sem DOM) e devolve a API OTKVerificadorWeb. */
export function apiDaPagina(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const proibidos = {};
  const ctx = {
    TextEncoder, TextDecoder, Uint8Array, console,
    crypto: { getRandomValues: (a) => crypto.getRandomValues(a) },
  };
  // Qualquer tentativa de rede no Node estoura aqui.
  for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) Object.defineProperty(ctx, n, { get() { proibidos[n] = true; throw new Error(`rede proibida: ${n}`); } });
  ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(scriptDaPagina(html), ctx, { filename: 'verificador-otk.html#script' });
  if (!ctx.OTKVerificadorWeb) throw new Error('API OTKVerificadorWeb ausente');
  return { api: ctx.OTKVerificadorWeb, proibidos };
}

/** Lê arquivos como o navegador os entrega: pasta → "<pasta>/<rel>", arquivo solto → nome. */
export function lerComoNavegador(alvos) {
  const out = [];
  for (const a of alvos) {
    const st = fs.statSync(a);
    if (st.isDirectory()) {
      const base = path.basename(a);
      const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name); const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(p, r); else out.push({ path: `${base}/${r}`, bytes: new Uint8Array(fs.readFileSync(p)), abs: p });
        }
      };
      walk(a, '');
    } else out.push({ path: path.basename(a), bytes: new Uint8Array(fs.readFileSync(a)), abs: a });
  }
  return out;
}

export function relatorioTap() {
  let n = 0, ok = 0; const linhas = [];
  return {
    t(cond, nome, extra) { n++; if (cond) ok++; linhas.push(`${cond ? 'ok' : 'not ok'} ${n} - ${nome}${!cond && extra ? ` # ${extra}` : ''}`); console.log(linhas.at(-1)); },
    fim(arq) { const s = `TAP version 13\n${linhas.join('\n')}\n1..${n}\n# pass ${ok}\n# fail ${n - ok}\n`; if (arq) fs.writeFileSync(arq, s); console.log(`# ${ok}/${n}`); return { total: n, pass: ok, fail: n - ok }; },
  };
}

export async function abrirNavegador() {
  const { chromium } = req('playwright');
  for (const channel of ['msedge', 'chrome']) {
    try { return { browser: await chromium.launch({ channel, headless: true }), channel }; } catch { /* tenta o próximo */ }
  }
  throw new Error('nenhum navegador sem cabeça disponível (msedge/chrome)');
}

/**
 * Abre a página como file:// com a rede cortada, carrega recibos e chaveiro pelos <input>, clica
 * em Conferir e devolve o que a tela mostra, o JSON baixado e toda requisição que não seja a página.
 */
export async function rodarNaPagina(browser, htmlPath, { recibos, pasta, chaveiro, impressao = '', viewport, tema }) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: viewport ?? { width: 1280, height: 900 }, colorScheme: tema ?? 'light' });
  await context.setOffline(true);
  const requisicoes = [];
  const url = 'file:///' + path.resolve(htmlPath).replace(/\\/g, '/');
  await context.route('**/*', (r) => { const u = r.request().url(); if (u === url) return r.continue(); requisicoes.push(u); return r.abort(); });
  const page = await context.newPage();
  page.on('request', (r) => { if (r.url() !== url && !requisicoes.includes(r.url())) requisicoes.push(r.url()); });
  const erros = []; page.on('pageerror', (e) => erros.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  await page.goto(url);
  const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null);
  // recibos: lista de arquivos soltos (setInputFiles não reproduz webkitRelativePath de pasta)
  if (pasta) await page.setInputFiles('#in-pasta', pasta); else await page.setInputFiles('#in-arquivos', recibos);
  if (chaveiro) await page.setInputFiles('#in-chaveiro', chaveiro);
  await page.fill('#in-impressao', impressao);
  await page.click('#bt-conferir');
  await page.waitForFunction(() => !document.getElementById('resultado').hidden || document.getElementById('st-conferir').textContent.startsWith('Não foi'), null, { timeout: 15000 });
  const tela = await page.evaluate(() => ({
    erro: document.getElementById('st-conferir').textContent,
    cartoes: [...document.querySelectorAll('.cartao')].map((c) => c.textContent),
    banner: document.getElementById('banner-ancora').hidden ? null : document.getElementById('banner-ancora').textContent,
    sha: document.getElementById('sha-relatorio').textContent,
    linhas: [...document.querySelectorAll('#tabela-corpo tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
    largura: document.documentElement.scrollWidth, janela: window.innerWidth,
  }));
  let json = null;
  if (!tela.erro) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bt-json')]);
    json = fs.readFileSync(await dl.path(), 'utf8');
  }
  return { page, context, tela, json, csp, requisicoes, erros, url };
}
