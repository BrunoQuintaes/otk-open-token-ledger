#!/usr/bin/env node
// Reprodução OFFLINE da verificação independente da CAL-ANTH (C141): recalcula os números da CAL-ANTH-01 e as contagens da CAL-ANTH-02
// a partir dos arquivos brutos já sanitizados pela origem (inputs/cal01, inputs/cal02), SEM usar o analisador original, e compara com
// expected/RECOMPUTE_RESULTS.json. Também confere o item 20 (escopo do custo por modelo). Só Node >= 24; sem rede.
//   node CAL-ANTH/scripts/reproduce_cal_anth.mjs --out <pasta vazia ou inexistente>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CAL = path.resolve(here, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', path.join(process.cwd(), 'reproducao_cal_anth')));
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) { console.error(`--out já existe e não está vazio: ${OUT}`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const checks = []; const add = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}`); };

// 1) recálculo independente
const GEN = path.join(OUT, 'RECOMPUTE_RESULTS.json');
const r = spawnSync(process.execPath, [path.join(here, 'recompute_cal_anth.mjs'), `--cal01=${path.join(CAL, 'inputs', 'cal01')}`, `--cal02=${path.join(CAL, 'inputs', 'cal02')}`, `--out=${GEN}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
fs.writeFileSync(path.join(OUT, 'recompute.log.txt'), (r.stdout ?? '') + (r.stderr ?? ''));
add('recompute_cal_anth.mjs executou (exit 0)', r.status === 0, { exit: r.status });
const gen = JSON.parse(fs.readFileSync(GEN, 'utf8')); const exp = JSON.parse(fs.readFileSync(path.join(CAL, 'expected', 'RECOMPUTE_RESULTS.json'), 'utf8'));
const strip = (x) => JSON.stringify(x, (k, v) => (k === 'inputs' || k === 'generatedUtc' ? undefined : v));
add('resultados (CAL-ANTH-01 e -02) idênticos ao esperado (exceto data/caminhos de entrada)', strip(gen) === strip(exp), { sha256Gerado: sha(strip(gen)), sha256Esperado: sha(strip(exp)) });
const shas = (x) => Object.values(x.inputs).sort().join(',');
add('os mesmos 13 arquivos de entrada (sha256) foram lidos', Object.keys(gen.inputs).length === Object.keys(exp.inputs).length && shas(gen) === shas(exp), { arquivos: Object.keys(gen.inputs).length });

// 2) item 20: escopo do custo por modelo (Haiku 4.5)
const C1 = path.join(CAL, 'inputs', 'cal01', 'docs', '_ops', 'experiments', 'OTK_CAL_ANTH_01');
const rows = fs.readFileSync(path.join(C1, 'CALL_RESULTS_SANITIZED.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.modelRequested === 'claude-haiku-4-5-20251001');
const sumBy = (f) => rows.filter(f).reduce((a, x) => a + BigInt(x.costMicroUsd ?? 0), 0n);
const core = sumBy((x) => x.stage === 'core'), smoke = sumBy((x) => x.stage === 'smoke');
const nCore = rows.filter((x) => x.stage === 'core').length, nSmoke = rows.filter((x) => x.stage === 'smoke').length;
const json = JSON.parse(fs.readFileSync(path.join(C1, 'RESULTS_PER_MODEL.json'), 'utf8')).models['claude-haiku-4-5-20251001'].operations;
add('item 20: RESULTS_PER_MODEL.json (Haiku 4.5) = só estágio core (288 chamadas): 134.055', String(core) === json.costMicroUsd && nCore === json.attempts && String(core) === '134055', { core: String(core), nCore, json: json.costMicroUsd });
add('item 20: core + smoke (289 chamadas) = 134.247 (valor da tabela do relatório)', String(core + smoke) === '134247' && nSmoke === 1, { smoke: String(smoke), nSmoke, total: String(core + smoke), diferenca: String(smoke) });

const ok = checks.every((c) => c.ok);
fs.writeFileSync(path.join(OUT, 'REPRODUCAO_CAL_ANTH.json'), JSON.stringify({ schema: 'otk.banca.cal_anth.reproduction.v1', node: process.version, ok, checks }, null, 1) + '\n');
console.log(ok ? 'REPRODUCAO CAL-ANTH: OK' : 'REPRODUCAO CAL-ANTH: DIVERGENCIA');
process.exit(ok ? 0 : 1);
