// F4 (C160 DEFESA_CIRCUITO): a página REAL no navegador sem cabeça, rede cortada, com
//  - o anel público do bot (B5F, otk.bridge.keyring_file.v1) como chaveiro: lido por conversão,
//    ancorado pelo sha do próprio arquivo, sem banner vermelho de "foi mexido";
//  - um arquivo de formato desconhecido como chaveiro: banner amarelo "Formato de chaveiro não reconhecido";
//  - detalhe de item que não é recibo sem o título "Recibo …#";
//  - sem recibo somado: "CU desconhecida" nas somas, nunca "CU 0";
//  - filtro de período digitado em dd/mm/aaaa, independente do idioma do navegador.
// Uso: node test/navegador_f4.mjs
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ, REPO, arg, abrirNavegador, rodarNaPagina, relatorioTap, lerEsperado, VETORES_NUCLEO } from './lib.mjs';

const VET = path.resolve(arg('--vetores', VETORES_NUCLEO));
const HTML = path.resolve(arg('--html', path.join(RAIZ, 'dist/verificador-otk.html')));
const OUT = path.join(RAIZ, 'test/saida_navegador_f4');
fs.mkdirSync(OUT, { recursive: true });
const esp = lerEsperado(VET);
const ANEL = path.join(REPO, 'test', 'verifier', 'f4', 'otk_keyring_b5f.json');
const ANEL_SHA = '2a65cd7f82c66b061ee54a8b74e4981cac4b9af2027a55b82e1fd3bac6e9dcaf';
const DESCONHECIDO = path.join(OUT, 'chaveiro_formato_desconhecido.json');
fs.writeFileSync(DESCONHECIDO, JSON.stringify({ schema: 'outro.formato.v9', keys: [] }) + '\n');
const SO_LIXO = path.join(OUT, 'nao_e_recibo.json');
fs.writeFileSync(SO_LIXO, JSON.stringify({ ola: 'isto não é recibo' }) + '\n');

const T = relatorioTap();
const { browser, channel } = await abrirNavegador();
console.log('# navegador', channel);
const base = { pasta: path.join(VET, 'recibos') };

