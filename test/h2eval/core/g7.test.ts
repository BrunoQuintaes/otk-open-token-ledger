// SYNTHETIC — OFFLINE. C158 §3 (PRIORIDADE ZERO): gatilho G7 bloqueante. Quando a ENTRADA MEDIDA pelo provedor excede o limite de entrada da RESERVA, o executor tem de
// parar: nenhuma nova operacao pode ser enviada (falha segura), tambem depois de um reinicio. Aqui estao a reproducao do comportamento antigo (o primeiro teste FALHA no
// codigo de 63907b29: a operacao seguinte foi enviada) e os dez cenarios de C158 §3.1. Doubles apenas; sem rede, sem credencial, sem chamada real, sem GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { openLedger } from '../../../scripts/h2eval/core/ledger.js';
import type { EgressResponse } from '../../../scripts/h2eval/core/egress.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, bodyOf as rawBodyOf, OFFICIAL_HOST, type ScriptedBody } from '../support/double.js';

process.env['H2EVAL_TEST_KEY'] = 'zq-g7-canary';
const LONG = Array.from({ length: 160 }, (_, i) => `palavra${i} sintetica de teste`).join(' ');
const TEXTS = { p1: 'Resuma este texto sintético sobre medição de tokens em três frases curtas.', p2: 'Outro texto sintético, diferente, para a segunda operação.', p3: 'Um terceiro texto sintético para a terceira operação do lote.', long1: LONG, long2: LONG + ' segundo' };
type Egress = (req: BuiltRequest) => Promise<EgressResponse>;
type RunnerResult = { operationId: string; state: string; stop: string | null; replayed: boolean };
const bodyOf = (s: ScriptedBody): EgressResponse => { const r = rawBodyOf(s); return { httpStatus: r.status, body: r.body }; };

/** monta um executor com egress programavel; devolve tambem o registro do que foi ENVIADO (sent) */
function build(over: { dir?: string; egress: (sent: BuiltRequest[]) => Egress; bound?: (p: ReturnType<typeof plan>, L0: unknown) => number; caps?: Partial<ExecutorConfig['ledger']>; omitPrices?: string[]; crashAt?: ExecutorConfig['crashAt']; timeoutMs?: number }) {
  const dir = over.dir ?? tmp('g7'); const store = memoryContentStore(TEXTS); const sent: BuiltRequest[] = [];
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir, { omit: over.omitPrices }),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, ...over.caps },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: over.egress(sent), credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' }, ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}) },
    capPolicy: { inputUpperBoundTokens: (p, L0) => (over.bound ? over.bound(p as ReturnType<typeof plan>, L0) : 1000), reasoningAllowanceTokens: () => 0 },
    executorCodeSha: 'c'.repeat(40), crashAt: over.crashAt,
  };
  return { dir, store, sent, cfg, ex: createExecutor(cfg) };
}
const P = (store: { sha: Record<string, string> }, n: string, rep = 1) => plan({ promptSha256: store.sha[n]!, promptId: n.toUpperCase(), rep });
/** o laco do lote (cli/run.ts): para na primeira operacao que devolve `stop` */
async function serial(ex: { run: (p: ReturnType<typeof plan>) => Promise<RunnerResult> }, plans: Array<ReturnType<typeof plan>>) {
  const results: RunnerResult[] = []; for (const p of plans) { const r = await ex.run(p); results.push(r); if (r.stop) break; } return results;
}
const lines = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
const sentOps = (dir: string) => lines(dir).filter((l) => l.kind === 'SENT').map((l) => l.operationId);

