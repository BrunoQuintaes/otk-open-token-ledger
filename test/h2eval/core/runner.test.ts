/**
 * Tests the executor's per-operation state machine: fixed step order, replay without re-sending, crash recovery at
 * every step, uncertainty, every spending cap, unknown prices, the stop file, secret hygiene and an unreachable REAL
 * mode.
 *
 * Modules under test: `scripts/h2eval/core/runner.ts` (`createExecutor`), `scripts/h2eval/core/ids.ts`,
 * `scripts/h2eval/core/journal.ts`, `scripts/h2eval/core/ledger.ts` and `scripts/h2eval/record/snapshot.ts`, with
 * the doubles in `../support/double.ts`.
 *
 * Strategy / partitions: the normal flow (journal kinds in order, snapshot before sending, reservation equal to the
 * cost cap, settlement); idempotent replay; a crash injected at each step (before sending the reservation is
 * released, after sending the operation is isolated as uncertain and possibly charged); send failures; refusals
 * with and without usage; partial usage (cost `UNKNOWN`, never 0); provider, batch and campaign caps checked before
 * sending; unknown price; a cost above the reserved cap; the stop file; two real failures in a row; a canary secret
 * in the process environment that never appears in any file or request; REAL mode unreachable in tests (flag, GO
 * file and key variable each missing, or a forbidden variable present); concurrency of one; a non-text modality
 * with an unknown local count; and a repository check that nothing outside `scripts/h2eval` and `test/h2eval`
 * differs from the earlier evaluated commit.
 *
 * Needs: a writable temporary directory; the `git` command and a repository checkout for the last test (it runs
 * `git diff` against a fixed commit, so any change outside those two folders, including comment-only changes, makes
 * it fail). It sets `H2EVAL_TEST_KEY` and `H2EVAL_TEST_FORBIDDEN` to fake values. Importing `syntheticGo` from
 * `./go.test.ts` also registers that file's tests in this run. No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/runner.test.ts`
 *
 * @module test/h2eval/core/runner.test
 */
// SYNTHETIC — OFFLINE. R11 runner + R15-style negatives: replay, crash at every point, duplicates, uncertain, every cap, unknown
// price, stop file, canary secret, REAL unreachable. Doubles only; no network; no credential value ever read in OFFLINE mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { readSnapshot } from '../../../scripts/h2eval/record/snapshot.js';
import { usdToPico } from '../../../scripts/h2eval/core/ledger.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, scriptedDouble, MODEL, OFFICIAL_HOST } from '../support/double.js';
import { syntheticGo } from './go.test.js';

const CANARY = 'zq-canary-secret-7f3a9c';
process.env['H2EVAL_TEST_KEY'] = CANARY; // present in the process; must never reach any file

function setup(opts: { steps?: Parameters<typeof scriptedDouble>[0]; omitPrices?: string[]; caps?: Partial<ExecutorConfig['ledger']>; crashAt?: ExecutorConfig['crashAt']; dir?: string; watchdogMs?: number; extra?: Partial<ExecutorConfig> } = {}) {
  const dir = opts.dir ?? tmp('run');
  const store = memoryContentStore({ p1: 'Resuma este texto sintético sobre medição de tokens em três frases curtas.', p2: 'Outro texto sintético, diferente, para a segunda operação.' });
  const sd = scriptedDouble(opts.steps ?? [{ kind: 'ok' }]);
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir, { omit: opts.omitPrices }),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, ...opts.caps },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: sd.double, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } },
    ...(opts.extra ?? {}),
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 },
    executorCodeSha: 'c'.repeat(40), crashAt: opts.crashAt, watchdogMs: opts.watchdogMs,
  };
  return { dir, store, sd, cfg, ex: createExecutor(cfg) };
}
const kindsOf = (dir: string, id: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')).filter((l) => l.operationId === id).map((l) => l.kind);
const allText = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name), 'utf8')).join('\n');

