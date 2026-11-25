/**
 * Tests the connectivity preflight that must pass before a REAL run: injected TLS and HTTP probes, the journal
 * line it writes, the environment fingerprint and the REAL-mode gate.
 *
 * Modules under test: `scripts/h2eval/cli/preflight.ts` (`preflightConnectivity`, `preflightGate`,
 * `latestPreflight`, `envFingerprint`, `campaignJournalPath`, `PROVIDER_PROBES`, `PREFLIGHT_MAX_AGE_MS`),
 * `scripts/h2eval/cli/run.ts` (`realPreconditions`, `runAuthorized`) and the journal verifier.
 *
 * Strategy / partitions: PASS (verified TLS and the expected "unauthenticated" HTTP status) appends a hash-chained
 * line with issuer and fingerprints and no credential; TLS failure (the HTTP probe is never attempted; an exception
 * code is recorded, its message never); unexpected HTTP status or a throwing probe; a forbidden environment
 * variable present (its name recorded, never its value); fingerprint sensitivity (names and CA policy only); the
 * gate states missing, failed, stale, environment mismatch and pass; a REAL run listing the missing preflight for
 * every provider in scope; and source guards that read `scripts/h2eval/cli/preflight.ts` as text (TLS checks never
 * turned off, no credential variable or env file referenced, default HTTP probe without credential headers, no
 * redirects followed).
 *
 * Needs: a writable temporary directory; probes are injected, so no socket, no network and no credential. The
 * environment passed to the code under test is a synthetic object, not the process environment.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/preflight.test.ts`
 *
 * @module test/h2eval/cli/preflight.test
 */
// SYNTHETIC — OFFLINE. CYCLE2-B (proposal C147): `preflight-connectivity` with INJECTED probes (no socket, no credential). PASS appends a
// hash-chained PREFLIGHT_CONNECTIVITY line to the campaign journal (issuer, leaf fingerprint, HTTP 401, env fingerprint); TLS verification
// failure => FAIL with the non-secret code and the HTTP probe is never attempted; unexpected HTTP status => FAIL; probe exception => FAIL with
// the cause code (message text never journaled); forbidden env present => FAIL. The REAL gate refuses MISSING / FAILED / STALE / ENV_MISMATCH
// and run-authorized --mode real lists the code for every provider in scope. Source guards: verification is never disabled, no credential
// variable is ever referenced by the module, default HTTP probe sends no credential header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preflightConnectivity, preflightGate, latestPreflight, envFingerprint, campaignJournalPath, PROVIDER_PROBES, PREFLIGHT_MAX_AGE_MS, type PreflightProbes, type TlsProbeResult } from '../../../scripts/h2eval/cli/preflight.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { realPreconditions, runAuthorized } from '../../../scripts/h2eval/cli/run.js';
import { CliError, EXIT } from '../../../scripts/h2eval/cli/common.js';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { syntheticMultiGo } from '../support/gomulti.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-preflight-${p}-`));
const SECRET = 'https://api.anthropic.com/v1/models?x-api-key=sk-SYNTHETIC-NEVER-A-KEY';
const okTls: TlsProbeResult = { authorized: true, authorizationError: null, issuer: 'CN=WE1, O=Google Trust Services', subject: 'CN=api.anthropic.com', fingerprint256: 'AA:BB:' + 'CC:'.repeat(29) + 'DD', validFrom: 'Sep 21 18:15:27 2026 GMT', validTo: 'Dec 20 19:15:03 2026 GMT', protocol: 'TLSv1.3' };
const probes = (o: { tls?: () => Promise<TlsProbeResult>; http?: (url: string) => Promise<{ status: number }> }): PreflightProbes & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, tls: async (h) => { calls.push(`tls:${h}`); return (o.tls ?? (async () => okTls))(); }, http: async (u) => { calls.push(`http:${u}`); return (o.http ?? (async () => ({ status: 401 })))(u); } };
};
const ENV = { PATH: 'x', SYSTEMROOT: 'y', NODE_EXTRA_CA_CERTS: '' } as NodeJS.ProcessEnv;
const NOW = Date.parse('2026-11-11T10:00:00.000Z');

