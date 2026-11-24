// SYNTHETIC — OFFLINE. Contract R2 addendum (CONTRACT_MIN_FOR_EXECUTOR_R2.md items 4/5/6/10/11/12, R10 R2 §5, R16/R17 alignment):
// locked Google branch, pause at 80% of a sub-ledger, batch ≤ N calls and one model per batch, EXCL_MODEL_MISMATCH, snapshot fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { readSnapshot } from '../../../scripts/h2eval/record/snapshot.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, scriptedDouble, MODEL, OFFICIAL_HOST } from '../support/double.js';

function setup(opts: { steps?: Parameters<typeof scriptedDouble>[0]; caps?: Partial<ExecutorConfig['ledger']>; dir?: string; extra?: Partial<ExecutorConfig> } = {}) {
  const dir = opts.dir ?? tmp('r2');
  const store = memoryContentStore({ p1: 'Resuma este texto sintético sobre medição de tokens em três frases curtas.', p2: 'Outro texto sintético, diferente, para a segunda operação.' });
  const sd = scriptedDouble(opts.steps ?? [{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }]);
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter(), 'gemini.generate_content': { ...doubleAdapter(), provider: 'google', api: 'gemini.generate_content' } }, contentStore: store, prices: prices(dir),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, ...opts.caps },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: sd.double, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 },
    executorCodeSha: 'c'.repeat(40), ...(opts.extra ?? {}),
  };
  return { dir, store, sd, cfg, ex: createExecutor(cfg) };
}
const kindsOf = (dir: string, id: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')).filter((l) => l.operationId === id).map((l) => l.kind);
const record = (dir: string, id: string) => JSON.parse(readFileSync(path.join(dir, 'records', `${id}.json`), 'utf8'));

test('R2 item 11: braço Google NOT_RUN_BRANCH_LOCKED em OFFLINE (só destrava em REAL com GO próprio): nada reservado, nada enviado, terminal no replay', async () => {
  const { dir, store, ex, sd } = setup();
  const g = plan({ promptSha256: store.sha['p1']!, provider: 'google', api: 'gemini.generate_content', modelRequested: 'sim-gemini' });
  const r = await ex.run(g);
  assert.deepEqual([r.state, r.stop, sd.seen.length], ['NOT_RUN_BRANCH_LOCKED', null, 0]);
  assert.equal(ex.ledger.state().providers.google.reservedUsd, '0');
  assert.equal(kindsOf(dir, operationIdOf(g)).at(-1), 'NOT_RUN_BRANCH_LOCKED');
  const r2 = await ex.run(g);
  assert.deepEqual([r2.replayed, r2.state, sd.seen.length], [true, 'NOT_RUN_BRANCH_LOCKED', 0]);
  // anthropic is not locked: runs
  assert.equal((await ex.run(plan({ promptSha256: store.sha['p1']! }))).state, 'COST_COMPUTED');
});

test('R2 item 12: ao atingir 80% do sub-ledger do provedor => PAUSE_REVIEW_AT_80PCT antes de enviar; só um ack explícito deixa continuar', async () => {
  // op cap = 0.00157 USD; provider 0.0064 => batch default 25% = 0.0016 >= cap: first op runs and settles 0.0004
  const s2 = setup({ caps: { providersUsd: { anthropic: '0.0064', openai: '3', google: '3' } } });
  assert.equal((await s2.ex.run(plan({ promptSha256: s2.store.sha['p1']! }))).state, 'COST_COMPUTED');
  // reopen the same batch dir with a provider cap of 0.0005 => committed 0.0004 / 0.0005 = 80%
  const s3 = setup({ dir: s2.dir, caps: { providersUsd: { anthropic: '0.0005', openai: '3', google: '3' } } });
  const r = await s3.ex.run(plan({ promptSha256: s3.store.sha['p2']!, promptId: 'P2' }));
  assert.deepEqual([r.state, r.stop, s3.sd.seen.length], ['ABORTED_BEFORE_SEND', 'PAUSE_REVIEW_AT_80PCT', 0]);
  assert.equal(kindsOf(s2.dir, operationIdOf(plan({ promptSha256: s3.store.sha['p2']!, promptId: 'P2' }))).at(-1), 'PAUSE_REVIEW');
  // below 80% (0.0004 / 0.0006 = 67%) no pause
  const s4 = setup({ dir: s2.dir, caps: { providersUsd: { anthropic: '0.0006', openai: '3', google: '3' } } });
  const r4 = await s4.ex.run(plan({ promptSha256: s4.store.sha['p2']!, promptId: 'P3' }));
  assert.notEqual(r4.stop, 'PAUSE_REVIEW_AT_80PCT');
  // with an explicit human ack the pause does not block (the next stop is budgetary, never a silent send above the cap)
  const s5 = setup({ dir: s2.dir, caps: { providersUsd: { anthropic: '0.0005', openai: '3', google: '3' } }, extra: { pauseAck: [{ provider: 'anthropic', acknowledgedBy: 'human:SYNTHETIC', source: 'operator', reference: 'test' }] } });
  const r5 = await s5.ex.run(plan({ promptSha256: s5.store.sha['p2']!, promptId: 'P4' }));
  assert.notEqual(r5.stop, 'PAUSE_REVIEW_AT_80PCT');
  assert.ok(verifyJournalText(readFileSync(path.join(s2.dir, 'journal.jsonl'), 'utf8')).some((l) => l.kind === 'PAUSE_ACK' && (l.body as { acknowledgedBy: string }).acknowledgedBy === 'human:SYNTHETIC'), 'R15-M4: reconhecimento journalizado com assinante');
  // an unsigned acknowledgement does not count
  const s6 = setup({ dir: s2.dir, caps: { providersUsd: { anthropic: '0.0005', openai: '3', google: '3' } }, extra: { pauseAck: [{ provider: 'anthropic', acknowledgedBy: 'config:true', source: 'operator', reference: 'x' }] } });
  assert.equal((await s6.ex.run(plan({ promptSha256: s6.store.sha['p2']!, promptId: 'P5' }))).stop, 'PAUSE_REVIEW_AT_80PCT');
  assert.deepEqual([r5.state, r5.stop, s5.sd.seen.length], ['STOP_BUDGET', 'STOP_BUDGET_PROVIDER', 0], 'com ack, o próximo freio é o sub-ledger (0.0004 + 0.00157 > 0.0005), nunca um envio');
});

test('R2 item 12: lote <= N chamadas (60 por padrão; aqui 2) e um modelo por lote, contados pelo journal (sobrevivem a reinício)', async () => {
  const { dir, store, sd, cfg } = setup();
  const ex = createExecutor({ ...cfg, maxBatchCalls: 2 });
  await ex.run(plan({ promptSha256: store.sha['p1']! })); await ex.run(plan({ promptSha256: store.sha['p2']!, promptId: 'P2' }));
  const r3 = await ex.run(plan({ promptSha256: store.sha['p1']!, promptId: 'P3' }));
  assert.deepEqual([r3.state, r3.stop, sd.seen.length], ['ABORTED_BEFORE_SEND', 'STOP_BATCH_SIZE', 2]);
  const re = setup({ dir });
  const ex2 = createExecutor({ ...re.cfg, maxBatchCalls: 2 });
  assert.equal((await ex2.run(plan({ promptSha256: store.sha['p1']!, promptId: 'P4' }))).stop, 'STOP_BATCH_SIZE', 'reinício não zera a contagem do lote');
  const mix = await ex2.run(plan({ promptSha256: store.sha['p1']!, promptId: 'P5', batchId: 'batch1', modelRequested: 'other-model' }));
  assert.equal(mix.stop, 'STOP_BATCH_MODEL_MIX');
  const other = await ex2.run(plan({ promptSha256: store.sha['p1']!, promptId: 'P6', batchId: 'batch2' }));
  assert.equal(other.state, 'COST_COMPUTED', 'outro lote segue');
  const ex3 = createExecutor({ ...setup({ dir }).cfg, maxBatchCalls: 100 });
  assert.equal((await ex3.run(plan({ promptSha256: store.sha['p1']!, promptId: 'P7', batchId: 'batch3' }))).state, 'COST_COMPUTED');
  assert.ok(ex3.mode === 'OFFLINE');
});

test('R10 R2 §5.3 + R2 item 10: modelServed fora do conjunto aceito => EXCL_MODEL_MISMATCH registrado (custo calculado, nada descartado em silêncio); modelDeprecation do adaptador', async () => {
  const { dir, store, cfg } = setup();
  const ex = createExecutor({ ...cfg, acceptedModelsServed: { [MODEL]: ['sim-haiku-20260101'] } });
  const p = plan({ promptSha256: store.sha['p1']! });
  const r = await ex.run(p);
  const rec = record(dir, operationIdOf(p));
  assert.deepEqual([r.state, rec.exclusion, rec.modelDeprecation, rec.cost.state], ['COST_COMPUTED', 'EXCL_MODEL_MISMATCH', 'LEGACY', 'CALCULATED']);
  const ok = setup({ extra: { acceptedModelsServed: { [MODEL]: [MODEL] } } });
  const p2 = plan({ promptSha256: ok.store.sha['p1']! });
  await ok.ex.run(p2);
  assert.equal(record(ok.dir, operationIdOf(p2)).exclusion, 'NONE');
});

test('R2 itens 4/5/6 no snapshot: thinking, cacheTtlRequested, reasoningAllowanceTokens e capBasis (TTL mais caro) gravados antes do envio', async () => {
  const { dir, store, cfg } = setup();
  const ex = createExecutor({ ...cfg, capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 1024 } });
  const p = plan({ promptSha256: store.sha['p1']!, params: { maxTokens: 64, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'standard_only', cacheDirectives: 'NONE', thinking: { mode: 'adaptive', effort: 'low' }, cacheTtlRequested: '5m' } });
  await ex.run(p);
  const snap = readSnapshot(dir, operationIdOf(p));
  assert.deepEqual([snap.params.thinking, snap.params.cacheTtlRequested, snap.costCap.reasoningAllowanceTokens, snap.costCap.capBasis.cacheWriteTtlUsed], [{ mode: 'adaptive', effort: 'low' }, '5m', 1024, '5m']);
  assert.equal(snap.costCap.usd, (1000n * 1_250_000n + (64n + 1024n) * 5_000_000n).toString());
  assert.equal(snap.counter.exploratoryFormulaEstimate, null);
});