test('R11 fluxo OK: ordem imutável PLANNED→SNAPSHOT→RESERVED→SENT→RESPONSE→USAGE→COST→SETTLED; snapshot gravado antes do envio; reserva = teto; liquidação pelo custo', async () => {
  const { dir, store, ex, sd } = setup({ steps: [{ kind: 'ok', input: 300, output: 20 }] });
  const p = plan({ promptSha256: store.sha['p1']! });
  const id = operationIdOf(p);
  const r = await ex.run(p);
  assert.deepEqual([r.state, r.stop, r.replayed], ['COST_COMPUTED', null, false]);
  assert.deepEqual(kindsOf(dir, id), ['PLANNED', 'PRECALL_SNAPSHOT_COMMITTED', 'RESERVED', 'SENT', 'RESPONSE_RECEIVED', 'USAGE_PARSED', 'COST_COMPUTED', 'SETTLED']);
  const snap = readSnapshot(dir, id);
  assert.equal(snap.estimateStatus, 'ESTIMATED'); assert.equal(typeof snap.counter.L0, 'number'); assert.ok((snap.counter.L0 as number) > 5);
  // cap = 1000 × max(1.00, 1.25) + 64 × 5.00 USD/MTok => (1000×1250000 + 64×5000000) pico = 1_570_000_000 pico = 0.00157 USD
  assert.equal(snap.costCap.usd, (1000n * 1_250_000n + 64n * 5_000_000n).toString());
  // cost = 300×1.00 + 20×5.00 => 300_000_000 + 100_000_000 = 400_000_000 pico = 0.0004 USD
  const rec = JSON.parse(readFileSync(path.join(dir, 'records', `${id}.json`), 'utf8'));
  assert.equal(rec.cost.usd, '400000000'); assert.equal(rec.cost.state, 'CALCULATED'); assert.equal(rec.cost.capCovered, true);
  assert.equal(rec.cost.billing.observedUsd, null); assert.equal(rec.outcome, 'OK'); assert.equal(rec.usage.cacheObserved, 'NO_HIT');
  const st = ex.ledger.state().providers.anthropic;
  assert.deepEqual([st.spentUsd, st.reservedUsd, st.possiblyChargedUsd, st.operations], ['400000000', '0', '0', 1]);
  assert.equal(sd.seen.length, 1); assert.equal(Object.keys(sd.seen[0]!.headers).some((h) => h.toLowerCase() === 'x-api-key'), false, 'sem credencial no pedido OFFLINE');
  // snapshot and journal written BEFORE egress: the double saw the request after the SENT line (seq order)
  const lines = verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
  assert.ok(lines.findIndex((l) => l.kind === 'SENT') < lines.findIndex((l) => l.kind === 'RESPONSE_RECEIVED'));
});

test('idempotência: a mesma operação (mesmo plano) de novo => REPLAY_SKIPPED, nenhum envio, nenhuma cobrança nova; operationId determinístico', async () => {
  const { dir, store, ex, sd } = setup();
  const p = plan({ promptSha256: store.sha['p1']! });
  await ex.run(p);
  const r2 = await ex.run(p);
  assert.deepEqual([r2.replayed, r2.state], [true, 'COST_COMPUTED']);
  assert.equal(sd.seen.length, 1);
  assert.equal(kindsOf(dir, operationIdOf(p)).at(-1), 'REPLAY_SKIPPED');
  assert.equal(ex.ledger.state().providers.anthropic.operations, 1);
  assert.equal(operationIdOf(p), operationIdOf({ ...p, variant: 'other', split: 'train' } as typeof p), 'id não depende de campos fora de protocolHash:cellId:promptId:rep:model');
  assert.notEqual(operationIdOf(p), operationIdOf({ ...p, rep: 2 }));
});