test('PASS: TLS verificado + HTTP 401 => linha PREFLIGHT_CONNECTIVITY encadeada no journal da campanha, com emissor, fingerprint, fingerprint do ambiente; nenhum cabecalho de credencial', async () => {
  const dir = tmp('pass'); const p = probes({});
  const r = await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env: ENV, probes: p, now: () => NOW, nodeVersion: 'v24.22.2' });
  assert.deepEqual([r.verdict, r.failCode, r.host, r.http?.status, r.tls?.issuer, r.tls?.fingerprint256, r.nodeVersion, r.caPathPresent, r.forbiddenEnvPresent], ['PASS', null, 'api.anthropic.com', 401, okTls.issuer, okTls.fingerprint256, 'v24.22.2', false, []]);
  assert.deepEqual(p.calls, ['tls:api.anthropic.com', 'http:https://api.anthropic.com/v1/models']);
  const lines = verifyJournalText(readFileSync(campaignJournalPath(dir), 'utf8'));
  assert.equal(lines.length, 1); assert.deepEqual([lines[0]!.kind, lines[0]!.operationId], ['PREFLIGHT_CONNECTIVITY', 'NONE']);
  assert.equal(r.envFingerprint, envFingerprint(ENV, 'v24.22.2'));
  assert.equal(latestPreflight(dir, 'anthropic')?.body.verdict, 'PASS'); assert.equal(latestPreflight(dir, 'openai'), null);
  // a second line chains after the first
  await preflightConnectivity({ campaignDir: dir, provider: 'openai', env: ENV, probes: probes({}), now: () => NOW });
  assert.equal(verifyJournalText(readFileSync(campaignJournalPath(dir), 'utf8')).length, 2);
});

test('FAIL TLS: cadeia nao verificada => TLS_<codigo>, sonda HTTP NUNCA chamada; excecao do tls com cause.code => mesmo tratamento; mensagem nunca no journal', async () => {
  const dir = tmp('failtls');
  const p1 = probes({ tls: async () => ({ ...okTls, authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', issuer: 'CN=AVG Web/Mail Shield Root' }) });
  const r1 = await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env: ENV, probes: p1, now: () => NOW });
  assert.deepEqual([r1.verdict, r1.failCode, r1.http, p1.calls.length, r1.tls?.issuer], ['FAIL', 'TLS_UNABLE_TO_VERIFY_LEAF_SIGNATURE', null, 1, 'CN=AVG Web/Mail Shield Root']);
  const p2 = probes({ tls: async () => { throw Object.assign(new Error(SECRET), { code: 'CERT_HAS_EXPIRED' }); } });
  const r2 = await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env: ENV, probes: p2, now: () => NOW });
  assert.deepEqual([r2.verdict, r2.failCode, r2.tls, r2.http, p2.calls.length], ['FAIL', 'TLS_CERT_HAS_EXPIRED', null, null, 1]);
  const p3 = probes({ tls: async () => { throw new Error(SECRET); } });
  const r3 = await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env: ENV, probes: p3, now: () => NOW });
  assert.equal(r3.failCode, 'TLS_UNKNOWN');
  assert.ok(!readFileSync(campaignJournalPath(dir), 'utf8').includes('sk-SYNTHETIC'), 'texto da excecao nunca no journal');
  assert.equal(latestPreflight(dir, 'anthropic')?.body.verdict, 'FAIL');
});

test('FAIL HTTP: status fora do esperado (200 = algo respondeu sem exigir credencial; 500; 301) => HTTP_STATUS_UNEXPECTED; fetch que lanca => HTTP_<codigo>; Google aceita 401|403', async () => {
  const dir = tmp('failhttp');
  for (const st of [200, 500, 301, 403]) { const r = await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env: ENV, probes: probes({ http: async () => ({ status: st }) }), now: () => NOW }); assert.deepEqual([r.verdict, r.failCode, r.http?.status], ['FAIL', 'HTTP_STATUS_UNEXPECTED', st], String(st)); }
  const r = await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env: ENV, probes: probes({ http: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(SECRET), { code: 'ECONNRESET' }) }); } }), now: () => NOW });
  assert.deepEqual([r.verdict, r.failCode, r.http?.status], ['FAIL', 'HTTP_ECONNRESET', null]);
  const g = await preflightConnectivity({ campaignDir: dir, provider: 'google', env: ENV, probes: probes({ http: async () => ({ status: 403 }) }), now: () => NOW });
  assert.deepEqual([g.verdict, g.host], ['PASS', PROVIDER_PROBES.google.host]);
});

