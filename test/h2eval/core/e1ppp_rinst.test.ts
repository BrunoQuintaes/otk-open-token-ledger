/**
 * Tests the request instrumentation of the executor: the sha256 of the exact body bytes sent and the provider's
 * request id, recorded without changing what is sent and without reading the credential header.
 *
 * Modules under test: `scripts/h2eval/core/requestInstrumentation.ts` (`wireBody`, `wireBodySha256`,
 * `wireBodySha256Of`, `providerRequestId`, `providerRequestIdFromResponse`, `REQUEST_ID_HEADER`, `NOT_AVAILABLE`)
 * and `scripts/h2eval/core/runner.ts` (`createExecutor`) in REAL mode with an injected fetch.
 *
 * Strategy / partitions: the body hash equals the sha256 of the UTF-8 bytes the transport received (not a
 * canonical form) and a present request id is recorded; an absent request id (or a response without headers) gives
 * `NOT_AVAILABLE` with a reason, never an invented value; a failing header read gives `NOT_AVAILABLE` without
 * throwing, and the send and result stay identical; only the allow-listed response header is read, nothing is
 * iterated; and the pure core (byte hash, failures without throwing, a provider without a documented header).
 *
 * Needs: a writable temporary directory. REAL mode runs only with an injected fetch, so no socket is opened; the
 * credential is a synthetic canary in a temporary env file, never in the process environment. Importing
 * `syntheticGo` from `./go.test.ts` also registers that file's tests in this run.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/e1ppp_rinst.test.ts`
 *
 * @module test/h2eval/core/e1ppp_rinst.test
 */
// SYNTHETIC — OFFLINE. E1‴ (C160): R-INST prospectivo no executor científico. REAL mode is exercised ONLY with an injected fetch — no socket is ever opened.
// The credential is a synthetic canary in a temporary file (never process.env). Checks: sha256 of the exact body bytes; request-id present / absent / instrumentation failure;
// the instrumentation never changes what is sent nor the result; the credential header is never read nor recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { NOT_AVAILABLE, providerRequestId, providerRequestIdFromResponse, REQUEST_ID_HEADER, wireBody, wireBodySha256, wireBodySha256Of } from '../../../scripts/h2eval/core/requestInstrumentation.js';
import { syntheticGo } from './go.test.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, bodyOf, OFFICIAL_HOST } from '../support/double.js';

const CANARY = 'zq-e1ppp-canary-4b1d9e7a20c63f';
const VAR = 'H2EVAL_E1PPP_TEST_VAR';
const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const okChecks = { insideGitTree: () => false, insideSyncFolder: () => false, aclWide: () => false as boolean | null };
type Seen = { body: string; headerNames: string[] };
type FakeRes = Record<string, unknown>;

/**
 * Runs ONE operation in REAL mode with an injected fetch; `respond` builds the fake response. Returns the journal lines, the record and what the transport saw.
 *
 * @param respond - Builds the fake HTTP response from what the injected fetch received (body text and header names).
 */