test('G7 (reproduz o defeito de 63907b29): entrada medida 1100 > limite da reserva 1000, mas o CUSTO fica dentro do teto => a operacao 2 NAO pode ser enviada', async () => {
  const b = build({ egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 1100, output: 5 }); } });
  const [p1, p2, p3] = [P(b.store, 'p1'), P(b.store, 'p2'), P(b.store, 'p3')];
  const rs = await serial(b.ex, [p1, p2, p3]);
  assert.equal(rs[0]!.stop, 'STOP_INPUT_ABOVE_RESERVATION', 'a 1a operacao liquida e DEVOLVE a parada (no codigo antigo devolve stop:null e o lote segue)');
  assert.equal(rs.length, 1, 'o laco do lote para'); assert.equal(b.sent.length, 1, 'nada alem da 1a operacao foi enviado'); assert.deepEqual(sentOps(b.dir), [operationIdOf(p1)]);
  const k = lines(b.dir).filter((l) => l.operationId === operationIdOf(p1)).map((l) => l.kind);
  assert.deepEqual(k.slice(-3), ['COST_COMPUTED', 'SETTLED', 'STOP_GLOBAL'], 'dinheiro liquidado ANTES da parada (a cobranca e real); depois STOP_GLOBAL'); assert.equal(k.includes('UNCERTAIN_ISOLATED'), false);
  const stopLine = lines(b.dir).find((l) => l.kind === 'STOP_GLOBAL')!.body as Record<string, unknown>;
  assert.deepEqual([stopLine['reason'], stopLine['measuredInputTokens'], stopLine['reservedInputUpperBoundTokens']], ['STOP_INPUT_ABOVE_RESERVATION', 1100, 1000]);
  assert.equal(openLedger(path.join(b.dir, 'ledger.jsonl'), b.cfg.ledger).state().providers['anthropic']!.reservedUsd, '0', 'nenhuma reserva aberta');
});

test('G7 limite exato: entrada medida == limite NAO para; limite + 1 para', async () => {
  const eq = build({ egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 1000, output: 5 }); } });
  const r = await serial(eq.ex, [P(eq.store, 'p1'), P(eq.store, 'p2')]); assert.deepEqual(r.map((x) => x.stop), [null, null]); assert.equal(eq.sent.length, 2);
  const over = build({ egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 1001, output: 5 }); } });
  const r2 = await serial(over.ex, [P(over.store, 'p1'), P(over.store, 'p2')]); assert.equal(r2[0]!.stop, 'STOP_INPUT_ABOVE_RESERVATION'); assert.equal(over.sent.length, 1);
});

test('controle: entrada dentro do limite => fluxo normal, todas as operacoes enviadas (nada muda para quem respeita a reserva)', async () => {
  const b = build({ egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 300, output: 20 }); } });
  const rs = await serial(b.ex, [P(b.store, 'p1'), P(b.store, 'p2'), P(b.store, 'p3')]); assert.deepEqual(rs.map((x) => x.stop), [null, null, null]); assert.equal(b.sent.length, 3);
});

test('cenario 1: entrada medida acima da reserva E custo acima do teto => STOP_CAP_VIOLATION (parada que ja existia), op 2 nao enviada', async () => {
  const b = build({ egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 5000, output: 20 }); } });
  const rs = await serial(b.ex, [P(b.store, 'p1'), P(b.store, 'p2')]); assert.equal(rs[0]!.stop, 'STOP_CAP_VIOLATION'); assert.equal(b.sent.length, 1);
});

