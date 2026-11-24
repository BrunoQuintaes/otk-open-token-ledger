// Paridade comando × página (desenho §3(e) item 9): para os vetores do VERIFICADOR_MVP, o JSON do
// `otk verify --json` e o JSON da página têm os mesmos bytes (mesmo sha256).
// Página: o <script> EXATO de dist/verificador-otk.html rodado no Node (vm, sem DOM, sem rede).
// Comando: scripts/verify/otk.ts do worktree pelo tsx, como processo separado.
// Uso: node test/paridade.mjs [--vetores <pasta com esperado.json>]  (padrão: test/verifier/vetores do núcleo)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RAIZ, REPO, NM, arg, sha256, apiDaPagina, lerComoNavegador, relatorioTap, lerEsperado, VETORES_NUCLEO } from './lib.mjs';

const WT = REPO;
const VET = path.resolve(arg('--vetores', VETORES_NUCLEO));
const HTML = path.resolve(arg('--html', path.join(RAIZ, 'dist/verificador-otk.html')));
const OUT = path.join(RAIZ, 'test/saida_paridade');
fs.mkdirSync(OUT, { recursive: true });
const esp = lerEsperado(VET);
const recibos = path.join(VET, 'recibos');
const chaveiro = path.join(VET, esp.keyring);
const T = relatorioTap();
const { api, proibidos } = apiDaPagina(HTML);
T.t(!api.usandoSimulado, 'página construída com o núcleo real (não o simulado)');

const cenarios = [
  { nome: 'sem_impressao', fp: '', esperado: esp.shaSem },
  { nome: 'impressao_certa', fp: esp.fingerprint, esperado: esp.shaCom },
  { nome: 'impressao_certa_com_0x_maiusculas', fp: '0x' + esp.fingerprint.toUpperCase(), esperado: esp.shaCom },
  { nome: 'impressao_errada', fp: 'ab'.repeat(32) },
];
const resumo = [];
for (const c of cenarios) {
  const outCli = path.join(OUT, `cli_${c.nome}.json`);
  const a = ['verify', recibos, '--keyring', chaveiro, '--json', '--out', outCli];
  if (c.fp) a.push('--fingerprint', c.fp);
  const p = spawnSync(process.execPath, [path.join(NM, 'tsx/dist/cli.mjs'), path.join(WT, 'scripts/verify/otk.ts'), ...a], { cwd: WT, encoding: 'utf8' });
  const cliTxt = fs.existsSync(outCli) ? fs.readFileSync(outCli, 'utf8') : null;
  const files = lerComoNavegador([recibos]).map(({ path: p2, bytes }) => ({ path: p2, bytes }));
  const kr = { path: path.basename(chaveiro), bytes: new Uint8Array(fs.readFileSync(chaveiro)) };
  const pg = api.verificar({ files, keyring: kr, fingerprint: c.fp });
  fs.writeFileSync(path.join(OUT, `pagina_${c.nome}.json`), pg.json);
  const sCli = cliTxt === null ? null : sha256(cliTxt); const sPg = sha256(pg.json);
  T.t(cliTxt !== null, `${c.nome}: comando gravou o relatório (saída ${p.status})`, (p.stderr || '').slice(0, 300));
  T.t(sCli === sPg, `${c.nome}: sha256 igual comando × página`, `${sCli} vs ${sPg}`);
  if (c.esperado) T.t(sPg === c.esperado, `${c.nome}: sha256 = o publicado em esperado.json do núcleo (${c.esperado.slice(0, 8)}…)`, sPg);
  T.t(pg.sha256 === sPg, `${c.nome}: sha mostrado na tela = sha dos bytes baixados`);
  resumo.push({ cenario: c.nome, cliExit: p.status, sha256: sPg, igual: sCli === sPg, overall: pg.report.overall, itens: pg.report.items.length });
}
// Vereditos esperados do MVP também saem iguais pela página (cenário ancorado).
{
  const files = lerComoNavegador([recibos]).map(({ path: p2, bytes }) => ({ path: p2, bytes }));
  const pg = api.verificar({ files, keyring: { path: path.basename(chaveiro), bytes: new Uint8Array(fs.readFileSync(chaveiro)) }, fingerprint: esp.fingerprint });
  let ok = 0; const falhas = [];
  for (const e of esp.expect) {
    const it = pg.report.items.find((i) => i.id === e.id && (!e.kind || i.kind === e.kind));
    if (it && it.verdict === e.verdict && it.code === e.code) ok++; else falhas.push(`${e.id}: esperado ${e.verdict}/${e.code}, veio ${it ? `${it.verdict}/${it.code}` : 'ausente'}`);
  }
  T.t(falhas.length === 0, `página: ${ok}/${esp.expect.length} vereditos esperados do MVP`, falhas.slice(0, 5).join(' | '));
}
T.t(Object.keys(proibidos).length === 0, 'nenhuma API de rede tocada no Node', Object.keys(proibidos).join(','));
fs.writeFileSync(path.join(OUT, 'resumo_paridade.json'), JSON.stringify({ html: HTML, htmlSha256: sha256(fs.readFileSync(HTML)), vetores: VET, resumo }, null, 2) + '\n');
const r = T.fim(path.join(RAIZ, 'test/paridade.TAP.txt'));
process.exitCode = r.fail ? 1 : 0;