for (const point of ['after_planned', 'after_snapshot', 'after_reserved', 'after_sent', 'after_response'] as const) {
  test(`crash em ${point}: ao reabrir, replay nunca reenvia; antes de SENT => ABORTED (reserva liberada); depois de SENT => UNCERTAIN isolado e possivelmente cobrado`, async () => {
    const dir = tmp(`crash-${point}`);
    const first = setup({ dir, crashAt: (pt) => { if (pt === point) throw new Error(`SYN_CRASH_${pt}`); } });
    const p = plan({ promptSha256: first.store.sha['p1']! });
    const id = operationIdOf(p);
    await assert.rejects(first.ex.run(p), /SYN_CRASH/);
    const sentBefore = first.sd.seen.length;
    const second = setup({ dir });
    const r = await second.ex.run(p);
    assert.equal(r.replayed, true);
    assert.equal(second.sd.seen.length, 0, 'replay nunca reenvia');
    const st = second.ex.ledger.state().providers.anthropic;
    if (point === 'after_sent' || point === 'after_response') {
      assert.equal(r.state, 'UNCERTAIN'); assert.equal(r.stop, 'STOP_UNCERTAIN');
      assert.equal(kindsOf(dir, id).at(-1), 'UNCERTAIN_ISOLATED');
      assert.equal(st.possiblyChargedUsd, (1000n * 1_250_000n + 64n * 5_000_000n).toString(), 'teto inteiro fica como possivelmente cobrado');
      assert.equal(st.reservedUsd, '0');
      assert.equal(sentBefore, point === 'after_response' ? 1 : 0, 'after_sent: a linha SENT precede o envio real; after_response: o double foi chamado uma vez');
    } else {
      assert.equal(r.state, 'ABORTED_BEFORE_SEND');
      assert.deepEqual([st.reservedUsd, st.possiblyChargedUsd, st.spentUsd], ['0', '0', '0'], 'nada reservado nem cobrado');
      assert.equal(sentBefore, 0, 'nada saiu antes de SENT');
    }
    const third = setup({ dir });
    const r3 = await third.ex.run(p);
    assert.equal(r3.replayed, true); assert.equal(third.sd.seen.length, 0, 'terminal: continua sem reenvio');
  });
}

test('falha de envio (exceção/timeout) => TIMEOUT_UNCERTAIN + UNCERTAIN_ISOLATED, custo UNKNOWN (nunca 0), possiblyCharged, reserva vira possivelmente cobrada', async () => {
  const { dir, store, ex } = setup({ steps: ['throw'] });
  const p = plan({ promptSha256: store.sha['p1']! });
  const r = await ex.run(p);
  assert.deepEqual([r.state, r.stop], ['UNCERTAIN', 'STOP_UNCERTAIN']);
  const rec = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(p)}.json`), 'utf8'));
  assert.deepEqual([rec.outcome, rec.cost.usd, rec.cost.state, rec.cost.possiblyCharged, rec.usage], ['TIMEOUT_UNCERTAIN', 'UNKNOWN', 'UNKNOWN', true, null]);
  assert.notEqual(ex.ledger.state().providers.anthropic.possiblyChargedUsd, '0');
});

test('recusa COM uso => REFUSED_WITH_USAGE, custo CALCULATED pelo uso declarado (não excluído); erro SEM uso => ERROR_NO_USAGE, custo UNKNOWN e possivelmente cobrado', async () => {
  const { dir, store, ex } = setup({ steps: [{ kind: 'refuse_with_usage', input: 120 }, { kind: 'error_no_usage' }] });
  const a = plan({ promptSha256: store.sha['p1']! }); const b = plan({ promptSha256: store.sha['p2']!, promptId: 'P2' });
  const ra = await ex.run(a); const rb = await ex.run(b);
  const recA = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(a)}.json`), 'utf8'));
  assert.deepEqual([ra.state, recA.outcome, recA.cost.state, recA.cost.usd, recA.refusal.code], ['COST_COMPUTED', 'REFUSED_WITH_USAGE', 'CALCULATED', (120n * 1_000_000n).toString(), 'policy']);
  const recB = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(b)}.json`), 'utf8'));
  assert.deepEqual([rb.state, recB.outcome, recB.cost.state, recB.cost.usd, recB.cost.possiblyCharged], ['UNCERTAIN', 'ERROR_NO_USAGE', 'UNKNOWN', 'UNKNOWN', true]);
});

test('uso parcial (campos faltando) => custo UNKNOWN, nunca 0; cacheObserved UNKNOWN', async () => {
  const { dir, store, ex } = setup({ steps: [{ kind: 'usage_missing_fields' }] });
  const p = plan({ promptSha256: store.sha['p1']! });
  await ex.run(p);
  const rec = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(p)}.json`), 'utf8'));
  assert.deepEqual([rec.usage.usageCompleteness, rec.usage.cacheObserved, rec.cost.state, rec.cost.usd], ['PARTIAL', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  assert.ok(Object.values(rec.cost.byCategory).includes('UNKNOWN'));
});