test('FAIL ambiente: variavel proibida presente (SSLKEYLOGFILE) => FORBIDDEN_ENV_PRESENT mesmo com TLS e HTTP corretos; nome registrado, valor nunca', async () => {
  const dir = tmp('env'); const env = { ...ENV, SSLKEYLOGFILE: '\\\\.\\device\\SYNTHETIC-VALUE' } as NodeJS.ProcessEnv;
  const r = await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env, probes: probes({}), now: () => NOW });
  assert.deepEqual([r.verdict, r.failCode, r.forbiddenEnvPresent], ['FAIL', 'FORBIDDEN_ENV_PRESENT', ['SSLKEYLOGFILE']]);
  assert.ok(!readFileSync(campaignJournalPath(dir), 'utf8').includes('SYNTHETIC-VALUE'));
});

test('envFingerprint: so NOMES e politica de CA; valor de variavel nao muda; nome novo, versao do Node, CA path ou conteudo do pem mudam', () => {
  const dir = tmp('fp'); const pem = path.join(dir, 'ca.pem'); writeFileSync(pem, 'SYNTHETIC CA A');
  const a = envFingerprint({ PATH: 'x', NODE_EXTRA_CA_CERTS: pem } as NodeJS.ProcessEnv, 'v24.22.2');
  assert.equal(envFingerprint({ PATH: 'other value', NODE_EXTRA_CA_CERTS: pem } as NodeJS.ProcessEnv, 'v24.22.2'), a, 'valores nao entram');
  assert.notEqual(envFingerprint({ PATH: 'x', NODE_EXTRA_CA_CERTS: pem, HTTPS_PROXY: 'p' } as NodeJS.ProcessEnv, 'v24.22.2'), a, 'nome novo');
  assert.notEqual(envFingerprint({ PATH: 'x', NODE_EXTRA_CA_CERTS: pem } as NodeJS.ProcessEnv, 'v24.22.3'), a, 'versao do Node');
  assert.notEqual(envFingerprint({ PATH: 'x' } as NodeJS.ProcessEnv, 'v24.22.2'), a, 'sem CA extra');
  writeFileSync(pem, 'SYNTHETIC CA B'); assert.notEqual(envFingerprint({ PATH: 'x', NODE_EXTRA_CA_CERTS: pem } as NodeJS.ProcessEnv, 'v24.22.2'), a, 'conteudo do pem');
  assert.notEqual(envFingerprint({ PATH: 'x', NODE_USE_SYSTEM_CA: '1' } as NodeJS.ProcessEnv, 'v24.22.2'), envFingerprint({ PATH: 'x', NODE_USE_SYSTEM_CA: '0' } as NodeJS.ProcessEnv, 'v24.22.2'), 'NODE_USE_SYSTEM_CA e politica, entra pelo valor');
});

test('gate REAL: MISSING, FAILED, STALE (> 60 min ou futuro), ENV_MISMATCH, PASS; realPreconditions com campaignDir lista o codigo com o provedor', async () => {
  const dir = tmp('gate'); const fp = envFingerprint(ENV, 'v24.22.2');
  assert.equal(preflightGate(dir, 'anthropic', { envFingerprint: fp, nowMs: NOW }), 'PREFLIGHT_CONNECTIVITY_MISSING');
  await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env: ENV, probes: probes({ http: async () => ({ status: 200 }) }), now: () => NOW, nodeVersion: 'v24.22.2' });
  assert.equal(preflightGate(dir, 'anthropic', { envFingerprint: fp, nowMs: NOW }), 'PREFLIGHT_CONNECTIVITY_FAILED');
  await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env: ENV, probes: probes({}), now: () => NOW, nodeVersion: 'v24.22.2' });
  const ts = Date.parse(latestPreflight(dir, 'anthropic')!.tsUtc);
  assert.equal(preflightGate(dir, 'anthropic', { envFingerprint: fp, nowMs: ts + 1000 }), null);
  assert.equal(preflightGate(dir, 'anthropic', { envFingerprint: fp, nowMs: ts + PREFLIGHT_MAX_AGE_MS + 1 }), 'PREFLIGHT_CONNECTIVITY_STALE');
  assert.equal(preflightGate(dir, 'anthropic', { envFingerprint: fp, nowMs: ts - 1000 }), 'PREFLIGHT_CONNECTIVITY_STALE', 'relogio no passado tambem recusa');
  assert.equal(preflightGate(dir, 'anthropic', { envFingerprint: envFingerprint({ ...ENV, HTTPS_PROXY: 'p' } as NodeJS.ProcessEnv, 'v24.22.2'), nowMs: ts + 1000 }), 'PREFLIGHT_ENV_MISMATCH');
  assert.equal(preflightGate(dir, 'openai', { envFingerprint: fp, nowMs: ts + 1000 }), 'PREFLIGHT_CONNECTIVITY_MISSING', 'por provedor');
  // through realPreconditions (plan/batch stubs; env without credential/GO so other codes appear too)
  const plan = { preregistration: { ratified: true, ratifiedSha256: 'a'.repeat(64) }, studyId: 's', protocolHash: 'p'.repeat(64), batches: [], policy: { capsUsd: { campaign: '11', providers: { anthropic: '5', openai: '3', google: '3' } } } } as unknown as BatchPlan;
  const batch = { batchId: 'b', provider: 'openai', model: 'm', operations: [], batchCapUsdPico: '1' } as unknown as Parameters<typeof realPreconditions>[1];
  const codes = realPreconditions(plan, batch, { realFlag: true, executorCodeSha: 'c'.repeat(40), env: ENV, nowMs: ts + 1000, campaignDir: dir });
  assert.ok(codes.includes('PREFLIGHT_CONNECTIVITY_MISSING:openai'), codes.join(';'));
  const codesNoDir = realPreconditions(plan, batch, { realFlag: true, executorCodeSha: 'c'.repeat(40), env: ENV, nowMs: ts + 1000 });
  assert.ok(!codesNoDir.some((c) => c.startsWith('PREFLIGHT')), 'sem campaignDir o gate nao se aplica (comando run antigo sem --campaign-dir)');
});

