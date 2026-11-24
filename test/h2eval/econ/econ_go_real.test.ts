/**
 * EXEC-ECON C160 delta 3 (DECISOES_MASTER_ECON): o ramo `h2eval.go.econ.v1` do egress (core/egress.ts readGo) com o validador injetado.
 * Modo REAL só com transporte FALSO (fetchImpl injetado), credencial SINTÉTICA num arquivo temporário (nomes de variável de teste, que
 * não existem no ambiente), nenhuma rede, US$ 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Canon, sha256Hex } from '../../../scripts/h2eval/core/canon.js';
import { createEgress, EgressRefused, EgressGoEconRefused, type GoContext } from '../../../scripts/h2eval/core/egress.js';
import { GO_ECON_REQUIRED_STOPS, type GoEconV1, type GoEconContext } from '../../../scripts/h2eval/econ/goEcon.js';
import { runEcon, goEconEgressValidator, ECON_TIMEOUT_MS, ECON_ALLOWED_HOSTS, ECON_GO_MARGEM_MS } from '../../../scripts/h2eval/econ/econ.js';
import { CAPS_PROFILE_ECON_DR277 } from '../../../scripts/h2eval/core/ledger.js';
import { ambiente, respostaDe } from './econ_fixture.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const END = Date.parse('2026-11-21T00:00:00Z');
const PREREG = '9'.repeat(64);
const VARS = { anthropic: 'H2EVAL_ECON_TEST_VAR_A', openai: 'H2EVAL_ECON_TEST_VAR_O', google: 'H2EVAL_ECON_TEST_VAR_G' } as const;
const okChecks = { insideGitTree: () => false, insideSyncFolder: () => false, aclWide: () => false as boolean | null };
const ALL = { providers: ['openai', 'google', 'anthropic'], modelIds: ['gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5'], seqFrom: 0, seqTo: 9, maxAttempts: 10 };
function goText(over: Record<string, unknown>): string {
  const g: Record<string, unknown> = {
    schema: 'h2eval.go.econ.v1', campaign: 'econ-teste', studyId: 'econ-teste', preregistrationSha256: PREREG, executorCodeSha: 'c'.repeat(40), timeoutMs: ECON_TIMEOUT_MS, g7bEstado: 'ABERTO',
    capsProfile: 'econ_dr277', caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '28' }, globalCampaignUsd: '132', pauseAtFractionOfSubLedger: 0.8 },
    scope: ALL, window: { notBeforeUtc: '2026-11-20T00:00:00Z', notAfterUtc: '2026-11-21T00:00:00Z' }, stops: [...GO_ECON_REQUIRED_STOPS], signedBy: 'human:TESTE', signatureStatement: 'GO de TESTE do estudo econômico (fixture)', ...over,
  };
  g['goDigestSha256'] = sha256Canon(g); return JSON.stringify(g);
}
const provOf = (url: string) => (url.includes('anthropic') ? 'anthropic' : url.includes('openai') ? 'openai' : 'google') as 'anthropic' | 'openai' | 'google';

/** consumidor ECON no modo REAL com fetch falso; `clock` alimenta o egress e o consumidor (mesmo relógio). */
function realEnv(o: { goOver?: Record<string, unknown>; clock?: () => number } = {}) {
  const a = ambiente({ blocks: 2 });
  const d = mkdtempSync(path.join(tmpdir(), 'econ-real-')); const envFile = path.join(d, 'h2eval.env');
  writeFileSync(envFile, Object.values(VARS).map((v) => `${v}=zq-econ-canary-sintetico`).join('\r\n') + '\r\n');
  const goFile = path.join(d, 'GO_ECON.json'); writeFileSync(goFile, goText({ cronogramaSha256: a.cfg.cronogramaSha256, ...o.goOver }));
  const fetched: Array<{ url: string; body: string; credHeader: boolean }> = [];
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const p = provOf(url); const model = (JSON.parse(init.body) as { model?: string }).model ?? /models\/([^:]+):/.exec(url)![1]!;
    fetched.push({ url, body: init.body, credHeader: Object.keys(init.headers).some((h) => ['x-api-key', 'authorization', 'x-goog-api-key'].includes(h.toLowerCase())) });
    return { status: 200, headers: new Headers({ 'request-id': 'req_econ_sintetico' }), json: async () => respostaDe(p, model, 'texto').body };
  }) as unknown as typeof fetch;
  const clock = o.clock ?? (() => NOW);
  a.cfg.egress = { mode: 'REAL', realFlag: true, campaign: 'econ-teste', credentialEnvVars: { ...VARS }, envFile, envFileChecks: okChecks, fetchImpl, forbiddenEnvVars: [] };
  a.cfg.go = { file: goFile, preregistrationSha256: PREREG, treeClean: true, nowMs: clock };
  return { a, fetched, goFile };
}

