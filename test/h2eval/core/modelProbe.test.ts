/**
 * Tests the automatic probe of a new model or an unmeasured prompt-length region: the first operation of a region
 * is judged, and a failed or unresolved probe halts the batch for good.
 *
 * Modules under test: `scripts/h2eval/core/modelProbe.ts` (`aboveRangeBand`, `probeRegionOf`, `probeKeyOf`,
 * `probeStateOf`, `judgeProbe`), `scripts/h2eval/cli/run.ts` (`modelProbeFromArgs`) and
 * `scripts/h2eval/core/runner.ts`.
 *
 * Strategy / partitions: units (regions, key, state and judgement; unknown is never treated as good); CLI and
 * configuration (limit required, outside [1, 10], NaN and empty refused; no probe without the flag); a new model
 * whose first operation is the probe; adversarial cases (ratio above the limit, truncated completion, input above
 * the reservation, an uncertain probe whose human acknowledgement does not license the model, crash windows around
 * the probe result); the above-range region of a model with a measured range, split into length-doubling bands each
 * with its own probe; interplay with the reserve policy and the input guard; off by default and exempt models; no
 * ratio judgement after a passed probe; restart after a passed probe; and refusal before the region when the local
 * count is unknown.
 *
 * Needs: a writable temporary directory. It sets `H2EVAL_TEST_KEY` to a fake canary value. Doubles only: no network,
 * no credential, no paid call, no GO file.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/modelProbe.test.ts`
 *
 * @module test/h2eval/core/modelProbe.test
 */
// SYNTHETIC — OFFLINE. C158: AUTOMATIC PROBE of a new model / unmeasured length region. The first operation of a region is judged (measured vs estimated vs reservation, completion, tier, reasoning);
// a failed or unresolved probe halts the batch (STOP_MODEL_PROBE_FAILED, no retry, latching, also after a restart). Adversarial: crash windows, ack of an uncertain probe, tier/truncation, G7 interplay,
// reserve-policy interplay, off by default. Doubles only: no network, no credential, no paid call, no GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { aboveRangeBand, probeRegionOf, probeKeyOf, probeStateOf, judgeProbe } from '../../../scripts/h2eval/core/modelProbe.js';
import { modelProbeFromArgs } from '../../../scripts/h2eval/cli/run.js';
import { loadPriceTable } from '../../../scripts/h2eval/record/prices.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { tmp, writePriceFixture, memoryContentStore, plan, doubleAdapter, bodyOf as rawBodyOf, OFFICIAL_HOST } from '../support/double.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';

process.env['H2EVAL_TEST_KEY'] = 'zq-probe-canary';
const NEW = 'claude-future-9'; const S55 = 'claude-sonnet-5-5'; const LIMIT = 1.9;
const SHORT = Array.from({ length: 30 }, (_, i) => `palavra${i} sintetica de teste`).join(' ');
const LONG = Array.from({ length: 400 }, (_, i) => `palavra${i} sintetica de teste`).join(' ');
const TEXTS = { a: SHORT, b: SHORT + ' b', c: SHORT + ' c', long1: LONG, long2: LONG + ' x', long3: LONG + ' y' };
function pricesFor(dir: string, model: string) { const f = writePriceFixture(dir); writeFileSync(f, readFileSync(f, 'utf8').split('sim-haiku').join(model)); return loadPriceTable(f); }
const kinds = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
type Mut = (body: Record<string, unknown>) => void;