// 1) anel do bot, ancorado pelo sha do próprio arquivo
{
  const r = await rodarNaPagina(browser, HTML, { ...base, chaveiro: ANEL, impressao: ANEL_SHA });
  T.t(!r.tela.erro, 'anel do bot: conferiu sem erro', r.tela.erro);
  const rep = JSON.parse(r.json);
  T.t(rep.keyring.anchor === 'anchored' && rep.keyring.convertedFrom === 'otk.bridge.keyring_file.v1', 'anel do bot: ancorado e marcado como convertido', JSON.stringify(rep.keyring).slice(0, 200));
  T.t(r.tela.banner === null, 'anel do bot ancorado: sem banner de chaveiro', r.tela.banner);
  const conv = await r.page.evaluate(() => { const e = document.getElementById('st-convertido'); return e.hidden ? null : e.textContent; });
  T.t(conv !== null && /anel público do bot/.test(conv) && /sem perder nenhuma chave/.test(conv), 'anel do bot: aviso de conversão sem perda visível', conv);
  const tudo = await r.page.evaluate(() => document.body.innerText);
  T.t(!/foi mexido|mexido ou não é um chaveiro|schema deve ser/i.test(tudo), 'anel do bot: nenhum "foi mexido" nem "schema deve ser" na tela');
  T.t(r.requisicoes.length === 0 && r.erros.length === 0, 'anel do bot: sem rede e sem erro de script', [...r.requisicoes, ...r.erros].join(' | ').slice(0, 200));
  // detalhe: item que não é recibo não leva "Recibo …"
  const linhas = await r.page.$$('#tabela-corpo tr');
  const falhas = []; let vistos = 0; let recibosVistos = 0;
  for (let i = 0; i < rep.items.length; i++) {
    const it = rep.items[i];
    await linhas[i].$('button').then((b) => b.click());
    const t = await r.page.evaluate(() => document.getElementById('det-titulo').textContent);
    await r.page.keyboard.press('Escape');
    if (it.kind === 'receipt') { recibosVistos++; if (!t.includes('Recibo ' + it.id)) falhas.push(`recibo ${it.id}: ${t}`); continue; }
    vistos++;
    if (/Recibo/.test(t) && it.kind !== 'legacy_receipt') falhas.push(`${it.kind} ${it.id}: ${t}`);
    if (/#\d/.test(t)) falhas.push(`${it.kind} ${it.id}: "#" no título: ${t}`);
  }
  T.t(vistos > 0 && recibosVistos > 0 && falhas.length === 0, `detalhe: ${vistos} itens que não são recibo sem "Recibo #", ${recibosVistos} recibos com "Recibo <id>"`, falhas.slice(0, 3).join(' | '));
  // filtro em dd/mm/aaaa
  const tipo = await r.page.evaluate(() => [document.getElementById('f-de').type, document.getElementById('f-de').placeholder]);
  T.t(tipo[0] === 'text' && tipo[1] === 'dd/mm/aaaa', 'filtro: campo de texto dd/mm/aaaa (não usa o calendário do navegador)', tipo.join(','));
  const comData = rep.items.filter((it) => it.facts && it.facts.admittedAt);
  const dia = comData.map((it) => it.facts.admittedAt.slice(0, 10)).sort().pop();
  const br = `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;
  await r.page.fill('#f-de', br); await r.page.dispatchEvent('#f-de', 'change');
  const n = (await r.page.$$('#tabela-corpo tr')).length;
  const esperado = rep.items.filter((it) => it.facts && it.facts.admittedAt && it.facts.admittedAt.slice(0, 10) >= dia).length;
  T.t(n === esperado && n > 0, `filtro De ${br}: ${n} linha(s) = itens com data >= ${dia}`, `${n} vs ${esperado}`);
  const datas = await r.page.evaluate(() => [...document.querySelectorAll('#tabela-corpo tr td:first-child')].map((td) => td.textContent));
  T.t(datas.every((d) => d === '—' || /^\d{2}\/\d{2}\/\d{4}( \d{2}:\d{2} UTC)?$/.test(d)), 'coluna Data sempre dd/mm/aaaa', datas.slice(0, 3).join(','));
  await r.page.screenshot({ path: path.join(OUT, 'tela_anel_do_bot.png'), fullPage: true });
  await r.context.close();
}
// 2) formato desconhecido
{
  const r = await rodarNaPagina(browser, HTML, { ...base, chaveiro: DESCONHECIDO, impressao: '' });
  T.t(!r.tela.erro, 'formato desconhecido: a página explica, não quebra', r.tela.erro);
  T.t(/Formato de chaveiro não reconhecido/.test(r.tela.banner ?? '') && !/mexido ou não/.test(r.tela.banner ?? ''), 'formato desconhecido: banner "Formato de chaveiro não reconhecido"', r.tela.banner);
  const cls = await r.page.evaluate(() => document.getElementById('banner-ancora').className);
  T.t(/amarelo/.test(cls), 'formato desconhecido: banner amarelo (não é sinal de adulteração)', cls);
  const rep = JSON.parse(r.json);
  T.t(rep.items.some((it) => it.code === 'keyring_unknown_format' && it.verdict === 'amarelo'), 'formato desconhecido: item keyring_unknown_format amarelo no relatório');
  await r.context.close();
}
// 3) nada para somar: CU desconhecida
{
  const r = await rodarNaPagina(browser, HTML, { recibos: [SO_LIXO], chaveiro: path.join(VET, esp.keyring), impressao: esp.fingerprint });
  const somas = await r.page.evaluate(() => document.getElementById('st-somas').textContent);
  T.t(/CU desconhecida/.test(somas) && !/CU 0\b/.test(somas), 'sem recibo somado: "CU desconhecida", nunca "CU 0"', somas);
  const tudo = await r.page.evaluate(() => document.body.innerText);
  T.t(!/schema/i.test(tudo), 'nenhum "schema" na tela');
  await r.context.close();
}
await browser.close();
T.fim(path.join(RAIZ, 'test/navegador_f4.TAP.txt'));