test('cenario 2: reserva insuficiente (sub-ledger quase vazio) => STOP antes de QUALQUER envio', async () => {
  const b = build({ caps: { providersUsd: { anthropic: '0.000001', openai: '3', google: '3' } }, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok' }); } });
  const rs = await serial(b.ex, [P(b.store, 'p1'), P(b.store, 'p2')]); assert.ok(rs[0]!.stop, 'parou'); assert.match(String(rs[0]!.stop), /^STOP_BUDGET/); assert.equal(b.sent.length, 0, 'nada enviado'); assert.deepEqual(sentOps(b.dir), []);
});

test('cenario 3: preco desconhecido => STOP_PRICE_UNKNOWN antes de reservar e de enviar', async () => {
  const b = build({ omitPrices: ['output'], egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok' }); } });
  const rs = await serial(b.ex, [P(b.store, 'p1'), P(b.store, 'p2')]); assert.equal(rs[0]!.stop, 'STOP_PRICE_UNKNOWN'); assert.equal(b.sent.length, 0);
  assert.equal(lines(b.dir).some((l) => l.kind === 'RESERVED'), false, 'nem reserva houve');
});

test('cenario 4: tokenizador local SUBESTIMANDO 1,7x (limite = 1,25 x contagem local + 64) => passa o texto curto, PARA no longo; a operacao seguinte nunca e enviada', async () => {
  let L0seen = 0; const b = build({ bound: (_p, L0) => { L0seen = typeof L0 === 'number' ? L0 : 0; return Math.ceil(L0seen * 1.25) + 64; }, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: Math.ceil(L0seen * 1.7), output: 5 }); } });
  const rs = await serial(b.ex, [P(b.store, 'p1'), P(b.store, 'long1'), P(b.store, 'p2')]);
  assert.equal(rs[0]!.stop, null, 'curto: 1,7 x L0 <= 1,25 x L0 + 64 enquanto L0 <= 182'); assert.ok(L0seen > 182, 'o texto longo tem contagem local acima de 182 (' + L0seen + ')');
  assert.equal(rs[1]!.stop, 'STOP_INPUT_ABOVE_RESERVATION', 'longo: 1,7 x L0 > 1,25 x L0 + 64'); assert.equal(b.sent.length, 2, 'a 3a nunca foi enviada'); assert.equal(rs.length, 2);
});

test('cenario 5: divergencia estimativa x contagem do provedor — provedor CONTA MENOS que a estimativa => sem falso positivo; CONTA 1,5x => so o G7 pega; CONTA 3x => qualquer parada bloqueante', async () => {
  let L0seen = 0; const mk = (factor: number) => build({ bound: (_p, L0) => { L0seen = typeof L0 === 'number' ? L0 : 0; return Math.ceil(L0seen * 1.25) + 64; }, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: Math.max(1, Math.round(L0seen * factor)), output: 5 }); } });
  const less = mk(0.5); assert.deepEqual((await serial(less.ex, [P(less.store, 'long1'), P(less.store, 'p1')])).map((x) => x.stop), [null, null], 'contagem menor que a estimativa nao bloqueia');
  const more = mk(1.5); const rs = await serial(more.ex, [P(more.store, 'long1'), P(more.store, 'p1')]); assert.equal(rs[0]!.stop, 'STOP_INPUT_ABOVE_RESERVATION', '1,5x de um texto longo passa do limite e o custo ainda cabe no teto: so o G7 pega'); assert.equal(more.sent.length, 1);
  const triple = mk(3); const rs3 = await serial(triple.ex, [P(triple.store, 'long1'), P(triple.store, 'p1')]); assert.ok(['STOP_INPUT_ABOVE_RESERVATION', 'STOP_CAP_VIOLATION'].includes(String(rs3[0]!.stop)), '3x: o custo tambem estoura o teto'); assert.equal(triple.sent.length, 1);
});

test('cenario 6: operacao incerta (falha no envio) => STOP_UNCERTAIN, reserva inteira retida, op 2 nao enviada, nada reenviado', async () => {
  const b = build({ egress: (sent) => async (req) => { sent.push(req); throw new Error('SYN_SEND_FAILURE'); } });
  const p1 = P(b.store, 'p1'); const rs = await serial(b.ex, [p1, P(b.store, 'p2')]); assert.equal(rs[0]!.stop, 'STOP_UNCERTAIN'); assert.equal(b.sent.length, 1);
  assert.notEqual(openLedger(path.join(b.dir, 'ledger.jsonl'), b.cfg.ledger).state().providers['anthropic']!.possiblyChargedUsd, '0', 'reserva inteira retida como possivelmente cobrada');
});

test('cenario 7: timeout => incerto, STOP_UNCERTAIN, op 2 nao enviada', async () => {
  const b = build({ timeoutMs: 40, egress: (sent) => () => { sent.push({} as BuiltRequest); return new Promise(() => { /* nunca responde */ }); } });
  const rs = await serial(b.ex, [P(b.store, 'p1'), P(b.store, 'p2')]); assert.equal(rs[0]!.stop, 'STOP_UNCERTAIN'); assert.equal(b.sent.length, 1);
  assert.equal(lines(b.dir).some((l) => l.kind === 'TIMEOUT_UNCERTAIN' && (l.body as { code?: string }).code === 'TIMEOUT'), true);
});

