// Interface da página (VERIFICADOR_WEB, C160). Todo dado vindo de arquivo entra na tela por
// textContent, nunca como HTML: o recibo é dado externo e não pode virar código na página.
import { verificar, usandoSimulado } from './adaptador.js';
import { ROTULO, UI, LIMITES } from './textos.js';

// API mínima exposta (também usada pelo teste de paridade no Node, sem DOM).
globalThis.OTKVerificadorWeb = { verificar, usandoSimulado };

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
}

function $(id) { return document.getElementById(id); }
function el(tag, attrs = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const f of filhos) if (f != null) e.append(f);
  return e;
}

// null do relatório = desconhecido; nunca mostrado como 0. '—' só quando o campo não se aplica (item sem recibo).
const DESCONHECIDO = 'desconhecido';
const COR = { verde: 'Verde', amarelo: 'Amarelo', vermelho: 'Vermelho' };
const NOME_TOKEN = { input: 'entrada', output: 'saída', input_cache_read: 'cache lido', input_cache_write: 'cache gravado', output_reasoning: 'raciocínio', input_audio: 'áudio entrada', output_audio: 'áudio saída', tool_use_prompt: 'ferramentas' };

const estado = { recibos: [], chaveiro: null, resultado: null, itens: [], de: '', ate: '' };

function iniciar() {
  if (usandoSimulado) $('aviso-simulado').hidden = false;
  montarLimites();
  ligarTema();

  const inPasta = $('in-pasta'); const inArq = $('in-arquivos'); const inChave = $('in-chaveiro');
  $('bt-pasta').addEventListener('click', () => inPasta.click());
  $('bt-arquivos').addEventListener('click', () => inArq.click());
  $('bt-chaveiro').addEventListener('click', () => inChave.click());
  inPasta.addEventListener('change', async () => definirRecibos(await lerLista(inPasta.files)));
  inArq.addEventListener('change', async () => definirRecibos(await lerLista(inArq.files)));
  inChave.addEventListener('change', async () => { const l = await lerLista(inChave.files); definirChaveiro(l[0] ?? null); });

  soltar($('zona-recibos'), async (lista) => definirRecibos(lista));
  soltar($('zona-chaveiro'), async (lista) => definirChaveiro(lista[0] ?? null));

  for (const l of document.querySelectorAll('a.abre-antes')) l.addEventListener('click', () => { $('antes').open = true; });
  $('bt-conferir').addEventListener('click', conferir);
  $('bt-json').addEventListener('click', () => baixar('relatorio-verificacao-otk.json', estado.resultado.json, 'application/json'));
  $('bt-csv').addEventListener('click', () => baixar('relatorio-verificacao-otk.csv', estado.resultado.csv, 'text/csv;charset=utf-8'));
  $('bt-imprimir').addEventListener('click', () => window.print());
  // datas sempre dd/mm/aaaa, digitadas como texto: o campo de data do navegador segue o idioma do
  // sistema (no Edge em inglês aparecia mm/dd/yyyy), então a página não usa <input type=date>.
  $('f-de').addEventListener('change', (e) => { estado.de = lerDataBr(e.target.value); desenharTabela(); });
  $('f-ate').addEventListener('change', (e) => { estado.ate = lerDataBr(e.target.value); desenharTabela(); });
  $('bt-limpar').addEventListener('click', () => { estado.de = estado.ate = ''; $('f-de').value = $('f-ate').value = ''; desenharTabela(); });
  $('bt-fechar').addEventListener('click', () => $('detalhe').close());
  atualizarPassos();
}

function ligarTema() {
  const bt = $('bt-tema');
  const raiz = document.documentElement;
  const escuroSistema = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const atual = () => raiz.dataset.theme || (escuroSistema() ? 'dark' : 'light');
  const rotular = () => { const d = atual() === 'dark'; bt.textContent = d ? '☼ Tema claro' : '☽ Tema escuro'; bt.setAttribute('aria-pressed', String(d)); };
  bt.addEventListener('click', () => { raiz.dataset.theme = atual() === 'dark' ? 'light' : 'dark'; rotular(); });
  rotular();
}

function montarLimites() {
  const ul = $('limites-lista');
  for (const [t, d] of LIMITES) ul.append(el('li', {}, el('strong', { text: t }), ' ' + d));
}