test('[DELTA3] GO ECON válido: o egress REAL (fetch falso) envia as 10 tentativas, na ordem, com a credencial injetada só no envio', async () => {
  const { a, fetched } = realEnv();
  const s = await runEcon(a.cfg);
  assert.equal(s.parada, null); assert.equal(s.executadasPrefixo, 10); assert.equal(fetched.length, 10);
  assert.ok(fetched.every((f) => f.credHeader)); assert.equal(a.sent.length, 0, 'o dublê OFFLINE não é usado');
  const j = readFileSync(path.join(a.cfg.batchDir, 'journal.jsonl'), 'utf8');
  assert.equal(j.includes('zq-econ-canary'), false); assert.equal(j.split('\n').filter((l) => l.includes('"SENT"') && l.includes('"REAL"')).length, 10);
});
test('[DELTA3] vencido no egress: o relógio passa do fim entre a guarda e o egress => recusa sem enviar (GO_EXPIRED), tentativa não enviada', async () => {
  const seq = [NOW, NOW, END + 1]; let i = 0; // início do consumidor, guarda da 1a tentativa, egress (já vencido)
  const { a, fetched } = realEnv({ clock: () => seq[Math.min(i++, seq.length - 1)]! });
  const s = await runEcon(a.cfg);
  assert.equal(fetched.length, 0); assert.equal(s.executadasPrefixo, 0);
  assert.ok(readFileSync(path.join(a.cfg.batchDir, 'journal.jsonl'), 'utf8').includes('GO_EXPIRED'));
  assert.equal(s.parada!.stop, 'PAUSE_ECON_GO', 'delta 4: pausa não terminal'); assert.equal(readFileSync(path.join(a.cfg.batchDir, 'journal.jsonl'), 'utf8').includes('ABORTED_BEFORE_SEND'), false);
});
test('[DELTA3] maxAttempts esgotado e escopo de seq: a guarda pausa antes do egress; nada além do escopo é enviado', async () => {
  const { a, fetched } = realEnv({ goOver: { scope: { ...ALL, seqTo: 9, maxAttempts: 3 } } });
  const s = await runEcon(a.cfg); assert.equal(fetched.length, 3); assert.equal(s.parada!.stop, 'PAUSE_ECON_GO');
  const { a: b, fetched: f2 } = realEnv({ goOver: { scope: { ...ALL, seqTo: 4, maxAttempts: 5 } } });
  const s2 = await runEcon(b.cfg); assert.equal(f2.length, 5); assert.equal(s2.parada!.seq, 5);
});