test('cenario 8: resposta incompleta (sem usage / usage parcial) => custo UNKNOWN => STOP_UNCERTAIN; op 2 nao enviada', async () => {
  for (const s of [{ kind: 'error_no_usage' }, { kind: 'usage_missing_fields' }] as ScriptedBody[]) {
    const b = build({ egress: (sent) => async (req) => { sent.push(req); return bodyOf(s); } });
    const rs = await serial(b.ex, [P(b.store, 'p1'), P(b.store, 'p2')]); assert.equal(rs[0]!.stop, 'STOP_UNCERTAIN', s.kind); assert.equal(b.sent.length, 1, s.kind);
  }
});

test('cenario 9: erro de rede (ECONNRESET) => incerto, STOP_UNCERTAIN, op 2 nao enviada', async () => {
  const b = build({ egress: (sent) => async (req) => { sent.push(req); throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); } });
  const rs = await serial(b.ex, [P(b.store, 'p1'), P(b.store, 'p2')]); assert.equal(rs[0]!.stop, 'STOP_UNCERTAIN'); assert.equal(b.sent.length, 1);
});

test('cenario 10a: REINICIO apos queda DEPOIS do envio => a operacao vira incerta e NAO e reenviada; a seguinte NAO e enviada', async () => {
  const dir = tmp('g7r'); const first = build({ dir, crashAt: (pt) => { if (pt === 'after_sent') throw new Error('SYN_CRASH'); }, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok' }); } });
  const [p1, p2] = [P(first.store, 'p1'), P(first.store, 'p2')];
  await assert.rejects(() => first.ex.run(p1), /SYN_CRASH/); first.ex.close();
  const second = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok' }); } });
  const rs = await serial(second.ex, [p1, p2]);
  assert.equal(rs[0]!.stop, 'STOP_UNCERTAIN'); assert.equal(rs[0]!.replayed, true); assert.equal(second.sent.length, 0, 'nada foi (re)enviado depois do reinicio');
});

test('cenario 10b: REINICIO depois de uma parada G7 => a operacao parada reaparece como liquidada, mas NENHUMA nova operacao e enviada (trava persistente no diario)', async () => {
  const dir = tmp('g7l'); const first = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 1100, output: 5 }); } });
  const [p1, p2, p3] = [P(first.store, 'p1'), P(first.store, 'p2'), P(first.store, 'p3')];
  assert.equal((await serial(first.ex, [p1, p2, p3]))[0]!.stop, 'STOP_INPUT_ABOVE_RESERVATION'); first.ex.close();
  const second = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
  const rs = await serial(second.ex, [p1, p2, p3]);
  assert.equal(second.sent.length, 0, 'o reinicio nao envia nada, nem com entrada boa'); assert.ok(rs.every((r) => r.stop === 'STOP_INPUT_ABOVE_RESERVATION' || r.replayed), 'todas as respostas sao replay ou a mesma parada');
  assert.equal(rs.at(-1)!.stop, 'STOP_INPUT_ABOVE_RESERVATION'); assert.equal(sentOps(dir).length, 1, 'no diario inteiro so existe 1 SENT');
});

test('A02 (gate PRE-ENVIO, BOT-01): limite da reserva (3) abaixo da contagem local do que vai ser enviado => nada e reservado nem enviado', async () => {
  const b = build({ bound: () => 3, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 2, output: 1 }); } });
  const rs = await serial(b.ex, [P(b.store, 'p1'), P(b.store, 'p2')]);
  assert.equal(rs[0]!.stop, 'STOP_INPUT_ABOVE_RESERVATION'); assert.equal(rs[0]!.state, 'ABORTED_BEFORE_SEND'); assert.equal(b.sent.length, 0, 'nenhum envio');
  assert.equal(lines(b.dir).some((l) => l.kind === 'RESERVED' || l.kind === 'SENT'), false, 'nem reserva');
  const stop = lines(b.dir).find((l) => l.kind === 'STOP_GLOBAL')!.body as Record<string, unknown>; assert.equal(stop['phase'], 'PRE_SEND');
});