test('estouro de cada teto ANTES do envio: sub-ledger do provedor, lote e campanha => STOP_BUDGET_* sem envio e sem reserva; sem transferência entre provedores', async () => {
  const capPico = 1000n * 1_250_000n + 64n * 5_000_000n; // 0.00157 USD por operação
  // provider 0.0064 (lote padrão = 25% = 0.0016 >= teto da operação); 4 operações em 4 lotes liquidam 0.00132 cada (1000 in × 1.00 + 64 out × 5.00)
  // => comprometido 0.00528; a quinta (0.00528 + 0.00157 > 0.0064) estoura o sub-ledger. pauseAck porque 82% > 80%.
  const { store, ex, sd } = setup({ steps: Array.from({ length: 5 }, () => ({ kind: 'ok' as const, input: 1000, output: 64 })), caps: { providersUsd: { anthropic: '0.0064', openai: '3', google: '3' } }, extra: { pauseAck: [{ provider: 'anthropic', acknowledgedBy: 'human:SYNTHETIC', source: 'operator', reference: 'test' }] } });
  for (let i = 1; i <= 4; i += 1) assert.equal((await ex.run(plan({ promptSha256: store.sha['p1']!, promptId: `P${i}`, batchId: `b${i}` }))).state, 'COST_COMPUTED');
  const rb = await ex.run(plan({ promptSha256: store.sha['p2']!, promptId: 'P5', batchId: 'b5' }));
  assert.deepEqual([rb.state, rb.stop], ['STOP_BUDGET', 'STOP_BUDGET_PROVIDER']);
  assert.equal(sd.seen.length, 4, 'quinta operação não saiu');
  assert.equal(ex.ledger.state().providers.anthropic.reservedUsd, '0');
  assert.ok(usdToPico('3') > capPico, 'openai teria espaço: nenhuma transferência cruzada foi feita');
  const batch = setup({ caps: { batchesUsd: { batch1: '0.001' } } });
  const rbatch = await batch.ex.run(plan({ promptSha256: batch.store.sha['p1']! }));
  assert.deepEqual([rbatch.state, rbatch.stop, batch.sd.seen.length], ['STOP_BUDGET', 'STOP_BUDGET_BATCH', 0]);
  const camp = setup({ caps: { campaignUsd: '0.001' } });
  const rcamp = await camp.ex.run(plan({ promptSha256: camp.store.sha['p1']! }));
  assert.deepEqual([rcamp.state, rcamp.stop, camp.sd.seen.length], ['STOP_BUDGET', 'STOP_BUDGET_CAMPAIGN', 0]);
});

test('preço desconhecido (categoria ausente na tabela) => STOP_PRICE_UNKNOWN antes de reservar; nada sai', async () => {
  const { store, ex, sd } = setup({ omitPrices: ['output'] });
  const r = await ex.run(plan({ promptSha256: store.sha['p1']! }));
  assert.deepEqual([r.state, r.stop, sd.seen.length], ['ABORTED_BEFORE_SEND', 'STOP_PRICE_UNKNOWN', 0]);
  assert.equal(ex.ledger.state().providers.anthropic.reservedUsd, '0');
});