// ------------------------------------------------------------------ o ramo do egress, direto
const req = (url: string, body: unknown): BuiltRequest => ({ url, method: 'POST', headers: { 'content-type': 'application/json' }, credentialHeader: 'x-api-key', credentialFormat: 'raw', body, textParts: [], nonTextParts: [] });
function egressWith(goFile: string, goEcon: Parameters<typeof createEgress>[0]['goEcon'], nowMs = NOW) {
  const d = mkdtempSync(path.join(tmpdir(), 'econ-eg-')); const envFile = path.join(d, 'h2eval.env'); writeFileSync(envFile, `${VARS.anthropic}=zq-econ-canary-sintetico\r\n`);
  let calls = 0; const fetchImpl = (async () => { calls++; return { status: 200, headers: new Headers(), json: async () => ({}) }; }) as unknown as typeof fetch;
  const eg = createEgress({ mode: 'REAL', realFlag: true, campaign: 'econ-teste', allowedHosts: [...ECON_ALLOWED_HOSTS], goFile, preregistrationSha256: PREREG, credentialEnvVars: { anthropic: VARS.anthropic }, envFile, envFileChecks: okChecks, fetchImpl, forbiddenEnvVars: [], now: () => nowMs, ...(goEcon ? { goEcon } : {}) });
  return { eg, calls: () => calls };
}
const pc = (model = 'claude-opus-5-5') => ({ provider: 'anthropic' as const, phase: 'COMPARATIVE_PAIRED', modelRequested: model, batchId: 'econ-b0000', executorVersion: 'x', executorCodeSha: 'c'.repeat(40), ledgerCaps: { campaignUsd: '132', providerUsd: '95' } });
function validatorFor(text: string, sha0 = sha256Hex(text)) {
  const go0 = JSON.parse(text) as GoEconV1;
  const ctxOf = (): GoEconContext => ({ campaign: 'econ-teste', studyId: 'econ-teste', preregistrationSha256: PREREG, executorCodeSha: 'c'.repeat(40), treeClean: true, cronogramaSha256: 'f'.repeat(64), cronogramaLength: 10, timeoutMs: ECON_TIMEOUT_MS, g7bEstado: 'ABERTO', ledgerCaps: { campaignUsd: CAPS_PROFILE_ECON_DR277.campaign, providersUsd: { ...CAPS_PROFILE_ECON_DR277.providers } }, nowMs: 0 });
  return goEconEgressValidator({ sha0, go0, ctxOf, executorCodeSha: 'c'.repeat(40), campaign: 'econ-teste' });
}
function goFileWith(over: Record<string, unknown> = {}): { file: string; text: string } { const d = mkdtempSync(path.join(tmpdir(), 'econ-gf-')); const file = path.join(d, 'GO.json'); const text = goText({ cronogramaSha256: 'f'.repeat(64), ...over }); writeFileSync(file, text); return { file, text }; }
const R = 'https://api.anthropic.com/v1/messages';

