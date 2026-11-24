// Build da página única (VERIFICADOR_WEB, C160).
// Uso: node scripts/build.mjs [--simulado]
//   sem flag : núcleo real de <repo>/src/verifier (importado pelo caminho, sem cópia); grava dist/ e copia para web/verificador/verificador-otk.html
//   --simulado: núcleo simulado, só para testar a interface (a página mostra aviso vermelho)
// esbuild e ethers vêm de <repo>/node_modules (ou --node-modules <dir>). Roda de qualquer pasta.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(RAIZ, '..', '..');
// Sem variáveis de ambiente (regra N4): tudo por argumento.
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const NM = path.resolve(arg('--node-modules', path.join(REPO, 'node_modules')));
const NUCLEO_DIR = path.resolve(arg('--nucleo', path.join(REPO, 'src', 'verifier')));
const req = createRequire(path.join(NM, 'x.js'));
const esbuild = req('esbuild');

const simulado = process.argv.includes('--simulado');
const entradaNucleo = simulado ? path.join(RAIZ, 'src/mock/nucleoSimulado.js') : acharEntrada(NUCLEO_DIR);

function acharEntrada(dir) {
  const pedido = arg('--entrada', null);
  if (pedido) return path.resolve(dir, pedido);
  for (const n of ['browser.ts', 'index.ts', 'verifyBundle.ts']) { const p = path.join(dir, n); if (fs.existsSync(p)) return p; }
  throw new Error(`núcleo não encontrado em ${dir}`);
}

// A página não pode conter código de rede. O único módulo do ethers que usa fetch é o de
// requisição HTTP (geturl-browser), puxado por FetchRequest; nada do caminho de verificação o
// chama. Trocamos por um módulo que só lança erro, e o teste sem_rede.mjs confere o bundle.
const semRede = {
  name: 'sem-rede',
  setup(b) {
    b.onResolve({ filter: /geturl(-browser)?(\.js)?$/ }, (a) => (/ethers/.test(a.importer) ? { path: 'sem-rede', namespace: 'sem-rede' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'sem-rede' }, () => ({
      contents: 'export function createGetUrl(){return async function(){throw new Error("rede desligada nesta página")}}',
      loader: 'js',
    }));
  },
};

// O núcleo e o código do recibo importam o objeto inteiro `import { ethers } from 'ethers'`, o
// que impede o esbuild de descartar o resto do ethers (provedores, fetch, WebSocket, URLs de rede).
// Sem mexer no núcleo: 1ª passada descobre quais `ethers.X` o código usa; geramos um módulo
// `ethers` reduzido só com esses nomes (importados do ethers verdadeiro) e a 2ª passada usa ele.
const SHIM = path.join(RAIZ, 'dist', '_ethers_reduzido.mjs');
const base = {
  entryPoints: [path.join(RAIZ, 'src/app.js')],
  bundle: true, format: 'iife', platform: 'browser', target: ['es2020'],
  minify: true, legalComments: 'inline', charset: 'utf8', write: false,
  alias: { 'otk-nucleo': entradaNucleo },
  nodePaths: [NM], metafile: true, logLevel: 'warning', absWorkingDir: RAIZ,
};
const p1 = await esbuild.build({ ...base, plugins: [semRede], logLevel: 'silent' });
const usados = new Set();
for (const k of Object.keys(p1.metafile.inputs)) {
  if (k.includes('node_modules') || k.includes(':')) continue;
  const src = fs.readFileSync(path.resolve(RAIZ, k), 'utf8');
  if (!/from\s+['"]ethers['"]/.test(src)) continue;
  for (const m of src.matchAll(/\bethers\.([A-Za-z_$][\w$]*)/g)) usados.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]ethers['"]/g))
    for (const n of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter((x) => x && x !== 'ethers' && !x.startsWith('type '))) usados.add(n);
}
// Só nomes que existem em tempo de execução (descarta tipos como Signer e "ethers.js" de comentário).
const ethersReal = req('ethers');
const nomes = [...usados].filter((n) => n in ethersReal).sort();
fs.mkdirSync(path.dirname(SHIM), { recursive: true });
fs.writeFileSync(SHIM, `// GERADO por scripts/build.mjs: ethers reduzido aos nomes que o código usa.
import { ${nomes.join(', ')} } from 'ethers';
export { ${nomes.join(', ')} };
export const ethers = Object.freeze({ ${nomes.join(', ')} });
`);
const reduzido = {
  name: 'ethers-reduzido',
  setup(b) {
    b.onResolve({ filter: /^ethers$/ }, (a) => (path.resolve(a.importer) === path.resolve(SHIM) ? undefined : { path: SHIM }));
  },
};
const r = await esbuild.build({ ...base, plugins: [reduzido, semRede] });
let js = r.outputFiles[0].text;
// Nada no script pode fechar a tag <script> nem abrir comentário HTML.
js = js.split('</script').join('<\\/script').split('<!--').join('<\\!--');
const tpl = fs.readFileSync(path.join(RAIZ, 'src/pagina.html'), 'utf8');
const MARCA = '/*__BUNDLE__*/';
if (tpl.split(MARCA).length !== 2) throw new Error('marca do bundle ausente ou repetida');
const html = tpl.split(MARCA).join(js);

const saida = path.join(RAIZ, 'dist', simulado ? 'verificador-otk.SIMULADO.html' : 'verificador-otk.html');
fs.mkdirSync(path.dirname(saida), { recursive: true });
fs.writeFileSync(saida, html);
// a página commitada (web/verificador/verificador-otk.html, -text no .gitattributes) é cópia byte a byte do dist
if (!simulado) fs.writeFileSync(path.join(RAIZ, 'verificador-otk.html'), html);
const sha = crypto.createHash('sha256').update(html).digest('hex');
const entradas = Object.keys(r.metafile.inputs).filter((k) => !k.includes('node_modules')).sort();
let nucleoCommit = null, nucleoSujo = null;
if (!simulado) {
  const { execFileSync } = await import('node:child_process');
  const wt = path.resolve(NUCLEO_DIR, '../..');
  try {
    nucleoCommit = execFileSync('git', ['-C', wt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    nucleoSujo = execFileSync('git', ['-C', wt, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim() || null;
  } catch { /* sem git: fica null */ }
}
const nucleoArquivos = entradas.filter((k) => !k.startsWith('src/') && !k.includes(':')).map((k) => ({ path: path.resolve(RAIZ, k).replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(RAIZ, k))).digest('hex') }));
const info = { saida, sha256: sha, nucleoCommit, nucleoMudancasNaoCommitadas: nucleoSujo, nucleoArquivos, bytes: Buffer.byteLength(html), simulado, nucleo: entradaNucleo, nomesDoEthers: nomes, entradasForaDeNodeModules: entradas };
fs.writeFileSync(saida.replace(/\.html$/, '.build.json'), JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify({ saida, sha256: sha, bytes: info.bytes, simulado }));