// ---- leitura de arquivos ----
async function lerLista(fileList) {
  const out = [];
  for (const f of Array.from(fileList ?? [])) out.push({ path: f.webkitRelativePath || f.name, file: f });
  return Promise.all(out.map(async (x) => ({ path: x.path, bytes: new Uint8Array(await x.file.arrayBuffer()) })));
}

function soltar(zona, aoSoltar) {
  const liga = (on) => zona.classList.toggle('sobre', on);
  zona.addEventListener('dragover', (e) => { e.preventDefault(); liga(true); });
  zona.addEventListener('dragleave', () => liga(false));
  zona.addEventListener('drop', async (e) => {
    e.preventDefault(); liga(false);
    const itens = Array.from(e.dataTransfer.items ?? []);
    const entradas = itens.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    let lista;
    if (entradas.length) {
      const arquivos = [];
      for (const en of entradas) await percorrer(en, '', arquivos);
      lista = await Promise.all(arquivos.map(async (x) => ({ path: x.path, bytes: new Uint8Array(await x.file.arrayBuffer()) })));
    } else lista = await lerLista(e.dataTransfer.files);
    aoSoltar(lista);
  });
}

function percorrer(entrada, prefixo, acc) {
  return new Promise((ok) => {
    if (entrada.isFile) entrada.file((f) => { acc.push({ path: prefixo + entrada.name, file: f }); ok(); }, () => ok());
    else if (entrada.isDirectory) {
      const leitor = entrada.createReader(); const todos = [];
      const lote = () => leitor.readEntries(async (es) => {
        if (!es.length) { for (const s of todos) await percorrer(s, prefixo + entrada.name + '/', acc); ok(); }
        else { todos.push(...es); lote(); }
      }, () => ok());
      lote();
    } else ok();
  });
}

// Os caminhos vão ao núcleo como o navegador os dá ("recibos/a.jsonl" para pasta, "a.jsonl" para
// arquivo solto), que é o mesmo que o comando registra. O núcleo decide o que ignorar (extensão).
function definirRecibos(lista) {
  estado.recibos = lista;
  estado.resultado = null; atualizarPassos();
}
function definirChaveiro(x) { estado.chaveiro = x; estado.resultado = null; atualizarPassos(); }

function atualizarPassos() {
  const n = estado.recibos.length;
  $('st-recibos').textContent = n ? `${n} arquivo(s) carregado(s).` : UI.semRecibos;
  $('st-chaveiro').textContent = estado.chaveiro ? `Chaveiro carregado: ${estado.chaveiro.path}.` : UI.semChaveiro;
  $('zona-recibos').classList.toggle('feito', n > 0);
  $('zona-chaveiro').classList.toggle('feito', !!estado.chaveiro);
  $('bt-conferir').disabled = !(n > 0 && estado.chaveiro);
  $('resultado').hidden = !estado.resultado;
}

// ---- conferência ----
function conferir() {
  const msg = $('st-conferir');
  msg.textContent = UI.conferindo;
  setTimeout(() => {
    try {
      const r = verificar({ files: estado.recibos, keyring: estado.chaveiro, fingerprint: $('in-impressao').value });
      estado.resultado = r; estado.itens = r.itens;
      msg.textContent = '';
      desenharResultado();
      $('resultado').hidden = false;
      $('titulo-resultado').focus();
    } catch (e) {
      estado.resultado = null; $('resultado').hidden = true;
      msg.textContent = 'Não foi possível conferir: ' + (e && e.message ? e.message : String(e)) + '.';
    }
  }, 20);
}

function selo(verdict) {
  const r = ROTULO[verdict];
  return el('span', { class: `selo ${verdict}` }, el('span', { class: 'icone', 'aria-hidden': 'true', text: r.icone }), ' ' + r.palavra);
}

