/**
 * Tests how a send failure is classified and journaled: a non-secret cause code and a derived phase hint, with the
 * operation still uncertain, isolated and never re-sent.
 *
 * Modules under test: `scripts/h2eval/core/egress.ts` (`classifySendFailure`, `createEgress`, `EgressRefused`,
 * `EgressTimeout`, `H2EVAL_ENV_NAMES`) and `scripts/h2eval/core/runner.ts`, with the doubles in
 * `../support/double.ts`.
 *
 * Strategy / partitions: the pure classifier (cause code and phase from the error's code, never from its message; a
 * code that is not an identifier gives `UNKNOWN`); a simulated TLS failure (journal line with cause code, TLS phase
 * hint and elapsed time; state uncertain; replay does not re-send); a send timeout; an exception without a code (the
 * previous behaviour); and two TLS-weakening environment variables that now make REAL mode refuse to start (checked
 * by name; values never read).
 *
 * Needs: a writable temporary directory. No network, no credential.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/sendfailure.test.ts`
 *
 * @module test/h2eval/core/sendfailure.test
 */
// SYNTHETIC — OFFLINE. CYCLE2-A (proposal, incident R17-001): a send failure is classified by the NON-SECRET cause code and a DERIVED phase
// hint, journaled in TIMEOUT_UNCERTAIN together with the elapsed time. The STATE does not change: UNCERTAIN, isolated, possiblyCharged,
// reservation kept, never resent on replay. Message text (may carry a URL/host) never reaches the journal; a non-identifier code => UNKNOWN.
// The forbidden env list now refuses SSLKEYLOGFILE and NODE_TLS_REJECT_UNAUTHORIZED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { classifySendFailure, createEgress, EgressRefused, EgressTimeout, H2EVAL_ENV_NAMES, type EgressResponse } from '../../../scripts/h2eval/core/egress.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, OFFICIAL_HOST } from '../support/double.js';

const SECRET_LOOKING = 'https://api.example.test/v1/messages?key=sk-SYNTHETIC-NOT-A-KEY-0000';
function setup(thrower: () => Promise<EgressResponse>, timeoutMs?: number) {
  const dir = tmp('sendfailure');
  const store = memoryContentStore({ p1: 'Texto sintético curto para classificar uma falha de envio.' });
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: thrower, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' }, timeoutMs },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40),
  };
  return { dir, store, ex: createExecutor(cfg) };
}
const uncertainLine = (dir: string, id: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')).find((l) => l.operationId === id && l.kind === 'TIMEOUT_UNCERTAIN')!.body as Record<string, unknown>;

test('classifySendFailure: codigo da causa (undici) e fase derivada; mensagem nunca e usada; codigo nao identificador => UNKNOWN', () => {
  const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(SECRET_LOOKING), { code }) });
  assert.deepEqual(classifySendFailure(fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE')), { causeCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', phaseHint: 'tls' });
  assert.deepEqual(classifySendFailure(fetchFailed('CERT_HAS_EXPIRED')), { causeCode: 'CERT_HAS_EXPIRED', phaseHint: 'tls' });
  assert.deepEqual(classifySendFailure(fetchFailed('ENOTFOUND')), { causeCode: 'ENOTFOUND', phaseHint: 'dns' });
  assert.deepEqual(classifySendFailure(fetchFailed('ECONNREFUSED')), { causeCode: 'ECONNREFUSED', phaseHint: 'connect' });
  assert.deepEqual(classifySendFailure(fetchFailed('ECONNRESET')), { causeCode: 'ECONNRESET', phaseHint: 'unknown' }, 'reset pode ocorrer apos o envio: fase desconhecida');
  assert.deepEqual(classifySendFailure(Object.assign(new Error('x'), { code: 'EPIPE' })), { causeCode: 'EPIPE', phaseHint: 'unknown' });
  assert.deepEqual(classifySendFailure(new EgressTimeout(5)), { causeCode: 'TIMEOUT', phaseHint: 'timeout' });
  assert.deepEqual(classifySendFailure(Object.assign(new Error('aborted'), { name: 'TimeoutError' })), { causeCode: 'TIMEOUT', phaseHint: 'timeout' });
  assert.deepEqual(classifySendFailure(fetchFailed('not an identifier: ' + SECRET_LOOKING)), { causeCode: 'UNKNOWN', phaseHint: 'unknown' });
  assert.deepEqual(classifySendFailure(fetchFailed('a'.repeat(70).toUpperCase())), { causeCode: 'UNKNOWN', phaseHint: 'unknown' }, 'identificador longo demais');
  assert.deepEqual(classifySendFailure(new Error(SECRET_LOOKING)), { causeCode: 'UNKNOWN', phaseHint: 'unknown' });
  assert.deepEqual(classifySendFailure(null), { causeCode: 'UNKNOWN', phaseHint: 'unknown' });
  assert.deepEqual(classifySendFailure('string'), { causeCode: 'UNKNOWN', phaseHint: 'unknown' });
});