test('M19 (BOT-01): REINICIO depois de STOP_CAP_VIOLATION (parada que ja existia) => nada e enviado (a trava cobre tambem as paradas anteriores ao G7)', async () => {
  const dir = tmp('g7m19'); const first = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 5000, output: 20 }); } });
  const [p1, p2, p3] = [P(first.store, 'p1'), P(first.store, 'p2'), P(first.store, 'p3')];
  assert.equal((await serial(first.ex, [p1, p2, p3]))[0]!.stop, 'STOP_CAP_VIOLATION'); first.ex.close();
  const second = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
  const rs = await serial(second.ex, [p1, p2, p3]); assert.equal(second.sent.length, 0, 'o processo 2 nao envia nada'); assert.equal(rs.at(-1)!.stop, 'STOP_CAP_VIOLATION'); assert.equal(sentOps(dir).length, 1);
});

test('defesa em profundidade (M16): um chamador que IGNORA r.stop e continua chamando run() nao consegue enviar depois de uma parada bloqueante', async () => {
  const b = build({ egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 1100, output: 5 }); } });
  const r1 = await b.ex.run(P(b.store, 'p1')); const r2 = await b.ex.run(P(b.store, 'p2')); const r3 = await b.ex.run(P(b.store, 'p3'));
  assert.deepEqual([r1.stop, r2.stop, r3.stop], ['STOP_INPUT_ABOVE_RESERVATION', 'STOP_INPUT_ABOVE_RESERVATION', 'STOP_INPUT_ABOVE_RESERVATION']); assert.equal(b.sent.length, 1, 'so a 1a foi enviada');
});

// ---- C158 ciclo 2 (BOT-01 R01 + mesma classe): o estado bloqueante e DERIVADO dos fatos do diario, nao so de uma linha STOP que pode nao ter sido gravada ----
test('R01 (BOT-01): queda ENTRE a liquidacao e a linha STOP_INPUT_ABOVE_RESERVATION => o reinicio decide o G7 no replay e NAO envia a seguinte', async () => {
  const dir = tmp('g7r01'); const first = build({ dir, crashAt: (pt) => { if (pt === 'after_settled') throw new Error('SYN_CRASH_SETTLED'); }, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 1100, output: 5 }); } });
  const [p1, p2, p3] = [P(first.store, 'p1'), P(first.store, 'p2'), P(first.store, 'p3')];
  await assert.rejects(() => first.ex.run(p1), /SYN_CRASH_SETTLED/); first.ex.close();
  const k0 = lines(dir).map((l) => l.kind); assert.equal(k0.includes('SETTLED'), true); assert.equal(k0.includes('STOP_GLOBAL'), false, 'a janela existe: liquidado, sem linha de parada');
  const second = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
  const rs = await serial(second.ex, [p1, p2, p3]);
  assert.equal(rs[0]!.stop, 'STOP_INPUT_ABOVE_RESERVATION', 'o replay da 1a operacao devolve a parada reconstruida'); assert.equal(rs[0]!.replayed, true); assert.equal(rs.length, 1);
  assert.equal(second.sent.length, 0, 'nada enviado depois do reinicio'); assert.equal(sentOps(dir).length, 1);
  const rec = lines(dir).find((l) => l.kind === 'STOP_GLOBAL')!.body as Record<string, unknown>; assert.deepEqual([rec['reason'], rec['phase']], ['STOP_INPUT_ABOVE_RESERVATION', 'REPLAY_RECONSTRUCTED'], 'a linha que faltava e gravada pelo replay');
  second.ex.close();
  // o chamador que pula a 1a operacao e chama direto a 2a: a trava derivada (USAGE_PARSED.U > limite da RESERVED) tambem bloqueia
  const third = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
  const r2 = await third.ex.run(p2); assert.equal(r2.stop, 'STOP_INPUT_ABOVE_RESERVATION'); assert.equal(third.sent.length, 0);
});