interface BuildOpts { dir?: string; model: string; probe?: ExecutorConfig['modelProbe']; policy?: ExecutorConfig['inputReservePolicy']; ratio?: number; mutate?: Mut; throwSend?: boolean; noUsage?: boolean; crashAt?: ExecutorConfig['crashAt']; bound?: (L0: number) => number }
function build(o: BuildOpts) {
  const dir = o.dir ?? tmp('prb'); const store = memoryContentStore(TEXTS); const sent: BuiltRequest[] = []; let lastL0 = 0;
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: pricesFor(dir, o.model),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' },
      double: async (req: BuiltRequest) => {
        sent.push(req); if (o.throwSend) throw new Error('SYN_SEND_FAILURE');
        const r = o.noUsage ? rawBodyOf({ kind: 'error_no_usage' }) : rawBodyOf({ kind: 'ok', input: Math.round((o.ratio ?? 1.5) * lastL0), output: 5 });
        if (o.mutate) o.mutate(r.body as Record<string, unknown>); return { httpStatus: r.status, body: r.body };
      } },
    capPolicy: { inputUpperBoundTokens: (_p, L0) => { lastL0 = L0 as number; return o.bound ? o.bound(L0 as number) : Math.ceil((L0 as number) * 10) + 100; }, reasoningAllowanceTokens: () => 0 },
    executorCodeSha: 'c'.repeat(40), modelProbe: o.probe, inputReservePolicy: o.policy, crashAt: o.crashAt,
  };
  return { dir, store, sent, ex: createExecutor(cfg), cfg };
}
const P = (store: { sha: Record<string, string> }, n: string, model: string, rep = 1) => plan({ promptSha256: store.sha[n]!, promptId: n.toUpperCase(), rep, modelRequested: model });
async function serial(ex: { run: (p: ReturnType<typeof plan>) => Promise<{ stop: string | null; replayed: boolean }> }, ps: Array<ReturnType<typeof plan>>) { const out: Array<{ stop: string | null; replayed: boolean }> = []; for (const p of ps) { const r = await ex.run(p); out.push(r); if (r.stop) break; } return out; }
const probe = { maxMeasuredToEstimatedRatio: LIMIT };
const sentCount = (dir: string) => kinds(dir).filter((l) => l.kind === 'SENT').length;

test('unidades: regioes de sonda, chave, estado e julgamento (desconhecido NUNCA e tratado como bom)', () => {
  assert.equal(probeRegionOf('anthropic', NEW, 40), 'UNMEASURED_MODEL'); assert.equal(probeRegionOf('anthropic', 'sim-haiku', 40), 'UNMEASURED_MODEL');
  assert.equal(probeRegionOf('anthropic', S55, 811), 'ABOVE_RANGE_B0'); assert.equal(probeRegionOf('anthropic', S55, 810), null); assert.equal(probeRegionOf('anthropic', S55, 11), 'BELOW_RANGE'); assert.equal(probeRegionOf('anthropic', S55, 'UNKNOWN'), 'L0_UNKNOWN');
  assert.equal(probeRegionOf('anthropic', 'claude-haiku-5-5', 5705), null); assert.equal(probeRegionOf('anthropic', 'claude-haiku-5-5', 5706), 'ABOVE_RANGE_B0');
  assert.equal(probeRegionOf('anthropic', 'claude-haiku-4-5-20251001', 99999), null, 'isento da politica'); assert.equal(probeRegionOf('openai', 'gpt-4o-mini-2024-07-18', 99999), null); assert.equal(probeRegionOf('google', 'x', 1), null);
  assert.notEqual(probeKeyOf('anthropic', NEW, 'UNMEASURED_MODEL'), probeKeyOf('anthropic', S55, 'ABOVE_RANGE_B0'));
  const L = (kind: string, operationId: string, body: Record<string, unknown>) => ({ kind, operationId, body });
  assert.equal(probeStateOf([], 'k'), 'NONE'); assert.equal(probeStateOf([L('MODEL_PROBE_STARTED', 'a', { key: 'k' })], 'k'), 'UNRESOLVED');
  assert.equal(probeStateOf([L('MODEL_PROBE_STARTED', 'a', { key: 'k' }), L('MODEL_PROBE_RESULT', 'a', { key: 'k', verdict: 'FAILED' })], 'k'), 'UNRESOLVED'); assert.equal(probeStateOf([L('MODEL_PROBE_STARTED', 'a', { key: 'k' }), L('MODEL_PROBE_RESULT', 'a', { key: 'k', verdict: 'PASSED' })], 'k'), 'PASSED');
  const ok = { U: 150, outputVisible: 5, reasoning: 0, outputTotal: 5, completion: 'COMPLETE', tierServed: 'standard' };
  const j = (u: Partial<typeof ok> | null, x: Partial<Parameters<typeof judgeProbe>[0]> = {}) => judgeProbe({ limit: 1.9, L0: 100, reservedBound: 500, usage: u === null ? null : { ...ok, ...u }, tierRequested: 'standard_only', reasoningAllowance: 0, ...x });
  assert.equal(j({}).verdict, 'PASSED'); assert.equal(j({ U: 190 }).verdict, 'PASSED', 'ratio == limite passa'); assert.equal(j({ U: 191 }).verdict, 'FAILED');
  assert.deepEqual(j(null), { verdict: 'FAILED', reasons: ['USAGE_MISSING'], ratio: 'UNKNOWN' }); assert.equal(j({ U: 'UNKNOWN' as unknown as number }).verdict, 'FAILED'); assert.equal(j({}, { L0: 0 }).verdict, 'FAILED');
  assert.equal(j({ U: 120 }, { reservedBound: 119 }).verdict, 'FAILED'); assert.equal(j({ completion: 'TRUNCATED_MAX_TOKENS' }).verdict, 'FAILED'); assert.equal(j({ completion: 'UNKNOWN' }).verdict, 'FAILED');
  assert.equal(j({ reasoning: 1 }).verdict, 'FAILED'); assert.equal(j({ reasoning: 'UNKNOWN' as unknown as number }).verdict, 'PASSED', 'raciocinio desconhecido e registrado, nao inventado'); assert.equal(j({ reasoning: 7 }, { reasoningAllowance: 7 }).verdict, 'PASSED');
  assert.equal(j({ tierServed: 'priority' }).verdict, 'FAILED'); assert.equal(j({ tierServed: 'UNKNOWN' }).verdict, 'PASSED'); assert.equal(j({ tierServed: 'priority' }, { tierRequested: 'auto' }).verdict, 'PASSED');
});