function desenharResultado() {
  const { report, sha256 } = estado.resultado;
  const cont = { verde: 0, amarelo: 0, vermelho: 0 };
  for (const it of estado.itens) cont[it.verdict]++;
  const cartoes = $('cartoes'); cartoes.replaceChildren();
  for (const v of ['verde', 'amarelo', 'vermelho']) {
    const r = ROTULO[v];
    cartoes.append(el('div', { class: `cartao ${v}` },
      el('div', { class: 'cartao-topo' }, el('span', { class: 'icone', 'aria-hidden': 'true', text: r.icone }), ' ' + r.palavra + ' · ' + COR[v]),
      el('div', { class: 'cartao-num', text: String(cont[v]) }),
      el('div', { class: 'cartao-legenda', text: v === 'verde' ? 'conferem' : v === 'amarelo' ? 'conferem com ressalva' : 'não conferem' })));
  }
  const banner = $('banner-ancora');
  const anc = report.keyring ? report.keyring.anchor : 'missing';
  banner.hidden = anc === 'anchored';
  banner.className = 'banner ' + (anc === 'not_anchored' || anc === 'unknown_format' ? 'amarelo' : 'vermelho');
  banner.textContent = {
    not_anchored: '⚠ Atenção: chaveiro não confirmado (não ancorado). Você não colou a impressão digital do chaveiro, então não há prova de que ele é o verdadeiro do operador. Por isso nenhum recibo fica com OK; o melhor resultado é Atenção.',
    mismatch: '✖ A impressão digital que você colou NÃO bate com o chaveiro carregado. Confira se colou o código certo e se o chaveiro é mesmo o do operador.',
    invalid: '✖ O arquivo de chaveiro não é válido: ' + (report.keyring?.error ?? '') + '. Confira se escolheu o arquivo certo.',
    unknown_format: '⚠ Formato de chaveiro não reconhecido: o arquivo escolhido não é o chaveiro público do OTK nem o anel público do bot. Isso não indica que alguém mexeu no arquivo; escolha o chaveiro que o operador entregou. Os recibos foram conferidos sem chaveiro.',
    missing: '✖ Nenhum chaveiro foi usado.',
  }[anc] ?? '';
  const conv = $('st-convertido');
  conv.hidden = !(report.keyring && report.keyring.convertedFrom);
  conv.textContent = conv.hidden ? '' : 'O chaveiro carregado é o anel público do bot. Ele foi lido por conversão, sem perder nenhuma chave; a impressão digital é a do próprio arquivo carregado.';
  const s = report.summary;
  // sem nenhum recibo somado, a CU é "desconhecida", nunca "0" (o relatório JSON fica como está)
  const cuSoma = s && s.counted ? (s.counted.counted === 0 ? 'desconhecida (nenhum recibo somado)' : (s.counted.cu.sum ?? 'desconhecida')) : '';
  $('st-somas').textContent = s && s.counted
    ? `Somados (só OK e Atenção): ${s.counted.counted} recibo(s); tokens ${s.counted.tokens.map((t) => `${NOME_TOKEN[t.name] ?? t.name} ${t.sum ?? DESCONHECIDO}${t.unknown ? ` (+${t.unknown} recibo(s) com valor ${DESCONHECIDO})` : ''}`).join(', ') || '—'}; CU ${cuSoma}${s.counted.cu.unknown ? ` (${s.counted.cu.unknown} recibo(s) com CU ${DESCONHECIDO})` : ''}. Os que falharam não entram nas somas. “${DESCONHECIDO}” nunca é zero: o número não foi informado ou não pôde ser calculado.`
    : '';
  $('sha-relatorio').textContent = sha256;
  desenharTabela();
}

