/**
 * Tests that the request instrumentation (body hash and provider request id) coexists with the model probe in the
 * executor, in REAL mode with an injected fetch and in OFFLINE mode with the double.
 *
 * Modules under test: `scripts/h2eval/core/runner.ts` (`createExecutor`), its request instrumentation and probe
 * judgement, with the journal verifier and the doubles in `../support/double.ts`.
 *
 * Strategy / scenarios: a probe of the mid-size comparison model in REAL mode records the hash of the bytes sent and
 * the response request id, and the probe and reservation decisions are identical with and without a request id and
 * when the instrumentation fails; the probe rule is preserved (a truncated probe with complete usage passes, a ratio
 * of 1.95 fails); and OFFLINE mode records the hash of the serialized body and `NOT_AVAILABLE` for the request id.
 * This file covers what `e1ppp_rinst.test.ts` does not. Tests tagged with a commit id failed before the fix.
 *
 * Needs: a writable temporary directory. REAL mode runs only with an injected fetch (no socket); the credential is a
 * synthetic canary in a temporary env file; OFFLINE runs set `H2EVAL_TEST_KEY` to a fake canary. Importing
 * `syntheticGo` from `./go.test.ts` also registers that file's tests in this run.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/e3hri_rinst.test.ts`
 *
 * @module test/h2eval/core/e3hri_rinst.test
 */
// SYNTHETIC — OFFLINE. E3HRI (C160, RINST-E3; DR-206): o delta R-INST do E1‴ c9d27216 portado para o executor E3HR 0f64e069 (sonda julgada pelo proposito), que e o do SONNET-R.
// Estes casos cobrem o que o e1ppp_rinst.test.ts (copiado sem mudanca) nao cobre no E3HR: a convivencia do R-INST com a SONDA de modelo/faixa do E3HR no claude-sonnet-5-5
// (faixa medida 12..810; texto de L0 ~ 860 => ABOVE_RANGE_B0) e o modo OFFLINE (double) usado pelo ensaio sintetico do kit SONNET-R.
// Casos marcados [FALHA NO 0f64e069] reprovam no E3HR (SENT sem wireBodySha256; resposta sem providerRequestId) e passam no E3HRI. Este arquivo NAO importa o modulo novo:
// a falha no 0f64e069 e de asserção, nao de importacao. REAL so com fetch injetado (nenhum socket); credencial = canario sintetico em arquivo temporario (nunca process.env).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { loadPriceTable } from '../../../scripts/h2eval/record/prices.js';
import { syntheticGo } from './go.test.js';
import { tmp, writePriceFixture, memoryContentStore, plan, doubleAdapter, bodyOf as rawBodyOf, OFFICIAL_HOST } from '../support/double.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';