test('falha TLS simulada no envio: TIMEOUT_UNCERTAIN carrega code SEND_FAILED + causeCode + phaseHint tls + elapsedMs; estado UNCERTAIN, reserva incerta, replay nao reenvia', async () => {
  let calls = 0;
  const s = setup(async () => { calls += 1; throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(SECRET_LOOKING), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }); });
  const p = plan({ promptSha256: s.store.sha['p1']! }); const id = operationIdOf(p);
  const r = await s.ex.run(p);
  assert.deepEqual([r.state, r.stop, calls], ['UNCERTAIN', 'STOP_UNCERTAIN', 1]);
  const b = uncertainLine(s.dir, id);
  assert.deepEqual([b['possiblyCharged'], b['code'], b['causeCode'], b['phaseHint']], [true, 'SEND_FAILED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls']);
  assert.ok(typeof b['elapsedMs'] === 'number' && b['elapsedMs'] >= 0 && b['elapsedMs'] < 60_000);
  const text = readFileSync(path.join(s.dir, 'journal.jsonl'), 'utf8');
  assert.ok(!text.includes('sk-SYNTHETIC') && !text.includes('api.example.test'), 'nenhum texto de mensagem no journal');
  const st = s.ex.ledger.state().providers.anthropic; assert.ok(BigInt(st.possiblyChargedUsd) > 0n); assert.equal(st.reservedUsd, '0');
  s.ex.close();
  // replay in a new executor over the SAME batchDir: never resent
  const s2 = createExecutor({ batchDir: s.dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: s.store, prices: prices(s.dir), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } }, egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: async () => { calls += 1; throw new Error('must not be called'); }, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } }, capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40) });
  const r2 = await s2.run(p); assert.deepEqual([r2.state, r2.replayed, calls], ['UNCERTAIN_ISOLATED', true, 1]); s2.close();
});

test('timeout do envio: code TIMEOUT, causeCode TIMEOUT, phaseHint timeout', async () => {
  const s = setup(() => new Promise<EgressResponse>(() => { /* never resolves */ }), 30);
  const p = plan({ promptSha256: s.store.sha['p1']! }); const r = await s.ex.run(p);
  assert.deepEqual([r.state, r.stop], ['UNCERTAIN', 'STOP_UNCERTAIN']);
  const b = uncertainLine(s.dir, operationIdOf(p)); assert.deepEqual([b['code'], b['causeCode'], b['phaseHint']], ['TIMEOUT', 'TIMEOUT', 'timeout']); s.ex.close();
});

test('excecao sem codigo (double antigo): causeCode UNKNOWN, phaseHint unknown — comportamento anterior preservado', async () => {
  const s = setup(async () => { throw new Error('OFFLINE_SIMULATED_SEND_FAILURE'); });
  const p = plan({ promptSha256: s.store.sha['p1']! }); const r = await s.ex.run(p);
  assert.equal(r.state, 'UNCERTAIN'); const b = uncertainLine(s.dir, operationIdOf(p)); assert.deepEqual([b['code'], b['causeCode'], b['phaseHint']], ['SEND_FAILED', 'UNKNOWN', 'unknown']); s.ex.close();
});

test('variaveis proibidas: SSLKEYLOGFILE e NODE_TLS_REJECT_UNAUTHORIZED agora recusam REAL (FORBIDDEN_ENV_PRESENT) antes do GO; presenca testada por nome, valor nunca lido', () => {
  assert.ok(H2EVAL_ENV_NAMES.forbidden.includes('SSLKEYLOGFILE') && H2EVAL_ENV_NAMES.forbidden.includes('NODE_TLS_REJECT_UNAUTHORIZED'));
  const dir = tmp('forbidden'); const store = memoryContentStore({ p1: 'x' });
  const req = doubleAdapter().buildRequest(plan({ promptSha256: store.sha['p1']! }), { promptSha256: store.sha['p1']!, messages: [{ role: 'user', parts: [{ type: 'text', text: 'x' }] }], prefixMessages: 'NOT_APPLICABLE' });
  const ctx = { provider: 'anthropic' as const, phase: 'PILOT', modelRequested: 'sim-haiku', batchId: 'batch1', executorVersion: 'otk.h2eval.executor.v0', executorCodeSha: 'c'.repeat(40), ledgerCaps: { campaignUsd: '11', providerUsd: '5' } };
  for (const name of ['SSLKEYLOGFILE', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    const saved = process.env[name]; process.env[name] = name === 'SSLKEYLOGFILE' ? '\\.\SYNTHETIC-device' : '0';
    try {
      const eg = createEgress({ mode: 'REAL', realFlag: true, campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], goFile: path.join(dir, 'missing-go.json'), preregistrationSha256: 'ab'.repeat(32), credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } });
      assert.throws(() => eg.preflight(ctx, req, [OFFICIAL_HOST]), (e: EgressRefused) => e.code === 'FORBIDDEN_ENV_PRESENT', name);
      const off = createEgress({ mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: async () => ({ httpStatus: 200, body: {} }) });
      assert.ok(off.preflight(ctx, req, [OFFICIAL_HOST]).token, 'OFFLINE nao consulta a lista');
    } finally { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; }
  }
});