/** "dd/mm/aaaa" (também d/m/aaaa, com - ou .) → "aaaa-mm-dd"; vazio → ''; inválida → null. */
function lerDataBr(txt) {
  const t = String(txt ?? '').trim();
  if (!t) return '';
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (!m) return null;
  const d = Number(m[1]); const mes = Number(m[2]); const a = Number(m[3]);
  const dt = new Date(Date.UTC(a, mes - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== d) return null;
  return `${m[3]}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function noPeriodo(it) {
  if (estado.de === null || estado.ate === null) return true;
  if (!estado.de && !estado.ate) return true;
  const d = typeof it.data === 'string' ? it.data.slice(0, 10) : '';
  if (!d) return false;
  return (!estado.de || d >= estado.de) && (!estado.ate || d <= estado.ate);
}

function fmtData(d, comSegundos = false) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(d)) return '—';
  const hora = comSegundos && d.length >= 19 ? d.slice(11, 19) : d.slice(11, 16);
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` + (d.length >= 16 ? ' ' + hora + ' UTC' : '');
}

function desenharTabela() {
  const corpo = $('tabela-corpo'); corpo.replaceChildren();
  const vis = estado.itens.filter(noPeriodo);
  const invalida = estado.de === null || estado.ate === null;
  $('st-filtro').textContent = invalida
    ? `Data inválida: escreva no formato dd/mm/aaaa (por exemplo 05/11/2026). Mostrando todos os ${estado.itens.length} item(ns).`
    : `Mostrando ${vis.length} de ${estado.itens.length} item(ns)` + (estado.de || estado.ate ? ' (itens sem data ficam fora do filtro).' : '.');
  vis.forEach((it) => {
    const tokens = it.tokens && it.tokens.length ? it.tokens.map((t) => `${NOME_TOKEN[t.name] ?? t.name} ${t.count ?? DESCONHECIDO}`).join(' · ') : '—';
    const bt = el('button', { type: 'button', class: 'link', text: UI.detalhe, 'aria-label': `${UI.detalhe}: ${nomeDoItem(it)}`, onclick: () => abrirDetalhe(it) });
    const tr = el('tr', { class: it.verdict },
      el('td', { 'data-rotulo': 'Data', text: fmtData(it.data) }),
      el('td', { 'data-rotulo': 'Provedor', text: it.provedor ?? '—' }),
      el('td', { 'data-rotulo': 'Modelo', text: it.modelo ?? '—' }),
      el('td', { 'data-rotulo': 'Tokens', text: tokens }),
      el('td', { 'data-rotulo': 'CU', text: it.cu ?? (it.temFatos ? DESCONHECIDO : '—') }),
      el('td', { 'data-rotulo': 'Veredito' }, selo(it.verdict)),
      el('td', { 'data-rotulo': 'Motivo', class: 'motivo' }, el('span', { text: it.reasonPt }), el('br'), bt));
    tr.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') abrirDetalhe(it); });
    corpo.append(tr);
  });
}

// Título do detalhe: só recibo leva "Recibo <cliente/operação>"; o resto diz o que é e de onde veio.
const NOME_TIPO = { receipt: 'Recibo', legacy_receipt: 'Recibo (formato antigo)', conference: 'Relatório de conferência', keyring: 'Chaveiro', file: 'Arquivo', record: 'Item do arquivo', bundle: 'Conjunto carregado' };
function ondeEsta(it) {
  if (!it.arquivo) return null;
  const m = /^(.*):(\d+)$/.exec(it.arquivo);
  return m ? `${m[1]}, linha ${m[2]}` : it.arquivo;
}
function nomeDoItem(it) {
  const tipo = NOME_TIPO[it.kind] ?? 'Item';
  const ehRecibo = it.kind === 'receipt' || it.kind === 'legacy_receipt' || it.kind === 'conference';
  const idProprio = it.id && !/#\d+$/.test(it.id);
  if (ehRecibo && idProprio) return `${tipo} ${it.id}`;
  const onde = ondeEsta(it);
  return onde ? `${tipo} (${onde})` : tipo;
}

function abrirDetalhe(it) {
  const d = $('detalhe');
  $('det-titulo').replaceChildren(selo(it.verdict), ' ' + nomeDoItem(it));
  $('det-aconteceu').textContent = it.reasonPt;
  $('det-significa').textContent = it.meaningPt;
  $('det-nao-garante').textContent = it.notGuaranteedPt;
  const av = $('det-avisos'); av.replaceChildren();
  for (const w of it.avisos) av.append(el('li', {}, selo(w.verdict), ' ' + w.textPt));
  $('det-avisos-bloco').hidden = it.avisos.length === 0;
  const tec = $('det-tecnico'); tec.replaceChildren();
  for (const [k, v] of [['Código', it.code], ['Tipo', it.kind], ['Arquivo e linha', it.arquivo], ['Detalhe técnico', it.detail], ['Chave (keyId)', it.keyId], ['Endereço que assinou', it.signer],
    ['Assinado em (declarado)', it.signedAt ? fmtData(it.signedAt, true) : null], ['Resumo recalculado', it.digestRecomputed], ['Resumo declarado', it.digestDeclared]]) {
    if (v == null) continue;
    tec.append(el('dt', { text: k }), el('dd', {}, el('code', { text: String(v) })));
  }
  if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
}

function baixar(nome, texto, tipo) {
  const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
  const a = el('a', { href: url, download: nome });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
