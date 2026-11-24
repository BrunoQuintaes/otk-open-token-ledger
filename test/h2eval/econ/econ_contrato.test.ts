/**
 * EXEC-ECON C160: teste de CONTRATO com cada formato real de resposta dos 3 provedores (texto, recusa, filtro, limite length/max_tokens,
 * campo ausente, zero, null) pelo executor inteiro (runner do E3G5 + delta), e testes de ponta a ponta dos itens 3, 4, 8, 11 e 12.
 * Tudo OFFLINE: o transporte é falso (egress OFFLINE com dublê), nenhuma rede, nenhuma credencial, US$ 0.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { runEcon, createEconExecutor, ECON_TIMEOUT_MS, type Tentativa } from '../../../scripts/h2eval/econ/econ.js';
import { ambiente, respostaDe, MODELOS, type Caso } from './econ_fixture.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';

const tentativas = (batchDir: string): Tentativa[] => { const f = path.join(batchDir, 'TENTATIVAS.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((x) => x.trim()).map((x) => JSON.parse(x) as Tentativa) : []; };
const journal = (batchDir: string) => readFileSync(path.join(batchDir, 'journal.jsonl'), 'utf8').split('\n').filter((x) => x.trim()).map((x) => JSON.parse(x) as { kind: string; operationId: string; body: Record<string, unknown> });
const LIMIT: Record<string, string> = { anthropic: 'max_tokens', openai: 'length', google: 'MAX_TOKENS' };

// ------------------------------------------------------------------ contrato: 5 modelos x 7 formas
interface Esperado { outcome: string; state: string; stop: string | null; cost: 'CALCULATED' | 'UNKNOWN'; truncated: boolean | 'UNKNOWN'; texto: 'T' | null | ''; refused: boolean }
function esperado(p: string, caso: Caso): Esperado {
  switch (caso) {
    case 'texto': return { outcome: 'OK', state: 'COST_COMPUTED', stop: null, cost: 'CALCULATED', truncated: false, texto: 'T', refused: false };
    case 'recusa': case 'filtro': return { outcome: 'REFUSED_WITH_USAGE', state: 'COST_COMPUTED', stop: null, cost: 'CALCULATED', truncated: p === 'google' && caso === 'recusa' ? 'UNKNOWN' : false, texto: p === 'anthropic' && caso === 'recusa' ? '' : null, refused: true };
    case 'limite': return { outcome: 'OK', state: 'COST_COMPUTED', stop: null, cost: 'CALCULATED', truncated: true, texto: 'T', refused: false };
    case 'ausente': return { outcome: 'ERROR_NO_USAGE', state: 'UNCERTAIN', stop: 'STOP_UNCERTAIN', cost: 'UNKNOWN', truncated: p === 'anthropic' ? false : 'UNKNOWN', texto: 'T', refused: false };
    case 'zero': return { outcome: 'OK', state: 'COST_COMPUTED', stop: null, cost: 'CALCULATED', truncated: false, texto: p === 'openai' ? '' : null, refused: false };
    case 'nulo': return { outcome: 'OK', state: 'UNCERTAIN', stop: 'STOP_UNCERTAIN', cost: 'UNKNOWN', truncated: 'UNKNOWN', texto: 'T', refused: false };
  }
}
for (const [model, provider] of MODELOS) for (const caso of ['texto', 'recusa', 'filtro', 'limite', 'ausente', 'zero', 'nulo'] as Caso[]) {
  test(`[CONTRATO] ${provider} ${model} forma "${caso}"${caso === 'recusa' || caso === 'filtro' ? ' [ITEM 12]' : caso === 'limite' ? ' (length/max_tokens)' : ''}`, async () => {
    const a = ambiente({ only: model, blocks: 1, answer: (req) => respostaDe(provider, (req.body as { model?: string }).model ?? model, caso, 'T') });
    const s = await runEcon(a.cfg);
    const e = esperado(provider, caso);
    const [t] = tentativas(a.cfg.batchDir); assert.ok(t, 'linha da tentativa gravada');
    assert.equal(t.outcome, e.outcome, 'outcome');
    assert.equal(t.cost.state, e.cost, 'custo'); if (e.cost === 'UNKNOWN') { assert.equal(t.cost.highUsd, t.cost.capUsd); assert.ok(t.cost.capUsd > 0); }
    assert.equal(t.truncated, e.truncated, 'truncated'); if (caso === 'limite') assert.equal(t.stopReason, LIMIT[provider]);
    assert.equal(t.outputText, e.texto === 'T' ? (caso === 'limite' ? 'T' : 'T') : e.texto, 'texto');
    assert.equal(t.refusal?.refused ?? false, e.refused, 'recusa');
    assert.equal(s.parada?.stop ?? null, e.stop, 'parada');
    // item 3: o corpo inteiro persistido por conteúdo, sempre que houve corpo (inclusive incerto por custo)
    const f = path.join(a.cfg.batchDir, 'responses', `${t.responseSha256}.json`); assert.ok(existsSync(f));
    assert.equal(createHash('sha256').update(readFileSync(f)).digest('hex'), t.responseSha256);
    // o texto nunca vai para journal nem ledger (só o sha)
    for (const x of ['journal.jsonl', 'ledger.jsonl']) assert.equal(readFileSync(path.join(a.cfg.batchDir, x), 'utf8').includes('"T"'), false, x);
  });
}

// ------------------------------------------------------------------ item 12: todos os finishReason de filtro do Google e o content_filter OpenAI
test('[ITEM 12] Google SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, SPII e promptFeedback.blockReason => REFUSED_WITH_USAGE, uso mantido e liquidado', async () => {
  for (const fr of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) {
    const a = ambiente({ only: 'gemini-3.1-flash-lite', blocks: 1, answer: () => { const r = respostaDe('google', 'gemini-3.1-flash-lite', 'filtro'); ((r.body as { candidates: Array<{ finishReason: string }> }).candidates[0]!).finishReason = fr; return r; } });
    const s = await runEcon(a.cfg); const [t] = tentativas(a.cfg.batchDir);
    assert.equal(t!.outcome, 'REFUSED_WITH_USAGE', fr); assert.equal(t!.stopReason, fr); assert.equal(t!.cost.state, 'CALCULATED', fr); assert.equal(t!.usage!.U, 85, fr); assert.equal(s.parada, null, fr);
  }
});
test('[ITEM 12] OpenAI content_filter e message.refusal; Anthropic stop_reason refusal: outcome de recusa com uso (um caso por provedor)', async () => {
  for (const [model, p, caso] of [['gpt-6-luna', 'openai', 'filtro'], ['gpt-6-luna', 'openai', 'recusa'], ['claude-haiku-5-5', 'anthropic', 'recusa']] as const) {
    const a = ambiente({ only: model, blocks: 1, answer: () => respostaDe(p, model, caso) });
    await runEcon(a.cfg); const [t] = tentativas(a.cfg.batchDir);
    assert.equal(t!.outcome, 'REFUSED_WITH_USAGE'); assert.equal(t!.refusal!.refused, true); assert.ok(t!.usage && typeof t!.usage.U === 'number');
  }
});

// ------------------------------------------------------------------ item 4: 5 modelos misturados no bloco, na ordem do cronograma
test('[ITEM 4] consumidor: 5 modelos misturados por bloco, enviados na ordem seq, um envio por tentativa, sem STOP_BATCH_MODEL_MIX', async () => {
  const a = ambiente({ blocks: 3 });
  const s = await runEcon(a.cfg);
  assert.equal(s.parada, null); assert.equal(s.executadasPrefixo, 15); assert.equal(a.sent.length, 15);
  const modelOf = (r: BuiltRequest) => (r.body as { model?: string }).model ?? /models\/([^:]+):/.exec(r.url)![1];
  assert.deepEqual(a.sent.map(modelOf), a.cron.map((l) => l.model));
  const j = journal(a.cfg.batchDir);
  assert.deepEqual(j.filter((l) => l.kind === 'PLANNED').map((l) => l.body['econSeq']), a.cron.map((l) => l.seq));
  assert.deepEqual(j.filter((l) => l.kind === 'PLANNED').map((l) => l.operationId), a.cron.map((l) => l.opId)); // opId = operationId
  assert.equal(j.some((l) => l.kind === 'STOP_GLOBAL'), false);
  assert.deepEqual(tentativas(a.cfg.batchDir).map((t) => t.seq), a.cron.map((l) => l.seq));
});
test('[ITEM 2] sem a tabela atestada do Sonnet 5 o consumidor não começa (nenhum envio, nenhuma reserva)', async () => {
  const a = ambiente({ sonnet5: false });
  await assert.rejects(runEcon(a.cfg), /ECON_PRICE_MISSING: claude-sonnet-5/);
  assert.equal(a.sent.length, 0); assert.equal(existsSync(path.join(a.cfg.batchDir, 'ledger.jsonl')), false);
});

// ------------------------------------------------------------------ item 11: ordem e prefixo de ponta a ponta
test('[ITEM 11] tentativa fora de ordem recusada antes de reservar (STOP_ECON_ORDER), nada enviado', async () => {
  const a = ambiente({ blocks: 1 });
  const e = await createEconExecutor(a.cfg);
  try {
    const r = await e.ex.run(e.plan(e.cron[2]!));
    assert.equal(r.stop, 'STOP_ECON_ORDER'); assert.equal(a.sent.length, 0);
    assert.equal(journal(a.cfg.batchDir).some((l) => l.kind === 'RESERVED' || l.kind === 'SENT'), false);
  } finally { e.ex.close(); }
});
test('[ITEM 11] retomada só a partir do primeiro seq não terminal: o que já foi enviado não é reenviado e a ordem continua', async () => {
  const a = ambiente({ blocks: 2 });
  const s1 = await runEcon({ ...a.cfg, maxOps: 4 }); assert.equal(s1.executadasPrefixo, 4); assert.equal(a.sent.length, 4);
  const s2 = await runEcon(a.cfg); assert.equal(s2.parada, null); assert.equal(s2.executadasPrefixo, 10);
  assert.equal(a.sent.length, 10, 'cada tentativa enviada uma única vez');
  const j = journal(a.cfg.batchDir);
  assert.deepEqual(j.filter((l) => l.kind === 'SENT').map((l) => l.operationId), a.cron.map((l) => l.opId));
  assert.equal(j.filter((l) => l.kind === 'REPLAY_SKIPPED').length, 4);
  assert.equal(tentativas(a.cfg.batchDir).length, 10, 'sem linha duplicada');
});
test('[ITEM 11] parada por STOP deixa só um prefixo: a tentativa parada nunca é enviada e nada depois dela roda, nem na retomada', async () => {
  const a = ambiente({ blocks: 1 });
  writeFileSync(path.join(a.cfg.batchDir, 'STOP'), 'x');
  const s1 = await runEcon(a.cfg); assert.equal(s1.parada!.seq, 0); assert.equal(a.sent.length, 0);
  // retirar o STOP não reabre a tentativa parada (terminal sem envio): o consumidor para nela, nenhum seq > 0 é enviado
  const { unlinkSync } = await import('node:fs'); unlinkSync(path.join(a.cfg.batchDir, 'STOP'));
  const s2 = await runEcon(a.cfg); assert.equal(s2.parada!.seq, 0); assert.equal(s2.parada!.stop, 'NAO_EXECUTADA'); assert.equal(a.sent.length, 0); assert.equal(s2.executadasPrefixo, 0);
});
test('[ITEM 4/11] LIMITING: a reserva que não cabe no sub-teto para ANTES do envio; o executado é prefixo em seq', async () => {
  // abertura assinada de TESTE: OpenAI com 10,999 já comprometidos (o teto 11 não cabe mais uma reserva luna)
  const providers = { openai: { settledUsd: '10.999', uncertainUsd: '0' } };
  const rest = { schema: 'h2eval.ledger_opening.v1' as const, fromStudy: { label: 'TESTE', ledgerSha256: 'e'.repeat(64), closedUtc: '2026-11-01T00:00:00Z' }, providers, signedBy: 'human:TESTE' };
  const opening = { ...rest, digestSha256: sha256Canon(rest) };
  const a = ambiente({ blocks: 2, extraCfg: { ledgerOpening: opening, pauseAck: [{ provider: 'openai', acknowledgedBy: 'human:TESTE', source: 'operator', reference: 'teste' }] } });
  const s = await runEcon(a.cfg);
  assert.equal(s.parada!.seq, 0); assert.equal(s.parada!.stop, 'STOP_BUDGET_PROVIDER'); assert.equal(a.sent.length, 0);
  assert.equal(journal(a.cfg.batchDir).some((l) => l.kind === 'SENT'), false);
});

// ------------------------------------------------------------------ item 3: persistência antes do SETTLED
test('[ITEM 3] falha ao persistir a resposta => nada liquidado: incerto (possivelmente cobrado), STOP_PERSISTENCE, nunca reenviado', async () => {
  const resp = respostaDe('openai', 'gpt-6-luna', 'texto');
  const sha = createHash('sha256').update(JSON.stringify(resp.body)).digest('hex');
  const a = ambiente({ only: 'gpt-6-luna', blocks: 2, answer: () => resp });
  mkdirSync(path.join(a.cfg.batchDir, 'responses', `${sha}.json`), { recursive: true }); // ocupa o nome: wx falha e o conteúdo não confere
  const s = await runEcon(a.cfg);
  assert.equal(s.parada!.seq, 0); assert.equal(s.parada!.stop, 'STOP_PERSISTENCE'); assert.equal(a.sent.length, 1);
  const kinds = journal(a.cfg.batchDir).map((l) => l.kind);
  assert.equal(kinds.includes('SETTLED'), false); assert.ok(kinds.includes('UNCERTAIN_ISOLATED'));
  const led = readFileSync(path.join(a.cfg.batchDir, 'ledger.jsonl'), 'utf8'); assert.ok(led.includes('"uncertain"')); assert.equal(led.includes('"settle"'), false);
  const s2 = await runEcon(a.cfg); assert.equal(a.sent.length, 1, 'não reenvia (N10) nem segue adiante'); assert.equal(s2.parada!.stop, 'STOP_UNCERTAIN'); assert.equal(s2.parada!.seq, 0);
});
test('[ITEM 3] ordem no journal: RESPONSE_RECEIVED traz só o responseSha256 e vem antes do SETTLED; o arquivo existe com o sha', async () => {
  const a = ambiente({ only: 'claude-opus-5-5', blocks: 1 });
  await runEcon(a.cfg);
  const j = journal(a.cfg.batchDir); const iR = j.findIndex((l) => l.kind === 'RESPONSE_RECEIVED'); const iS = j.findIndex((l) => l.kind === 'SETTLED');
  assert.ok(iR >= 0 && iS > iR); const sha = j[iR]!.body['responseSha256'] as string; assert.match(sha, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(path.join(a.cfg.batchDir, 'responses', `${sha}.json`)));
});

// ------------------------------------------------------------------ item 8: timeout com relógio falso
test('[ITEM 8] relógio falso: nada acontece antes de 600 000 ms; no limite vira TIMEOUT_UNCERTAIN (INCERTO), custo no highUsd, não reenviado', async () => {
  let chamou!: () => void; const chamado = new Promise<void>((r) => { chamou = r; });
  const a = ambiente({ only: 'claude-opus-5-5', blocks: 2, answer: () => { chamou(); return new Promise(() => { /* nunca responde */ }); } });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let fim = false; const p = runEcon(a.cfg).then((s) => { fim = true; return s; });
    await chamado; mock.timers.tick(ECON_TIMEOUT_MS - 1); await new Promise((r) => setImmediate(r)); assert.equal(fim, false, 'antes do prazo nada termina');
    mock.timers.tick(1); const s = await p;
    assert.equal(s.parada!.seq, 0); assert.equal(s.parada!.stop, 'STOP_UNCERTAIN');
    const [t] = tentativas(a.cfg.batchDir); assert.equal(t!.outcome, 'TIMEOUT_UNCERTAIN'); assert.equal(t!.cost.state, 'UNKNOWN'); assert.equal(t!.cost.highUsd, t!.cost.capUsd); assert.equal(t!.timeoutMs, 600_000);
    assert.ok(journal(a.cfg.batchDir).some((l) => l.kind === 'TIMEOUT_UNCERTAIN'));
  } finally { mock.timers.reset(); }
  const s2 = await runEcon(a.cfg); assert.equal(a.sent.length, 1, 'incerto nunca reenviado (N10)'); assert.notEqual(s2.parada, null);
});
test('[ITEM 8] o mesmo timeoutMs em todas as tentativas (5 modelos)', async () => {
  const a = ambiente({ blocks: 2 }); await runEcon(a.cfg);
  const ts = tentativas(a.cfg.batchDir); assert.equal(ts.length, 10); assert.deepEqual([...new Set(ts.map((t) => t.timeoutMs))], [600_000]);
  assert.deepEqual([...new Set(ts.map((t) => t.model))].sort(), MODELOS.map((m) => m[0]).sort());
});

// ------------------------------------------------------------------ item 9: reserva Google pelo parâmetro, de ponta a ponta
test('[ITEM 9] a reserva Google gravada no journal muda com o G-7b (ABERTO > NAO_LIMITA > LIMITA)', async () => {
  const res: bigint[] = [];
  for (const g of [{ estado: 'ABERTO' }, { estado: 'NAO_LIMITA', tMaxThoughts: 2000, fonte: 'teste' }, { estado: 'LIMITA', fonte: 'teste' }] as const) {
    const a = ambiente({ only: 'gemini-3.1-flash-lite', blocks: 1, g7b: g }); await runEcon(a.cfg);
    res.push(BigInt(journal(a.cfg.batchDir).find((l) => l.kind === 'RESERVED')!.body['usd'] as string));
  }
  assert.ok(res[0]! > res[1]! && res[1]! > res[2]!);
  assert.equal(res[0]! - res[2]!, 8192n * 1_500_000n); // 8192 thoughts a 1,50 USD/M
});