test('[DELTA3] egress: GO ECON válido => token de uso único; o envio passa uma vez e o mesmo token é recusado na 2a', async () => {
  const { file, text } = goFileWith({ pauseAck80pct: { anthropic: { acknowledgedBy: 'human:TESTE', atUtc: '2026-11-20T00:00:00Z' } } });
  const { eg, calls } = egressWith(file, validatorFor(text)); const r = req(R, { model: 'claude-opus-5-5' });
  const pf = eg.preflight(pc(), r, ['api.anthropic.com']);
  assert.ok(pf.token); assert.equal(pf.goMaxCalls, null); assert.equal(pf.goPauseAck?.acknowledgedBy, 'human:TESTE');
  await eg.send('anthropic', r, pf.token); assert.equal(calls(), 1);
  await assert.rejects(eg.send('anthropic', r, pf.token), /PREFLIGHT_TOKEN_INVALID/); assert.equal(calls(), 1);
});
test('[DELTA3] egress recusa SEM enviar: vencido, ainda não válido, modelo fora do escopo, arquivo com sha diferente, sem validador injetado', async () => {
  const cases: Array<[string, () => { eg: ReturnType<typeof createEgress>; calls: () => number }, string]> = [
    ['vencido', () => { const g = goFileWith(); return egressWith(g.file, validatorFor(g.text), END); }, 'GO_EXPIRED'],
    ['nao valido', () => { const g = goFileWith(); return egressWith(g.file, validatorFor(g.text), Date.parse('2026-11-19T00:00:00Z')); }, 'GO_NOT_YET_VALID'],
    ['escopo', () => { const g = goFileWith({ scope: { providers: ['anthropic'], modelIds: ['claude-haiku-5-5'], seqFrom: 0, seqTo: 9, maxAttempts: 10 } }); return egressWith(g.file, validatorFor(g.text)); }, 'GO_PROVIDER_OR_MODEL_NOT_IN_SCOPE'],
    ['sha errado', () => { const g = goFileWith(); return egressWith(g.file, validatorFor(g.text, '0'.repeat(64))); }, 'GO_CHANGED_DURING_RUN'],
    ['sem validador', () => { const g = goFileWith(); return egressWith(g.file, undefined); }, 'GO_ECON_CONTEXT_MISSING'],
    ['teto', () => { const g = goFileWith({ caps: { perProviderSubLedgerUsd: { anthropic: '96', openai: '11', google: '28' }, globalCampaignUsd: '132', pauseAtFractionOfSubLedger: 0.8 } }); return egressWith(g.file, validatorFor(g.text)); }, 'GO_CAPS_MISMATCH'],
  ];
  for (const [nome, mk, code] of cases) {
    const { eg, calls } = mk();
    assert.throws(() => eg.preflight(pc(), req(R, { model: 'claude-opus-5-5' }), ['api.anthropic.com']), (e: unknown) => e instanceof EgressRefused && e.code === code, nome);
    assert.equal(calls(), 0, nome);
  }
});
test('[DELTA3] os GO antigos seguem idênticos com o gancho configurado: single e multi devolvem os mesmos códigos com e sem goEcon', () => {
  const single = JSON.stringify({ schema: 'h2eval.go.v1', campaign: 'econ-teste' });
  const multi = JSON.stringify({ schema: 'h2eval.go.multi.v1', campaign: 'econ-teste' });
  for (const t of [single, multi, '{"schema":"outro"}']) {
    const d = mkdtempSync(path.join(tmpdir(), 'econ-old-')); const f = path.join(d, 'GO.json'); writeFileSync(f, t);
    const code = (eg: ReturnType<typeof createEgress>) => { try { eg.preflight(pc(), req(R, { model: 'claude-opus-5-5' }), ['api.anthropic.com']); return null; } catch (e) { return (e as EgressRefused).code; } };
    const sem = code(egressWith(f, undefined).eg); const com = code(egressWith(f, validatorFor(goText({ cronogramaSha256: 'f'.repeat(64) }))).eg);
    assert.equal(com, sem, t); assert.notEqual(sem, null);
  }
});
void ({} as GoContext);