test('R01 (sem a janela de gravacao): a trava deriva o G7 do USAGE_PARSED mesmo quando NAO ha nenhuma linha STOP_GLOBAL e a operacao 1 nem e repetida pelo chamador', async () => {
  const dir = tmp('g7r01b'); const first = build({ dir, crashAt: (pt) => { if (pt === 'after_settled') throw new Error('SYN_CRASH_SETTLED'); }, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 1100, output: 5 }); } });
  const [p1, p2] = [P(first.store, 'p1'), P(first.store, 'p2')]; await assert.rejects(() => first.ex.run(p1), /SYN_CRASH_SETTLED/); first.ex.close();
  const second = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
  const r = await second.ex.run(p2); assert.equal(r.stop, 'STOP_INPUT_ABOVE_RESERVATION'); assert.equal(second.sent.length, 0);
  const ab = lines(dir).find((l) => l.kind === 'ABORTED_BEFORE_SEND')!.body as Record<string, unknown>; assert.deepEqual([ab['reason'], ab['latchKind']], ['STOP_INPUT_ABOVE_RESERVATION', 'USAGE_ABOVE_BOUND']);
});

test('mesma classe (BOT-01): REINICIO depois de operacao INCERTA (falha de envio, timeout, resposta incompleta, ECONNRESET) => o replay devolve STOP_UNCERTAIN e NADA e enviado', async () => {
  const cases: Array<{ name: string; timeoutMs?: number; egress: (sent: BuiltRequest[]) => Egress }> = [
    { name: 'falha de envio', egress: (sent) => async (req) => { sent.push(req); throw new Error('SYN_SEND_FAILURE'); } },
    { name: 'timeout', timeoutMs: 40, egress: (sent) => () => { sent.push({} as BuiltRequest); return new Promise(() => { /* nunca responde */ }); } },
    { name: 'sem usage', egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'error_no_usage' }); } },
    { name: 'usage parcial', egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'usage_missing_fields' }); } },
    { name: 'ECONNRESET', egress: (sent) => async (req) => { sent.push(req); throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); } },
  ];
  for (const c of cases) {
    const dir = tmp('g7u'); const first = build({ dir, timeoutMs: c.timeoutMs, egress: c.egress }); const [p1, p2, p3] = [P(first.store, 'p1'), P(first.store, 'p2'), P(first.store, 'p3')];
    assert.equal((await serial(first.ex, [p1, p2, p3]))[0]!.stop, 'STOP_UNCERTAIN', c.name); first.ex.close();
    const second = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
    const rs = await serial(second.ex, [p1, p2, p3]);
    assert.equal(rs[0]!.stop, 'STOP_UNCERTAIN', `${c.name}: o replay devolve a parada`); assert.equal(rs[0]!.replayed, true, c.name); assert.equal(rs.length, 1, c.name); assert.equal(second.sent.length, 0, `${c.name}: nada enviado apos o reinicio`); assert.equal(sentOps(dir).length, 1, c.name);
    second.ex.close();
    const third = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
    const r3 = await third.ex.run(p3); assert.equal(r3.stop, 'STOP_UNCERTAIN', `${c.name}: a trava por diretorio de lote bloqueia uma operacao nova`); assert.equal(third.sent.length, 0, c.name);
  }
});

test('resumo ao reabrir: a parada G7 da ULTIMA operacao do lote aparece no replay (nada a executar, mas o stop nao some)', async () => {
  const dir = tmp('g7last'); const first = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
  const [p1, p2] = [P(first.store, 'p1'), P(first.store, 'p2')]; await first.ex.run(p1);
  first.ex.close();
  const mid = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 1100, output: 5 }); } });
  assert.equal((await mid.ex.run(p1)).stop, null, 'p1 e boa'); assert.equal((await mid.ex.run(p2)).stop, 'STOP_INPUT_ABOVE_RESERVATION'); mid.ex.close();
  const reopened = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
  const rs = await serial(reopened.ex, [p1, p2]); assert.equal(rs.at(-1)!.stop, 'STOP_INPUT_ABOVE_RESERVATION', 'a parada da ultima operacao continua visivel ao reabrir'); assert.equal(reopened.sent.length, 0);
});

// ---- C158 ciclo 2 (decisao A da coordenadora): retomada apos operacao incerta exige RECONHECIMENTO HUMANO por operacao; o ack nunca reenvia a incerta, so libera as PROXIMAS ----
import { validateUncertainAckShape, UncertainAckError } from '../../../scripts/h2eval/core/runner.js';
import { uncertainAckFromArgs } from '../../../scripts/h2eval/cli/run.js';
const AUTH = 'ordem sintetica do autor: retomar o lote apos a operacao incerta';

