/**
 * G15 EXEC-ECON delta 2/3 (auditor-independente C160): testes próprios do auditor sobre a44175b3. Offline, transporte falso, credencial
 * sintética em arquivo temporário, US$ 0.
 * INCORPORADO pelo agente EXEC-ECON C160 no delta 4 (R-D2: mutantes B03/B05), de runs/C160/EXEC_ECON_G15/D23/replica/g15tests/. Única mudança
 * de conteúdo: o teste da corrida (R-D1) passa a exigir o comportamento NOVO do delta 4 (recusa de GO ECON no egress = pausa não terminal;
 * a reexecução com GO novo no MESMO diretório envia a seq 2, nunca REPLAY_SKIPPED). O original media o travamento (ABORTED_BEFORE_SEND).
 *
 * English summary: an independent auditor's own tests of the economic study's GO handling, kept in the suite: a
 * race between the order guard and the egress, the cumulative attempt budget, a sequence range not starting at 0,
 * a GO of the wrong schema, a GO changed on disk mid-run, extra egress refusals, and a probe over the five models
 * that includes a null stop reason with complete usage.
 *
 * Modules under test: `scripts/h2eval/core/egress.ts` (`createEgress`, `EgressRefused`), `scripts/h2eval/econ/econ.ts`
 * (`runEcon`, `goEconEgressValidator`, `ECON_ALLOWED_HOSTS`) and `scripts/h2eval/econ/goEcon.ts`, using the fixture in
 * `./econ_fixture.ts`.
 *
 * Needs: a writable temporary directory; the credential is a synthetic value in a temporary file. The last test
 * reads and imports the study's external grading module from a fixed folder outside the repository (hash
 * checked) and fails, rather than skips, when that file is absent. Optional environment variable `G15_D23_OUT`:
 * when set, the test writes a JSON dump of intermediate values to that path. Fake transport; no network, no
 * spending.
 *
 * Run just this file: `npx tsx --test test/h2eval/econ/g15d23_extra.test.ts`
 *
 * @module test/h2eval/econ/g15d23_extra.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256Canon, sha256Hex } from '../../../scripts/h2eval/core/canon.js';
import { createEgress, EgressRefused } from '../../../scripts/h2eval/core/egress.js';
import { GO_ECON_REQUIRED_STOPS, type GoEconV1, type GoEconContext } from '../../../scripts/h2eval/econ/goEcon.js';
import { runEcon, goEconEgressValidator, ECON_TIMEOUT_MS, ECON_ALLOWED_HOSTS } from '../../../scripts/h2eval/econ/econ.js';
import { CAPS_PROFILE_ECON_DR277 } from '../../../scripts/h2eval/core/ledger.js';
import { ambiente, respostaDe, MODELOS } from './econ_fixture.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const END = Date.parse('2026-11-21T00:00:00Z');
const PREREG = '9'.repeat(64);
const VARS = { anthropic: 'H2EVAL_G15D23_VAR_A', openai: 'H2EVAL_G15D23_VAR_O', google: 'H2EVAL_G15D23_VAR_G' } as const;
const okChecks = { insideGitTree: () => false, insideSyncFolder: () => false, aclWide: () => false as boolean | null };
const ALL = { providers: ['openai', 'google', 'anthropic'], modelIds: ['gpt-6-luna', 'gemini-3.1-flash-lite', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5'], seqFrom: 0, seqTo: 9, maxAttempts: 10 };
const OUT = process.env.G15_D23_OUT;
const out: Record<string, unknown> = {};
function dump(k: string, v: unknown) { out[k] = v; if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1)); }

function goText(over: Record<string, unknown>, win = { notBeforeUtc: '2026-11-20T00:00:00Z', notAfterUtc: '2026-11-21T00:00:00Z' }): string {
  const g: Record<string, unknown> = {
    schema: 'h2eval.go.econ.v1', campaign: 'econ-teste', studyId: 'econ-teste', preregistrationSha256: PREREG, executorCodeSha: 'c'.repeat(40), timeoutMs: ECON_TIMEOUT_MS, g7bEstado: 'ABERTO',
    capsProfile: 'econ_dr277', caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '28' }, globalCampaignUsd: '132', pauseAtFractionOfSubLedger: 0.8 },
    scope: ALL, window: win, stops: [...GO_ECON_REQUIRED_STOPS], signedBy: 'human:G15', signatureStatement: 'GO de TESTE do auditor G15 (fixture)', ...over,
  };
  g['goDigestSha256'] = sha256Canon(g); return JSON.stringify(g);
}
const provOf = (url: string) => (url.includes('anthropic') ? 'anthropic' : url.includes('openai') ? 'openai' : 'google') as 'anthropic' | 'openai' | 'google';
function fakeFetch(fetched: string[]) {
  return (async (url: string, init: { body: string }) => { const p = provOf(url); const model = (JSON.parse(init.body) as { model?: string }).model ?? /models\/([^:]+):/.exec(url)![1]!; fetched.push(model); return { status: 200, headers: new Headers(), json: async () => respostaDe(p, model, 'texto').body }; }) as unknown as typeof fetch;
}
function realEnv(o: { goOver?: Record<string, unknown>; clock: () => number }) {
  const a = ambiente({ blocks: 2 });
  const d = mkdtempSync(path.join(tmpdir(), 'g15d23-')); const envFile = path.join(d, 'h2eval.env');
  writeFileSync(envFile, Object.values(VARS).map((v) => `${v}=zq-g15-d23-canary-sintetico`).join('\r\n') + '\r\n');
  const goFile = path.join(d, 'GO_ECON.json'); writeFileSync(goFile, goText({ cronogramaSha256: a.cfg.cronogramaSha256, ...o.goOver }));
  const fetched: string[] = [];
  a.cfg.egress = { mode: 'REAL', realFlag: true, campaign: 'econ-teste', credentialEnvVars: { ...VARS }, envFile, envFileChecks: okChecks, fetchImpl: fakeFetch(fetched), forbiddenEnvVars: [] };
  a.cfg.go = { file: goFile, preregistrationSha256: PREREG, treeClean: true, nowMs: o.clock };
  return { a, fetched, goFile, d };
}
const journalOf = (dir: string) => readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; operationId: string; body: Record<string, unknown> });

// ------------------------------------------------------------------ (3) corrida: o GO vence entre a guarda e o egress, e depois?
test('[G15-D23] corrida guarda->egress na seq 2: nada enviado na 2; prefixo 0..1 preservado; reexecução com GO novo no MESMO diretório', async () => {
  let phase: 'ok' | 'armed' | 'expired' = 'ok'; let after = 0;
  const { a, fetched, d } = realEnv({ clock: () => { if (phase === 'armed') { phase = 'expired'; return NOW; } return phase === 'expired' ? END + 1 : NOW; } });
  const origFetch = a.cfg.egress.fetchImpl!; a.cfg.egress.fetchImpl = (async (...x: Parameters<typeof fetch>) => { const r = await origFetch(...x); if (++after === 2) phase = 'armed'; return r; }) as typeof fetch;
  const s1 = await runEcon(a.cfg);
  const j1 = journalOf(a.cfg.batchDir); const ab = j1.filter((l) => l.kind === 'ABORTED_BEFORE_SEND');
  assert.equal(fetched.length, 2); assert.equal(s1.executadasPrefixo, 2);
  // delta 4 (R-D1): a recusa do GO ECON no egress é PAUSA não terminal da seq 2 (nada reservado nem enviado), não ABORTED_BEFORE_SEND
  assert.equal(ab.length, 0, 'nenhuma tentativa terminal sem envio');
  assert.equal(s1.parada!.stop, 'PAUSE_ECON_GO'); assert.equal(s1.parada!.seq, 2);
  const p2 = j1.filter((l) => l.kind === 'PAUSE_REVIEW'); assert.equal(p2.length, 1); assert.equal(p2[0]!.body['code'], 'GO_EXPIRED'); assert.equal(p2[0]!.body['gate'], 'EGRESS');
  const seq2 = p2[0]!.operationId;
  assert.equal(j1.filter((l) => (l.kind === 'RESERVED' || l.kind === 'PLANNED' || l.kind === 'SENT') && l.operationId === seq2).length, 0, 'nada planejado, reservado ou enviado na seq 2');
  // reexecução: GO novo válido (janela posterior), mesmo diretório
  const go2 = path.join(d, 'GO_ECON_2.json'); writeFileSync(go2, goText({ cronogramaSha256: a.cfg.cronogramaSha256 }, { notBeforeUtc: '2026-11-21T00:00:00Z', notAfterUtc: '2026-11-22T00:00:00Z' }));
  a.cfg.go = { ...a.cfg.go!, file: go2, nowMs: () => END + 3600_000 };
  let s2: unknown = null; let err: string | null = null; try { s2 = await runEcon(a.cfg); } catch (e) { err = String((e as Error).message ?? e); }
  const j2 = journalOf(a.cfg.batchDir);
  dump('corrida', { run1: { parada: s1.parada, prefixo: s1.executadasPrefixo, enviados: 2 }, run2: { erro: err, resumo: s2 ? { parada: (s2 as { parada: unknown }).parada, prefixo: (s2 as { executadasPrefixo: number }).executadasPrefixo } : null, enviadosTotal: fetched.length, journalNovasLinhas: j2.slice(j1.length).map((l) => `${l.kind}:${String((l.body as { reason?: string }).reason ?? '')}`) } });
  assert.equal(err, null);
  assert.equal(j2.filter((l) => l.kind === 'REPLAY_SKIPPED' && l.operationId === seq2).length, 0, 'a seq 2 NAO vira REPLAY_SKIPPED');
  assert.equal(j2.filter((l) => l.kind === 'SENT' && l.operationId === seq2).length, 1, 'a seq 2 é enviada uma vez na reexecução');
  assert.equal((s2 as { parada: unknown }).parada, null); assert.equal((s2 as { executadasPrefixo: number }).executadasPrefixo, 10); assert.equal(fetched.length, 10, 'prefixo completo, cada tentativa enviada uma vez');
  const sentOrder = j2.filter((l) => l.kind === 'SENT').map((l) => l.operationId); assert.deepEqual(sentOrder, a.cron.map((l) => l.opId), 'ordem seq mantida');
});

// ------------------------------------------------------------------ (2) maxAttempts é contado pelo journal: reexecução não estoura
test('[G15-D23] maxAttempts=3: 1a execução envia 3; reexecução com o MESMO GO não envia mais nenhuma', async () => {
  const { a, fetched } = realEnv({ goOver: { scope: { ...ALL, maxAttempts: 3 } }, clock: () => NOW });
  const s1 = await runEcon(a.cfg); assert.equal(fetched.length, 3); assert.equal(s1.parada!.stop, 'PAUSE_ECON_GO');
  const s2 = await runEcon(a.cfg); assert.equal(fetched.length, 3); assert.equal(s2.parada!.stop, 'PAUSE_ECON_GO');
  dump('maxAttemptsReexec', { run1: s1.parada, run2: s2.parada, enviados: fetched.length });
});
test('[G15-D23] faixa de seq que não começa em 0: pausa na seq 0 sem enviar nada', async () => {
  const { a, fetched } = realEnv({ goOver: { scope: { ...ALL, seqFrom: 3, seqTo: 9, maxAttempts: 7 } }, clock: () => NOW });
  const s = await runEcon(a.cfg); assert.equal(fetched.length, 0); assert.equal(s.parada!.stop, 'PAUSE_ECON_GO'); assert.equal(s.parada!.seq, 0);
});
test('[G15-D23] consumidor REAL com GO de outro schema (single) => não começa, nada criado', async () => {
  const { a, goFile } = realEnv({ clock: () => NOW });
  writeFileSync(goFile, JSON.stringify({ schema: 'h2eval.go.v1', campaign: 'econ-teste' }));
  await assert.rejects(runEcon(a.cfg), /ECON_GO_INVALID/);
  assert.equal(existsSync(path.join(a.cfg.batchDir, 'journal.jsonl')), false); assert.equal(existsSync(path.join(a.cfg.batchDir, 'ledger.jsonl')), false);
});
test('[G15-D23] GO trocado no disco no meio da coleta: pausa (guarda) e nada enviado depois', async () => {
  const { a, fetched, goFile } = realEnv({ clock: () => NOW });
  const orig = a.cfg.egress.fetchImpl!; let n = 0;
  a.cfg.egress.fetchImpl = (async (...x: Parameters<typeof fetch>) => { const r = await orig(...x); if (++n === 4) writeFileSync(goFile, goText({ cronogramaSha256: a.cfg.cronogramaSha256, signatureStatement: 'GO de TESTE do auditor G15 trocado' })); return r; }) as typeof fetch;
  const s = await runEcon(a.cfg); assert.equal(fetched.length, 4); assert.equal(s.parada!.stop, 'PAUSE_ECON_GO');
});

// ------------------------------------------------------------------ egress direto: casos além dos do produtor
const req = (url: string, body: unknown): BuiltRequest => ({ url, method: 'POST', headers: { 'content-type': 'application/json' }, credentialHeader: 'x-api-key', credentialFormat: 'raw', body, textParts: [], nonTextParts: [] });
function egressWith(goFile: string, goEcon: Parameters<typeof createEgress>[0]['goEcon'], nowMs = NOW, extra: Record<string, unknown> = {}) {
  const d = mkdtempSync(path.join(tmpdir(), 'g15d23eg-')); const envFile = path.join(d, 'h2eval.env'); writeFileSync(envFile, Object.values(VARS).map((v) => `${v}=zq-g15-d23-canary-sintetico`).join('\r\n') + '\r\n');
  let calls = 0; const fetchImpl = (async () => { calls++; return { status: 200, headers: new Headers(), json: async () => ({}) }; }) as unknown as typeof fetch;
  const eg = createEgress({ mode: 'REAL', realFlag: true, campaign: 'econ-teste', allowedHosts: [...ECON_ALLOWED_HOSTS], goFile, preregistrationSha256: PREREG, credentialEnvVars: { ...VARS }, envFile, envFileChecks: okChecks, fetchImpl, forbiddenEnvVars: [], now: () => nowMs, ...(goEcon ? { goEcon } : {}), ...extra } as Parameters<typeof createEgress>[0]);
  return { eg, calls: () => calls };
}
const pcA = (o: Record<string, unknown> = {}) => ({ provider: 'anthropic' as const, phase: 'COMPARATIVE_PAIRED', modelRequested: 'claude-opus-5-5', batchId: 'econ-b0000', executorVersion: 'x', executorCodeSha: 'c'.repeat(40), ledgerCaps: { campaignUsd: '132', providerUsd: '95' }, ...o });
function validatorFor(text: string, o: { sha0?: string; treeClean?: boolean | null; len?: number } = {}) {
  const go0 = JSON.parse(text) as GoEconV1;
  const ctxOf = (): GoEconContext => ({ campaign: 'econ-teste', studyId: 'econ-teste', preregistrationSha256: PREREG, executorCodeSha: 'c'.repeat(40), treeClean: o.treeClean === undefined ? true : o.treeClean, cronogramaSha256: 'f'.repeat(64), cronogramaLength: o.len ?? 10, timeoutMs: ECON_TIMEOUT_MS, g7bEstado: 'ABERTO', ledgerCaps: { campaignUsd: CAPS_PROFILE_ECON_DR277.campaign, providersUsd: { ...CAPS_PROFILE_ECON_DR277.providers } }, nowMs: 0 });
  return goEconEgressValidator({ sha0: o.sha0 ?? sha256Hex(text), go0, ctxOf, executorCodeSha: 'c'.repeat(40), campaign: 'econ-teste' });
}
function goFileWith(over: Record<string, unknown> = {}, win?: { notBeforeUtc: string; notAfterUtc: string }) { const d = mkdtempSync(path.join(tmpdir(), 'g15d23gf-')); const file = path.join(d, 'GO.json'); const text = goText({ cronogramaSha256: 'f'.repeat(64), ...over }, win); writeFileSync(file, text); return { file, text }; }
const RA = 'https://api.anthropic.com/v1/messages'; const RO = 'https://api.openai.com/v1/chat/completions';
const codeOf = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return e instanceof EgressRefused ? e.code : 'NAO_EGRESS:' + String((e as Error).message).slice(0, 40); } };

test('[G15-D23] egress recusa sem enviar: casos adicionais do auditor', async () => {
  const res: Record<string, string | null> = {};
  const C: Array<[string, () => { eg: ReturnType<typeof createEgress>; calls: () => number }, Record<string, unknown>, string, string]> = [
    ['executor da tentativa difere', () => { const g = goFileWith(); return egressWith(g.file, validatorFor(g.text)); }, { executorCodeSha: 'd'.repeat(40) }, RA, 'GO_EXECUTOR_MISMATCH'],
    ['campanha do egress difere', () => { const g = goFileWith(); return egressWith(g.file, validatorFor(g.text), NOW, { campaign: 'outra' }); }, {}, RA, 'GO_EXECUTOR_MISMATCH'],
    ['provedor fora do escopo', () => { const g = goFileWith({ scope: { providers: ['anthropic'], modelIds: ['claude-opus-5-5'], seqFrom: 0, seqTo: 9, maxAttempts: 10 } }); return egressWith(g.file, validatorFor(g.text)); }, { provider: 'openai', modelRequested: 'gpt-6-luna', ledgerCaps: { campaignUsd: '132', providerUsd: '11' } }, RO, 'GO_PROVIDER_OR_MODEL_NOT_IN_SCOPE'],
    ['arquivo alterado no disco depois do inicio', () => { const g = goFileWith(); const v = validatorFor(g.text); writeFileSync(g.file, g.text.replace('fixture', 'fixturX')); return egressWith(g.file, v); }, {}, RA, 'GO_CHANGED_DURING_RUN'],
    ['janela maior que 7 dias', () => { const g = goFileWith({}, { notBeforeUtc: '2026-11-15T00:00:00Z', notAfterUtc: '2026-11-23T00:00:00Z' }); return egressWith(g.file, validatorFor(g.text)); }, {}, RA, 'GO_WINDOW_TOO_LONG'],
    ['maxAttempts maior que a faixa', () => { const g = goFileWith({ scope: { ...ALL, seqTo: 4, maxAttempts: 6 } }); return egressWith(g.file, validatorFor(g.text)); }, {}, RA, 'GO_MAX_ATTEMPTS'],
    ['seqTo fora do cronograma', () => { const g = goFileWith({ scope: { ...ALL, seqTo: 10, maxAttempts: 10 } }); return egressWith(g.file, validatorFor(g.text)); }, {}, RA, 'GO_SEQ_RANGE'],
    ['teto global abaixo', () => { const g = goFileWith({ caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '28' }, globalCampaignUsd: '131', pauseAtFractionOfSubLedger: 0.8 } }); return egressWith(g.file, validatorFor(g.text)); }, {}, RA, 'GO_CAPS_MISMATCH'],
    ['pausa 0,9', () => { const g = goFileWith({ caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '28' }, globalCampaignUsd: '132', pauseAtFractionOfSubLedger: 0.9 } }); return egressWith(g.file, validatorFor(g.text)); }, {}, RA, 'GO_CAPS'],
    ['arvore suja', () => { const g = goFileWith(); return egressWith(g.file, validatorFor(g.text, { treeClean: false })); }, {}, RA, 'GO_EXECUTOR_TREE_DIRTY'],
    ['assinatura nao humana', () => { const g = goFileWith({ signedBy: 'agent:x' }); return egressWith(g.file, validatorFor(g.text)); }, {}, RA, 'GO_UNSIGNED'],
    ['digest adulterado', () => { const g = goFileWith(); const t = g.text.replace(/"goDigestSha256":"[0-9a-f]+"/, `"goDigestSha256":"${'0'.repeat(64)}"`); writeFileSync(g.file, t); return egressWith(g.file, validatorFor(t)); }, {}, RA, 'GO_DIGEST_MISMATCH'],
    ['curinga no modelo', () => { const g = goFileWith({ scope: { ...ALL, modelIds: ['*'] } }); return egressWith(g.file, validatorFor(g.text)); }, {}, RA, 'GO_MODEL_NOT_ECON'],
    ['limite exato notAfter', () => { const g = goFileWith(); return egressWith(g.file, validatorFor(g.text), END); }, {}, RA, 'GO_EXPIRED'],
    ['sem REAL flag', () => { const g = goFileWith(); return egressWith(g.file, validatorFor(g.text), NOW, { realFlag: false }); }, {}, RA, 'REAL_FLAG_MISSING'],
    ['GO ECON com goMulti configurado mas sem goEcon', () => { const g = goFileWith(); return egressWith(g.file, undefined, NOW, { goMulti: { anything: true } }); }, {}, RA, 'GO_ECON_CONTEXT_MISSING'],
  ];
  for (const [nome, mk, pco, url, want] of C) {
    const { eg, calls } = mk(); const got = codeOf(() => eg.preflight(pcA(pco) as never, req(url, { model: (pco['modelRequested'] as string) ?? 'claude-opus-5-5' }), [new URL(url).hostname]));
    res[nome] = got; assert.equal(got, want, nome); assert.equal(calls(), 0, nome);
  }
  // validador que lança: preflight falha (não é EgressRefused), nenhum token, nenhum envio
  { const g = goFileWith(); const { eg, calls } = egressWith(g.file, { validate: () => { throw new Error('boom'); } }); const r = req(RA, { model: 'claude-opus-5-5' });
    res['validador lanca'] = codeOf(() => eg.preflight(pcA() as never, r, ['api.anthropic.com'])); assert.equal(calls(), 0);
    await assert.rejects(eg.send('anthropic', r, 'x'.repeat(32)), /PREFLIGHT_TOKEN_INVALID/); assert.equal(calls(), 0); }
  // pauseAck só do próprio provedor
  { const g = goFileWith({ pauseAck80pct: { openai: { acknowledgedBy: 'human:G15', atUtc: '2026-11-20T00:00:00Z' } } }); const { eg } = egressWith(g.file, validatorFor(g.text));
    const pf = eg.preflight(pcA() as never, req(RA, { model: 'claude-opus-5-5' }), ['api.anthropic.com']); res['pauseAck de outro provedor'] = String(pf.goPauseAck); assert.equal(pf.goPauseAck, null); assert.equal(pf.goMaxCalls, null); }
  // token: preso ao corpo e ao provedor, uso único
  { const g = goFileWith(); const { eg, calls } = egressWith(g.file, validatorFor(g.text)); const r = req(RA, { model: 'claude-opus-5-5' });
    const pf = eg.preflight(pcA() as never, r, ['api.anthropic.com']);
    await assert.rejects(eg.send('anthropic', req(RA, { model: 'claude-opus-5-5', x: 1 }), pf.token), /PREFLIGHT_TOKEN_INVALID/);
    await assert.rejects(eg.send('anthropic', r, pf.token), /PREFLIGHT_TOKEN_INVALID/, 'consumido pela tentativa falha'); assert.equal(calls(), 0);
    const pf2 = eg.preflight(pcA() as never, r, ['api.anthropic.com']); await assert.rejects(eg.send('openai', r, pf2.token), /PREFLIGHT_TOKEN_INVALID/); assert.equal(calls(), 0);
    const pf3 = eg.preflight(pcA() as never, r, ['api.anthropic.com']); await eg.send('anthropic', r, pf3.token); assert.equal(calls(), 1);
    await assert.rejects(eg.send('anthropic', r, pf3.token), /PREFLIGHT_TOKEN_INVALID/); assert.equal(calls(), 1); res['token'] = 'uso unico, preso a corpo e provedor'; }
  dump('egressCasos', res);
});

// ------------------------------------------------------------------ (4) R-A pelos 3 provedores e pela porta v3.2 real
const RUBRICA = 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/C160/ECON_PREP/V3_2/KIT/rubrica_econ.mjs';
test('[G15-D23] R-A: sonda própria nos 5 modelos; inclui stop nulo com uso COMPLETO (o A1)', async () => {
  assert.equal(createHash('sha256').update(readFileSync(RUBRICA)).digest('hex'), '73b4f4000797088bfee3211d63f95129b5663c10c4b29914ebf753b731148d2a');
  const { portaOperacional } = (await import(pathToFileURL(RUBRICA).href)) as { portaOperacional: (op: unknown, t: unknown, aceitos: unknown) => { classe: string } };
  const nullStopFullUsage = (provider: string, model: string) => {
    const r = respostaDe(provider as never, model, 'texto') as { httpStatus: number; body: Record<string, unknown> }; const b = JSON.parse(JSON.stringify(r.body)) as Record<string, any>; // eslint-disable-line
    if (provider === 'anthropic') b['stop_reason'] = null; else if (provider === 'openai') b['choices'][0]['finish_reason'] = null; else delete b['candidates'][0]['finishReason'];
    return { httpStatus: 200, body: b };
  };
  const casos: Record<string, (p: string, m: string) => { httpStatus: number; body: unknown }> = {
    texto: (p, m) => respostaDe(p as never, m, 'texto'), limite: (p, m) => respostaDe(p as never, m, 'limite'), nulo_parcial: (p, m) => respostaDe(p as never, m, 'nulo'),
    nulo_uso_completo: nullStopFullUsage, filtro: (p, m) => respostaDe(p as never, m, 'filtro'),
  };
  const tab: Record<string, Record<string, { truncated: unknown; stopReason: unknown; outcome: unknown; classe: string; enviados: number }>> = {};
  for (const [model, provider, arm] of MODELOS) for (const [nome, f] of Object.entries(casos)) {
    const a = ambiente({ only: model, blocks: 1, answer: (r) => f(provider, (r.body as { model?: string }).model ?? model) });
    await runEcon(a.cfg);
    const tf = path.join(a.cfg.batchDir, 'TENTATIVAS.jsonl'); const t = existsSync(tf) ? JSON.parse(readFileSync(tf, 'utf8').trim()) as Record<string, unknown> : null;
    const cls = portaOperacional({ opId: a.cron[0]!.opId, itemId: a.cron[0]!.itemId, arm, model }, t, { [arm]: { [model]: [model] } }).classe;
    (tab[model] ??= {})[nome] = { truncated: t?.['truncated'], stopReason: t?.['stopReason'], outcome: t?.['outcome'], classe: cls, enviados: a.sent.length };
    if (nome === 'texto') { assert.equal(t!['truncated'], false); assert.equal(cls, 'OK'); }
    if (nome === 'limite') { assert.equal(t!['truncated'], true); assert.equal(cls, 'TRUNCADO'); }
    if (nome.startsWith('nulo')) { assert.notEqual(cls, 'OK', `${model} ${nome}`); if (t) assert.equal(t['truncated'], 'UNKNOWN'); }
    if (t) assert.ok(typeof t['truncated'] === 'boolean' || t['truncated'] === 'UNKNOWN');
  }
  dump('RA', tab);
});