// ------------------------------------------------------------------ delta 4 (R-D1)
test('[DELTA4] margem até o notAfter: padrão 15 min; com menos, PAUSE antes de reservar (nada enviado); com mais, envia', async () => {
  assert.equal(ECON_GO_MARGEM_MS, 15 * 60_000);
  const fim = new Date(NOW + 10 * 60_000).toISOString();
  const { a, fetched } = realEnv({ goOver: { window: { notBeforeUtc: '2026-11-20T00:00:00Z', notAfterUtc: fim } } });
  const s = await runEcon(a.cfg);
  assert.equal(fetched.length, 0); assert.equal(s.parada!.stop, 'PAUSE_ECON_GO'); assert.equal(s.parada!.seq, 0);
  const j = readFileSync(path.join(a.cfg.batchDir, 'journal.jsonl'), 'utf8'); assert.ok(j.includes('GO_MARGEM_INSUFICIENTE')); assert.equal(j.includes('"RESERVED"'), false);
  const { a: b, fetched: f2 } = realEnv({ goOver: { window: { notBeforeUtc: '2026-11-20T00:00:00Z', notAfterUtc: new Date(NOW + 16 * 60_000).toISOString() } } });
  const s2 = await runEcon(b.cfg); assert.equal(s2.parada, null); assert.equal(f2.length, 10);
});
test('[DELTA4] margem configurável, nunca menor que timeout + folga (600 s + 60 s)', async () => {
  const { a } = realEnv(); a.cfg.go = { ...a.cfg.go!, marginMs: 5 * 60_000 };
  await assert.rejects(runEcon(a.cfg), /ECON_GO_MARGEM_INVALIDA/);
  const { a: b, fetched } = realEnv({ goOver: { window: { notBeforeUtc: '2026-11-20T00:00:00Z', notAfterUtc: new Date(NOW + 12 * 60_000).toISOString() } } }); b.cfg.go = { ...b.cfg.go!, marginMs: 11 * 60_000 };
  const s = await runEcon(b.cfg); assert.equal(s.parada, null); assert.equal(fetched.length, 10);
});
test('[DELTA4] só o ramo GO ECON gera EgressGoEconRefused; recusas de GO single/multi seguem EgressRefused simples (inalteradas)', () => {
  const g = goFileWith(); const { eg } = egressWith(g.file, validatorFor(g.text), END);
  assert.throws(() => eg.preflight(pc(), req(R, { model: 'claude-opus-5-5' }), ['api.anthropic.com']), (e: unknown) => e instanceof EgressGoEconRefused && (e as EgressRefused).code === 'GO_EXPIRED');
  const g2 = goFileWith(); const { eg: eg2 } = egressWith(g2.file, undefined);
  assert.throws(() => eg2.preflight(pc(), req(R, { model: 'claude-opus-5-5' }), ['api.anthropic.com']), (e: unknown) => e instanceof EgressGoEconRefused && (e as EgressRefused).code === 'GO_ECON_CONTEXT_MISSING');
  for (const t of [JSON.stringify({ schema: 'h2eval.go.v1', campaign: 'econ-teste' }), JSON.stringify({ schema: 'h2eval.go.multi.v1', campaign: 'econ-teste' })]) {
    const d = mkdtempSync(path.join(tmpdir(), 'econ-d4-')); const f = path.join(d, 'GO.json'); writeFileSync(f, t);
    assert.throws(() => egressWith(f, validatorFor(g.text)).eg.preflight(pc(), req(R, { model: 'claude-opus-5-5' }), ['api.anthropic.com']), (e: unknown) => e instanceof EgressRefused && !(e instanceof EgressGoEconRefused), t);
  }
});
test('[DELTA4] fora do estudo (sem cfg.econ) uma recusa vinda do ramo GO ECON segue a semântica antiga: ABORTED_BEFORE_SEND, sem pausa', async () => {
  const { createExecutor } = await import('../../../scripts/h2eval/core/runner.js');
  const sup = await import('../support/double.js');
  const d = mkdtempSync(path.join(tmpdir(), 'econ-d4-legacy-')); const envFile = path.join(d, 'h2eval.env'); writeFileSync(envFile, `${VARS.anthropic}=zq-econ-canary-sintetico\r\n`);
  const g = goFileWith(); let calls = 0;
  const fetchImpl = (async () => { calls++; return { status: 200, headers: new Headers(), json: async () => ({}) }; }) as unknown as typeof fetch;
  const dir = sup.tmp('econ-d4-legacy'); const store = sup.memoryContentStore({ p1: 'Texto sintético.' });
  const ex = createExecutor({ batchDir: dir, adapters: { 'anthropic.messages': sup.doubleAdapter() }, contentStore: store, prices: sup.prices(dir), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'REAL', realFlag: true, campaign: 'h2eval-test', allowedHosts: [sup.OFFICIAL_HOST], goFile: g.file, preregistrationSha256: PREREG, credentialEnvVars: { anthropic: VARS.anthropic }, envFile, envFileChecks: okChecks, fetchImpl, forbiddenEnvVars: [], goEcon: { validate: () => ({ code: 'GO_EXPIRED', pauseAck: null }) } },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), lockedProviders: [] });
  try { const r = await ex.run(sup.plan({ promptSha256: store.sha['p1']! })); assert.equal(r.state, 'ABORTED_BEFORE_SEND'); assert.equal(r.stop, null); } finally { ex.close(); }
  const j = readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'); assert.ok(j.includes('"ABORTED_BEFORE_SEND"')); assert.equal(j.includes('PAUSE_REVIEW'), false); assert.equal(calls, 0);
});