const SONNET = 'claude-sonnet-5-5'; const LIMIT = 1.9;   // PROBE_MAX_RATIO do roda_sonnet_r (1.9)
const CANARY = 'zq-e3hri-canary-7c41e0d9b2';
const VAR = 'H2EVAL_E3HRI_TEST_VAR';
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const okChecks = { insideGitTree: () => false, insideSyncFolder: () => false, aclWide: () => false as boolean | null };
const phrase = (i: number) => `trecho${i} de prosa sintetica para a sonda`;
const TEXT = Array.from({ length: 95 }, (_, i) => phrase(i)).join(' ') + ' s1 ção 🙂';   // L0 ~ 860 > 810 (ABOVE_RANGE_B0 do Sonnet)
function pricesFor(dir: string) { const f = writePriceFixture(dir); writeFileSync(f, readFileSync(f, 'utf8').split('sim-haiku').join(SONNET)); return loadPriceTable(f); }
type Mut = (body: Record<string, unknown>) => void;
const served: Mut = (b) => { b['model'] = SONNET; };
const truncAt = (maxTokens: number): Mut => (b) => { served(b); b['stop_reason'] = 'max_tokens'; (b['usage'] as Record<string, unknown>)['output_tokens'] = maxTokens; };
type Line = { kind: string; body: Record<string, unknown> };
const KINDS_E3HR = new Set(['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'MODEL_PROBE_STARTED', 'RESERVED', 'SENT', 'RESPONSE_RECEIVED', 'ERROR_WITH_USAGE', 'ERROR_NO_USAGE', 'TIMEOUT_UNCERTAIN', 'UNCERTAIN_ISOLATED', 'USAGE_PARSED', 'COST_COMPUTED', 'SETTLED', 'MODEL_PROBE_RESULT', 'STOP_GLOBAL']);

/**
 * Uma sonda do Sonnet (1a operacao da banda ABOVE_RANGE_B0). REAL: fetch injetado com os `headers` dados; OFFLINE: double sem headers (como no ensaio sintetico do kit).
 *
 * @param o - Scenario: execution mode, response headers (REAL only), the provider-to-local token ratio to simulate,
 *   an optional mutation of the fake response, and the output-token cap of the probe.
 */
async function probeRun(o: { mode: 'REAL' | 'OFFLINE'; headers?: unknown; ratio?: number; mutate?: Mut; maxTokens?: number }) {
  const dir = tmp('e3hri'); const store = memoryContentStore({ s1: TEXT }); let lastL0 = 0;
  const seenBodies: string[] = []; const doubleReqs: BuiltRequest[] = [];
  const respBody = () => { const r = rawBodyOf({ kind: 'ok', input: Math.round((o.ratio ?? 1.5) * lastL0), output: 40 }); (o.mutate ?? served)(r.body as Record<string, unknown>); return r; };
  let egress: ExecutorConfig['egress'];
  if (o.mode === 'REAL') {
    const d = mkdtempSync(path.join(tmpdir(), 'h2eval-e3hri-')); const envFile = path.join(d, 'h2eval.env'); writeFileSync(envFile, `${VAR}=${CANARY}\r\n`);
    const go = path.join(d, 'GO.json'); writeFileSync(go, syntheticGo({ campaign: 'h2eval-test', modelIds: [SONNET], window: { notBeforeUtc: new Date(Date.now() - 60_000).toISOString(), expiresUtc: new Date(Date.now() + 3_600_000).toISOString() } }));
    const fetchImpl = (async (_url: string, init: { body: string }) => { seenBodies.push(init.body); const r = respBody(); return { status: r.status, headers: o.headers, json: async () => r.body }; }) as unknown as typeof fetch;
    egress = { mode: 'REAL', realFlag: true, campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], goFile: go, preregistrationSha256: 'ab'.repeat(32), credentialEnvVars: { anthropic: VAR }, envFile, envFileChecks: okChecks, fetchImpl, forbiddenEnvVars: [] };
  } else {
    process.env['H2EVAL_TEST_KEY'] = 'zq-e3hri-offline-canary';
    egress = { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' }, double: async (req: BuiltRequest) => { doubleReqs.push(req); const r = respBody(); return { httpStatus: r.status, body: r.body }; } };
  }
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: pricesFor(dir), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } }, egress,
    capPolicy: { inputUpperBoundTokens: (_p, L0) => { lastL0 = L0 as number; return Math.ceil((L0 as number) * 10) + 100; }, reasoningAllowanceTokens: () => 1024 },
    executorCodeSha: 'c'.repeat(40), modelProbe: { maxMeasuredToEstimatedRatio: LIMIT }, consecutiveFailureStop: 2, lockedProviders: [],
  };
  const ex = createExecutor(cfg); const base = plan({ promptSha256: store.sha['s1']!, promptId: 'S1', modelRequested: SONNET });
  const r = await ex.run({ ...base, params: { ...base.params, maxTokens: o.maxTokens ?? 512 } }); ex.close();
  const lines = verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')) as unknown as Line[];
  return { r, lines, seenBodies, doubleReqs, line: (k: string) => lines.find((l) => l.kind === k)?.body, journalText: readFileSync(path.join(dir, 'journal.jsonl'), 'utf8') };
}
/**
 * O que a sonda e a reserva decidem, sem os campos do R-INST nem tempos: tem de ser igual com e sem request-id e com falha da instrumentacao.
 *
 * @param x - Output of one `probeRun` call.
 */
const probeFacts = (x: Awaited<ReturnType<typeof probeRun>>) => {
  const s = x.line('MODEL_PROBE_STARTED'); const res = x.line('MODEL_PROBE_RESULT'); const rv = x.line('RESERVED');
  return { state: x.r.state, stop: x.r.stop, kinds: x.lines.map((l) => l.kind), started: s, verdict: res?.['verdict'], reasons: res?.['reasons'], ratio: res?.['ratio'], localCount: res?.['localCount'], reservedBound: res?.['reservedInputUpperBoundTokens'], reservedUsd: rv?.['usd'], reservedTokens: rv?.['reservedInputUpperBoundTokens'], sentBodies: x.seenBodies };
};