async function realRun(respond: (seen: Seen) => FakeRes | Promise<FakeRes>) {
  const d = mkdtempSync(path.join(tmpdir(), 'h2eval-e1ppp-')); const envFile = path.join(d, 'h2eval.env'); writeFileSync(envFile, `${VAR}=${CANARY}\r\n`);
  const go = path.join(d, 'GO.json'); writeFileSync(go, syntheticGo({ campaign: 'h2eval-test', window: { notBeforeUtc: new Date(Date.now() - 60_000).toISOString(), expiresUtc: new Date(Date.now() + 3_600_000).toISOString() } }));
  const seen: Seen[] = [];
  const fetchImpl = (async (_url: string, init: { headers: Record<string, string>; body: string }) => { const s = { body: init.body, headerNames: Object.keys(init.headers) }; seen.push(s); return respond(s); }) as unknown as typeof fetch;
  const dir = tmp('e1ppp-real'); const store = memoryContentStore({ p1: 'Resuma este texto sintético: ção, ü, 漢字, emoji 🙂.' });
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'REAL', realFlag: true, campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], goFile: go, preregistrationSha256: 'ab'.repeat(32), credentialEnvVars: { anthropic: VAR }, envFile, envFileChecks: okChecks, fetchImpl, forbiddenEnvVars: [] },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), lockedProviders: [],
  };
  const ex = createExecutor(cfg); const p = plan({ promptSha256: store.sha['p1']! });
  const r = await ex.run(p); ex.close();
  const lines = readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { kind: string; body: Record<string, unknown> });
  const rec = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(p)}.json`), 'utf8')) as Record<string, unknown>;
  const all = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name), 'utf8')).join('\n');
  return { r, lines, rec, seen, all, line: (k: string) => lines.find((l) => l.kind === k)?.body };
}
const ok = bodyOf({ kind: 'ok' });
const okRes = (headers: unknown): FakeRes => ({ status: ok.status, headers, json: async () => ok.body });
/**
 * Result fields that must not depend on the instrumentation (timestamps and latency excluded).
 *
 * @param x - Output of one `realRun` call.
 */
const stable = (x: Awaited<ReturnType<typeof realRun>>) => ({ state: x.r.state, stop: x.r.stop, kinds: x.lines.map((l) => l.kind), outcome: x.rec['outcome'], httpStatus: x.rec['httpStatus'], usage: x.rec['usage'], cost: x.rec['cost'], responseSha256: x.rec['responseSha256'], finalState: x.rec['finalState'], sentBody: x.seen.map((s) => s.body) });

test('E1‴ R-INST: wireBodySha256 é o sha256 dos BYTES exatos que o transporte recebeu (UTF-8, não canônico); request-id presente é gravado; credencial nunca gravada', async () => {
  const x = await realRun(() => okRes(new Headers({ 'request-id': 'req_011CTestE1pppSynthetic01', 'x-api-key-echo': 'nao-ler' })));
  assert.equal(x.seen.length, 1);
  const sent = x.line('SENT')!;
  assert.equal(sent['wireBodySha256'], sha(x.seen[0]!.body), 'hash igual ao dos bytes do corpo enviado');
  assert.equal(sent['wireBodySha256Reason'], undefined);
  assert.notEqual(sent['wireBodySha256'], sent['requestBodySha256'], 'o hash dos bytes não é o hash canônico (campo novo, distinto)');
  const resp = x.line('RESPONSE_RECEIVED')!;
  assert.equal(resp['providerRequestId'], 'req_011CTestE1pppSynthetic01');
  assert.equal(resp['providerRequestIdReason'], undefined);
  assert.equal(x.r.state, 'COST_COMPUTED');
  assert.doesNotMatch(x.all, new RegExp(CANARY), 'nenhum segredo em journal/ledger/snapshot/registro');
});

test('E1‴ R-INST: request-id AUSENTE (ou resposta sem headers) ⇒ NOT_AVAILABLE com motivo; nunca valor inventado', async () => {
  const a = await realRun(() => okRes(new Headers({ 'content-type': 'application/json' })));
  assert.deepEqual([a.line('RESPONSE_RECEIVED')!['providerRequestId'], a.line('RESPONSE_RECEIVED')!['providerRequestIdReason']], [NOT_AVAILABLE, 'HEADER_ABSENT']);
  const b = await realRun(() => ({ status: ok.status, json: async () => ok.body }));
  assert.deepEqual([b.line('RESPONSE_RECEIVED')!['providerRequestId'], b.line('RESPONSE_RECEIVED')!['providerRequestIdReason']], [NOT_AVAILABLE, 'NO_HEADERS']);
  const c = await realRun(() => okRes(new Headers({ 'request-id': 'tem espaço e é inválido' })));
  assert.deepEqual([c.line('RESPONSE_RECEIVED')!['providerRequestId'], c.line('RESPONSE_RECEIVED')!['providerRequestIdReason']], [NOT_AVAILABLE, 'FORMAT_INVALID']);
  assert.doesNotMatch(c.all, /tem espaço/, 'o valor inválido não é gravado');
});

test('E1‴ R-INST: FALHA da instrumentação (headers.get lança; getter de headers lança) ⇒ NOT_AVAILABLE/HEADER_READ_FAILED, sem lançar; envio e resultado idênticos ao caso sem falha', async () => {
  const base = await realRun(() => okRes(new Headers({ 'request-id': 'req_base' })));
  const f1 = await realRun(() => okRes({ get: () => { throw new Error('hostil'); } }));
  const f2 = await realRun(() => { const o: FakeRes = { status: ok.status, json: async () => ok.body }; Object.defineProperty(o, 'headers', { get: () => { throw new Error('hostil'); } }); return o; });
  for (const f of [f1, f2]) {
    assert.deepEqual([f.line('RESPONSE_RECEIVED')!['providerRequestId'], f.line('RESPONSE_RECEIVED')!['providerRequestIdReason']], [NOT_AVAILABLE, 'HEADER_READ_FAILED']);
    assert.deepEqual(stable(f), stable(base), 'mesmo corpo enviado, mesmo estado, mesmo registro');
  }
  // envio falho (sem resposta) ⇒ incerta como antes; request-id NOT_AVAILABLE/NO_RESPONSE; o hash dos bytes continua no SENT
  const u = await realRun(() => { throw new Error('SYN_SEND_FAILURE'); });
  assert.deepEqual([u.r.state, u.r.stop], ['UNCERTAIN', 'STOP_UNCERTAIN']);
  assert.deepEqual([u.line('TIMEOUT_UNCERTAIN')!['providerRequestId'], u.line('TIMEOUT_UNCERTAIN')!['providerRequestIdReason']], [NOT_AVAILABLE, 'NO_RESPONSE']);
  assert.equal(u.line('SENT')!['wireBodySha256'], sha(u.seen[0]!.body));
});

test('E1‴ R-INST: só o cabeçalho de RESPOSTA allow-listado é lido (get("request-id")); nada é iterado; o cabeçalho de autorização jamais é lido', async () => {
  const asked: string[] = []; const touched: string[] = [];
  const spy = new Proxy({ get: (n: string) => { asked.push(n); return n === 'request-id' ? 'req_spy_1' : null; } }, { get(t, k) { touched.push(String(k)); return (t as Record<string | symbol, unknown>)[k]; }, ownKeys() { touched.push('ownKeys'); return []; } });
  const x = await realRun(() => okRes(spy));
  assert.deepEqual(asked, ['request-id']);
  assert.deepEqual(touched, ['get']);
  assert.equal(x.line('RESPONSE_RECEIVED')!['providerRequestId'], 'req_spy_1');
  assert.ok(x.seen[0]!.headerNames.includes('x-api-key'), 'o envio continua com a credencial no cabeçalho (inalterado)');
  assert.doesNotMatch(JSON.stringify(x.lines), /x-api-key|authorization/i);
});

test('E1‴ R-INST núcleo puro: hash dos bytes, falhas sem lançar, provedor sem cabeçalho documentado', () => {
  const s = '{"a":"ção 🙂"}';
  assert.deepEqual(wireBodySha256(s), { value: sha(s), reason: null });
  assert.deepEqual(wireBodySha256(42), { value: NOT_AVAILABLE, reason: 'BODY_NOT_STRING' });
  const circ: Record<string, unknown> = {}; circ['self'] = circ;
  assert.deepEqual(wireBodySha256Of({ body: circ }), { value: NOT_AVAILABLE, reason: 'BODY_SERIALISE_FAILED' });
  assert.equal(wireBody({ body: { b: 1, a: 2 } }), '{"b":1,"a":2}', 'wireBody é exatamente JSON.stringify(body) (ordem preservada)');
  assert.deepEqual(REQUEST_ID_HEADER, { anthropic: 'request-id' });
  // E3G (C160 BRACO-GO): google/openai now have their own allow-listed headers (ARM_REQUEST_ID_HEADERS); the Anthropic name `request-id` is still NOT read for them
  assert.deepEqual(providerRequestId('google', new Headers({ 'request-id': 'x' })), { value: NOT_AVAILABLE, reason: 'HEADER_ABSENT' });
  assert.deepEqual(providerRequestId('openai', new Headers({ 'request-id': 'x' })), { value: NOT_AVAILABLE, reason: 'HEADER_ABSENT' });
  assert.deepEqual(providerRequestId('anthropic', new Headers({ 'request-id': 'r'.repeat(129) })), { value: NOT_AVAILABLE, reason: 'FORMAT_INVALID' });
  assert.deepEqual(providerRequestId('anthropic', { get: () => 7 }), { value: NOT_AVAILABLE, reason: 'FORMAT_INVALID' });
  assert.deepEqual(providerRequestIdFromResponse('anthropic', null), { value: NOT_AVAILABLE, reason: 'NO_HEADERS' });
  assert.deepEqual(providerRequestIdFromResponse('anthropic', { providerRequestId: { value: 'req_ok', reason: null } }), { value: 'req_ok', reason: null });
  assert.deepEqual(providerRequestIdFromResponse('anthropic', { providerRequestId: { value: 'forjado com espaço', reason: null } }), { value: NOT_AVAILABLE, reason: 'FORMAT_INVALID' });
  const hostile = new Proxy({}, { get() { throw new Error('hostil'); } });
  assert.deepEqual(providerRequestIdFromResponse('anthropic', hostile), { value: NOT_AVAILABLE, reason: 'HEADER_READ_FAILED' });
});
