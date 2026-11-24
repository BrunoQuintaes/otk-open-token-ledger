#!/usr/bin/env node
// Reprodução OFFLINE da H1 (baseline 7606bc9b, campanha OVERNIGHT 2) a partir dos insumos sanitizados do pacote. Só Node >= 24. Sem rede, sem credenciais.
//   node H1/scripts/reproduce_h1.mjs --out <pasta vazia ou inexistente>
// Passos: (1) inventário das 662 operações  (2) denominadores  (3) tabelas/métricas/comparação de calibração  (4) corpus e prompts (hash)  (5) dados do explorador.
// Cada arquivo regenerado é comparado, byte a byte (sha256), com o arquivo correspondente enviado no pacote. Exit 0 = tudo idêntico.
// Os gráficos (H1/results/figures) NÃO são regenerados aqui (exigem Python + matplotlib); vide H1/README.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const H1 = path.resolve(here, '..');
const PACK = path.resolve(H1, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', path.join(process.cwd(), 'reproducao_h1')));
const SUBSET = path.join(H1, 'inputs', 'h1_subset');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mk = (d) => fs.mkdirSync(d, { recursive: true });
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) { console.error(`--out já existe e não está vazio: ${OUT}`); process.exit(2); }
mk(OUT);
const steps = [];
const run = (name, script, args) => {
  // cwd = pasta de saída e caminhos de inventário/saída RELATIVOS: os scripts gravam o caminho recebido nas saídas (determinismo, sem caminho da máquina)
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, cwd: OUT });
  fs.writeFileSync(path.join(OUT, `${name}.log.txt`), (r.stdout ?? '') + (r.stderr ?? ''));
  steps.push({ name, exit: r.status }); console.log(`${r.status === 0 ? 'OK  ' : 'FALHA'} ${name} (exit ${r.status})`);
  return r.status === 0;
};

run('1_inventario', path.join(here, 'build_inventory.mjs'), ['--h1', SUBSET, '--out', 'inventory']);
run('2_denominadores', path.join(here, 'build_denominators.mjs'), ['--inventory', 'inventory/inventory_662.jsonl', '--out', 'denominators']);
run('3_resultados', path.join(here, 'recompute.mjs'), ['--h1', SUBSET, '--inventory', 'inventory/inventory_662.jsonl', '--out', 'results']);
run('4_corpus_prompts', path.join(here, 'verify_corpus_prompts.mjs'), ['--h1dir', H1, '--out', path.join(OUT, 'corpus_check.json')]);

// 5) explorador: monta a pasta de insumos com os nomes que o build.mjs espera e gera os dados
const ST = path.join(OUT, '_explorer_inputs'); const cp = (from, to) => { mk(path.dirname(to)); fs.copyFileSync(from, to); };
cp(path.join(OUT, 'inventory', 'inventory_662.jsonl'), path.join(ST, 'R02', 'inventory_662.jsonl'));
for (const f of ['special_prompts.json', 'planned_prompt_hash_check.csv', 'prompts.jsonl']) cp(path.join(H1, 'corpus', f), path.join(ST, 'R03', f));
cp(path.join(OUT, 'denominators', 'denominators.json'), path.join(ST, 'R04', 'denominators.json'));
cp(path.join(OUT, 'results', 'comparison.json'), path.join(ST, 'R05', 'comparison.json'));
for (const f of ['metrics_long.json', 'pairs_633.csv']) cp(path.join(OUT, 'results', 'data', f), path.join(ST, 'R05', 'data', f));
for (const f of fs.readdirSync(path.join(H1, 'results', 'figures')).filter((x) => x.endsWith('.png'))) cp(path.join(H1, 'results', 'figures', f), path.join(ST, 'R05', 'figures', f));
cp(path.join(PACK, 'CAL-ANTH', 'expected', 'RECOMPUTE_RESULTS.json'), path.join(ST, 'CAL_ANTH_VERIFY', 'RECOMPUTE_RESULTS.json'));
cp(path.join(PACK, 'CAL-ANTH', 'CAL_ANTH_VERIFICATION_REPORT.md'), path.join(ST, 'CAL_ANTH_VERIFY', 'CAL_ANTH_VERIFICATION_REPORT.md'));
run('5_explorador_dados', path.join(H1, 'explorer', 'build.mjs'), ['--source', SUBSET, '--inputs', ST, '--out', path.join(OUT, 'explorer_data'), '--fig-out', path.join(OUT, 'explorer_fig')]);

// comparação byte a byte com o que o pacote contém
const pairs = [
  [path.join(OUT, 'inventory'), path.join(H1, 'inventory')],
  [path.join(OUT, 'denominators'), path.join(H1, 'denominators')],
  [path.join(OUT, 'results'), path.join(H1, 'results')],
  [path.join(OUT, 'explorer_data'), path.join(H1, 'explorer', 'web', 'data')],
];
const cmp = [];
for (const [gen, shipped] of pairs) for (const f of walk(gen)) {
  const rel = path.relative(gen, f).split(path.sep).join('/'); const other = path.join(shipped, rel);
  const a = sha(fs.readFileSync(f)); const b = fs.existsSync(other) ? sha(fs.readFileSync(other)) : null;
  cmp.push({ file: `${path.basename(shipped) === 'data' ? 'explorer/web/data' : path.relative(H1, shipped).split(path.sep).join('/')}/${rel}`, regenerated: a, shipped: b, equal: a === b });
}
const corpus = JSON.parse(fs.readFileSync(path.join(OUT, 'corpus_check.json'), 'utf8'));
const allSteps = steps.every((s) => s.exit === 0); const allEq = cmp.length > 0 && cmp.every((c) => c.equal);
const report = { schema: 'otk.banca.h1.reproduction.v1', node: process.version, steps, filesCompared: cmp.length, filesEqual: cmp.filter((c) => c.equal).length, notEqual: cmp.filter((c) => !c.equal), corpusChecks: corpus.checks.map((c) => ({ name: c.name, ok: c.ok })), corpusSha256: corpus.corpusSha256, ok: allSteps && allEq && corpus.ok };
fs.writeFileSync(path.join(OUT, 'REPRODUCAO_H1.json'), JSON.stringify(report, null, 1) + '\n');
console.log(`arquivos regenerados e comparados: ${report.filesEqual}/${report.filesCompared} idênticos; corpus sha256 ${corpus.corpusSha256}`);
console.log(report.ok ? 'REPRODUCAO H1: OK (idêntica ao pacote)' : 'REPRODUCAO H1: DIVERGENCIA (veja REPRODUCAO_H1.json)');
process.exit(report.ok ? 0 : 1);
