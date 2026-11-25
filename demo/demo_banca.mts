/**
 * "Use o OTK você mesmo": sobe o OTK da versão avaliada no seu computador, manda UMA chamada de IA pelo proxy do OTK,
 * mostra o que o OTK registrou (contagem própria, uso declarado, comparação, CU, custo), exporta o recibo assinado e
 * confere esse recibo com o verificador, usando o chaveiro da própria instalação.
 *
 *   npm run demo-banca                       MODO DEMONSTRAÇÃO: provedor sintético na sua máquina, SEM chave, SEM custo
 *   npm run demo-banca -- --real openai      MODO COM A SUA CHAVE (gpt-4o-mini; também anthropic = claude-haiku-4-5, gemini = gemini-3.5-flash-lite)
 *   opções: --manter (não desliga o PostgreSQL no fim)   --pasta <saída> (padrão demo-saida/<data-hora>)
 *           --so-conferir (confere a configuração — chave no .env, .env fora do git, Docker — e para antes de qualquer chamada)
 *
 * Precisa do Docker Desktop aberto (o OTK guarda as operações num PostgreSQL, que o Docker sobe numa caixa isolada).
 * O código do OTK que roda é o do repositório (src/api/server.ts, o mesmo ponto de entrada da campanha de 7/10).
 * Modo real: a chave é lida SÓ do arquivo .env na raiz do repositório (que o .gitignore impede de ir para o git); nunca é
 * impressa nem gravada; a chamada tem no máximo 16 tokens de saída. Este modo NÃO foi testado com chave real pelo autor do
 * pacote (nenhuma chamada paga foi feita para preparar este repositório).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ethers } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const tem = (n: string) => process.argv.includes(`--${n}`);
const REAL = arg('real') as 'openai' | 'anthropic' | 'gemini' | undefined;
const MANTER = tem('manter');
const agora = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
const OUT = path.resolve(arg('pasta') ?? path.join(ROOT, 'demo-saida', agora));
let PG_PORT = Number(process.env['OTK_DEMO_PG_PORT'] ?? 55432);
const PROJ = 'otk-banca-demo';
const say = (s = '') => console.log(s);
const passo = (n: number, s: string) => say(`\n[${n}] ${s}`);
const falha = (msg: string, dica: string): never => { say(`\nPAROU: ${msg}\nO que fazer: ${dica}`); process.exit(1); };

// perfis da versão avaliada (os mesmos de scripts/pilot/anthropic/runPilotV3.ts)
const PERFIS = {
  openai: { provider: 'openai', model: 'gpt-4o-mini', synthModel: 'gpt-4o-mini-2024-07-18', keyEnv: 'OPENAI_API_KEY', upstreamEnv: 'OTK_PROXY_UPSTREAM_OPENAI', fixtureKey: 'sk-proj-demo-banca-synthetic-fixture',
    route: '/v1/chat/completions', priceTable: 'scripts/pilot/price_table_pilot_v3_20261003.json', policy: 'otk.money_bound_policy.v3@2026-10-03', weights: 'development',
    headers: {} as Record<string, string>, synthHeaders: { 'x-test-openai-cached': '0' } as Record<string, string>, forward: 'x-test-script,x-test-tokens,x-test-model,x-test-openai-cached,x-test-openai-tier',
    precoAprox: 'menos de US$ 0,0001 (cerca de 30 tokens de entrada a US$ 0,15/milhão e até 16 de saída a US$ 0,60/milhão)' },
  anthropic: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', synthModel: 'claude-haiku-4-5-20251001', keyEnv: 'ANTHROPIC_API_KEY', upstreamEnv: 'OTK_PROXY_UPSTREAM_ANTHROPIC', fixtureKey: 'sk-ant-demo-banca-synthetic-fixture',
    route: '/v1/messages', priceTable: 'scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json', policy: 'otk.money_bound_policy.v2@2026-10-02', weights: 'development',
    headers: { 'anthropic-version': '2023-06-01' } as Record<string, string>, synthHeaders: { 'x-test-cache': '0,0' } as Record<string, string>, forward: 'x-test-script,x-test-tokens,x-test-model,x-test-cache',
    precoAprox: 'cerca de US$ 0,0001 (cerca de 20 tokens de entrada a US$ 1/milhão e até 16 de saída a US$ 5/milhão)' },
  gemini: { provider: 'gemini', model: 'gemini-3.5-flash-lite', synthModel: 'gemini-3.5-flash-lite', keyEnv: 'GEMINI_API_KEY', upstreamEnv: 'OTK_PROXY_UPSTREAM_GEMINI', fixtureKey: 'AIza-demo-banca-synthetic-fixture',
    route: '/v1beta/models/gemini-3.5-flash-lite:generateContent', priceTable: 'scripts/pilot/price_table_pilot_v3_gemini35_20261004.json', policy: 'otk.money_bound_policy.v5@2026-10-04', weights: 'development-2026-10-04',
    headers: {} as Record<string, string>, synthHeaders: { 'x-test-gemini-thoughts': '0' } as Record<string, string>, forward: 'x-test-script,x-test-tokens,x-test-model,x-test-gemini-cached,x-test-gemini-thoughts,x-test-gemini-tier',
    precoAprox: 'menos de US$ 0,0001 (cerca de 10 tokens de entrada a US$ 0,30/milhão e até 16 de saída a US$ 2,50/milhão)' },
};
const P = PERFIS[REAL ?? 'openai'];
if (REAL && !PERFIS[REAL]) falha(`provedor desconhecido: ${REAL}`, 'use --real openai, --real anthropic ou --real gemini');

const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const espera = async (oque: string, f: () => Promise<boolean>, ms: number) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 500)); } falha(`${oque} não respondeu em ${ms / 1000} s`, 'feche e abra o Docker Desktop, espere ele dizer que está rodando e rode o comando de novo'); };
const docker = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
// lê UMA variável do arquivo .env sem imprimir nada dele
const leEnv = (nome: string): string | null => { const f = path.join(ROOT, '.env'); if (!fs.existsSync(f)) return null;
  for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l); if (m && m[1] === nome) return m[2]!.replace(/^["']|["']$/g, '') || null; } return null; };

say(`OTK — ${REAL ? `MODO COM A SUA CHAVE (${P.model})` : 'MODO DEMONSTRAÇÃO (provedor sintético, sem chave, sem custo)'}`);
say(`Pasta com os resultados: ${path.relative(ROOT, OUT) || OUT}`);
fs.mkdirSync(OUT, { recursive: true });

// 0. chave (só no modo real)
let chaveReal: string | null = null;
if (REAL) {
  passo(0, `Procurando ${P.keyEnv} no arquivo .env (o valor não é mostrado)`);
  const ign = spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: ROOT });
  if (ign.status === 1) falha('o arquivo .env NÃO está protegido pelo .gitignore', 'não continue; confira se o .gitignore deste repositório tem a linha .env');
  chaveReal = leEnv(P.keyEnv);
  if (!chaveReal) falha(`não achei ${P.keyEnv}=... no arquivo .env da raiz do repositório`, `crie o arquivo .env com uma linha ${P.keyEnv}=<sua chave> (veja o README, parte "Modo com as suas chaves")`);
  say(`    achei ${P.keyEnv} (${chaveReal.length} caracteres). Custo aproximado desta chamada: ${P.precoAprox}.`);
}

// 1. PostgreSQL
passo(1, tem('so-conferir') ? 'Conferindo se o Docker responde' : 'Ligando o PostgreSQL de teste no Docker (pode levar 1 a 2 minutos na primeira vez, porque baixa a imagem)');
const dv = docker(['version', '--format', '{{.Server.Version}}']);
if (dv.status !== 0) falha('o Docker não está respondendo', 'abra o Docker Desktop, espere aparecer "Engine running" e rode o comando de novo');
if (tem('so-conferir')) {
  say(`    Docker respondendo (versão ${dv.stdout.trim()}).`);
  say(`\nCONFIGURAÇÃO OK${REAL ? `: a chave ${P.keyEnv} está no .env, o .env está fora do git e o Docker responde` : ': o Docker responde'}. Nenhuma chamada foi feita (--so-conferir).`);
  process.exit(0);
}
// No Windows, o sistema (Hyper-V/WSL) pode reservar faixas de portas, inclusive a 55432; nesse caso usa uma porta livre escolhida pelo próprio sistema.
if (!process.env['OTK_DEMO_PG_PORT']) { const livre = await new Promise<boolean>((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(PG_PORT, '127.0.0.1', () => s.close(() => r(true))); });
  if (!livre) { const antes = PG_PORT; PG_PORT = await freePort(); say(`    a porta ${antes} não está disponível neste computador; usando a porta ${PG_PORT}.`); } }
const up = docker(['compose', '-p', PROJ, '-f', 'infra/test/docker-compose.services.yml', 'up', '-d', '--wait', 'postgres'], { OTK_TEST_PG_PORT: String(PG_PORT) });
if (up.status !== 0) falha(`o Docker não conseguiu ligar o PostgreSQL:\n${(up.stderr || up.stdout).slice(-600)}`, `se a mensagem fala em porta ocupada, rode de novo com outra porta: no PowerShell, $env:OTK_DEMO_PG_PORT="15432"; npm run demo-banca (no Mac: OTK_DEMO_PG_PORT=15432 npm run demo-banca)`);
const ADMIN = `postgres://otk:otk-test-only@127.0.0.1:${PG_PORT}/otk`;
const dbName = `otk_demo_${agora.toLowerCase().replace(/[^a-z0-9]/g, '_')}`.slice(0, 63);
await espera('o PostgreSQL', async () => { const c = new pg.Client({ connectionString: ADMIN }); await c.connect(); await c.end(); return true; }, 120_000);
{ const c = new pg.Client({ connectionString: ADMIN }); await c.connect(); await c.query(`CREATE DATABASE "${dbName}"`); await c.end(); }
const u = new URL(ADMIN); u.pathname = `/${dbName}`; const DB = String(u);
say(`    PostgreSQL pronto (banco novo ${dbName}).`);

// 2. chave de assinatura DESTA instalação (descartável; fica só na memória) e provedor
passo(2, 'Criando a chave de assinatura desta instalação (descartável) e preparando o provedor');
const operador = ethers.Wallet.createRandom();
const KEY_ID = 'otk-v3-operador-demo-local';
let sint: { start(): Promise<void>; stop(): Promise<void>; url: string; calls: unknown[] } | null = null;
if (!REAL) {
  const { ControllableProvider } = await import('../test/services/d1d8_c_provider.ts');
  sint = new ControllableProvider() as unknown as typeof sint; await sint!.start();
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(sint!.url)) falha('o provedor sintético não está na própria máquina', 'relate o problema');
  say(`    provedor sintético na sua máquina (${sint!.url}); ele responde como ${P.synthModel} e declara 20 tokens de entrada e 5 de saída.`);
} else say(`    provedor real: ${P.provider} (${P.model}).`);

// 3. OTK (o mesmo ponto de entrada da versão avaliada)
passo(3, 'Ligando o OTK (src/api/server.ts) com o proxy de medição');
const [apiPort, proxyPort] = [await freePort(), await freePort()];
const token = crypto.randomBytes(24).toString('hex'); const adminToken = crypto.randomBytes(24).toString('hex'); const adminKey = crypto.randomBytes(16).toString('hex');
const TENANT = 'banca-demo';
const env: NodeJS.ProcessEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!/^OTK_|^PROVER_|_API_KEY$|_SECRET$|_TOKEN$/i.test(k)) env[k] = v;
Object.assign(env, {
  NODE_ENV: 'development', OTK_PROXY_ENABLED: '1', OTK_DB_URL: DB, OTK_TENANTS: `${TENANT}/OPERATOR:${token},${TENANT}/ADMIN:${adminToken}`,
  API_PORT: String(apiPort), OTK_PROXY_PORT: String(proxyPort), OTK_ADMIN_KEY: adminKey, PROVER_URL: 'disabled', OTK_RECEIPT_LOG: '',
  OTK_SPOOL_DIR: fs.mkdtempSync(path.join(OUT, 'spool-')), OTK_INSTANCE_ID: `demo-banca-${agora}`, OTK_CU_WEIGHTS_PROFILE: P.weights,
  OTK_PRICE_TABLE_FILES: P.priceTable, OTK_OPERATION_RECOVERY_MS: '1000', OTK_MONEY_BOUND_POLICY: P.policy,
  OTK_V3_OPERATOR_KEY: operador.privateKey, OTK_V3_OPERATOR_KEY_ID: KEY_ID,
});
if (sint) Object.assign(env, { OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE: '1', [P.upstreamEnv]: sint.url, [P.keyEnv]: P.fixtureKey, OTK_PROXY_FORWARD_HEADERS: P.forward });
else env[P.keyEnv] = chaveReal!;
const log: string[] = [];
const srv = spawn(process.execPath, ['--import', 'tsx', 'src/api/server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout?.on('data', (d) => log.push(String(d))); srv.stderr?.on('data', (d) => log.push(String(d)));
const limpa = (s: string) => [token, adminToken, adminKey, operador.privateKey.slice(2), chaveReal ?? '\u0000'].reduce((a, v) => a.split(v).join('[OCULTO]'), s);
let encerrado = false;
const encerra = async (codigo: number) => {
  if (encerrado) return; encerrado = true;
  fs.writeFileSync(path.join(OUT, 'log_do_otk.txt'), limpa(log.join('')));
  srv.kill('SIGKILL'); await sint?.stop();
  if (!MANTER) { docker(['compose', '-p', PROJ, '-f', 'infra/test/docker-compose.services.yml', 'down', '-v'], { OTK_TEST_PG_PORT: String(PG_PORT) }); say('\nPostgreSQL de teste desligado e apagado (use --manter para deixar ligado).'); }
  process.exit(codigo);
};
const PROXY = `http://127.0.0.1:${proxyPort}`;
await espera('o OTK', async () => (await fetch(`${PROXY}/health`)).ok, 120_000);
const c = new pg.Pool({ connectionString: DB, max: 2 });
await c.query('INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, money_policy) VALUES ($1, $2, $3::numeric, $4)', [`demo-${agora}`.slice(0, 120), TENANT, (REAL ? 1_000_000n : 1_000_000_000_000n) * 1_000_000n + '', P.policy]);
say(`    OTK no ar (proxy em ${PROXY}); orçamento do cliente de demonstração ${REAL ? 'US$ 1' : 'fictício'}.`);

// 4. uma chamada pelo proxy
passo(4, 'Mandando uma chamada de IA pelo proxy do OTK');
const opId = `demo-${agora}`.toLowerCase().slice(0, 100);
const pergunta = 'Responda apenas com a palavra ok.';
const corpo = P.provider === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: pergunta }] }], generationConfig: { maxOutputTokens: 16, thinkingConfig: { thinkingLevel: 'minimal' } } }
  : { model: P.model, max_tokens: 16, messages: [{ role: 'user', content: pergunta }] };
const hdr: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-otk-provider': P.provider, 'x-otk-operation-id': opId, ...P.headers,
  ...(sint ? { 'x-test-script': 'ok', 'x-test-tokens': '20,5', 'x-test-model': P.synthModel, ...P.synthHeaders } : {}) };
const r = await fetch(`${PROXY}${P.route}`, { method: 'POST', headers: hdr, body: JSON.stringify(corpo) });
const resp = await r.json().catch(() => null) as Record<string, unknown> | null;
if (r.status !== 200) { say(`    o provedor/OTK respondeu HTTP ${r.status}: ${limpa(JSON.stringify(resp)).slice(0, 300)}`); await encerra(1); }
say(`    resposta HTTP 200 (operação ${opId}).`);

// 5. o que o OTK registrou
passo(5, 'O que o OTK registrou sobre essa chamada');
let conf: Record<string, any> | null = null;
for (let i = 0; i < 60; i++) {
  const g = await fetch(`${PROXY}/v1/operations/${encodeURIComponent(opId)}/conference`, { headers: { authorization: `Bearer ${token}` } });
  const j = await g.json().catch(() => null) as Record<string, any> | null;
  if (g.ok && j?.receipt && j?.conference?.payload) { conf = j; break; }
  await new Promise((res) => setTimeout(res, 500));
}
if (!conf) { say('    o recibo não ficou pronto em 30 s'); await encerra(1); }
const rec = conf!.receipt.payload; const rep = conf!.conference.payload;
const recibo = path.join(OUT, 'recibos', `recibo_${opId}.json`);
fs.mkdirSync(path.dirname(recibo), { recursive: true });
fs.writeFileSync(recibo, JSON.stringify(conf, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'operacao.json'), JSON.stringify(await (await fetch(`${PROXY}/v1/operations/${encodeURIComponent(opId)}`, { headers: { authorization: `Bearer ${token}` } })).json(), null, 2) + '\n');
const mostra = (rotulo: string, v: unknown) => say(`    ${rotulo.padEnd(38)} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
const us = rec.usage ?? {}; const frac = (a: { units: string; scale: string }) => Number(a.units) / Number(a.scale);
const custoUsd = (rec.price?.lines ?? []).reduce((s: number, l: { amount: { units: string; scale: string } }) => s + frac(l.amount), 0);
mostra('modelo pedido / devolvido:', `${us.modelRequested ?? '?'} / ${us.modelReturned ?? '?'}`);
mostra('uso declarado pelo provedor:', `entrada ${us.tIn ?? '?'} tokens, saída ${us.tOut ?? '?'} tokens`);
mostra('contagem própria do OTK:', (rep.comparisons ?? []).map((x: { category: string; local: string }) => `${x.category === 'input' ? 'entrada' : x.category === 'output' ? 'saída' : x.category} ${x.local}`).join(', ') || '(não contou)');
mostra('régua usada na contagem:', `${rep.tokenizer?.encoding ?? '?'} (${rep.support === 'exact' ? 'exata' : rep.support ?? '?'})`);
mostra('comparação:', `${rep.state} / ${rep.verdict} (divergente só se a diferença passar de ${rep.threshold?.absoluteTokens} tokens E de ${Number(rep.threshold?.relative) * 100} %)`);
mostra('CU (unidade normalizada):', rec.cu?.cu ? `${frac(rec.cu.cu)} (pesos ${rec.cu.developmentProfile ? 'de desenvolvimento' : rec.cu.weights?.version})` : '(sem CU)');
mostra('custo calculado (tabela pública):', `US$ ${custoUsd.toFixed(8)}${REAL ? '' : ' (fictício: o provedor é sintético)'}`);
say(`    recibo completo salvo em: ${path.relative(ROOT, recibo)}`);

// 6. chaveiro desta instalação e conferência no verificador
passo(6, 'Gerando o chaveiro público desta instalação e conferindo o recibo no verificador');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const chaveiro = path.join(OUT, 'chaveiro_desta_instalacao.json');
const k = spawnSync(process.execPath, [TSX, 'scripts/verify/otk.ts', 'keyring', 'export', '--key', `${KEY_ID}=${operador.address},active`, '--operator', 'Demonstração local da banca', '--out', chaveiro], { cwd: ROOT, encoding: 'utf8' });
if (k.status !== 0) { say(limpa(k.stdout + k.stderr)); await encerra(1); }
const digital = crypto.createHash('sha256').update(fs.readFileSync(chaveiro)).digest('hex');
say(`    chaveiro: ${path.relative(ROOT, chaveiro)}   impressão digital: ${digital}`);
const v = spawnSync(process.execPath, [TSX, 'scripts/verify/otk.ts', 'verify', path.dirname(recibo), '--keyring', chaveiro, '--fingerprint', digital], { cwd: ROOT, encoding: 'utf8' });
fs.writeFileSync(path.join(OUT, 'verificacao.txt'), v.stdout + v.stderr);
say(v.stdout.split('\n').filter((l) => /^\[(OK|ATENÇÃO|FALHOU)\]|^Resultado/.test(l)).map((l) => `    ${l}`).join('\n'));
const assinaturaOk = /\[OK\] .*Íntegro e assinado/.test(v.stdout) && !/\[FALHOU\]/.test(v.stdout);
const soPerfilDev = v.status === 10 && v.stdout.split('\n').filter((l) => /^\[ATENÇÃO\]/.test(l)).every((l) => /Perfil de desenvolvimento/.test(l));
fs.writeFileSync(path.join(OUT, 'RESUMO_DEMO.json'), JSON.stringify({ schema: 'otk.demo_banca.v1', modo: REAL ? `real:${P.provider}` : 'sintetico', modelo: P.model, operacao: opId,
  comparacao: { estado: rep.state, veredito: rep.verdict }, impressaoDigitalChaveiro: digital, verificador: { codigoSaida: v.status, verde: v.status === 0, assinaturaConferida: assinaturaOk, unicoAvisoPerfilDesenvolvimento: soPerfilDev } }, null, 2) + '\n');
if (v.status === 0) say('\nDEU CERTO: o recibo saiu VERDE no verificador.');
else if (assinaturaOk && soPerfilDev) say('\nDEU CERTO: o recibo está íntegro e assinado pela chave desta instalação ([OK]). O aviso amarelo "Perfil de desenvolvimento"\né esperado: a versão avaliada calcula a CU com pesos de teste (os mesmos da coleta de 7/10), e o verificador avisa isso.');
else say(`\nO verificador terminou com código ${v.status} (veja ${path.relative(ROOT, path.join(OUT, 'verificacao.txt'))}).`);
say(`Para ver na página: abra web/verificador/verificador-otk.html, arraste a pasta ${path.relative(ROOT, path.dirname(recibo))}, arraste ${path.relative(ROOT, chaveiro)} e cole a impressão digital acima.`);
await c.end();
await encerra(v.status === 0 || (assinaturaOk && soPerfilDev) ? 0 : 1);
