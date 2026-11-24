// SYNTHETIC — OFFLINE. R15-HARDEN negatives (independent review B06, R15_REVIEW_PHASE1.md): A1 caps above defaults refused and GO tied to
// the effective caps; M1 replay with a different plan aborted; M2 batchDir lock; M3 ledger reconciled with the journal; M5 send timeout
// => TIMEOUT_UNCERTAIN with the reservation kept; B2 corpus determinism; B3 send requires the preflight token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, BatchLockedError, LedgerReconciliationError, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { CapsAboveDefault, usdToPico } from '../../../scripts/h2eval/core/ledger.js';
import { createEgress, EgressRefused } from '../../../scripts/h2eval/core/egress.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { buildCorpus } from '../../../scripts/h2eval/corpus/manifest.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, scriptedDouble, OFFICIAL_HOST } from '../support/double.js';

function setup(opts: { steps?: Parameters<typeof scriptedDouble>[0]; dir?: string; caps?: Partial<ExecutorConfig['ledger']>; extra?: Partial<ExecutorConfig>; egress?: Partial<ExecutorConfig['egress']> } = {}) {
  const dir = opts.dir ?? tmp('harden');
  const store = memoryContentStore({ p1: 'Resuma este texto sintético sobre medição de tokens em três frases curtas.', p2: 'Outro texto sintético para a segunda operação.' });
  const sd = scriptedDouble(opts.steps ?? [{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }]);
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, ...opts.caps },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: sd.double, ...(opts.egress ?? {}) },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), ...(opts.extra ?? {}),
  };
  return { dir, store, sd, cfg };
}
const kinds = (dir: string, id: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')).filter((l) => l.operationId === id).map((l) => l.kind);

test('R15-A1: tetos efetivos acima do padrao (11 / 5 / 3 / 3) sao recusados ao abrir; menores sao aceitos; provedor desconhecido recusado', () => {
  const a = setup({ caps: { providersUsd: { anthropic: '50', openai: '3', google: '3' } } });
  assert.throws(() => createExecutor(a.cfg), (e: CapsAboveDefault) => e instanceof CapsAboveDefault && /anthropic 50 > 5/.test(e.detail));
  const b = setup({ caps: { campaignUsd: '100' } });
  assert.throws(() => createExecutor(b.cfg), (e: CapsAboveDefault) => e instanceof CapsAboveDefault && /campaign 100 > 11/.test(e.detail));
  const c = setup({ caps: { providersUsd: { anthropic: '5.000000000001', openai: '3', google: '3' } } });
  assert.throws(() => createExecutor(c.cfg), CapsAboveDefault, 'um pico acima do padrao ja e recusado');
  const d = setup({ caps: { providersUsd: { anthropic: '1', openai: '0.5', google: '0', mistral: '1' } as never } });
  assert.throws(() => createExecutor(d.cfg), (e: CapsAboveDefault) => /mistral/.test(e.detail));
  const ok = setup({ caps: { campaignUsd: '0.5', providersUsd: { anthropic: '0.2', openai: '0.2', google: '0.1' } } });
  const ex = createExecutor(ok.cfg); ex.close();
  assert.ok(!existsSync(path.join(ok.dir, '.lock')), 'close libera o trinco');
});

test('R15-M1: a mesma operationId com plano diferente (corpo / promptSha256 / braco) => REPLAY_PLAN_MISMATCH, abortada, nada enviado; o mesmo plano continua REPLAY_SKIPPED', async () => {
  const s = setup();
  const ex = createExecutor(s.cfg);
  const p = plan({ promptSha256: s.store.sha['p1']! });
  assert.equal((await ex.run(p)).state, 'COST_COMPUTED');
  // same identity tuple (protocolHash:cellId:promptId:rep:model), different max_tokens => different body
  const r = await ex.run({ ...p, params: { ...p.params, maxTokens: 128 } });
  assert.deepEqual([r.state, r.stop, r.replayed, s.sd.seen.length], ['ABORTED_BEFORE_SEND', 'STOP_REPLAY_PLAN_MISMATCH', true, 1]);
  assert.equal(kinds(s.dir, operationIdOf(p)).at(-1), 'REPLAY_PLAN_MISMATCH');
  const r2 = await ex.run({ ...p, promptSha256: s.store.sha['p2']! });
  assert.equal(r2.stop, 'STOP_REPLAY_PLAN_MISMATCH', 'outro conteudo');
  const r3 = await ex.run({ ...p, plannedCacheArm: 'S2_NOHIT' });
  assert.equal(r3.stop, 'STOP_REPLAY_PLAN_MISMATCH', 'outro braco');
  const same = await ex.run(p);
  assert.deepEqual([same.replayed, same.state, s.sd.seen.length], [true, 'COST_COMPUTED', 1]);
  ex.close();
});

test('R15-M2: trinco <batchDir>/.lock: executor OCUPADO no mesmo diretorio e recusado; um ocioso e superado (reinicio) e perde o trinco (LOCK_LOST); apos close() abre; pid morto e tomado; pid vivo estranho e recusado', async () => {
  let release: (() => void) | null = null;
  const s = setup({ egress: { double: () => new Promise((res) => { release = () => res({ httpStatus: 200, body: { id: 'x', type: 'message', model: 'sim-haiku', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' } } }); }) } });
  const ex1 = createExecutor(s.cfg);
  assert.ok(existsSync(path.join(s.dir, '.lock')));
  const pending = ex1.run(plan({ promptSha256: s.store.sha['p1']! }));
  await new Promise((r) => setTimeout(r, 20));
  assert.throws(() => createExecutor(s.cfg), (e: BatchLockedError) => e instanceof BatchLockedError && e.code === 'LOCK_HELD_IN_PROCESS', 'ocupado: recusado');
  release!(); assert.equal((await pending).state, 'COST_COMPUTED');
  const ex2 = createExecutor(s.cfg); // idle ex1 is superseded (restart semantics)
  await assert.rejects(ex1.run(plan({ promptSha256: s.store.sha['p2']!, promptId: 'P2' })), (e: BatchLockedError) => e.code === 'LOCK_LOST');
  ex2.close();
  writeFileSync(path.join(s.dir, '.lock'), JSON.stringify({ pid: 999999999, nonce: 'dead' }));
  const ex3 = createExecutor(s.cfg); ex3.close(); // dead pid: taken over
  writeFileSync(path.join(s.dir, '.lock'), JSON.stringify({ pid: process.ppid, nonce: 'alive' }));
  assert.throws(() => createExecutor(s.cfg), (e: BatchLockedError) => e instanceof BatchLockedError && e.code === 'LOCK_HELD_BY_PID');
});

test('R15-M3: ledger.jsonl editado (liquidacao apagada / reserva apagada) nao reconcilia com o journal => abrir e recusado', async () => {
  const s = setup();
  const ex = createExecutor(s.cfg);
  const p = plan({ promptSha256: s.store.sha['p1']! });
  assert.equal((await ex.run(p)).state, 'COST_COMPUTED');
  ex.close();
  assert.doesNotThrow(() => createExecutor(s.cfg).close(), 'intacto: reconcilia');
  const lp = path.join(s.dir, 'ledger.jsonl'); const lines = readFileSync(lp, 'utf8');
  writeFileSync(lp, lines.split('\n').filter((l) => l && !l.includes('"kind":"settle"')).join('\n') + '\n');
  assert.throws(() => createExecutor(s.cfg), (e: LedgerReconciliationError) => e instanceof LedgerReconciliationError && e.detail['provider'] === 'anthropic');
  writeFileSync(lp, '');
  assert.throws(() => createExecutor(s.cfg), LedgerReconciliationError, 'ledger vazio com journal liquidado');
  writeFileSync(lp, lines);
  createExecutor(s.cfg).close();
});

test('R15-M5: envio que nunca responde => timeout => TIMEOUT_UNCERTAIN, reserva mantida como possivelmente cobrada, nunca reenvio', async () => {
  const s = setup({ egress: { double: () => new Promise(() => { /* hangs */ }), timeoutMs: 40 } });
  const ex = createExecutor(s.cfg);
  const p = plan({ promptSha256: s.store.sha['p1']! });
  const t0 = Date.now();
  const r = await ex.run(p);
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual([r.state, r.stop], ['UNCERTAIN', 'STOP_UNCERTAIN']);
  assert.deepEqual(kinds(s.dir, operationIdOf(p)).slice(-2), ['TIMEOUT_UNCERTAIN', 'UNCERTAIN_ISOLATED']);
  const st = ex.ledger.state().providers.anthropic;
  assert.equal(st.possiblyChargedUsd, (1000n * 1_250_000n + 64n * 5_000_000n).toString()); assert.equal(st.reservedUsd, '0');
  ex.close();
});

test('R15-B3: send exige o token de preflight do mesmo corpo, de uso unico; sem ele => PREFLIGHT_TOKEN_INVALID', async () => {
  const e = createEgress({ mode: 'OFFLINE', campaign: 'x', allowedHosts: [OFFICIAL_HOST], double: async () => ({ httpStatus: 200, body: {} }) });
  const req = doubleAdapter().buildRequest(plan({ promptSha256: 'a'.repeat(64) }), { promptSha256: 'a'.repeat(64), messages: [{ role: 'user', parts: [{ type: 'text', text: 'oi' }] }], prefixMessages: 'NOT_APPLICABLE' });
  const ctx = { provider: 'anthropic' as const, phase: 'PILOT', modelRequested: 'sim-haiku', batchId: 'b', executorVersion: 'v', executorCodeSha: 'c', ledgerCaps: { campaignUsd: '11', providerUsd: '5' } };
  await assert.rejects(e.send('anthropic', req, 'nope'), (x: EgressRefused) => x.code === 'PREFLIGHT_TOKEN_INVALID');
  const { token } = e.preflight(ctx, req, [OFFICIAL_HOST]);
  await assert.rejects(e.send('anthropic', { ...req, body: { changed: true } }, token), (x: EgressRefused) => x.code === 'PREFLIGHT_TOKEN_INVALID', 'corpo diferente do pre-voo');
  const { token: t2 } = e.preflight(ctx, req, [OFFICIAL_HOST]);
  assert.equal((await e.send('anthropic', req, t2)).httpStatus, 200);
  await assert.rejects(e.send('anthropic', req, t2), (x: EgressRefused) => x.code === 'PREFLIGHT_TOKEN_INVALID', 'uso unico');
});

test('R15-P2-3: tres negativos diretos - preflight REAL sem flag; teto de lote configurado acima de 25% recusado pelo ledger; liquidacao acima da reserva => STOP_CAP_VIOLATION', async () => {
  const e = createEgress({ mode: 'REAL', realFlag: false, campaign: 'x', allowedHosts: [OFFICIAL_HOST], fetchImpl: (async () => { throw new Error('never'); }) as unknown as typeof fetch });
  const req = doubleAdapter().buildRequest(plan({ promptSha256: 'a'.repeat(64) }), { promptSha256: 'a'.repeat(64), messages: [{ role: 'user', parts: [{ type: 'text', text: 'oi' }] }], prefixMessages: 'NOT_APPLICABLE' });
  assert.throws(() => e.preflight({ provider: 'anthropic', phase: 'PILOT', modelRequested: 'sim-haiku', batchId: 'b', executorVersion: 'v', executorCodeSha: 'c', ledgerCaps: { campaignUsd: '11', providerUsd: '5' } }, req, [OFFICIAL_HOST]), (x: EgressRefused) => x.code === 'REAL_FLAG_MISSING');
  const { openLedger, BudgetStop } = await import('../../../scripts/h2eval/core/ledger.js');
  const L = openLedger(path.join(tmp('l25'), 'ledger.jsonl'), { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, batchesUsd: { big: '1.26' } });
  assert.throws(() => L.reserve('op', 'anthropic', 'big', 1n), (x: InstanceType<typeof BudgetStop>) => x.reason === 'STOP_BUDGET_BATCH' && x.detail['reason'] === 'batch_cap_above_25pct_of_provider');
  L.reserve('op2', 'anthropic', 'ok', usdToPico('0.5'));
  assert.throws(() => L.settle('op2', 'anthropic', 'ok', usdToPico('0.5') + 1n), (x: InstanceType<typeof BudgetStop>) => x.reason === 'STOP_CAP_VIOLATION');
  L.settle('op2', 'anthropic', 'ok', usdToPico('0.5'));
});

test('R15-B2: buildCorpus duas vezes com a mesma semente => mesmo corpusSha256 (o congelamento executa o gerador antes e depois da colisao)', () => {
  const a = buildCorpus({ seed: 424242, s2Dialogs: 2, s3Dialogs: 2 }); const b = buildCorpus({ seed: 424242, s2Dialogs: 2, s3Dialogs: 2 });
  assert.equal(a.manifest['corpusSha256'], b.manifest['corpusSha256']);
  assert.notEqual(a.manifest['corpusSha256'], buildCorpus({ seed: 424243, s2Dialogs: 2, s3Dialogs: 2 }).manifest['corpusSha256']);
  assert.ok(usdToPico('11') > 0n);
});
