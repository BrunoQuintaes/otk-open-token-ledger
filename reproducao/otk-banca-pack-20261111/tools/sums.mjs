#!/usr/bin/env node
// SHA256SUMS do pacote (formato "<sha256>  <caminho relativo>", ordenado, UTF-8, LF). Sem dependências.
//   node tools/sums.mjs make   [--root <pasta do pacote>]   grava <root>/SHA256SUMS (exclui o próprio SHA256SUMS)
//   node tools/sums.mjs verify [--root <pasta do pacote>]   confere todos os arquivos; exit 1 se algo divergir, faltar ou sobrar
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const ri = process.argv.indexOf('--root');
const ROOT = path.resolve(ri >= 0 ? process.argv[ri + 1] : path.join(here, '..'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files = walk(ROOT).map(rel).filter((f) => f !== 'SHA256SUMS').sort();

if (mode === 'make') {
  fs.writeFileSync(path.join(ROOT, 'SHA256SUMS'), files.map((f) => `${sha(path.join(ROOT, f))}  ${f}`).join('\n') + '\n');
  console.log(`SHA256SUMS: ${files.length} arquivos`);
} else if (mode === 'verify') {
  const lines = fs.readFileSync(path.join(ROOT, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean).map((l) => { const m = l.match(/^([0-9a-f]{64}) {2}(.+)$/); return m ? [m[2], m[1]] : [l, null]; });
  const listed = new Map(lines); const bad = [], missing = [], extra = [];
  for (const [f, h] of listed) { const p = path.join(ROOT, f); if (!fs.existsSync(p)) missing.push(f); else if (sha(p) !== h) bad.push(f); }
  for (const f of files) if (!listed.has(f)) extra.push(f);
  const ok = !bad.length && !missing.length && !extra.length;
  console.log(JSON.stringify({ listed: listed.size, ok, divergentes: bad, ausentes: missing, nao_listados: extra }));
  process.exit(ok ? 0 : 1);
} else { console.error('uso: node tools/sums.mjs make|verify [--root <pasta>]'); process.exit(2); }
