/**
 * G15 EXEC-ECON delta 4 (auditor-independente C160): testes próprios do auditor sobre df1b011e. Offline, transporte falso, credencial
 * sintética em arquivo temporário, US$ 0.
 * INCORPORADO pelo agente EXEC-ECON C160 no delta 5 (R-D5: R02, M03, M05, M06), de runs/C160/EXEC_ECON_G15/D4/replica/g15tests/. Única mudança de
 * conteúdo: o teste "recusa do egress que NÃO é do GO" passa a exigir o comportamento NOVO do delta 5 (R-D4: pausa não terminal PAUSE_ECON_EGRESS;
 * a reexecução com a credencial certa envia a seq uma vez, sem REPLAY_SKIPPED). O original media o travamento (ABORTED_BEFORE_SEND).
 * Também: `void EgressGoEconRefused` no fim (o import original não era usado em valor e o tsc acusava TS6133).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { createEgress, EgressRefused, EgressGoEconRefused } from '../../../scripts/h2eval/core/egress.js';
import { GO_ECON_REQUIRED_STOPS } from '../../../scripts/h2eval/econ/goEcon.js';
import { runEcon, ECON_TIMEOUT_MS, ECON_ALLOWED_HOSTS, ECON_GO_MARGEM_MS } from '../../../scripts/h2eval/econ/econ.js';
import { ambiente, respostaDe } from './econ_fixture.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const END = Date.parse('2026-11-21T00:00:00Z');
const PREREG = '9'.repeat(64);
const VARS = { anthropic: 'H2EVAL_G15D4_VAR_A', openai: 'H2EVAL_G15D4_VAR_O', google: 'H2EVAL_G15D4_VAR_G' } as const;
const okChecks = { insideGitTree: () => false, insideSyncFolder: () => false, aclWide: () => false as boolean | null };
const ALL = { providers: ['openai', 'google', 'anthropic'], modelIds: ['gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5'], seqFrom: 0, seqTo: 9, maxAttempts: 10 };
const OUT = process.env.G15_D4_OUT; const out: Record<string, unknown> = {};
function dump(k: string, v: unknown) { out[k] = v; if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1)); }
const W0 = { notBeforeUtc: '2026-11-20T00:00:00Z', notAfterUtc: '2026-11-21T00:00:00Z' };
function goText(over: Record<string, unknown>, win = W0): string {
  const g: Record<string, unknown> = {
    schema: 'h2eval.go.econ.v1', campaign: 'econ-teste', studyId: 'econ-teste', preregistrationSha256: PREREG, executorCodeSha: 'c'.repeat(40), timeoutMs: ECON_TIMEOUT_MS, g7bEstado: 'ABERTO',
    capsProfile: 'econ_dr277', caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '28' }, globalCampaignUsd: '132', pauseAtFractionOfSubLedger: 0.8 },
    scope: ALL, window: win, stops: [...GO_ECON_REQUIRED_STOPS], signedBy: 'human:G15', signatureStatement: 'GO de TESTE do auditor G15 D4 (fixture)', ...over,
  };
  g['goDigestSha256'] = sha256Canon(g); return JSON.stringify(g);
}
const provOf = (url: string) => (url.includes('anthropic') ? 'anthropic' : url.includes('openai') ? 'openai' : 'google') as 'anthropic' | 'openai' | 'google';
function realEnv(o: { win?: typeof W0; clock: () => number; envOk?: boolean }) {
  const a = ambiente({ blocks: 2 });
  const d = mkdtempSync(path.join(tmpdir(), 'g15d4-')); const envFile = path.join(d, 'h2eval.env');
  if (o.envOk !== false) writeFileSync(envFile, Object.values(VARS).map((v) => `${v}=zq-g15-d4-canary-sintetico`).join('\r\n') + '\r\n');
  const goFile = path.join(d, 'GO_ECON.json'); writeFileSync(goFile, goText({ cronogramaSha256: a.cfg.cronogramaSha256 }, o.win));
  const fetched: string[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => { const p = provOf(url); const model = (JSON.parse(init.body) as { model?: string }).model ?? /models\/([^:]+):/.exec(url)![1]!; fetched.push(model); return { status: 200, headers: new Headers(), json: async () => respostaDe(p, model, 'texto').body }; }) as unknown as typeof fetch;
  a.cfg.egress = { mode: 'REAL', realFlag: true, campaign: 'econ-teste', credentialEnvVars: { ...VARS }, envFile, envFileChecks: okChecks, fetchImpl, forbiddenEnvVars: [] };
  a.cfg.go = { file: goFile, preregistrationSha256: PREREG, treeClean: true, nowMs: o.clock };
  return { a, fetched, goFile, d };
}
const J = (dir: string) => readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; operationId: string; body: Record<string, unknown> });

test('[G15-D4] corrida guarda->egress na seq 2 (relógio próprio): PAUSA não terminal; duas reexecuções sem GO novo não enviam; GO novo envia a seq 2 uma vez', async () => {
  let phase: 'ok' | 'armed' | 'expired' = 'ok'; let n = 0;
  const { a, fetched, d } = realEnv({ clock: () => { if (phase === 'armed') { phase = 'expired'; return NOW; } return phase === 'expired' ? END + 1 : NOW; } });
  const f0 = a.cfg.egress.fetchImpl!; a.cfg.egress.fetchImpl = (async (...x: Parameters<typeof fetch>) => { const r = await f0(...x); if (++n === 2) phase = 'armed'; return r; }) as typeof fetch;
  const s1 = await runEcon(a.cfg); const j1 = J(a.cfg.batchDir); const op2 = a.cron[2]!.opId;
  assert.equal(fetched.length, 2); assert.equal(s1.parada!.stop, 'PAUSE_ECON_GO'); assert.equal(s1.parada!.seq, 2);
  const ofOp2 = j1.filter((l) => l.operationId === op2).map((l) => `${l.kind}:${String(l.body['gate'] ?? '')}:${String(l.body['code'] ?? l.body['reason'] ?? '')}`);
  assert.deepEqual(ofOp2, ['PAUSE_REVIEW:EGRESS:GO_EXPIRED']);
  // reexecução com o MESMO GO já vencido: o consumidor não começa, nada enviado, nada escrito
  const nj = J(a.cfg.batchDir).length; await assert.rejects(runEcon(a.cfg), /ECON_GO_INVALID: GO_EXPIRED/); assert.equal(fetched.length, 2); assert.equal(J(a.cfg.batchDir).length, nj, 'GO vencido: o consumidor nem começa, journal intocado'); const s1b = { parada: 'NAO_COMECA:ECON_GO_INVALID:GO_EXPIRED' };
  const go2 = path.join(d, 'GO2.json'); writeFileSync(go2, goText({ cronogramaSha256: a.cfg.cronogramaSha256 }, { notBeforeUtc: '2026-11-21T00:00:00Z', notAfterUtc: '2026-11-22T00:00:00Z' }));
  a.cfg.go = { ...a.cfg.go!, file: go2, nowMs: () => END + 3600_000 };
  const s2 = await runEcon(a.cfg); const j2 = J(a.cfg.batchDir);
  const sent = j2.filter((l) => l.kind === 'SENT').map((l) => l.operationId);
  assert.equal(s2.parada, null); assert.equal(s2.executadasPrefixo, 10); assert.equal(fetched.length, 10);
  assert.deepEqual(sent, a.cron.map((l) => l.opId)); assert.equal(new Set(sent).size, 10);
  assert.equal(j2.filter((l) => (l.kind === 'REPLAY_SKIPPED' || l.kind === 'ABORTED_BEFORE_SEND') && l.operationId === op2).length, 0, 'seq 2 sem REPLAY_SKIPPED nem ABORTED'); assert.equal(j2.filter((l) => l.kind === 'ABORTED_BEFORE_SEND').length, 0);
  dump('corrida', { run1: s1.parada, run1b: s1b.parada, run2: { parada: s2.parada, prefixo: s2.executadasPrefixo }, op2: j2.filter((l) => l.operationId === op2).map((l) => l.kind), enviados: fetched.length });
});

test('[G15-D4] margem: limites exatos (padrão 15 min; 660 000 aceito; 659 999, não inteiro e negativo recusados antes de criar arquivos)', async () => {
  assert.equal(ECON_GO_MARGEM_MS, 900_000);
  const res: Record<string, string> = {};
  for (const [nome, m] of [['659999', 659_999], ['10.5min', 630_000.5], ['negativo', -1], ['NaN', Number.NaN]] as const) {
    const { a } = realEnv({ clock: () => NOW }); a.cfg.go = { ...a.cfg.go!, marginMs: m };
    await assert.rejects(runEcon(a.cfg), /ECON_GO_MARGEM_INVALIDA/, nome);
    assert.equal(existsSync(path.join(a.cfg.batchDir, 'journal.jsonl')), false); assert.equal(existsSync(path.join(a.cfg.batchDir, 'ledger.jsonl')), false); res[nome] = 'recusada, nada criado';
  }
  // 660 000 com notAfter exatamente a 660 000 ms: envia (a regra é "< margem")
  { const { a, fetched } = realEnv({ clock: () => NOW, win: { notBeforeUtc: W0.notBeforeUtc, notAfterUtc: new Date(NOW + 660_000).toISOString() } }); a.cfg.go = { ...a.cfg.go!, marginMs: 660_000 };
    const s = await runEcon(a.cfg); assert.equal(s.parada, null); assert.equal(fetched.length, 10); res['660000_igual'] = 'envia'; }
  // padrão: 15 min - 1 ms => pausa sem PLANNED/RESERVED/SENT; 15 min exatos => envia
  { const { a, fetched } = realEnv({ clock: () => NOW, win: { notBeforeUtc: W0.notBeforeUtc, notAfterUtc: new Date(NOW + 900_000 - 1).toISOString() } });
    const s = await runEcon(a.cfg); assert.equal(fetched.length, 0); assert.equal(s.parada!.stop, 'PAUSE_ECON_GO');
    const j = J(a.cfg.batchDir); assert.deepEqual(j.map((l) => l.kind).filter((k) => ['PLANNED', 'RESERVED', 'SENT', 'ABORTED_BEFORE_SEND', 'STOP_GLOBAL'].includes(k)), []);
    assert.ok(j.some((l) => l.kind === 'PAUSE_REVIEW' && l.body['motivo'] === 'GO_MARGEM_INSUFICIENTE')); res['15min-1ms'] = 'PAUSE_ECON_GO sem reserva'; }
  { const { a, fetched } = realEnv({ clock: () => NOW, win: { notBeforeUtc: W0.notBeforeUtc, notAfterUtc: new Date(NOW + 900_000).toISOString() } });
    const s = await runEcon(a.cfg); assert.equal(s.parada, null); assert.equal(fetched.length, 10); res['15min'] = 'envia'; }
  dump('margem', res);
});

test('[G15-D4] dentro do estudo, recusa do egress que NÃO é do GO (credencial ausente) vira PAUSA não terminal; reexecução com a credencial certa envia a seq 0 uma vez', async () => {
  const { a, fetched } = realEnv({ clock: () => NOW, envOk: false });
  const s = await runEcon(a.cfg); const j = J(a.cfg.batchDir);
  assert.equal(fetched.length, 0);
  // delta 5 (R-D4): nada terminal, nada planejado/reservado; pausa PAUSE_ECON_EGRESS com o código do egress
  assert.equal(j.filter((l) => l.kind === 'ABORTED_BEFORE_SEND').length, 0);
  const p = j.filter((l) => l.kind === 'PAUSE_REVIEW'); assert.equal(p.length, 1); assert.equal(p[0]!.body['reason'], 'PAUSE_ECON_EGRESS'); assert.equal(p[0]!.body['code'], 'ENV_FILE_MISSING');
  assert.equal(s.parada!.stop, 'PAUSE_ECON_EGRESS'); assert.equal(s.parada!.seq, 0);
  assert.equal(j.some((l) => l.kind === 'RESERVED' || l.kind === 'PLANNED' || l.kind === 'SENT'), false);
  const op0 = p[0]!.operationId;
  // reexecução com a credencial certa, mesmo diretório: a seq 0 é enviada UMA vez, sem REPLAY_SKIPPED, e a coleta completa em ordem
  writeFileSync(a.cfg.egress.envFile!, Object.values(VARS).map((v) => `${v}=zq-g15-d4-canary-sintetico`).join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10));
  const s2 = await runEcon(a.cfg); const j2 = J(a.cfg.batchDir);
  dump('credencialAusente', { run1: { parada: s.parada, reason: p[0]!.body['code'] }, run2: { parada: s2.parada, enviados: fetched.length, novas: j2.slice(j.length).map((l) => l.kind) } });
  assert.equal(j2.filter((l) => l.kind === 'REPLAY_SKIPPED' && l.operationId === op0).length, 0, 'sem REPLAY_SKIPPED');
  assert.equal(j2.filter((l) => l.kind === 'SENT' && l.operationId === op0).length, 1, 'seq 0 enviada uma vez');
  assert.equal(s2.parada, null); assert.equal(fetched.length, 10); assert.deepEqual(j2.filter((l) => l.kind === 'SENT').map((l) => l.operationId), a.cron.map((l) => l.opId));
});

test('[G15-D4] classe da recusa no egress: só o ramo ECON gera EgressGoEconRefused; arquivo ausente/ilegível/inválido e single/multi seguem EgressRefused simples', () => {
  const req = (url: string, body: unknown): BuiltRequest => ({ url, method: 'POST', headers: { 'content-type': 'application/json' }, credentialHeader: 'x-api-key', credentialFormat: 'raw', body, textParts: [], nonTextParts: [] });
  const d = mkdtempSync(path.join(tmpdir(), 'g15d4eg-')); const envFile = path.join(d, 'h2eval.env'); writeFileSync(envFile, `${VARS.anthropic}=zq-g15-d4-canary-sintetico\r\n`);
  const mk = (goFile: string, goEcon?: unknown) => createEgress({ mode: 'REAL', realFlag: true, campaign: 'econ-teste', allowedHosts: [...ECON_ALLOWED_HOSTS], goFile, preregistrationSha256: PREREG, credentialEnvVars: { anthropic: VARS.anthropic }, envFile, envFileChecks: okChecks, fetchImpl: (async () => { throw new Error('nunca'); }) as unknown as typeof fetch, forbiddenEnvVars: [], now: () => NOW, ...(goEcon ? { goEcon } : {}) } as Parameters<typeof createEgress>[0]);
  const pc = { provider: 'anthropic' as const, phase: 'X', modelRequested: 'claude-opus-5-5', batchId: 'b', executorVersion: 'x', executorCodeSha: 'c'.repeat(40), ledgerCaps: { campaignUsd: '132', providerUsd: '95' } };
  const cls = (eg: ReturnType<typeof createEgress>) => { try { eg.preflight(pc, req('https://api.anthropic.com/v1/messages', { model: 'claude-opus-5-5' }), ['api.anthropic.com']); return 'OK'; } catch (e) { return `${(e as Error).constructor.name}:${(e as EgressRefused).code}`; } };
  const f = (t: string) => { const p = path.join(mkdtempSync(path.join(tmpdir(), 'g15d4f-')), 'GO.json'); writeFileSync(p, t); return p; };
  const validator = { validate: () => ({ code: 'GO_EXPIRED', pauseAck: null }) };
  const r: Record<string, string> = {
    ausente: cls(mk(path.join(d, 'nao-existe.json'), validator)),
    invalido: cls(mk(f('{nao json'), validator)),
    single: cls(mk(f(JSON.stringify({ schema: 'h2eval.go.v1', campaign: 'econ-teste' })), validator)),
    multi: cls(mk(f(JSON.stringify({ schema: 'h2eval.go.multi.v1', campaign: 'econ-teste' })), validator)),
    outro: cls(mk(f('{"schema":"outro"}'), validator)),
    econ_vencido: cls(mk(f(goText({ cronogramaSha256: 'f'.repeat(64) })), validator)),
    econ_sem_validador: cls(mk(f(goText({ cronogramaSha256: 'f'.repeat(64) })))),
  };
  for (const k of ['ausente', 'invalido', 'single', 'multi', 'outro']) assert.match(r[k]!, /^EgressRefused:/, k);
  assert.equal(r['econ_vencido'], 'EgressGoEconRefused:GO_EXPIRED'); assert.equal(r['econ_sem_validador'], 'EgressGoEconRefused:GO_ECON_CONTEXT_MISSING');
  dump('classes', r);
});

// EXEC-ECON (incorporacao): o import original nao era usado em valor (tsc TS6133 sob noUnusedLocals); referencia explicita, sem mudar teste.
void EgressGoEconRefused;
