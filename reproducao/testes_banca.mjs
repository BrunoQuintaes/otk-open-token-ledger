// Roda, SEM REDE, a bateria de testes automáticos do OTK (a mesma lista do `npm test` da versão avaliada, mais os testes do verificador).
//   npm run testes-banca
// Ficam de fora só os testes que leem arquivos internos que NÃO estão neste repositório público (pasta de coordenação
// docs/_ops, documentos de governança, CLAUDE.md, regras de dono de cada arquivo). Cada um está listado abaixo com o motivo.
// Na versão avaliada (H1 7606bc9b), com esses arquivos presentes, a bateria completa dava 3.563 testes: 3.560 passam e 3 "todo".
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process'; import { fileURLToPath, pathToFileURL } from 'node:url';
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(RAIZ, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!fs.existsSync(TSX)) { console.error('Falta instalar as dependências: rode primeiro  npm ci'); process.exit(3); }
const PASTAS = ['test/unit', 'test/pricing', 'test/sdk', 'test/security', 'test/integration', 'test/receipt', 'test/zk', 'test/verifier'];
const FORA_ARQUIVO = {
  'test/unit/calibration_support_returned.test.ts': 'lê perfis de calibração guardados em docs/_ops/OVERNIGHT2_20261006 (pasta interna fora do pacote)',
};
export const FORA_TESTE = [
  ['is valid, has no normalization chosen', 'lê as páginas de preço arquivadas em docs/_ops/OVERNIGHT2_20261006/evidence (fora do pacote)'],
  ['the pinned values are the ones recorded at the freeze', 'lê declarações da campanha em docs/_ops/FINAL_CLOSURE_20261007 (fora do pacote)'],
  ['NOT_CALIBRATED: the pilot profiles', 'lê perfis do piloto em docs/_ops/OVERNIGHT_20261005_MASTER (fora do pacote)'],
  ['restart: profiles reloaded from files', 'lê perfis do piloto em docs/_ops/OVERNIGHT_20261005_MASTER (fora do pacote)'],
  ['ownership: every tracked path resolves to a known owner', 'confere o dono de cada arquivo do repositório interno; as pastas novas deste pacote (reproducao, demo, chaveiro) não têm dono lá'],
  ['RC2 — Canonical governance files', 'procura CLAUDE.md e documentos de governança internos (fora do pacote)'],
  ['RC2 — Release artifacts', 'procura listas internas de lançamento em docs/ (fora do pacote)'],
  ['RC2 — ROADMAP completeness', 'procura o roteiro interno docs/ROADMAP_UNIFIED.md (fora do pacote)'],
  ['RC2 — Evidence trail', 'procura as pastas de evidência em docs/_ops (fora do pacote)'],
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const arquivos = PASTAS.flatMap((d) => fs.existsSync(path.join(RAIZ, d)) ? fs.readdirSync(path.join(RAIZ, d)).filter((f) => f.endsWith('.test.ts')).map((f) => `${d}/${f}`) : []).filter((f) => !FORA_ARQUIVO[f]).sort();
const guarda = pathToFileURL(path.join(RAIZ, 'reproducao', 'ferramentas', 'sem_rede.mjs')).href;
// Alguns testes rodam scripts bash. No Windows, o comando "bash" pode ser o do WSL (que não entende caminhos C:\...);
// por isso o bash do Git for Windows (que vem junto com o Git do passo 1) vai na frente do PATH dos testes.
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
let caminho = process.env[PATH_KEY] ?? '';
if (process.platform === 'win32') {
  const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  const raizGit = ex.status === 0 ? path.resolve(ex.stdout.trim(), '..', '..', '..') : null;
  const bin = raizGit && [path.join(raizGit, 'usr', 'bin'), path.join(raizGit, 'bin')].filter((d) => fs.existsSync(path.join(d, 'bash.exe')));
  if (bin && bin.length) caminho = [...bin, caminho].join(path.delimiter);
  else console.log('Aviso: não achei o bash do Git for Windows; os testes que rodam scripts bash podem falhar. Instale o Git for Windows (passo 1 do README).');
}
console.log(`Rodando ${arquivos.length} arquivos de teste, sem rede (leva de 2 a 5 minutos)...\n`);
// O teste de tempo do verificador ("1.000 recibos em menos de 5 s") roda SOZINHO depois da bateria: no meio dos outros
// ~3.500 testes em paralelo, o computador fica ocupado e ele estoura o tempo sem que haja defeito.
const TEMPO = 'desempenho: 1.000 recibos verificados em menos de 5 s';
const envT = { ...process.env, [PATH_KEY]: caminho, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${guarda}`.trim() };
const r1 = spawnSync(process.execPath, [TSX, '--test', `--test-skip-pattern=${[...FORA_TESTE.map(([n]) => n), TEMPO].map(esc).join('|')}`, ...arquivos],
  { cwd: RAIZ, env: envT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
console.log('Bateria principal terminada; agora o teste de tempo do verificador, sozinho...');
const r2 = spawnSync(process.execPath, [TSX, '--test', `--test-name-pattern=${esc(TEMPO)}`, 'test/verifier/verificador.test.ts'], { cwd: RAIZ, env: envT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const s1 = (r1.stdout ?? '') + (r1.stderr ?? ''); const s2 = (r2.stdout ?? '') + (r2.stderr ?? '');
const saida = `${s1}\n\n===== teste de tempo do verificador, rodado sozinho =====\n${s2}`;
const r = { status: r1.status === 0 && r2.status === 0 ? 0 : 1 };
fs.writeFileSync(path.join(RAIZ, 'testes-banca-saida.txt'), saida);
const num1 = (s, k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(s) ?? [])[1] ?? NaN);
const num = (k) => num1(s1, k) + (k === 'skipped' ? 0 : num1(s2, k)) - (k === 'tests' ? num1(s2, 'skipped') : 0);
const res = { testes: num('tests'), passaram: num('pass'), falharam: num('fail'), cancelados: num('cancelled'), pulados: num('skipped'), todo: num('todo') };
if (res.falharam || res.cancelados) console.log(saida.split('\n').filter((l) => /^✖ /.test(l) && !/failing tests:/.test(l)).slice(0, 40).join('\n'));
console.log(`\nResultado: ${res.testes} testes — ${res.passaram} passaram, ${res.falharam} falharam, ${res.cancelados} cancelados, ${res.pulados} pulados, ${res.todo} "todo".`);
console.log(`Deixados de fora de propósito (não entram na contagem acima): ${FORA_TESTE.length} grupos de testes e ${Object.keys(FORA_ARQUIVO).length} arquivo, porque leem arquivos internos que não estão neste repositório:`);
for (const [n, m] of FORA_TESTE) console.log(`  - "${n}…": ${m}`);
for (const [f, m] of Object.entries(FORA_ARQUIVO)) console.log(`  - ${f}: ${m}`);
console.log('Saída completa em testes-banca-saida.txt');
console.log(res.falharam === 0 && res.cancelados === 0 && r.status === 0 ? '\nTESTES OK' : '\nHOUVE FALHA (veja testes-banca-saida.txt)');
process.exit(res.falharam === 0 && res.cancelados === 0 && r.status === 0 ? 0 : 1);
