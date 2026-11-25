/**
 * Tests the 80% sub-ledger checkpoint at executor level, the signed pre-approval to continue up to 100%, and the
 * study-wide attempt budget.
 *
 * Modules under test: `scripts/h2eval/core/runner.ts` (`createExecutor`), `scripts/h2eval/core/ledger.ts` and the
 * journal verifier, with the doubles in `../support/double.ts`.
 *
 * Strategy / scenarios: a base batch settles 20 operations on a shared study ledger; another batch then pauses at 80%
 * without pre-approval (the spend reaches it only through the shared ledger); with a signed pre-approval it
 * continues while the committed amount plus every future reservation of the remaining scope fits (the pause is
 * journaled once) and stops when it would not; an unsigned pre-approval counts for nothing; and an exhausted
 * attempt budget stops before planning, counted at every SENT line.
 *
 * Needs: a writable temporary directory. No network, no credential.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/preauth.test.ts`
 *
 * @module test/h2eval/core/preauth.test
 */
// SYNTHETIC — OFFLINE. C144 D144-06 / D144-04 at the executor level: the 80 % checkpoint without pre-authorisation stops (PAUSE_REVIEW_AT_80PCT);
// a SIGNED preAuthorizeTo100pct continues ONLY while committed + every future reservation of the remaining scope fits the sub-ledger
// (journaled PAUSE_PREAUTHORIZED once); when the future scope would overflow, it stops even though pre-authorised; an unsigned
// pre-authorisation counts for nothing; the study attempts budget stops BEFORE PLANNED (STOP_MAX_ATTEMPTS). The spend that crosses 80 %
// lives in ANOTHER batch directory and reaches this one only through the shared study ledger + journal reconciliation (pilot inheritance).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { usdToPico } from '../../../scripts/h2eval/core/ledger.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, scriptedDouble, OFFICIAL_HOST } from '../support/double.js';

const N = 20; // settled ops of 0.0004 USD each => 0.008 USD; op cap 0.00157 USD
const STUDY = tmp('preauth-study'); const LEDGER = path.join(STUDY, 'ledger.jsonl'); const DIR_A = path.join(STUDY, 'batches', 'A');
function setup(o: { dir: string; anthropicUsd: string; steps?: number; extra?: Partial<ExecutorConfig> }) {
  mkdirSync(o.dir, { recursive: true });
  const store = memoryContentStore({ p1: 'Resuma este texto sintético sobre medição de tokens em três frases curtas.' });
  const sd = scriptedDouble(Array.from({ length: o.steps ?? 4 }, () => ({ kind: 'ok' as const })));
  const cfg: ExecutorConfig = {
    batchDir: o.dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(o.dir),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: o.anthropicUsd, openai: '3', google: '3' } }, ledgerPath: LEDGER, reconcileJournalPaths: readdirSync(path.join(STUDY, 'batches')).map((b) => path.join(STUDY, 'batches', b, 'journal.jsonl')).filter((p) => existsSync(p)),
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: sd.double, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), ...(o.extra ?? {}),
  };
  return { store, sd, cfg, ex: createExecutor(cfg) };
}
const kinds = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
const PRE = [{ provider: 'anthropic' as const, acknowledgedBy: 'human:SYNTHETIC', source: 'go' as const, reference: 'go-preauth:test' }];
let K = 0n; // op cap in pico

test('base: 20 operacoes liquidadas no lote A (ledger de estudo compartilhado)', async () => {
  const a = setup({ dir: DIR_A, anthropicUsd: '5', steps: N });
  for (let i = 1; i <= N; i += 1) { const r = await a.ex.run(plan({ promptSha256: a.store.sha['p1']!, promptId: `P${i}`, batchId: 'A' })); assert.equal(r.state, 'COST_COMPUTED', `op ${i}`); }
  const st = a.ex.ledger.state().providers.anthropic; assert.equal(st.spentUsd, usdToPico('0.008').toString());
  const res = kinds(DIR_A).find((l) => l.kind === 'RESERVED')!; K = BigInt((res.body as { usd: string }).usd); assert.equal(K, usdToPico('0.00157'));
  a.ex.close();
});

test('D144-06: 80 % sem pre-autorizacao => PAUSE_REVIEW_AT_80PCT; herdado de OUTRO lote via ledger compartilhado', async () => {
  // 0.008 / 0.0098 = 81.6 % committed BEFORE this batch sends anything; one more op (0.00157) still fits (0.00957 <= 0.0098)
  const b = setup({ dir: path.join(STUDY, 'batches', 'B'), anthropicUsd: '0.0098' });
  const r = await b.ex.run(plan({ promptSha256: b.store.sha['p1']!, promptId: 'Q1', batchId: 'B' }));
  assert.deepEqual([r.state, r.stop, b.sd.seen.length], ['ABORTED_BEFORE_SEND', 'PAUSE_REVIEW_AT_80PCT', 0]);
  const l = kinds(path.join(STUDY, 'batches', 'B')).find((x) => x.kind === 'PAUSE_REVIEW')!; assert.equal((l.body as { preauthorized?: boolean }).preauthorized, false);
  b.ex.close();
});

