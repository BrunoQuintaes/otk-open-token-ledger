// Teste da página REAL num navegador sem cabeça (Edge/Chrome já instalados), aberta como file://
// com a rede cortada (setOffline + toda requisição abortada e registrada):
//  - a pasta de vetores entra pelo seletor de pasta (webkitdirectory), como o leigo faria;
//  - o JSON baixado pelo botão tem os mesmos bytes do JSON do comando (paridade no navegador);
//  - nenhuma requisição de rede; CSP presente e exata;
//  - casos vermelhos e amarelos: o detalhe mostra os três textos em português do núcleo, nunca
//    só o código; selo com ícone + palavra;
//  - 360 px sem rolagem horizontal, tema escuro, impressão (PDF) gerada.
// Uso: node test/navegador.mjs   (depois de node test/paridade.mjs, que grava os JSON do comando)
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ, arg, sha256, abrirNavegador, rodarNaPagina, relatorioTap, lerEsperado, VETORES_NUCLEO } from './lib.mjs';

const VET = path.resolve(arg('--vetores', VETORES_NUCLEO));
const HTML = path.resolve(arg('--html', path.join(RAIZ, 'dist/verificador-otk.html')));
const OUT = path.join(RAIZ, 'test/saida_navegador');
fs.mkdirSync(OUT, { recursive: true });
const esp = lerEsperado(VET);
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'";
const T = relatorioTap();
const { browser, channel } = await abrirNavegador();
console.log('# navegador', channel);
const base = { pasta: path.join(VET, 'recibos'), chaveiro: path.join(VET, esp.keyring) };

