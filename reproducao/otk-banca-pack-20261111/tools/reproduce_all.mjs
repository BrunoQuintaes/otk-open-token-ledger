#!/usr/bin/env node
// Reprodução completa do pacote, OFFLINE, em um único comando (só Node >= 24; sem rede, sem credenciais, sem escrever dentro do pacote):
//   node tools/reproduce_all.mjs --out <pasta vazia ou inexistente>
// Etapas: (1) SHA256SUMS confere  (2) scanner de sanitização PASSA  (3) controle negativo do scanner  (4) reprodução H1  (5) reprodução CAL-ANTH.
// Exit 0 = todas passaram. Resultado em <out>/REPRODUCAO_PACOTE.json.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.resolve(here, '..');
const i = process.argv.indexOf('--out');
const OUT = path.resolve(i >= 0 ? process.argv[i + 1] : path.join(process.cwd(), 'reproducao_pacote'));
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) { console.error(`--out já existe e não está vazio: ${OUT}`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const steps = [];
const run = (name, args, logName) => {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  fs.writeFileSync(path.join(OUT, `${logName}.log.txt`), (r.stdout ?? '') + (r.stderr ?? ''));
  steps.push({ name, exit: r.status, ok: r.status === 0 }); console.log(`${r.status === 0 ? 'OK  ' : 'FALHA'} ${name} (exit ${r.status})`);
};
run('1. SHA256SUMS confere', [path.join(here, 'sums.mjs'), 'verify', '--root', PACK], 'sums');
run('2. scanner de sanitização (pacote inteiro)', [path.join(here, 'scan_sanitization.mjs'), '--root', PACK, '--out', path.join(OUT, 'scan_report.json')], 'scan');
run('3. controle negativo do scanner', [path.join(here, 'selftest_scanner.mjs'), '--out', path.join(OUT, 'scanner_negative_control.json')], 'selftest');
run('4. reprodução H1', [path.join(PACK, 'H1', 'scripts', 'reproduce_h1.mjs'), '--out', path.join(OUT, 'h1')], 'h1');
run('5. reprodução CAL-ANTH', [path.join(PACK, 'CAL-ANTH', 'scripts', 'reproduce_cal_anth.mjs'), '--out', path.join(OUT, 'cal_anth')], 'cal_anth');
const ok = steps.every((s) => s.ok);
fs.writeFileSync(path.join(OUT, 'REPRODUCAO_PACOTE.json'), JSON.stringify({ schema: 'otk.banca.pack.reproduction.v1', node: process.version, ok, steps }, null, 1) + '\n');
console.log(ok ? 'PACOTE: TUDO REPRODUZIU' : 'PACOTE: HÁ FALHAS (veja os .log.txt em --out)');
process.exit(ok ? 0 : 1);
