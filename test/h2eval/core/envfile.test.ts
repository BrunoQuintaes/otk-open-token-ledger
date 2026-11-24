// SYNTHETIC — OFFLINE. R16 gap: credential loader by PATH. Only synthetic files in temporary directories; the canary value must never
// reach process.env, journal, ledger, snapshot, record, error text or the (injected) fetch except as the credential header.
// REAL mode is exercised ONLY with an injected fetch (returns 599) — no socket is ever opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkEnvFileLocation, readEnvFileVar, EnvFileRefused, defaultInsideGitTree, defaultInsideSyncFolder } from '../../../scripts/h2eval/core/envFile.js';
import { createEgress, EgressRefused, H2EVAL_ENV_NAMES } from '../../../scripts/h2eval/core/egress.js';
import { createExecutor, EXECUTOR_VERSION, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { syntheticGo } from './go.test.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, OFFICIAL_HOST } from '../support/double.js';

const CANARY = 'zq-envfile-canary-7d41c9b2e0f3a5';
const tdir = () => mkdtempSync(path.join(tmpdir(), 'h2eval-envfile-'));
const okChecks = { insideGitTree: () => false, insideSyncFolder: () => false, aclWide: () => false as boolean | null };
const writeEnv = (dir: string, lines: string[], name = 'h2eval.env'): string => { const p = path.join(dir, name); writeFileSync(p, lines.join('\r\n') + '\r\n'); return p; };

test('localizacao: so caminho absoluto, existente, fora de arvore Git e de pasta de sync, ACL sem grupo amplo; codigos fixos; o arquivo nao e aberto', () => {
  const d = tdir(); const f = writeEnv(d, ['H2EVAL_ANTHROPIC_API_KEY=' + CANARY]);
  assert.throws(() => checkEnvFileLocation('relative/h2eval.env', okChecks), (e: EnvFileRefused) => e.code === 'ENV_FILE_NOT_ABSOLUTE');
  assert.throws(() => checkEnvFileLocation(path.join(d, 'nope.env'), okChecks), (e: EnvFileRefused) => e.code === 'ENV_FILE_MISSING');
  assert.throws(() => checkEnvFileLocation(f, { ...okChecks, insideGitTree: () => true }), (e: EnvFileRefused) => e.code === 'ENV_FILE_IN_GIT_TREE');
  assert.throws(() => checkEnvFileLocation(f, { ...okChecks, insideSyncFolder: () => true }), (e: EnvFileRefused) => e.code === 'ENV_FILE_IN_SYNC_FOLDER');
  assert.throws(() => checkEnvFileLocation(f, { ...okChecks, aclWide: () => true }), (e: EnvFileRefused) => e.code === 'ENV_FILE_ACL');
  assert.throws(() => checkEnvFileLocation(f, { ...okChecks, aclWide: () => null }), (e: EnvFileRefused) => e.code === 'ENV_FILE_ACL', 'ACL indeterminada => recusa');
  assert.equal(checkEnvFileLocation(f, okChecks), f);
  // real walkers: a .git directory above the file is detected; sync folder names are detected
  const g = path.join(d, 'repo'); mkdirSync(path.join(g, '.git'), { recursive: true }); mkdirSync(path.join(g, 'sub'));
  const inGit = writeEnv(path.join(g, 'sub'), ['H2EVAL_ANTHROPIC_API_KEY=' + CANARY]);
  assert.equal(defaultInsideGitTree(inGit), true);
  assert.equal(defaultInsideSyncFolder('C:\\Users\\x\\OneDrive - Org\\h2eval.env'), true);
  assert.equal(defaultInsideSyncFolder('C:\\otk-secrets-h2eval\\h2eval.env'), false);
});

test('forma: so a linha da variavel pedida e lida; ausente / duplicada / aspas / espaco / curta => codigo fixo sem eco; nomes proibidos e outras linhas sao ignorados; BOM e CRLF tolerados', () => {
  const d = tdir();
  const f = writeEnv(d, ['\uFEFF# comentario', 'OPENAI_API_KEY=bot-key-must-never-be-read-0001', 'H2EVAL_OPENAI_API_KEY=other-provider-value-000001', 'H2EVAL_ANTHROPIC_API_KEY=' + CANARY, 'GARBAGE LINE WITHOUT EQUALS']);
  assert.equal(readEnvFileVar(f, 'H2EVAL_ANTHROPIC_API_KEY'), CANARY);
  assert.equal(readEnvFileVar(f, 'H2EVAL_OPENAI_API_KEY'), 'other-provider-value-000001');
  assert.throws(() => readEnvFileVar(f, 'H2EVAL_GOOGLE_API_KEY'), (e: EnvFileRefused) => e.code === 'ENV_FILE_VAR_ABSENT');
  assert.throws(() => readEnvFileVar(f, 'OPENAI_API_KEY'), (e: EnvFileRefused) => e.code === 'ENV_FILE_SHAPE', 'so nomes H2EVAL_ podem ser lidos');
  for (const [lines, code] of [
    [['H2EVAL_ANTHROPIC_API_KEY=' + CANARY, 'H2EVAL_ANTHROPIC_API_KEY=' + CANARY], 'ENV_FILE_VAR_DUPLICATE'],
    [['H2EVAL_ANTHROPIC_API_KEY="' + CANARY + '"'], 'ENV_FILE_SHAPE'],
    [['H2EVAL_ANTHROPIC_API_KEY=' + CANARY + ' '], 'ENV_FILE_SHAPE'],
    [['H2EVAL_ANTHROPIC_API_KEY=short'], 'ENV_FILE_SHAPE'],
    [['H2EVAL_ANTHROPIC_API_KEY='], 'ENV_FILE_SHAPE'],
  ] as const) {
    const p = writeEnv(d, [...lines], `case-${code}-${lines.length}.env`);
    let msg = '';
    assert.throws(() => readEnvFileVar(p, 'H2EVAL_ANTHROPIC_API_KEY'), (e: EnvFileRefused) => { msg = e.message; return e.code === code; });
    assert.doesNotMatch(msg, new RegExp(CANARY));
  }
  assert.equal(process.env['H2EVAL_ANTHROPIC_API_KEY'], undefined, 'nunca atribuido a process.env');
});

test('egress REAL: fonte ambigua (variavel E arquivo) recusada; OFFLINE nunca abre o arquivo; preflight checa so a localizacao', () => {
  const d = tdir(); const f = writeEnv(d, ['H2EVAL_ANTHROPIC_API_KEY=' + CANARY]);
  const req = doubleAdapter().buildRequest(plan({ promptSha256: 'a'.repeat(64) }), { promptSha256: 'a'.repeat(64), messages: [{ role: 'user', parts: [{ type: 'text', text: 'oi' }] }], prefixMessages: 'NOT_APPLICABLE' });
  const ctx = { provider: 'anthropic' as const, phase: 'PILOT', modelRequested: 'sim-haiku', batchId: 'batch1', executorVersion: EXECUTOR_VERSION, executorCodeSha: 'c'.repeat(40), ledgerCaps: { campaignUsd: '11', providerUsd: '5' } };
  let opened = 0; const spyChecks = { ...okChecks, insideGitTree: () => { opened += 1; return false; } };
  const off = createEgress({ mode: 'OFFLINE', campaign: 'x', allowedHosts: [OFFICIAL_HOST], double: async () => ({ httpStatus: 200, body: {} }), envFile: f, envFileChecks: spyChecks });
  off.preflight(ctx, req, [OFFICIAL_HOST]); assert.equal(opened, 0, 'OFFLINE: nem a localizacao e consultada');
  process.env['H2EVAL_ENVFILE_TEST_VAR'] = 'x'.repeat(30);
  const amb = createEgress({ mode: 'REAL', realFlag: true, forbiddenEnvVars: [], campaign: 'H2EVAL-TEST', allowedHosts: [OFFICIAL_HOST], goFile: path.join(d, 'none.json'), preregistrationSha256: 'ab'.repeat(32), credentialEnvVars: { anthropic: 'H2EVAL_ENVFILE_TEST_VAR' }, envFile: f, envFileChecks: okChecks });
  assert.throws(() => amb.preflight(ctx, req, [OFFICIAL_HOST]), (e: EgressRefused) => e.code === 'GO_FILE_MISSING', 'GO vem antes');
  const go = path.join(d, 'GO.json'); writeFileSync(go, syntheticGo({ window: { notBeforeUtc: new Date(Date.now() - 60_000).toISOString(), expiresUtc: new Date(Date.now() + 3_600_000).toISOString() } }));
  const amb2 = createEgress({ mode: 'REAL', realFlag: true, forbiddenEnvVars: [], campaign: 'H2EVAL-TEST', allowedHosts: [OFFICIAL_HOST], goFile: go, preregistrationSha256: 'ab'.repeat(32), credentialEnvVars: { anthropic: 'H2EVAL_ENVFILE_TEST_VAR' }, envFile: f, envFileChecks: okChecks });
  assert.throws(() => amb2.preflight(ctx, req, [OFFICIAL_HOST]), (e: EgressRefused) => e.code === 'CREDENTIAL_SOURCE_AMBIGUOUS');
  delete process.env['H2EVAL_ENVFILE_TEST_VAR'];
  const git = createEgress({ mode: 'REAL', realFlag: true, forbiddenEnvVars: [], campaign: 'H2EVAL-TEST', allowedHosts: [OFFICIAL_HOST], goFile: go, preregistrationSha256: 'ab'.repeat(32), credentialEnvVars: { anthropic: 'H2EVAL_ENVFILE_TEST_VAR' }, envFile: f, envFileChecks: { ...okChecks, insideGitTree: () => true } });
  assert.throws(() => git.preflight(ctx, req, [OFFICIAL_HOST]), (e: EgressRefused) => e.code === 'ENV_FILE_IN_GIT_TREE');
  const none = createEgress({ mode: 'REAL', realFlag: true, forbiddenEnvVars: [], campaign: 'H2EVAL-TEST', allowedHosts: [OFFICIAL_HOST], goFile: go, preregistrationSha256: 'ab'.repeat(32), credentialEnvVars: { anthropic: 'H2EVAL_ENVFILE_TEST_VAR' } });
  assert.throws(() => none.preflight(ctx, req, [OFFICIAL_HOST]), (e: EgressRefused) => e.code === 'CREDENTIAL_ENV_MISSING');
});

test('ensaio REAL com fetch INJETADO (sem socket): o valor do arquivo-isca vai SO para o cabecalho; process.env nao o recebe; journal/ledger/snapshot/registro nao o contem; 599 => UNCERTAIN', async () => {
  const d = tdir(); const f = writeEnv(d, ['H2EVAL_ANTHROPIC_API_KEY=not-the-configured-name-0000000', 'H2EVAL_ENVFILE_TEST_VAR=' + CANARY]);
  const go = path.join(d, 'GO.json'); writeFileSync(go, syntheticGo({ campaign: 'h2eval-test', window: { notBeforeUtc: new Date(Date.now() - 60_000).toISOString(), expiresUtc: new Date(Date.now() + 3_600_000).toISOString() } }));
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => { seen.push({ url, headers: init.headers }); return { status: 599, json: async () => ({ type: 'error', error: { type: 'synthetic' } }) }; }) as unknown as typeof fetch;
  const dir = tmp('envreal');
  const store = memoryContentStore({ p1: 'Resuma este texto sintético.' });
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'REAL', realFlag: true, campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], goFile: go, preregistrationSha256: 'ab'.repeat(32), credentialEnvVars: { anthropic: 'H2EVAL_ENVFILE_TEST_VAR' }, envFile: f, envFileChecks: okChecks, fetchImpl, forbiddenEnvVars: [] },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), lockedProviders: [],
  };
  const ex = createExecutor(cfg);
  const p = plan({ promptSha256: store.sha['p1']! });
  const r = await ex.run(p);
  ex.close();
  assert.deepEqual([r.state, r.stop, seen.length], ['UNCERTAIN', 'STOP_UNCERTAIN', 1]);
  const rec = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(p)}.json`), 'utf8'));
  assert.equal(rec.httpStatus, 599);
  assert.equal(seen[0]!.headers['x-api-key'], CANARY, 'credencial injetada no cabecalho no instante do envio');
  assert.equal(process.env['H2EVAL_ENVFILE_TEST_VAR'], undefined);
  assert.equal(process.env['H2EVAL_ANTHROPIC_API_KEY'], undefined);
  const all = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name), 'utf8')).join('\n');
  assert.doesNotMatch(all, new RegExp(CANARY));
  assert.ok(all.includes(operationIdOf(p)));
  void H2EVAL_ENV_NAMES;
});