const cenarios = [['sem_impressao', ''], ['impressao_certa', esp.fingerprint]];
for (const [nome, fp] of cenarios) {
  const r = await rodarNaPagina(browser, HTML, { ...base, impressao: fp });
  T.t(r.csp === CSP, `${nome}: CSP exata no <meta>`, r.csp);
  T.t(!r.tela.erro, `${nome}: conferiu sem erro`, r.tela.erro);
  const cli = path.join(RAIZ, `test/saida_paridade/cli_${nome}.json`);
  const sCli = fs.existsSync(cli) ? sha256(fs.readFileSync(cli, 'utf8')) : null;
  fs.writeFileSync(path.join(OUT, `baixado_${nome}.json`), r.json ?? '');
  T.t(r.json !== null && sha256(r.json) === sCli, `${nome}: JSON baixado no navegador = JSON do comando (sha256)`, `${r.json && sha256(r.json)} vs ${sCli}`);
  T.t(r.tela.sha === sCli, `${nome}: código de conferência na tela = sha do comando`);
  T.t(r.requisicoes.length === 0, `${nome}: nenhuma requisição de rede`, r.requisicoes.join(', '));
  T.t(r.erros.length === 0, `${nome}: nenhum erro no console`, r.erros.join(' | ').slice(0, 300));
  const rep = JSON.parse(r.json);
  T.t(r.tela.linhas.length === rep.items.length, `${nome}: uma linha por item (${rep.items.length})`);
  T.t(nome !== 'sem_impressao' || (r.tela.banner ?? '').includes('não confirmado'), `${nome}: aviso de chaveiro não confirmado`);
  T.t(nome !== 'impressao_certa' || r.tela.banner === null, `${nome}: sem aviso de âncora quando a impressão confere`);
  T.t(r.tela.cartoes.length === 3 && r.tela.cartoes.every((c) => /OK|Atenção|Falhou/.test(c) && /[✔⚠✖]/.test(c)), `${nome}: 3 cartões com ícone + palavra`);

  {
    // null do relatório aparece como "desconhecido", nunca como 0 nem "null"
    const nulos = []; const zeros = [];
    rep.items.forEach((it, i) => {
      if (!it.facts) return;
      const tok = r.tela.linhas[i][3]; const cu = r.tela.linhas[i][4];
      for (const t of it.facts.tokens) if (t.count === null && !tok.includes('desconhecido')) nulos.push(`${it.id} ${t.name}: ${tok}`);
      if (it.facts.cu === null && cu !== 'desconhecido') zeros.push(`${it.id} cu: ${cu}`);
    });
    const somas = await r.page.evaluate(() => document.getElementById('st-somas').textContent);
    const s = rep.summary.counted;
    const nulosSoma = [...s.tokens.filter((t) => t.sum === null).map((t) => t.name), ...(s.cu.sum === null ? ['cu'] : [])];
    const tudo = r.tela.linhas.flat().join(' ') + ' ' + somas;
    T.t(nulos.length === 0 && zeros.length === 0, `${nome}: contagem e CU null na tabela aparecem como "desconhecido"`, [...nulos, ...zeros].slice(0, 3).join(' | '));
    T.t(!/null|undefined|NaN/.test(tudo), `${nome}: "null", "undefined" ou "NaN" nunca aparecem na tela`);
    T.t(nulosSoma.length === 0 || /desconhecido/.test(somas), `${nome}: somas null (${nulosSoma.join(', ') || 'nenhuma neste cenário'}) aparecem como "desconhecido"`, somas);
    T.t(rep.items.some((it) => it.facts && it.facts.tokens.some((t) => t.count === null)), `${nome}: vetores têm ao menos uma contagem null (o teste acima não é vazio)`);
  }
  if (nome === 'impressao_certa') {
    // casos vermelhos e amarelos: textos em português do núcleo, no detalhe
    const linhas = await r.page.$$('#tabela-corpo tr');
    const codigos = new Map(); let conferidos = 0; const falhas = [];
    for (let i = 0; i < rep.items.length; i++) {
      const it = rep.items[i];
      if (it.verdict === 'verde') continue;
      await linhas[i].$('button').then((b) => b.click());
      const d = await r.page.evaluate(() => ({ t: document.getElementById('det-titulo').textContent, a: document.getElementById('det-aconteceu').textContent, s: document.getElementById('det-significa').textContent, n: document.getElementById('det-nao-garante').textContent }));
      await r.page.keyboard.press('Escape');
      const pal = it.verdict === 'vermelho' ? 'Falhou' : 'Atenção';
      const ok = d.a === it.reasonPt && d.s === it.meaningPt && d.n === it.notGuaranteedPt
        && [d.a, d.s, d.n].every((x) => x.length >= 15 && x !== it.code && /[a-zà-ú]{3,} [a-zà-ú]{2,}/i.test(x))
        && d.t.includes(pal);
      if (ok) conferidos++; else falhas.push(`${it.id} ${it.code}: ${JSON.stringify(d).slice(0, 200)}`);
      codigos.set(`${it.verdict}/${it.code}`, (codigos.get(`${it.verdict}/${it.code}`) ?? 0) + 1);
    }
    T.t(falhas.length === 0, `detalhe de ${conferidos} itens vermelhos/amarelos mostra os 3 textos em português do núcleo`, falhas.slice(0, 3).join(' | '));
    const exigidos = ['vermelho/digest_mismatch', 'vermelho/bad_signature', 'vermelho/revoked_key', 'vermelho/wrong_domain', 'vermelho/binding_mismatch', 'amarelo/unauthorized_signer'];
    const faltam = exigidos.filter((c) => !codigos.has(c));
    T.t(faltam.length === 0, `cobertura: ${[...codigos.keys()].sort().join(', ')}`, `faltam ${faltam.join(', ')}`);
    fs.writeFileSync(path.join(OUT, 'codigos_conferidos.json'), JSON.stringify(Object.fromEntries([...codigos].sort()), null, 2) + '\n');
    // CSV
    const [dl] = await Promise.all([r.page.waitForEvent('download'), r.page.click('#bt-csv')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    T.t(csv.charCodeAt(0) === 0xfeff && csv.split('\r\n').length - 2 === rep.items.length, 'CSV baixado: BOM + cabeçalho + uma linha por item');
    // teclado: Tab chega ao botão Conferir e a um "Ver detalhe"
    const foco = await r.page.evaluate(() => { document.getElementById('bt-conferir').focus(); return document.activeElement.id; });
    T.t(foco === 'bt-conferir', 'botão Conferir recebe foco pelo teclado');
    // explicativo "Antes de começar"
    await r.page.click('a[href="#onde-recibos"]');
    T.t(await r.page.evaluate(() => document.getElementById('antes').open), 'link "Onde consigo esses arquivos?" abre o explicativo');
    // impressão
    await r.page.emulateMedia({ media: 'print' });
    await r.page.pdf({ path: path.join(OUT, 'impressao.pdf'), format: 'A4' });
    T.t(fs.statSync(path.join(OUT, 'impressao.pdf')).size > 10000, 'impressão gera PDF (CSS de impressão)');
    await r.page.emulateMedia({ media: 'screen' });
    await r.page.screenshot({ path: path.join(OUT, 'tela_desktop.png'), fullPage: true });
  }
  await r.context.close();
}
// impressão digital mal digitada: a página explica, não quebra
{
  const r = await rodarNaPagina(browser, HTML, { ...base, impressao: '123' });
  T.t(/Não foi possível conferir: .+/.test(r.tela.erro), 'impressão digital inválida: mensagem em português', r.tela.erro);
  T.t(r.requisicoes.length === 0 && r.erros.length === 0, 'impressão inválida: sem rede e sem erro de script');
  await r.context.close();
}
// celular 360 px, tema escuro
{
  const r = await rodarNaPagina(browser, HTML, { ...base, impressao: esp.fingerprint, viewport: { width: 360, height: 780 }, tema: 'dark' });
  T.t(r.tela.largura <= 360, '360 px: sem rolagem horizontal', String(r.tela.largura));
  const bg = await r.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  T.t(bg === 'rgb(20, 20, 20)', 'tema escuro aplicado pelo sistema', bg);
  await r.page.screenshot({ path: path.join(OUT, 'tela_360_escuro.png'), fullPage: true });
  await r.context.close();
}
await browser.close();
const res = T.fim(path.join(RAIZ, 'test/navegador.TAP.txt'));
process.exitCode = res.fail ? 1 : 0;