// ------------------------------------------------------------------ delta 5 (R-D4)
test('[DELTA5] no estudo, recusas de pré-envio que não vêm do GO viram PAUSE_ECON_EGRESS (não terminal); corrigida a causa, a MESMA seq é enviada uma vez', async () => {
  const casos: Array<[string, (a: ReturnType<typeof realEnv>['a']) => () => void, string]> = [
    ['ENV_FILE_MISSING', (a) => { const f = a.cfg.egress.envFile!; const orig = readFileSync(f, 'utf8'); writeFileSync(f + '.bak', orig); a.cfg.egress = { ...a.cfg.egress, envFile: f + '.nao-existe' }; return () => { a.cfg.egress = { ...a.cfg.egress, envFile: f }; }; }, 'ENV_FILE_MISSING'],
    ['REAL_FLAG_MISSING', (a) => { a.cfg.egress = { ...a.cfg.egress, realFlag: false }; return () => { a.cfg.egress = { ...a.cfg.egress, realFlag: true }; }; }, 'REAL_FLAG_MISSING'],
    ['HOST_NOT_ALLOWED', (a) => { a.cfg.egress = { ...a.cfg.egress, allowedHosts: ['api.anthropic.com'] }; return () => { a.cfg.egress = { ...a.cfg.egress, allowedHosts: undefined }; }; }, 'HOST_NOT_ALLOWED'],
    ['FORBIDDEN_ENV_PRESENT', (a) => { const nome = 'H2EVAL_ECON_TEST_FORBIDDEN_SINTETICO'; process.env[nome] = 'x'; a.cfg.egress = { ...a.cfg.egress, forbiddenEnvVars: [nome] }; return () => { delete process.env[nome]; }; }, 'FORBIDDEN_ENV_PRESENT'],
    ['CREDENTIAL_SOURCE_AMBIGUOUS', (a) => { const v = VARS.openai; process.env[v] = 'zq-econ-canary-sintetico'; void a; return () => { delete process.env[v]; }; }, 'CREDENTIAL_SOURCE_AMBIGUOUS'],
  ];
  for (const [nome, quebra, code] of casos) {
    const { a, fetched } = realEnv();
    const conserta = quebra(a);
    let s1; try { s1 = await runEcon(a.cfg); } finally { /* a causa continua até o conserto abaixo */ }
    const j1 = readFileSync(path.join(a.cfg.batchDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; operationId: string; body: Record<string, unknown> });
    assert.equal(fetched.length, 0, nome); assert.equal(s1!.parada!.stop, 'PAUSE_ECON_EGRESS', nome); assert.equal(s1!.parada!.seq, 0, nome);
    const p = j1.filter((l) => l.kind === 'PAUSE_REVIEW'); assert.equal(p.length, 1, nome); assert.equal(p[0]!.body['code'], code, nome);
    assert.equal(j1.some((l) => l.kind === 'ABORTED_BEFORE_SEND' || l.kind === 'RESERVED' || l.kind === 'SENT'), false, nome);
    conserta();
    const s2 = await runEcon(a.cfg);
    const j2 = readFileSync(path.join(a.cfg.batchDir, 'journal.jsonl'), 'utf8');
    assert.equal(s2.parada, null, nome); assert.equal(fetched.length, 10, nome); assert.equal(j2.includes('REPLAY_SKIPPED'), false, nome);
  }
});
test('[DELTA5] fora do estudo (sem cfg.econ) a recusa de pré-envio segue terminal: ABORTED_BEFORE_SEND, sem pausa (semântica antiga)', async () => {
  const { createExecutor } = await import('../../../scripts/h2eval/core/runner.js');
  const sup = await import('../support/double.js');
  const g = goFileWith(); const dir = sup.tmp('econ-d5-legacy'); const store = sup.memoryContentStore({ p1: 'Texto sintético.' });
  const ex = createExecutor({ batchDir: dir, adapters: { 'anthropic.messages': sup.doubleAdapter() }, contentStore: store, prices: sup.prices(dir), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'REAL', realFlag: true, campaign: 'h2eval-test', allowedHosts: [sup.OFFICIAL_HOST], goFile: g.file, preregistrationSha256: PREREG, credentialEnvVars: { anthropic: VARS.anthropic }, envFile: path.join(dir, 'nao-existe.env'), envFileChecks: okChecks, fetchImpl: (async () => { throw new Error('nunca'); }) as unknown as typeof fetch, forbiddenEnvVars: [], goEcon: { validate: () => ({ code: null, pauseAck: null }) } },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), lockedProviders: [] });
  try { const r = await ex.run(sup.plan({ promptSha256: store.sha['p1']! })); assert.equal(r.state, 'ABORTED_BEFORE_SEND'); assert.equal(r.stop, null); } finally { ex.close(); }
  const j = readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'); assert.ok(j.includes('"ABORTED_BEFORE_SEND"')); assert.equal(j.includes('PAUSE_REVIEW'), false);
});