test('violação do teto (custo calculado > teto reservado) => STOP_CAP_VIOLATION, STOP_GLOBAL no journal, reserva fica possivelmente cobrada', async () => {
  const { dir, store, ex } = setup({ steps: [{ kind: 'ok', input: 5000, output: 64 }] }); // 5000×1.00 + 64×5 = 0.00532 > cap 0.00157
  const p = plan({ promptSha256: store.sha['p1']! });
  const r = await ex.run(p);
  assert.deepEqual([r.state, r.stop], ['STOP_BUDGET', 'STOP_CAP_VIOLATION']);
  assert.equal(kindsOf(dir, operationIdOf(p)).at(-1), 'STOP_GLOBAL');
  const rec = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(p)}.json`), 'utf8'));
  assert.equal(rec.cost.capCovered, false);
});

test('arquivo de stop => nada sai, STOP_FILE; watchdog de tempo como extra', async () => {
  const { dir, store, ex, sd } = setup();
  writeFileSync(path.join(dir, 'STOP'), '');
  const r = await ex.run(plan({ promptSha256: store.sha['p1']! }));
  assert.deepEqual([r.stop, sd.seen.length], ['STOP_FILE', 0]);
  rmSync(path.join(dir, 'STOP'));
  const w = setup({ watchdogMs: -1 });
  const rw = await w.ex.run(plan({ promptSha256: w.store.sha['p1']! }));
  assert.deepEqual([rw.stop, w.sd.seen.length], ['STOP_WATCHDOG', 0]);
});

test('2 falhas REAIS seguidas no mesmo modelo => pausa (STOP_CONSECUTIVE_FAILURES) na terceira, antes de enviar', async () => {
  // E1': a regra e a mesma de antes para falhas reais com usage: aqui, modelServed fora da lista aceita (EXCL_MODEL_MISMATCH) x2 (erro sem usage vira UNCERTAIN/STOP_UNCERTAIN antes, ver C158 cycle 2).
  // As RECUSAS com usage deixaram de contar: teste proprio em e1prime_refusal.test.ts.
  const { store, ex, sd, cfg } = setup({ steps: [{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }] });
  const modelo = plan({ promptSha256: store.sha['p1']! }).modelRequested;
  const ex2 = createExecutor({ ...cfg, consecutiveFailureStop: 2, acceptedModelsServed: { [modelo]: ['modelo-que-nao-e-o-servido'] } });
  await ex2.run(plan({ promptSha256: store.sha['p1']! })); await ex2.run(plan({ promptSha256: store.sha['p2']!, promptId: 'P2' }));
  const r3 = await ex2.run(plan({ promptSha256: store.sha['p1']!, promptId: 'P3' }));
  assert.deepEqual([r3.stop, sd.seen.length], ['STOP_CONSECUTIVE_FAILURES', 2]);
  void ex;
});

test('canário: a variável de ambiente com o segredo existe no processo e NUNCA aparece em journal, snapshot, registro, ledger ou pedido (OFFLINE nem a lê)', async () => {
  const { dir, store, ex, sd } = setup({ steps: [{ kind: 'ok' }, { kind: 'error_no_usage' }, 'throw'] });
  await ex.run(plan({ promptSha256: store.sha['p1']! })); await ex.run(plan({ promptSha256: store.sha['p2']!, promptId: 'P2' })); await ex.run(plan({ promptSha256: store.sha['p1']!, promptId: 'P3' }));
  assert.doesNotMatch(allText(dir), new RegExp(CANARY));
  assert.doesNotMatch(JSON.stringify(sd.seen), new RegExp(CANARY));
  // prompt text never in journal/snapshots/records either (content by hash only)
  assert.doesNotMatch(allText(dir), /Resuma este texto sintético/);
});

test('modo REAL é INALCANÇÁVEL nos testes: flag sem GO, GO sem flag, e flag+GO sem variável da chave => ABORTED_BEFORE_SEND, 0 fetch, nada reservado', async () => {
  const fetchSpy = async () => { throw new Error('fetch must never be called in tests'); };
  const base = setup();
  const go = path.join(base.dir, 'GO.json');
  // a complete, self-consistent synthetic GO v1 for THIS executor (codeSha, campaign, batch, model) — still not enough without flag + env
  writeFileSync(go, syntheticGo({ campaign: 'h2eval-test', window: { notBeforeUtc: new Date(Date.now() - 60_000).toISOString(), expiresUtc: new Date(Date.now() + 3_600_000).toISOString() } }));
  const prereg = 'ab'.repeat(32);
  const variants = [
    { name: 'flag sem GO', egress: { realFlag: true, goFile: path.join(base.dir, 'missing.json'), preregistrationSha256: prereg }, env: 'NO_SUCH_VAR', forbidden: [] as string[] },
    { name: 'GO sem flag', egress: { realFlag: false, goFile: go, preregistrationSha256: prereg }, env: 'NO_SUCH_VAR', forbidden: [] as string[] },
    { name: 'flag+GO v1 válido sem chave', egress: { realFlag: true, goFile: go, preregistrationSha256: prereg }, env: 'H2EVAL_KEY_THAT_DOES_NOT_EXIST', forbidden: [] as string[] },
    { name: 'flag+GO sem pré-registro configurado', egress: { realFlag: true, goFile: go }, env: 'H2EVAL_TEST_KEY', forbidden: [] as string[] },
    { name: 'flag+GO+chave mas variável proibida presente (chave do Bot)', egress: { realFlag: true, goFile: go, preregistrationSha256: prereg }, env: 'H2EVAL_TEST_KEY', forbidden: ['H2EVAL_TEST_FORBIDDEN'] },
  ];
  process.env['H2EVAL_TEST_FORBIDDEN'] = 'x';
  for (const v of variants) {
    const dir = tmp('real');
    const ex = createExecutor({ ...base.cfg, batchDir: dir, egress: { mode: 'REAL', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], credentialEnvVars: { anthropic: v.env }, forbiddenEnvVars: v.forbidden, fetchImpl: fetchSpy as unknown as typeof fetch, ...v.egress } });
    const r = await ex.run(plan({ promptSha256: base.store.sha['p1']! }));
    assert.deepEqual([r.state, r.stop], ['ABORTED_BEFORE_SEND', null], v.name);
    assert.equal(ex.ledger.state().providers.anthropic.reservedUsd, '0', v.name);
    assert.ok(!existsSync(path.join(dir, 'snapshots', `${operationIdOf(plan({ promptSha256: base.store.sha['p1']! }))}.json`)), `${v.name}: nenhum snapshot (recusa antes)`);
  }
  // host fora da lista oficial/allowlist => recusa antes de tudo, mesmo OFFLINE
  const bad = { ...doubleAdapter(), officialHosts: ['evil.invalid'] };
  const exBad = createExecutor({ ...base.cfg, batchDir: tmp('host'), adapters: { 'anthropic.messages': { ...bad, buildRequest: (p, c) => ({ ...doubleAdapter().buildRequest(p, c), url: 'https://evil.invalid/v1/messages' }) } } });
  const rb = await exBad.run(plan({ promptSha256: base.store.sha['p1']! }));
  assert.deepEqual([rb.state, base.sd.seen.length], ['ABORTED_BEFORE_SEND', 0]);
});

test('concorrência 1: segunda chamada enquanto a primeira corre é recusada', async () => {
  const { store, ex } = setup({ steps: [{ kind: 'ok' }, { kind: 'ok' }] });
  const a = ex.run(plan({ promptSha256: store.sha['p1']! }));
  await assert.rejects(ex.run(plan({ promptSha256: store.sha['p2']!, promptId: 'P2' })), /serial/);
  await a;
});

test('modalidade não-texto (imagem) => contador incomplete, L0 UNKNOWN, estimateStatus UNSUPPORTED_FOR_ESTIMATION (nunca L0 inventado), mas a operação roda e o custo vem do uso declarado', async () => {
  const dir = tmp('image');
  const store = memoryContentStore({ p1: 'texto' });
  const h = 'd'.repeat(64);
  const img: Awaited<ReturnType<typeof store.get>> = { promptSha256: h, messages: [{ role: 'user', parts: [{ type: 'text', text: 'descreva' }, { type: 'image', mime: 'image/png', bytesSha256: 'e'.repeat(64), width: 10, height: 10 }] }], prefixMessages: 'NOT_APPLICABLE' };
  const cs = { ...store, get: async (x: string) => (x === h ? img : store.get(x)) };
  const { cfg } = setup({ dir });
  const ex = createExecutor({ ...cfg, contentStore: cs });
  const p = plan({ promptSha256: h, modality: 'image' });
  const r = await ex.run(p);
  assert.equal(r.state, 'COST_COMPUTED');
  const snap = readSnapshot(dir, operationIdOf(p));
  assert.deepEqual([snap.counter.L0, snap.estimateStatus], ['UNKNOWN', 'UNSUPPORTED_FOR_ESTIMATION']);
});

test(`H1 intocada: diff contra 7606bc9b fora de scripts/h2eval e test/h2eval é vazio (conferido por git no repositório)`, () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const out = execFileSync('git', ['-C', root, 'diff', '7606bc9be46bde8c1bc427c2eb4873bc1a474779', '--stat', '--', '.', ':!scripts/h2eval', ':!test/h2eval'], { encoding: 'utf8' });
  assert.equal(out.trim(), '');
  void MODEL;
});