test('[FALHA NO 0f64e069] E3HRI: sonda do Sonnet (ABOVE_RANGE_B0) em REAL: SENT grava o sha256 dos bytes enviados, a resposta grava o request-id, e a sonda/reserva ficam como no E3HR', async () => {
  const x = await probeRun({ mode: 'REAL', headers: new Headers({ 'request-id': 'req_011CE3hriSyntheticProbe01' }) });
  assert.equal(x.seenBodies.length, 1);
  assert.equal(x.line('MODEL_PROBE_STARTED')?.['key'], `anthropic|${SONNET}|ABOVE_RANGE_B0`, 'a operacao e a sonda da banda B0 do Sonnet');
  assert.equal(x.line('SENT')?.['wireBodySha256'], sha(x.seenBodies[0]!), 'hash = sha256 dos bytes do corpo que o fetch recebeu');
  assert.equal(x.line('RESPONSE_RECEIVED')?.['providerRequestId'], 'req_011CE3hriSyntheticProbe01');
  assert.equal(x.line('MODEL_PROBE_RESULT')?.['verdict'], 'PASSED');
  assert.ok(x.lines.every((l) => KINDS_E3HR.has(l.kind)), `nenhum kind novo: ${x.lines.map((l) => l.kind).join(',')}`);
  assert.equal(x.line('MODEL_PROBE_RESULT')?.['providerRequestId'], undefined, 'o R-INST nao entra no resultado da sonda');
  assert.doesNotMatch(x.journalText, new RegExp(CANARY), 'nenhum segredo no journal');
  // a instrumentacao nao muda a sonda nem a reserva: request-id ausente e headers hostis dao os MESMOS fatos de sonda/reserva/corpo
  const absent = await probeRun({ mode: 'REAL', headers: new Headers({ 'content-type': 'application/json' }) });
  const hostile = await probeRun({ mode: 'REAL', headers: { get: () => { throw new Error('hostil'); } } });
  assert.deepEqual([absent.line('RESPONSE_RECEIVED')?.['providerRequestId'], absent.line('RESPONSE_RECEIVED')?.['providerRequestIdReason']], ['NOT_AVAILABLE', 'HEADER_ABSENT']);
  assert.deepEqual([hostile.line('RESPONSE_RECEIVED')?.['providerRequestId'], hostile.line('RESPONSE_RECEIVED')?.['providerRequestIdReason']], ['NOT_AVAILABLE', 'HEADER_READ_FAILED']);
  for (const y of [absent, hostile]) assert.deepEqual(probeFacts(y), probeFacts(x));
});

test('[FALHA NO 0f64e069] E3HRI: regra do E3HR preservada com o R-INST: sonda truncada por max_tokens com usage completo PASSA; razao 1,95 > 1,9 REPROVA (STOP_MODEL_PROBE_FAILED); o request-id e gravado nos dois', async () => {
  const t = await probeRun({ mode: 'REAL', headers: new Headers({ 'request-id': 'req_trunc_1' }), mutate: truncAt(512) });
  assert.equal(t.line('RESPONSE_RECEIVED')?.['completion'], 'TRUNCATED_MAX_TOKENS');
  assert.deepEqual([t.line('MODEL_PROBE_RESULT')?.['verdict'], t.r.stop], ['PASSED', null]);
  assert.equal(t.line('RESPONSE_RECEIVED')?.['providerRequestId'], 'req_trunc_1');
  const f = await probeRun({ mode: 'REAL', headers: new Headers({ 'request-id': 'req_fail_1' }), ratio: 1.95 });
  assert.equal(f.line('MODEL_PROBE_RESULT')?.['verdict'], 'FAILED');
  assert.equal(f.r.stop, 'STOP_MODEL_PROBE_FAILED');
  assert.equal(f.line('STOP_GLOBAL')?.['reason'], 'STOP_MODEL_PROBE_FAILED');
  assert.equal(f.line('RESPONSE_RECEIVED')?.['providerRequestId'], 'req_fail_1');
  assert.equal(f.line('SENT')?.['wireBodySha256'], sha(f.seenBodies[0]!));
});

test('[FALHA NO 0f64e069] E3HRI: modo OFFLINE (double, o do ensaio sintetico do kit): SENT grava sha256(JSON.stringify(corpo)) e a resposta NOT_AVAILABLE/NO_HEADERS; nada mais muda', async () => {
  const x = await probeRun({ mode: 'OFFLINE' });
  assert.equal(x.doubleReqs.length, 1);
  assert.equal(x.line('SENT')?.['wireBodySha256'], sha(JSON.stringify(x.doubleReqs[0]!.body)));
  assert.deepEqual([x.line('RESPONSE_RECEIVED')?.['providerRequestId'], x.line('RESPONSE_RECEIVED')?.['providerRequestIdReason']], ['NOT_AVAILABLE', 'NO_HEADERS']);
  assert.equal(x.line('MODEL_PROBE_RESULT')?.['verdict'], 'PASSED');
  assert.ok(x.lines.every((l) => KINDS_E3HR.has(l.kind)));
  assert.equal(x.line('SENT')?.['mode'], 'OFFLINE');
});