test('CLI e config: limite sem padrao; fora de [1,10], NaN e vazio sao recusados; sem a flag a sonda nao existe', () => {
  const get = (m: Record<string, string>) => (k: string) => m[k];
  assert.equal(modelProbeFromArgs(get({})), undefined); assert.deepEqual(modelProbeFromArgs(get({ 'model-probe-max-ratio': '1.9' })), { maxMeasuredToEstimatedRatio: 1.9 });
  for (const bad of ['0.5', '11', 'abc', '', 'NaN', 'Infinity']) assert.throws(() => modelProbeFromArgs(get({ 'model-probe-max-ratio': bad })), (e: { code?: string }) => e.code === 'MODEL_PROBE_RATIO', bad);
  for (const r of [0.99, 10.01, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => build({ model: NEW, probe: { maxMeasuredToEstimatedRatio: r } }), RangeError, String(r));
});

test('modelo NOVO: a 1a operacao e a sonda (STARTED antes de RESERVED/SENT; RESULT PASSED depois de SETTLED); a regiao inteira segue sem nova sonda', async () => {
  const b = build({ model: NEW, probe, ratio: 1.5 }); const ps = ['a', 'b', 'c'].map((n) => P(b.store, n, NEW));
  const rs = await serial(b.ex, ps); assert.deepEqual(rs.map((r) => r.stop), [null, null, null]); assert.equal(b.sent.length, 3);
  const k = kinds(b.dir); assert.equal(k.filter((l) => l.kind === 'MODEL_PROBE_STARTED').length, 1, 'uma unica sonda'); assert.equal(k.filter((l) => l.kind === 'MODEL_PROBE_RESULT').length, 1);
  const op1 = k.filter((l) => l.operationId === operationIdOf(ps[0]!)).map((l) => l.kind); assert.ok(op1.indexOf('MODEL_PROBE_STARTED') < op1.indexOf('RESERVED') && op1.indexOf('RESERVED') < op1.indexOf('SENT') && op1.indexOf('SETTLED') < op1.indexOf('MODEL_PROBE_RESULT'), op1.join(','));
  const res = k.find((l) => l.kind === 'MODEL_PROBE_RESULT')!.body as Record<string, unknown>; assert.equal(res['verdict'], 'PASSED'); assert.equal(res['key'], probeKeyOf('anthropic', NEW, 'UNMEASURED_MODEL'));
  assert.ok(typeof res['ratio'] === 'number' && (res['ratio'] as number) > 1.4 && (res['ratio'] as number) < 1.6); assert.equal((res['measured'] as Record<string, unknown>)['completion'], 'COMPLETE');
  b.ex.close();
});

test('ADVERSARIAL: razao medida/estimada acima do limite => sonda FALHA, parada bloqueante, a 2a operacao NAO e enviada (sem retry), e o reinicio tambem nao envia', async () => {
  const dir = tmp('prbf'); const b = build({ dir, model: NEW, probe, ratio: 2.5 }); const ps = ['a', 'b', 'c'].map((n) => P(b.store, n, NEW));
  const r1 = await b.ex.run(ps[0]!); assert.equal(r1.stop, 'STOP_MODEL_PROBE_FAILED'); assert.equal(b.sent.length, 1);
  const k = kinds(dir); const res = k.find((l) => l.kind === 'MODEL_PROBE_RESULT')!.body as { verdict: string; reasons: string[] }; assert.equal(res.verdict, 'FAILED'); assert.ok(res.reasons.some((x) => x.startsWith('RATIO_ABOVE_LIMIT')));
  assert.equal(k.filter((l) => l.kind === 'SETTLED').length, 1, 'a cobranca e real: liquidada ANTES da parada'); assert.deepEqual(k.filter((l) => l.kind === 'STOP_GLOBAL').map((l) => (l.body as { reason: string }).reason), ['STOP_MODEL_PROBE_FAILED']);
  assert.equal((await b.ex.run(ps[1]!)).stop, 'STOP_MODEL_PROBE_FAILED', 'chamador que ignora r.stop'); assert.equal(b.sent.length, 1); b.ex.close();
  const again = build({ dir, model: NEW, probe, ratio: 1.0 }); const rs = await serial(again.ex, ps); assert.equal(rs.at(-1)!.stop, 'STOP_MODEL_PROBE_FAILED'); assert.equal(again.sent.length, 0, 'reinicio: nada enviado, nem com razao boa'); assert.equal(sentCount(dir), 1);
  again.ex.close();
  const noProbeCfg = build({ dir, model: NEW, ratio: 1.0 }); const rr = await noProbeCfg.ex.run(ps[2]!); assert.equal(rr.stop, 'STOP_MODEL_PROBE_FAILED', 'reiniciar SEM a flag tambem nao envia: o estado vem do diario'); assert.equal(noProbeCfg.sent.length, 0); noProbeCfg.ex.close();
});

test('ADVERSARIAL: conclusao truncada e entrada acima da reserva reprovam a sonda e param o lote (a camada/tier diferente so e coberta na unidade judgeProbe: o double sempre devolve tier UNKNOWN)', async () => {
  const cases: Array<{ name: string; opts: Partial<BuildOpts>; reason: RegExp }> = [
    { name: 'truncada (E1HR: inadmissivel aqui porque o modelo servido pelo double, sim-haiku, difere do pedido; truncada admissivel em e1hr_probe.test.ts)', opts: { mutate: (body) => { body['stop_reason'] = 'max_tokens'; } }, reason: /COMPLETION_TRUNCATED_MAX_TOKENS\(MODEL_SERVED_sim-haiku\)/ },
    { name: 'reserva', opts: { bound: (L0) => L0 + 1, ratio: 1.5 }, reason: /INPUT_ABOVE_RESERVATION/ },
  ];
  for (const c of cases) {
    const b = build({ model: NEW, probe, ratio: 1.2, ...c.opts }); const r = await serial(b.ex, ['a', 'b'].map((n) => P(b.store, n, NEW)));
    assert.ok(r[0]!.stop !== null, c.name); assert.equal(b.sent.length, 1, c.name);
    const res = kinds(b.dir).find((l) => l.kind === 'MODEL_PROBE_RESULT')!.body as { verdict: string; reasons: string[] }; assert.equal(res.verdict, 'FAILED', c.name); assert.ok(res.reasons.some((x) => c.reason.test(x)), `${c.name}: ${res.reasons.join(',')}`);
    b.ex.close();
  }
});

test('ADVERSARIAL: entrada medida acima da reserva na sonda => a parada G7 vale (uma unica linha STOP), a sonda fica FAILED e o lote nao segue', async () => {
  const b = build({ model: NEW, probe, bound: (L0) => L0 + 1, ratio: 1.5 }); const r = await serial(b.ex, ['a', 'b'].map((n) => P(b.store, n, NEW)));
  assert.equal(r[0]!.stop, 'STOP_INPUT_ABOVE_RESERVATION'); assert.equal(b.sent.length, 1); const k = kinds(b.dir);
  assert.deepEqual(k.filter((l) => l.kind === 'STOP_GLOBAL').map((l) => (l.body as { reason: string }).reason), ['STOP_INPUT_ABOVE_RESERVATION']); assert.equal((k.find((l) => l.kind === 'MODEL_PROBE_RESULT')!.body as { verdict: string }).verdict, 'FAILED'); b.ex.close();
});

test('ADVERSARIAL: sonda INCERTA (falha de envio / sem usage) => STOP_UNCERTAIN; o ack humano da incerta NAO licencia o modelo: a sonda segue sem PASSED e o lote continua bloqueado', async () => {
  for (const o of [{ throwSend: true }, { noUsage: true }]) {
    const dir = tmp('prbu'); const first = build({ dir, model: NEW, probe, ...o }); const ps = ['a', 'b'].map((n) => P(first.store, n, NEW));
    assert.equal((await first.ex.run(ps[0]!)).stop, 'STOP_UNCERTAIN'); first.ex.close();
    const acked = build({ dir, model: NEW, probe, ratio: 1.0 }); acked.ex.close();
    const ex = createExecutor({ ...acked.cfg, uncertainAck: [{ operationId: operationIdOf(ps[0]!), acknowledgedBy: 'human:autor', authority: 'ordem sintetica do autor: retomar o lote' }] });
    const rs = await serial(ex, ps); assert.equal(rs.at(-1)!.stop, 'STOP_MODEL_PROBE_FAILED', JSON.stringify(o)); assert.equal(acked.sent.length, 0, 'nada enviado apos o ack'); assert.equal(sentCount(dir), 1); ex.close();
  }
});

test('ADVERSARIAL: queda entre a liquidacao e o RESULT da sonda => o reinicio bloqueia pelo diario (sonda sem PASSED), tambem para uma operacao nova; queda apos RESERVED idem', async () => {
  for (const point of ['after_settled', 'after_reserved']) {
    const dir = tmp('prbc'); const first = build({ dir, model: NEW, probe, crashAt: (pt) => { if (pt === point) throw new Error('SYN_CRASH'); } }); const ps = ['a', 'b', 'c'].map((n) => P(first.store, n, NEW));
    await assert.rejects(() => first.ex.run(ps[0]!), /SYN_CRASH/); first.ex.close();
    assert.equal(kinds(dir).some((l) => l.kind === 'MODEL_PROBE_RESULT'), false, point);
    const second = build({ dir, model: NEW, probe, ratio: 1.0 }); const rs = await serial(second.ex, ps); assert.equal(rs.at(-1)!.stop, 'STOP_MODEL_PROBE_FAILED', point); assert.equal(second.sent.length, 0, point); second.ex.close();
    const third = build({ dir, model: NEW, probe, ratio: 1.0 }); assert.equal((await third.ex.run(ps[2]!)).stop, 'STOP_MODEL_PROBE_FAILED', `${point}: operacao nova`); assert.equal(third.sent.length, 0); third.ex.close();
  }
});

test('regiao ACIMA DA FAIXA: Sonnet 5.5 com L0 > 810 => a 1a longa e a sonda; as curtas nao sao sondas; a 2a longa segue sem nova sonda; a politica de reserva nao recusa (a sonda a cobre)', async () => {
  const b = build({ model: S55, probe, policy: { id: 'R-A-1.03' }, ratio: 1.5, bound: (L0) => Math.ceil(2.2 * L0) + 100 });
  const ps = [P(b.store, 'a', S55), P(b.store, 'long1', S55), P(b.store, 'b', S55), P(b.store, 'long2', S55)];
  const rs = await serial(b.ex, ps); assert.deepEqual(rs.map((r) => r.stop), [null, null, null, null], JSON.stringify(rs));
  const started = kinds(b.dir).filter((l) => l.kind === 'MODEL_PROBE_STARTED'); assert.equal(started.length, 1); assert.equal((started[0]!.body as { key: string }).key.replace(/B\d+$/, 'B#'), 'anthropic|claude-sonnet-5-5|ABOVE_RANGE_B#'); assert.equal(started[0]!.operationId, operationIdOf(ps[1]!));
  assert.ok((started[0]!.body as { localCount: number }).localCount > 810); b.ex.close();
  // sonda reprovada na regiao longa: as operacoes curtas (dentro da faixa) tambem ficam bloqueadas (o diario do lote para)
  const bad = build({ model: S55, probe, policy: { id: 'R-A-1.03' }, ratio: 2.4, bound: (L0) => Math.ceil(2.6 * L0) + 100 }); const bps = [P(bad.store, 'a', S55), P(bad.store, 'long1', S55), P(bad.store, 'b', S55)];
  const brs = await serial(bad.ex, bps); assert.equal(brs.at(-1)!.stop, 'STOP_MODEL_PROBE_FAILED'); assert.equal(bad.sent.length, 2); assert.equal((await bad.ex.run(bps[2]!)).stop, 'STOP_MODEL_PROBE_FAILED'); assert.equal(bad.sent.length, 2); bad.ex.close();
});

test('interacao com a politica de reserva: modelo novo + politica SEM sonda => recusa (como antes); COM sonda => a sonda cobre e RESERVED registra NOT_APPLICABLE', async () => {
  const noProbe = build({ model: NEW, policy: { id: 'R-A-1.03' } }); const r = await noProbe.ex.run(P(noProbe.store, 'a', NEW)); assert.equal(r.stop, 'STOP_INPUT_RESERVE_POLICY'); assert.equal(noProbe.sent.length, 0); noProbe.ex.close();
  const withProbe = build({ model: NEW, probe, policy: { id: 'R-A-1.03' }, ratio: 1.5 }); const r2 = await withProbe.ex.run(P(withProbe.store, 'a', NEW)); assert.equal(r2.stop, null); assert.equal(withProbe.sent.length, 1);
  assert.equal((kinds(withProbe.dir).find((l) => l.kind === 'RESERVED')!.body as Record<string, unknown>)['reservePolicy'], 'NOT_APPLICABLE'); withProbe.ex.close();
});

test('padrao DESLIGADO e isentos: sem modelProbe nada muda (nenhuma linha de sonda); com modelProbe, Haiku 4.5 e modelos 5.5 dentro da faixa nao sao sondados', async () => {
  const off = build({ model: NEW, ratio: 3 }); const ro = await serial(off.ex, ['a', 'b'].map((n) => P(off.store, n, NEW))); assert.deepEqual(ro.map((r) => r.stop), [null, null]); assert.equal(kinds(off.dir).some((l) => l.kind.startsWith('MODEL_PROBE')), false); off.ex.close();
  for (const model of ['claude-haiku-4-5-20251001', 'claude-haiku-5-5']) { const b = build({ model, probe, ratio: 3 }); const r = await serial(b.ex, ['a', 'b'].map((n) => P(b.store, n, model))); assert.deepEqual(r.map((x) => x.stop), [null, null], model); assert.equal(kinds(b.dir).some((l) => l.kind.startsWith('MODEL_PROBE')), false, model); b.ex.close(); }
});

test('LIMITE DECLARADO: depois de uma sonda PASSED as demais operacoes da regiao nao sao julgadas pela razao (so o G7 por operacao as limita)', async () => {
  const b = build({ model: NEW, probe, ratio: 1.0, bound: (L0) => Math.ceil(L0 * 3) + 100 }); const p1 = P(b.store, 'a', NEW); assert.equal((await b.ex.run(p1)).stop, null); b.ex.close();
  const worse = build({ dir: b.dir, model: NEW, probe, ratio: 2.9, bound: (L0) => Math.ceil(L0 * 3) + 100 }); assert.equal((await worse.ex.run(P(worse.store, 'b', NEW))).stop, null, 'razao 2,9 passa: ja ha PASSED e a reserva 3x a cobre'); worse.ex.close();
  const over = build({ dir: b.dir, model: NEW, probe, ratio: 3.5, bound: (L0) => Math.ceil(L0 * 3) + 100 }); assert.equal((await over.ex.run(P(over.store, 'c', NEW))).stop, 'STOP_INPUT_ABOVE_RESERVATION', 'o G7 por operacao continua valendo'); over.ex.close();
});

test('REINICIO depois de uma sonda PASSED: o replay da sonda NAO a marca como incerta nem reenvia; o lote continua; a sonda nao se repete', async () => {
  const dir = tmp('prbr'); const first = build({ dir, model: NEW, probe, ratio: 1.5 }); const ps = ['a', 'b', 'c'].map((n) => P(first.store, n, NEW));
  assert.equal((await first.ex.run(ps[0]!)).stop, null); first.ex.close();
  const second = build({ dir, model: NEW, probe, ratio: 1.5 }); const rs = await serial(second.ex, ps);
  assert.deepEqual(rs.map((r) => r.stop), [null, null, null]); assert.equal(rs[0]!.replayed, true); assert.equal(second.sent.length, 2, 'so as duas novas foram enviadas; a sonda nao foi reenviada');
  const k = kinds(dir); assert.equal(k.filter((l) => l.kind === 'UNCERTAIN_ISOLATED').length, 0); assert.equal(k.filter((l) => l.kind === 'MODEL_PROBE_STARTED').length, 1); assert.equal(sentCount(dir), 3); second.ex.close();
});

test('Q07 (BOT-01): contagem local DESCONHECIDA => recusa pre-envio ANTES da regiao de modelo novo; judgeProbe nunca divide por texto', () => {
  assert.equal(probeRegionOf('anthropic', NEW, 'UNKNOWN'), 'L0_UNKNOWN'); assert.equal(probeRegionOf('anthropic', S55, 'UNKNOWN'), 'L0_UNKNOWN'); assert.equal(probeRegionOf('anthropic', 'claude-haiku-4-5-20251001', 'UNKNOWN'), null, 'isento'); assert.equal(probeRegionOf('openai', 'gpt-4o-mini-2024-07-18', 'UNKNOWN'), null);
  const j = judgeProbe({ limit: 1.9, L0: 'UNKNOWN', reservedBound: 500, usage: { U: 150, outputVisible: 5, reasoning: 0, outputTotal: 5, completion: 'COMPLETE', tierServed: 'standard' }, tierRequested: 'standard_only', reasoningAllowance: 0 });
  assert.deepEqual(j, { verdict: 'FAILED', reasons: ['LOCAL_COUNT_UNKNOWN'], ratio: 'UNKNOWN' }); assert.doesNotThrow(() => JSON.stringify(j));
});

test('Q08 (BOT-01): a regiao ACIMA da faixa e dividida em FAIXAS que dobram o comprimento; cada faixa tem a sua sonda e o RESULT declara o maximo licenciado', async () => {
  assert.deepEqual(aboveRangeBand(810, 811), { band: 0, licensedMaxLocalCount: 1620 }); assert.deepEqual(aboveRangeBand(810, 1620), { band: 0, licensedMaxLocalCount: 1620 }); assert.deepEqual(aboveRangeBand(810, 1621), { band: 1, licensedMaxLocalCount: 3240 }); assert.deepEqual(aboveRangeBand(810, 13501), { band: 4, licensedMaxLocalCount: 25920 });
  assert.equal(probeRegionOf('anthropic', S55, 1441), 'ABOVE_RANGE_B0'); assert.equal(probeRegionOf('anthropic', S55, 13501), 'ABOVE_RANGE_B4', 'uma sonda em L0~1441 NAO licencia L0~13501 (BOT-01: 9x)');
  const b = build({ model: S55, probe, policy: { id: 'R-A-1.03', outsideMeasuredRange: 'ALLOW' }, ratio: 1.5, bound: (L0) => Math.ceil(2.2 * L0) + 100 });
  const ps = [P(b.store, 'long1', S55), P(b.store, 'long2', S55)]; const rs = await serial(b.ex, ps); assert.deepEqual(rs.map((r) => r.stop), [null, null]);
  const started = kinds(b.dir).filter((l) => l.kind === 'MODEL_PROBE_STARTED'); assert.equal(started.length, 1, 'mesma faixa: uma sonda');
  const res = kinds(b.dir).find((l) => l.kind === 'MODEL_PROBE_RESULT')!.body as { licensedMaxLocalCount: number }; const lc = (started[0]!.body as { localCount: number }).localCount; assert.ok(res.licensedMaxLocalCount >= lc && res.licensedMaxLocalCount < 2 * lc, 'o maximo licenciado esta registrado e e menor que o dobro do comprimento da sonda'); b.ex.close();
});