test('run-authorized --mode real: REAL_PRECONDITIONS_FAILED inclui PREFLIGHT_CONNECTIVITY_MISSING para TODO provedor do escopo (anthropic e openai), exit 6, nada executado', { timeout: 300_000 }, async () => {
  const work = tmp('ra'); const corpus = path.join(work, 'corpus'); const prereg = path.join(work, 'PREREG.md'); writeFileSync(prereg, '# synthetic prereg\n');
  freezeCorpus({ out: corpus, seed: 147001, s2: 2, s3: 3, noRepoScan: true });
  const pilot: BatchPlan = buildPlan({ corpusDir: corpus, preregFile: prereg, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-PREFLIGHT' });
  const planFile = path.join(work, 'plan.json'); writePlan(pilot, planFile);
  const ids = pilot.batches.filter((b) => !b.branchLocked).map((b) => b.batchId); // anthropic x2 + openai
  // the GO must pass validation before preconditions are reached: synthetic plan is unratified, so the validator stops at GO_PREREG_UNCONFIGURED in REAL.
  // Patch the plan copy as ratified (synthetic) so that the preconditions are what refuse.
  const ratified = { ...pilot, preregistration: { ...pilot.preregistration, ratified: true, ratifiedSha256: pilot.preregistration.sha256 } };
  const ratifiedFile = path.join(work, 'plan.ratified.json'); writeFileSync(ratifiedFile, JSON.stringify(ratified));
  const dir = tmp('ra-study');
  const go = path.join(work, 'go.json'); writeFileSync(go, syntheticMultiGo(pilot, ids, { executorCodeSha: 'c'.repeat(40), campaignDir: dir }));
  let err: CliError | null = null;
  try { await runAuthorized({ planFile: ratifiedFile, goFile: go, campaignDir: dir, corpusDir: corpus, mode: 'real', realFlag: true, executorCodeSha: 'c'.repeat(40), identity: { sha: 'c'.repeat(40), clean: true }, env: ENV }); } catch (e) { err = e as CliError; }
  assert.ok(err instanceof CliError && err.exit === EXIT.REAL_PRECONDITIONS, String(err));
  assert.match(err!.message, /PREFLIGHT_CONNECTIVITY_MISSING:anthropic/); assert.match(err!.message, /PREFLIGHT_CONNECTIVITY_MISSING:openai/);
  assert.ok(!verifyJournalText('').length);
});

test('guardas de fonte: verificacao nunca desativada; modulo nao referencia variaveis de credencial nem o arquivo de env; sonda HTTP padrao sem cabecalho de credencial', () => {
  const src = readFileSync(new URL('../../../scripts/h2eval/cli/preflight.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /rejectUnauthorized:\s*false/); assert.doesNotMatch(src, /NODE_TLS_REJECT_UNAUTHORIZED\s*=/); assert.match(src, /rejectUnauthorized: true/);
  assert.doesNotMatch(src, /H2EVAL_ENV_NAMES\.credentials|readEnvFileVar|envFile|H2EVAL_ANTHROPIC_API_KEY|x-api-key|['"]authorization['"]|Bearer/i);
  assert.match(src, /headers: \{ accept: 'application\/json' \}/);
  assert.doesNotMatch(src, /redirect: 'follow'/); assert.match(src, /redirect: 'error'/);
});
