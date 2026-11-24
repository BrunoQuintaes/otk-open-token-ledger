// Prova estática de que a página não faz rede (desenho §3(e) item 10, carta §7.5) e contraste AA.
// Lê dist/verificador-otk.html e confere:
//  - CSP exata num <meta>, antes de qualquer <script>;
//  - um único <script> inline, nenhum src/href externo, nenhum <link>, <iframe>, <object>, <form>;
//  - nenhuma ocorrência de fetch, XMLHttpRequest, WebSocket, sendBeacon, EventSource, importScripts,
//    Worker, RTCPeerConnection, nem URL http(s)/ws(s) no código;
//  - contraste WCAG AA (>= 4,5:1) dos pares de cor de texto/fundo, temas claro e escuro.
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ, arg, relatorioTap, scriptDaPagina } from './lib.mjs';

const HTML = path.resolve(arg('--html', path.join(RAIZ, 'dist/verificador-otk.html')));
const html = fs.readFileSync(HTML, 'utf8');
const js = scriptDaPagina(html);
const T = relatorioTap();
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'";
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
T.t(meta && meta[1] === CSP, 'CSP exata no <meta>');
T.t(meta && html.indexOf(meta[0]) < html.indexOf('<script'), 'CSP vem antes do script');
T.t((html.match(/<script/g) ?? []).length === 1 && !/<script[^>]*\ssrc=/.test(html), 'um só <script>, inline');
T.t(!/<(link|iframe|object|embed|form|base)\b/i.test(html), 'sem <link>, <iframe>, <object>, <embed>, <form>, <base>');
T.t(!/\s(src|href|action)="(?!#)[^"]+"/.test(html.replace(js, '')), 'nenhum src/href/action externo no HTML (só âncoras #)');
for (const p of ['fetch', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'importScripts', 'RTCPeerConnection', 'new Worker', 'SharedWorker', 'serviceWorker', 'navigator.connection']) {
  const n = js.split(p).length - 1;
  T.t(n === 0, `bundle sem "${p}"`, `${n} ocorrência(s)`);
}
const urls = [...js.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)]*/g)].map((m) => m[0]);
T.t(urls.length === 0, 'bundle sem URL http(s)/ws(s)', urls.slice(0, 5).join(' '));

// contraste
const lum = (hex) => { const c = hex.match(/\w\w/g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const razao = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const tokens = (bloco) => Object.fromEntries([...bloco.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const claro = tokens(html.match(/:root \{([\s\S]*?)\}/)[1]);
const escuro = tokens(html.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\}/)[1]);
const pares = [['texto', 'fundo'], ['texto', 'superficie'], ['suave', 'superficie'], ['suave', 'fundo'], ['link', 'superficie'], ['link', 'fundo'],
  ['verde-texto', 'verde-fundo'], ['amarelo-texto', 'amarelo-fundo'], ['vermelho-texto', 'vermelho-fundo'], ['fundo', 'texto']];
for (const [nome, t] of [['claro', claro], ['escuro', escuro]]) {
  const ruins = pares.map(([a, b]) => [a, b, razao(t[a], t[b])]).filter((x) => x[2] < 4.5);
  T.t(ruins.length === 0, `contraste AA no tema ${nome} (${pares.length} pares, mínimo ${Math.min(...pares.map(([a, b]) => razao(t[a], t[b]))).toFixed(2)}:1)`, ruins.map((x) => `${x[0]}/${x[1]} ${x[2].toFixed(2)}`).join(', '));
}
const r = T.fim(path.join(RAIZ, 'test/sem_rede.TAP.txt'));
process.exitCode = r.fail ? 1 : 0;