test('D144-06: pre-autorizacao ASSINADA e reserva futura cabendo => PAUSE_PREAUTHORIZED (uma vez) e segue; quando a proxima reserva futura estoura, PARA mesmo pre-autorizada', async () => {
  const dir = path.join(STUDY, 'batches', 'C');
  const c = setup({ dir, anthropicUsd: '0.0098', extra: { preAuthorizedTo100: PRE, remainingScopeCapPico: () => K } });
  const r1 = await c.ex.run(plan({ promptSha256: c.store.sha['p1']!, promptId: 'Q1', batchId: 'C' }));
  assert.deepEqual([r1.state, r1.stop, c.sd.seen.length], ['COST_COMPUTED', null, 1]);
  const k1 = kinds(dir); assert.equal(k1.filter((x) => x.kind === 'PAUSE_PREAUTHORIZED').length, 1); assert.ok(!k1.some((x) => x.kind === 'PAUSE_REVIEW'));
  assert.equal((k1.find((x) => x.kind === 'PAUSE_PREAUTHORIZED')!.body as { acknowledgedBy: string }).acknowledgedBy, 'human:SYNTHETIC');
  // committed now 0.0084; the next future reservation (0.00157) would reach 0.00997 > 0.0098 => stop, pre-authorised or not
  const r2 = await c.ex.run(plan({ promptSha256: c.store.sha['p1']!, promptId: 'Q2', batchId: 'C' }));
  assert.deepEqual([r2.state, r2.stop, c.sd.seen.length], ['ABORTED_BEFORE_SEND', 'PAUSE_REVIEW_AT_80PCT', 1]);
  const pr = kinds(dir).find((x) => x.kind === 'PAUSE_REVIEW')!.body as { preauthorized: boolean; detail: string };
  assert.deepEqual([pr.preauthorized, pr.detail], [true, 'future_reservations_exceed_subledger']);
  c.ex.close();
});

test('D144-06: reserva futura do escopo maior que o que cabe => para no checkpoint apesar da pre-autorizacao; pre-autorizacao nao assinada nao vale', async () => {
  const d = setup({ dir: path.join(STUDY, 'batches', 'D'), anthropicUsd: '0.0098', extra: { preAuthorizedTo100: PRE, remainingScopeCapPico: () => K * 2n } });
  const r = await d.ex.run(plan({ promptSha256: d.store.sha['p1']!, promptId: 'Q1', batchId: 'D' }));
  assert.deepEqual([r.stop, d.sd.seen.length], ['PAUSE_REVIEW_AT_80PCT', 0]); d.ex.close();
  const e = setup({ dir: path.join(STUDY, 'batches', 'E'), anthropicUsd: '0.0098', extra: { preAuthorizedTo100: [{ ...PRE[0]!, acknowledgedBy: 'agent:bot' }], remainingScopeCapPico: () => K } });
  const r2 = await e.ex.run(plan({ promptSha256: e.store.sha['p1']!, promptId: 'Q1', batchId: 'E' }));
  assert.deepEqual([r2.stop, e.sd.seen.length], ['PAUSE_REVIEW_AT_80PCT', 0]); assert.ok(!kinds(path.join(STUDY, 'batches', 'E')).some((x) => x.kind === 'PAUSE_PREAUTHORIZED')); e.ex.close();
});

test('D144-04: orcamento de tentativas do estudo esgotado => STOP_MAX_ATTEMPTS antes de PLANNED; contado a cada SENT', async () => {
  let used = 0;
  const f = setup({ dir: path.join(STUDY, 'batches', 'F'), anthropicUsd: '5', extra: { attemptsBudget: { max: 2, used: () => used, onSend: () => { used += 1; } } } });
  assert.equal((await f.ex.run(plan({ promptSha256: f.store.sha['p1']!, promptId: 'Q1', batchId: 'F' }))).state, 'COST_COMPUTED');
  assert.equal((await f.ex.run(plan({ promptSha256: f.store.sha['p1']!, promptId: 'Q2', batchId: 'F' }))).state, 'COST_COMPUTED');
  const r = await f.ex.run(plan({ promptSha256: f.store.sha['p1']!, promptId: 'Q3', batchId: 'F' }));
  assert.deepEqual([r.state, r.stop, used, f.sd.seen.length], ['ABORTED_BEFORE_SEND', 'STOP_MAX_ATTEMPTS', 2, 2]);
  assert.ok(kinds(path.join(STUDY, 'batches', 'F')).some((x) => x.kind === 'STOP_GLOBAL' && (x.body as { reason: string }).reason === 'STOP_MAX_ATTEMPTS')); f.ex.close();
});
