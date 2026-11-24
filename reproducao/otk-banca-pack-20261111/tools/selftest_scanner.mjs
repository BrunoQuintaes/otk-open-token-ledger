#!/usr/bin/env node
// Controle negativo do scanner: planta, em uma pasta temporária, exemplos FALSOS de cada categoria bloqueante (montados por fragmentos,
// para que este arquivo não se auto-detecte) e exige que o scanner FALHE em cada um; depois exige que uma pasta limpa PASSE.
//   node tools/selftest_scanner.mjs [--out <arquivo.json>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCAN = path.join(here, 'scan_sanitization.mjs');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i >= 0 ? process.argv[i + 1] : null; })();
const J = (...p) => p.join('');
const samples = {
  caminho_usuario_windows: J('C:', '\\', 'Users', '\\', 'fulano', '\\docs\\x.txt'),
  caminho_usuario_unix: J('cd /Us', 'ers/fulano/projeto'),
  email: J('fulano', '@', 'exemplo.com'),
  telefone_internacional: J('+55 ', '11 ', '91234 ', '5678'),
  telefone_br: J('(11) ', '91234-', '5678'),
  chave_sk: J('sk', '-', 'A'.repeat(24)),
  chave_google: J('AI', 'za', 'B'.repeat(35)),
  token_github: J('gh', 'p_', 'C'.repeat(30)),
  token_slack: J('xo', 'xb-', '1234567890-abcdef'),
  chave_aws: J('AK', 'IA', 'D'.repeat(16)),
  bearer: J('Bear', 'er ', 'E'.repeat(30)),
  chave_privada_pem: J('-----BEGIN ', 'RSA PRIVATE KEY', '-----'),
  atribuicao_segredo: J('api_', 'key = "', 'F'.repeat(20), '"'),
  id_requisicao_anthropic: J('ms', 'g_', 'G'.repeat(24)),
  id_requisicao_openai: J('chat', 'cmpl-', 'H'.repeat(20)),
  x_request_id: J('x-request', '-id: ', 'abc123def456'),
  gemini_response_id_valor: J('"respon', 'seId": "', 'abcDEF123456', '"'),
  nome_pessoa_ou_conta: J('Bru', 'no'),
  arquivo_segredo: J('.e', 'nv'),
  workspace_ou_org_nomeado: J('work', 'space: "', 'minha-equipe', '"'),
};
const run = (dir) => spawnSync(process.execPath, [SCAN, '--root', dir, '--out', path.join(dir, '..', 'r.json')], { encoding: 'utf8' });
const results = []; let ok = true;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-neg-'));
for (const [cat, text] of Object.entries(samples)) {
  const d = path.join(tmp, cat); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'amostra.txt'), `linha anterior\n${text}\nlinha seguinte\n`);
  const r = run(d); let rep = null; try { rep = JSON.parse(fs.readFileSync(path.join(tmp, 'r.json'), 'utf8')); } catch { /* */ }
  const hit = !!rep && rep.findings.some((f) => f.category === cat); const failed = r.status === 1;
  results.push({ category: cat, scannerFailed: failed, categoryDetected: hit }); if (!(failed && hit)) ok = false;
}
const clean = path.join(tmp, 'limpo'); fs.mkdirSync(clean); fs.writeFileSync(path.join(clean, 'ok.txt'), 'texto neutro com números 12345 e hashes ' + 'a'.repeat(64) + '\n');
const rc = run(clean); const cleanPass = rc.status === 0; if (!cleanPass) ok = false;
fs.rmSync(tmp, { recursive: true, force: true });
const report = { schema: 'otk.banca.scanner-negative-control.v1', categoriesTested: results.length, allDetected: results.every((x) => x.scannerFailed && x.categoryDetected), cleanFolderPasses: cleanPass, ok, results };
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
for (const x of results) console.log(`${x.scannerFailed && x.categoryDetected ? 'OK  ' : 'FALHA'} detecta ${x.category}`);
console.log(`${cleanPass ? 'OK  ' : 'FALHA'} pasta limpa passa`);
console.log(ok ? 'CONTROLE NEGATIVO: OK' : 'CONTROLE NEGATIVO: FALHOU');
process.exit(ok ? 0 : 1);