// ------------------------------------------------------------------ delta 7b (X1 v3.5 R2): tetos do autor vindos do GO
test('[DELTA7B] ledger do estudo: o envelope ECON só vale com econEnvelope (estudo); fora dele as regras antigas, inalteradas', async () => {
  const { openLedger, CapsAboveDefault } = await import('../../../scripts/h2eval/core/ledger.js');
  const d = mkdtempSync(path.join(tmpdir(), 'econ-7b-'));
  const caps = { campaignUsd: '97', providersUsd: { anthropic: '76', openai: '11', google: '10' } };
  assert.equal(openLedger(path.join(d, 'a.jsonl'), caps, undefined, undefined, { econEnvelope: true }).state().providers.anthropic.capUsd, (76n * 10n ** 12n).toString());
  assert.throws(() => openLedger(path.join(d, 'b.jsonl'), caps), CapsAboveDefault, 'fora do estudo 76 > 5 continua recusado');
  for (const c of [{ campaignUsd: '133', providersUsd: { anthropic: '95', openai: '11', google: '28' } }, { campaignUsd: '97', providersUsd: { anthropic: '96', openai: '11', google: '10' } }, { campaignUsd: '97', providersUsd: { anthropic: '76', openai: '0', google: '10' } }])
    assert.throws(() => openLedger(path.join(d, 'c.jsonl'), c, undefined, undefined, { econEnvelope: true }), CapsAboveDefault, JSON.stringify(c));
  assert.equal(openLedger(path.join(d, 'e.jsonl'), { campaignUsd: '132', providersUsd: { anthropic: '95', openai: '11', google: '28' } }).state().campaignCapUsd, (132n * 10n ** 12n).toString(), 'perfil exato segue aceito como antes');
});
test('[DELTA7B] REAL: os tetos do GO assinado (97/76/11/10) são os do ledger da coleta; GO fora do envelope não deixa começar', async () => {
  const caps = { perProviderSubLedgerUsd: { anthropic: '76', openai: '11', google: '10' }, globalCampaignUsd: '97', pauseAtFractionOfSubLedger: 0.8 };
  const { a, fetched } = realEnv({ goOver: { caps } });
  const s = await runEcon(a.cfg);
  assert.equal(s.parada, null); assert.equal(fetched.length, 10);
  const st = s.ledger as { campaignCapUsd: string; providers: Record<string, { capUsd: string }> };
  assert.equal(st.campaignCapUsd, (97n * 10n ** 12n).toString()); assert.equal(st.providers['anthropic']!.capUsd, (76n * 10n ** 12n).toString()); assert.equal(st.providers['google']!.capUsd, (10n * 10n ** 12n).toString());
  const { a: b, fetched: f2 } = realEnv({ goOver: { caps: { ...caps, perProviderSubLedgerUsd: { anthropic: '96', openai: '11', google: '10' } } } });
  await assert.rejects(runEcon(b.cfg), /ECON_GO_INVALID: GO_CAPS_MISMATCH/); assert.equal(f2.length, 0); assert.equal(existsSync(path.join(b.cfg.batchDir, 'ledger.jsonl')), false);
});
test('[DELTA7B] pauseAck80pct do GO por provedor dispensa a PAUSE_REVIEW_AT_80PCT (comportamento de antes, inalterado); sem ele, pausa sem enviar', async () => {
  const caps = { perProviderSubLedgerUsd: { anthropic: '76', openai: '0.03', google: '10' }, globalCampaignUsd: '97', pauseAtFractionOfSubLedger: 0.8 };
  const rest = { schema: 'h2eval.ledger_opening.v1' as const, fromStudy: { label: 'TESTE', ledgerSha256: 'e'.repeat(64), closedUtc: '2026-11-01T00:00:00Z' }, providers: { openai: { settledUsd: '0.025', uncertainUsd: '0' } }, signedBy: 'human:TESTE' };
  const opening = { ...rest, digestSha256: sha256Canon(rest) }; // 0,025 / 0,03 = 83 % comprometido antes da 1a tentativa luna
  const sem = realEnv({ goOver: { caps } }); sem.a.cfg.ledgerOpening = opening; sem.a.cfg.maxOps = 1;
  const s1 = await runEcon(sem.a.cfg);
  assert.equal(s1.parada!.stop, 'PAUSE_REVIEW_AT_80PCT'); assert.equal(sem.fetched.length, 0);
  const com = realEnv({ goOver: { caps, pauseAck80pct: { openai: { acknowledgedBy: 'human:TESTE', atUtc: '2026-11-20T00:00:00Z' } } } }); com.a.cfg.ledgerOpening = opening; com.a.cfg.maxOps = 1;
  const s2 = await runEcon(com.a.cfg);
  assert.equal(s2.parada, null); assert.equal(com.fetched.length, 1);
  const j = readFileSync(path.join(com.a.cfg.batchDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; body: Record<string, unknown> });
  const ack = j.find((l) => l.kind === 'PAUSE_ACK')!; assert.equal(ack.body['source'], 'go'); assert.equal(ack.body['acknowledgedBy'], 'human:TESTE'); assert.equal(j.some((l) => l.kind === 'PAUSE_REVIEW'), false);
});
test('[DELTA7B] runner fora do estudo (sem cfg.econ) recusa abrir ledger com tetos do envelope ECON fora dos perfis (mata B704)', async () => {
  const { createExecutor } = await import('../../../scripts/h2eval/core/runner.js');
  const { CapsAboveDefault } = await import('../../../scripts/h2eval/core/ledger.js');
  const sup = await import('../support/double.js');
  const dir = sup.tmp('econ-7b-legacy'); const store = sup.memoryContentStore({ p1: 'Texto sintético.' });
  assert.throws(() => createExecutor({ batchDir: dir, adapters: { 'anthropic.messages': sup.doubleAdapter() }, contentStore: store, prices: sup.prices(dir), ledger: { campaignUsd: '97', providersUsd: { anthropic: '76', openai: '11', google: '10' } },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [sup.OFFICIAL_HOST], double: async () => ({ httpStatus: 200, body: {} }) }, capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40) }), CapsAboveDefault);
});
