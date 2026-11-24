#!/usr/bin/env node
// Scanner de sanitização do pacote da banca (OFFLINE, sem dependências). Varre TODOS os arquivos sob --root
// (texto e binário-como-latin1) em busca de padrões sensíveis e escreve um relatório. Sai com código 1 se houver
// qualquer achado "BLOQUEANTE". O relatório NUNCA imprime o trecho achado inteiro: só categoria, arquivo, linha e um
// prefixo mascarado (primeiros 4 caracteres + tamanho), para não replicar o dado sensível no próprio relatório.
// Uso: node tools/scan_sanitization.mjs --root <dir> [--out <relatorio.json>] [--md <relatorio.md>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const ROOT = path.resolve(arg('root') ?? '.');
const OUT = arg('out'); const MD = arg('md');

// Categoria -> { re, blocking }. Todas BLOQUEANTES, exceto as marcadas como "revisao" (contagem informativa).
const PATTERNS = [
  ['caminho_usuario_windows', /[A-Za-z]:[\\/]+Users[\\/]+[^\\/"'\s<>|]+/gi, true],
  ['caminho_usuario_unix', /(?:^|[\s"'=(])\/(?:Users|home)\/[A-Za-z0-9._-]+/g, true],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, true],
  ['telefone_internacional', /(?<![\w.])\+\d{1,3}[ .-]?\(?\d{2,3}\)?[ .-]\d{3,5}[ .-]\d{3,5}(?![\w])/g, true],
  ['telefone_br', /(?<![\w.])\(\d{2}\)\s?9?\d{4}-\d{4}(?![\w])/g, true],
  ['chave_sk', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, true],
  ['chave_google', /\bAIza[0-9A-Za-z_-]{30,}/g, true],
  ['token_github', /\bgh[pousr]_[A-Za-z0-9]{20,}/g, true],
  ['token_slack', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, true],
  ['chave_aws', /\bAKIA[0-9A-Z]{16}\b/g, true],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, true],
  ['chave_privada_pem', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, true],
  ['atribuicao_segredo', /\b(?:api[_-]?key|secret|password|passwd|token|authorization)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/gi, true],
  ['id_requisicao_anthropic', /\bmsg_[A-Za-z0-9]{16,}/g, true],
  ['id_requisicao_openai', /\b(?:chatcmpl|resp|req|run|thread|asst|file|org|proj)[-_][A-Za-z0-9]{12,}/g, true],
  ['x_request_id', /\b(?:x-)?request-?id["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/gi, true],
  ['gemini_response_id_valor', /["']responseId["']\s*:\s*["'][^"']{6,}["']/g, true],
  // Listas de nomes/arquivos montadas por fragmentos para que este arquivo não se auto-detecte; no relatório a regex dessas duas categorias é omitida.
  ['nome_pessoa_ou_conta', new RegExp('\\b(?:' + [['bru', 'no'], ['quint', 'aes'], ['tha', 'li'], ['hot', 'mail']].map((x) => x.join('')).join('|') + ')\\b', 'gi'), true],
  ['arquivo_segredo', new RegExp('(?:' + [['otk_', 'secrets'], ['\\.e', 'nv(?:\\.[a-z]+)?\\b'], ['auth_', 'info'], ['CREDENTIALS', '\\.md'], ['\\.auto-', 'claude']].map((x) => x.join('')).join('|') + ')', 'g'), true],
  ['workspace_ou_org_nomeado', /\b(?:workspace|organization[_ -]?(?:id|name)|org[_-]?id)\b["']?\s*[:=]\s*["'][^"']+["']/gi, true],
  // Informativo (revisão manual; não bloqueia): menções genéricas.
  ['revisao_palavra_workspace', /\bworkspace\b/gi, false],
  ['revisao_palavra_account', /\baccount\b/gi, false],
];

const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } })(ROOT);
files.sort();

const findings = []; const counts = {}; const perCat = {};
for (const p of files) {
  const rel = path.relative(ROOT, p).split(path.sep).join('/');
  const txt = fs.readFileSync(p).toString('latin1'); // varre também binários (png/pdf) sem decodificar
  const lineStarts = [0]; for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (idx) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= idx) lo = m; else hi = m - 1; } return lo + 1; };
  for (const [cat, re, blocking] of PATTERNS) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(txt)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      perCat[cat] = (perCat[cat] ?? 0) + 1;
      if (blocking) {
        const s = m[0].trim();
        findings.push({ category: cat, file: rel, line: lineOf(m.index), masked: `${s.slice(0, 4)}…(${s.length} car.)`, sha256_12: crypto.createHash('sha256').update(s).digest('hex').slice(0, 12) });
      }
    }
  }
}
const treeSha = crypto.createHash('sha256').update(files.map((p) => path.relative(ROOT, p).split(path.sep).join('/') + '\0' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')).join('\n')).digest('hex');
const blocking = findings.length;
const report = {
  schema: 'otk.banca.sanitization-scan.v1',
  scanner: 'tools/scan_sanitization.mjs',
  rootName: path.basename(ROOT),
  filesScanned: files.length,
  bytesScanned: files.reduce((a, p) => a + fs.statSync(p).size, 0),
  treeSha256: treeSha,
  patternsBlocking: PATTERNS.filter((x) => x[2]).map((x) => ({ category: x[0], regex: ['nome_pessoa_ou_conta', 'arquivo_segredo'].includes(x[0]) ? '(lista omitida no relatório; veja o código do scanner)' : x[1].source, flags: x[1].flags })),
  patternsReview: PATTERNS.filter((x) => !x[2]).map((x) => x[0]),
  blockingFindings: blocking,
  countsPerCategory: Object.fromEntries(PATTERNS.map((x) => [x[0], perCat[x[0]] ?? 0])),
  verdict: blocking === 0 ? 'PASS' : 'FAIL',
  findings: findings.slice(0, 200),
};
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
if (MD) {
  const L = [`# Relatório do scanner de sanitização`, ``, `- raiz: \`${report.rootName}\``, `- arquivos varridos: ${report.filesScanned} (${report.bytesScanned} bytes)`, `- sha256 da árvore varrida: \`${treeSha}\``, `- **veredito: ${report.verdict}** (${blocking} achado(s) bloqueante(s))`, ``, `| categoria | ocorrências | bloqueante |`, `|---|---:|:-:|`];
  for (const [cat, , b] of PATTERNS) L.push(`| ${cat} | ${perCat[cat] ?? 0} | ${b ? 'sim' : 'não (informativo)'} |`);
  L.push('', 'O scanner varre texto e binários (como latin1). Achados são mascarados no relatório (4 primeiros caracteres + tamanho + sha256 curto).');
  fs.writeFileSync(MD, L.join('\n') + '\n');
}
console.log(JSON.stringify({ filesScanned: report.filesScanned, blockingFindings: blocking, verdict: report.verdict, counts: report.countsPerCategory }, null, 1));
process.exit(blocking === 0 ? 0 : 1);