test('ack humano: libera as PROXIMAS operacoes, NUNCA reenvia a incerta; o ack fica gravado no diario (UNCERTAIN_ACKNOWLEDGED)', async () => {
  const dir = tmp('g7ack'); const first = build({ dir, egress: (sent) => async (req) => { sent.push(req); throw new Error('SYN_SEND_FAILURE'); } });
  const [p1, p2, p3] = [P(first.store, 'p1'), P(first.store, 'p2'), P(first.store, 'p3')];
  assert.equal((await serial(first.ex, [p1, p2, p3]))[0]!.stop, 'STOP_UNCERTAIN'); first.ex.close();
  const noAck = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
  assert.equal((await serial(noAck.ex, [p1, p2, p3])).at(-1)!.stop, 'STOP_UNCERTAIN'); assert.equal(noAck.sent.length, 0, 'sem ack nada e enviado'); noAck.ex.close();
  const acked = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } });
  acked.ex.close(); // a lock e liberada; o ack entra pela configuracao do executor:
  const cfg = { ...acked.cfg, uncertainAck: [{ operationId: operationIdOf(p1), acknowledgedBy: 'human:autor', authority: AUTH }] };
  const ex = createExecutor(cfg); const sent2: number[] = []; const rs: RunnerResult[] = [];
  for (const p of [p1, p2, p3]) { const r = await ex.run(p); rs.push(r); if (r.stop) break; sent2.push(1); }
  assert.deepEqual(rs.map((r) => r.stop), [null, null, null], 'a incerta repete como replay sem parada; as proximas seguem'); assert.equal(rs[0]!.replayed, true);
  const sentIds = sentOps(dir); assert.equal(sentIds.filter((x) => x === operationIdOf(p1)).length, 1, 'a incerta NUNCA e reenviada'); assert.equal(sentIds.length, 3, 'p1 (original) + p2 + p3');
  const ack = lines(dir).filter((l) => l.kind === 'UNCERTAIN_ACKNOWLEDGED'); assert.equal(ack.length, 1); assert.deepEqual([ack[0]!.operationId, (ack[0]!.body as Record<string, unknown>)['acknowledgedBy'], (ack[0]!.body as Record<string, unknown>)['resend']], [operationIdOf(p1), 'human:autor', false]);
  ex.close();
});

test('ack recusado: sem assinatura "human:", sem texto/ordem, sem operationId valido, ou para operacao que NAO e incerta (liquidada / parada G7)', async () => {
  assert.throws(() => validateUncertainAckShape({ operationId: 'abcdef12', acknowledgedBy: 'coordenadora', authority: AUTH }), (e: UncertainAckError) => e.code === 'UNCERTAIN_ACK_NOT_HUMAN');
  assert.throws(() => validateUncertainAckShape({ operationId: 'abcdef12', acknowledgedBy: 'human:autor', authority: '  ' }), (e: UncertainAckError) => e.code === 'UNCERTAIN_ACK_NO_AUTHORITY');
  assert.throws(() => validateUncertainAckShape({ operationId: '', acknowledgedBy: 'human:autor', authority: AUTH }), (e: UncertainAckError) => e.code === 'UNCERTAIN_ACK_NO_OPERATION');
  const get = (m: Record<string, string>) => (k: string) => m[k];
  assert.deepEqual(uncertainAckFromArgs(get({})), []);
  assert.throws(() => uncertainAckFromArgs(get({ 'ack-uncertain': 'abcdef12' })), (e: { code?: string }) => e.code === 'UNCERTAIN_ACK_INCOMPLETE');
  assert.throws(() => uncertainAckFromArgs(get({ 'ack-uncertain': 'abcdef12', 'ack-uncertain-by': 'human:autor' })), (e: { code?: string }) => e.code === 'UNCERTAIN_ACK_INCOMPLETE');
  assert.equal(uncertainAckFromArgs(get({ 'ack-uncertain': 'abcdef12', 'ack-uncertain-by': 'human:autor', 'ack-uncertain-ref': AUTH }))[0]!.operationId, 'abcdef12');
  // operacao que nao e incerta: um ack nao libera uma parada G7 nem inventa uma operacao
  const dir = tmp('g7ackbad'); const first = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 1100, output: 5 }); } });
  const p1 = P(first.store, 'p1'); assert.equal((await first.ex.run(p1)).stop, 'STOP_INPUT_ABOVE_RESERVATION'); first.ex.close();
  for (const id of [operationIdOf(p1), 'deadbeefdeadbeef']) {
    assert.throws(() => createExecutor({ ...first.cfg, uncertainAck: [{ operationId: id, acknowledgedBy: 'human:autor', authority: AUTH }] }), (e: UncertainAckError) => e.code === 'UNCERTAIN_ACK_NOT_UNCERTAIN');
  }
  const again = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } }); // a lock foi liberada apos a recusa
  assert.equal((await again.ex.run(P(again.store, 'p2'))).stop, 'STOP_INPUT_ABOVE_RESERVATION'); assert.equal(again.sent.length, 0); again.ex.close();
});

