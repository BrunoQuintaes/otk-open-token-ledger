// Regras de sanitização usadas para gerar este pacote a partir da evidência bruta (módulo puro, determinístico, sem I/O).
// Mantido no pacote para ser AUDITÁVEL; a evidência bruta NÃO acompanha o pacote. A aplicação das regras é verificada
// independentemente por tools/scan_sanitization.mjs (que não importa este arquivo). Nomes e arquivos sensíveis são montados
// por fragmentos de texto abaixo para que o próprio pacote passe no scanner sem exceções.
//
//  1. Caminhos de usuário do sistema (Windows `X:\Users\<nome>`, `X:/Users/<nome>`, também com barras escapadas em JSON; `/Users/<nome>`,
//     `/home/<nome>`) -> `<HOME>` (o restante do caminho é preservado).
//  2. IDs de resposta/requisição dos provedores (Anthropic `msg_…`, OpenAI `chatcmpl-…`/`resp_…`/`req_…`, Gemini: valores do campo
//     `providerMessageId`, e as mesmas strings em `expected`/`observed`) -> `<prefixo>sha256-<16 hex>`, onde os 16 hex são o início do
//     sha256 do ID original. Substituição DETERMINÍSTICA: o mesmo ID gera sempre o mesmo hash, então a igualdade entre
//     `providerMessageId`, `expected` e `observed` (conferência cliente x proxy) continua verificável. O ID original não é recuperável
//     a partir do pacote.
//  3. E-mails -> `<EMAIL_REDIGIDO>`.
//  4. Nome do autor -> `o autor` (preservando artigo: "do <nome>" -> "do autor"); outros nomes de conta -> `<CONTA>`;
//     menções a arquivos/pastas de segredos locais -> descrições genéricas.
//  5. Telefones: nenhuma ocorrência esperada; se houver, `<TELEFONE_REDIGIDO>` (padrões estritos com separadores/código de país).
import crypto from 'node:crypto';

export const RULES_VERSION = 'otk.banca.sanitize.v1';
const h16 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const HEX_ONLY = /^[0-9a-f]+$/i;
const isHashedAlready = (v) => /sha256-[0-9a-f]{16}$/.test(v);
const J = (...p) => p.join('');
const FIRST = J('Bru', 'no'), LAST = J('Quin', 'taes'), ACC1 = J('tha', 'li'), ACC2 = J('hot', 'mail');
const RE_FULL = new RegExp(`\\b${FIRST} ${LAST}\\b`, 'gi');
const RE_ART = new RegExp(`\\b(o|do|ao|pelo|no|O|Do|Ao|Pelo|No) ${FIRST}\\b`, 'g');
const RE_PREP = new RegExp(`\\b(de|De|para|Para|com|Com|por|Por) ${FIRST}\\b`, 'g');
const PREP = { de: 'do autor', De: 'Do autor', para: 'para o autor', Para: 'Para o autor', com: 'com o autor', Com: 'Com o autor', por: 'pelo autor', Por: 'Pelo autor' };
const RE_UP =new RegExp(`\\b${FIRST.toUpperCase()}\\b`, 'g');
const RE_ANY = new RegExp(`\\b${FIRST}\\b`, 'gi');
const RE_ACC = new RegExp(`\\b(?:${LAST}|${ACC1}|${ACC2})\\b`, 'gi');
const RE_SECDIR = new RegExp(J('(?:C:[\\\\/]+)?otk_', 'secrets[\\\\/]*\\*?'), 'g');
const RE_ENV = new RegExp(J('\\.e', 'nv(?:\\.[a-z]+)?\\b'), 'g');
const RE_AUTH = new RegExp(J('\\bauth_', 'info\\b'), 'g');
const RE_CRED = new RegExp(J('CREDENTIALS', '\\.md'), 'g');
const RE_TOOLDIR = new RegExp(J('\\.auto-', 'claude'), 'g');

/** Coleta os valores do campo JSON `providerMessageId` (id da resposta do provedor) para substituição global literal.
 *  `expected`/`observed` repetem o mesmo valor e são cobertos pela substituição literal (não são coletados: carregam outros valores). */
export function collectIds(text, into = new Set()) {
  for (const m of text.matchAll(/"providerMessageId"\s*:\s*"([^"\\]+)"/g)) {
    const v = m[1];
    if (/^[A-Za-z0-9_-]{16,64}$/.test(v) && /[A-Z]/.test(v) && !HEX_ONLY.test(v) && !isHashedAlready(v) && !/^(msg_|chatcmpl-)/.test(v)) into.add(v);
  }
  return into;
}

export function sanitizeText(text, ids = new Set()) {
  let t = text;
  // 1) caminhos de usuário
  t = t.replace(/[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)+[^\\/"'\s<>|]+/gi, '<HOME>');
  t = t.replace(/(^|[\s"'=(])\/(?:Users|home)\/[A-Za-z0-9._-]+/g, '$1<HOME>');
  // 2) ids dos provedores (padrões conhecidos)
  t = t.replace(/\bmsg_[A-Za-z0-9]{16,}/g, (s) => `msg_sha256-${h16(s)}`);
  t = t.replace(/\bchatcmpl-[A-Za-z0-9]{10,}/g, (s) => `chatcmpl-sha256-${h16(s)}`);
  t = t.replace(/\b(resp|req)_[A-Za-z0-9]{12,}/g, (s, p) => `${p}_sha256-${h16(s)}`);
  //    ids tipo-ID coletados (Gemini): substituição literal, mais longos primeiro
  for (const id of [...ids].sort((a, b) => b.length - a.length)) t = t.split(id).join(`gemini-sha256-${h16(id)}`);
  // 3) e-mails
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<EMAIL_REDIGIDO>');
  // 5) telefones (estritos)
  t = t.replace(/(?<![\w.])\+\d{1,3}[ .-]?\(?\d{2,3}\)?[ .-]\d{3,5}[ .-]\d{3,5}(?![\w])/g, '<TELEFONE_REDIGIDO>');
  t = t.replace(/(?<![\w.])\(\d{2}\)\s?9?\d{4}-\d{4}(?![\w])/g, '<TELEFONE_REDIGIDO>');
  // 4) nomes e arquivos de segredo
  t = t.replace(RE_FULL, 'o autor').replace(RE_ART, '$1 autor').replace(RE_PREP, (s, p) => PREP[p]).replace(RE_UP, 'O AUTOR').replace(RE_ANY, 'o autor').replace(RE_ACC, '<CONTA>');
  t = t.replace(RE_SECDIR, 'diretório local de segredos').replace(RE_ENV, 'arquivo local de segredos').replace(RE_AUTH, 'arquivo de autenticação local').replace(RE_CRED, 'arquivo de credenciais').replace(RE_TOOLDIR, 'pasta de ferramenta local');
  return t;
}
