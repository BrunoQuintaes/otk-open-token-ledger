// Tempo da página (script exato, Node vm) com ~1.000 itens: os vetores repetidos em 25 pastas.
import fs from 'node:fs'; import path from 'node:path';
import { RAIZ, apiDaPagina, lerComoNavegador, VETORES_NUCLEO } from './lib.mjs';
const VET = VETORES_NUCLEO;
const { api } = apiDaPagina(path.join(RAIZ, 'dist/verificador-otk.html'));
const base = lerComoNavegador([path.join(VET, 'recibos')]);
const files = []; for (let i = 0; i < 25; i++) for (const f of base) files.push({ path: f.path.replace('recibos/', `recibos/c${String(i).padStart(2, '0')}/`), bytes: f.bytes });
const kr = { path: 'chaveiro.json', bytes: new Uint8Array(fs.readFileSync(path.join(VET, 'chaveiro.json'))) };
const t0 = performance.now(); const r = api.verificar({ files, keyring: kr, fingerprint: '' }); const ms = performance.now() - t0;
const out = { arquivos: files.length, itens: r.report.items.length, ms: Math.round(ms) };
fs.writeFileSync(path.join(RAIZ, 'test/desempenho.json'), JSON.stringify(out) + '\n'); console.log(JSON.stringify(out));