// ---- C158 ciclo 3 (BOT-01 S10): STOP_STOP_REASON_MISSING tambem e DERIVADO dos fatos do diario (stopReason UNKNOWN + usage presente, politica de integridade exige o motivo) ----
test('S10 (BOT-01): queda entre a liquidacao e a linha STOP_STOP_REASON_MISSING => o reinicio decide a parada no replay e NAO envia a seguinte; sem a politica nao ha falso positivo', async () => {
  const noReason = (sent: BuiltRequest[]): Egress => async (req) => { sent.push(req); const r = bodyOf({ kind: 'ok', input: 10, output: 5 }); delete (r.body as Record<string, unknown>)['stop_reason']; return r; };
  const integrity = { stopReasonRequired: true, thinkingDisabledRejectedStops: true };
  const dir = tmp('g7s10'); const first = build({ dir, crashAt: (pt) => { if (pt === 'after_settled') throw new Error('SYN_CRASH_SETTLED'); }, egress: noReason }); first.ex.close();
  const withPolicy = (b: ReturnType<typeof build>, extra: Partial<ExecutorConfig> = {}) => createExecutor({ ...b.cfg, integrity, ...extra });
  const [p1, p2] = [P(first.store, 'p1'), P(first.store, 'p2')];
  const ex1 = withPolicy(first); await assert.rejects(() => ex1.run(p1), /SYN_CRASH_SETTLED/); ex1.close();
  assert.equal(lines(dir).some((l) => l.kind === 'SETTLED'), true); assert.equal(lines(dir).some((l) => l.kind === 'STOP_GLOBAL'), false, 'a janela existe');
  const second = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } }); const ex2 = withPolicy(second);
  const rs = await serial(ex2, [p1, p2]);
  assert.equal(rs[0]!.stop, 'STOP_STOP_REASON_MISSING'); assert.equal(rs[0]!.replayed, true); assert.equal(rs.length, 1); assert.equal(second.sent.length, 0, 'nada enviado apos o reinicio');
  const rec = lines(dir).find((l) => l.kind === 'STOP_GLOBAL')!.body as Record<string, unknown>; assert.deepEqual([rec['reason'], rec['phase']], ['STOP_STOP_REASON_MISSING', 'REPLAY_RECONSTRUCTED']); ex2.close();
  const third = build({ dir, egress: (sent) => async (req) => { sent.push(req); return bodyOf({ kind: 'ok', input: 10, output: 5 }); } }); const ex3 = withPolicy(third);
  assert.equal((await ex3.run(p2)).stop, 'STOP_STOP_REASON_MISSING'); assert.equal(third.sent.length, 0); ex3.close();
  // sem a politica de integridade (stopReasonRequired ausente) o mesmo diario NAO bloqueia: sem falso positivo
  const dir2 = tmp('g7s10b'); const f2 = build({ dir: dir2, egress: noReason }); const r2 = await serial(f2.ex, [P(f2.store, 'p1'), P(f2.store, 'p2')]); assert.deepEqual(r2.map((r) => r.stop), [null, null]); assert.equal(f2.sent.length, 2);
});
