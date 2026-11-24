/**
 * EXEC-ECON C160 delta 7 (OPÇÃO (c) para o autor): reserva de entrada do painel (`resposta`, Anthropic) pelo T MEDIDO no smoke (86 880 tokens
 * para 178 793 caracteres) + 2 %, só para o painel do corpus f7832807. Offline, transporte falso, US$ 0.
 * Os testes com o corpus/cronograma REAIS do kit v3.5 leem os arquivos fora do repositório (só leitura) e são pulados se o kit faltar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { computeCostCap } from '../../../scripts/h2eval/record/cost.js';
import { validateGoEconV1, type GoEconContext } from '../../../scripts/h2eval/econ/goEcon.js';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { ECON_RESERVA_PAINEL_MEDIDA, ECON_TIMEOUT_MS, boundByMeasure, econCapPolicy, corpusContentStore, corpusIdentity, readCronograma, runEcon, somaCostCap, loadEconPriceTable, planOf } from '../../../scripts/h2eval/econ/econ.js';
import { ambiente, respostaDe, tmp, writeSonnet5Fixture } from './econ_fixture.js';

const V35 = 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/C160/ECON_PREP/V3_5';
const CRON_V35 = '2d3a2de52730bc9246592699b24dd85e3a6d8868bc9feddb7052378b87821208';
const temKit = existsSync(path.join(V35, 'CORPUS', 'itens.jsonl')) && existsSync(path.join(V35, 'PLANOS', 'CRONOGRAMA.jsonl'));
const R = ECON_RESERVA_PAINEL_MEDIDA;
const ctx = { studyId: 'econ-teste', protocolHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) };
/** Sonnet 5 a 2/10 (DR-310) só como fixture de teste; o executor real usa a tabela atestada injetada */
function prices2_10(dir: string) { const t = JSON.parse(readFileSync(writeSonnet5Fixture(dir), 'utf8')); t.models['claude-sonnet-5'].tiers[0].prices = { ...t.models['claude-sonnet-5'].tiers[0].prices, input: '2000000', output: '10000000', reasoning: '10000000' }; const p = path.join(dir, 's5_2_10.json'); writeFileSync(p, JSON.stringify(t)); return loadEconPriceTable({ sonnet5TablePath: p }); }

test('[DELTA7] medida congelada e fórmula: o pedido medido (178 793 caracteres) dá ceil(86 880 × 1,02) = 88 618; margem 2 % ≈ 2,018 caracteres/token', () => {
  assert.deepEqual({ c: R.charsMedidos, t: R.tokensMedidos, m: R.margemPct, p: R.provider }, { c: 178793, t: 86880, m: 2, p: 'anthropic' });
  assert.equal(boundByMeasure(178793, R), 88618);
  assert.equal(boundByMeasure(178793, { ...R, margemPct: 0 }), 86880);
  assert.ok(Math.abs(178793 / boundByMeasure(178793, R) - 2.0176) < 0.001);
  assert.ok(boundByMeasure(178793, R) < Math.ceil(178793 / 1.647), 'menor que a regra de 1,647 (108 557)');
});
test('[DELTA7] política: só anthropic e só o sistema medido usam a medida; outro texto e outros provedores seguem a razão do pior caso', () => {
  const chars = () => 178793; const sys = (h: string) => (h === 'P'.repeat(64) ? R.sistemaSha256 : 'x'.repeat(64));
  const cp = econCapPolicy({ charsOf: chars, g7b: { estado: 'ABERTO' }, painel: { reserva: R, systemShaOf: sys } });
  const plan = (provider: 'anthropic' | 'openai' | 'google', model: string, prompt: string) => planOf({ seq: 0, block: 0, posNoBloco: 0, opId: 'd'.repeat(64), itemId: 'i', family: 'resposta', templateId: 't', arm: 'B', rep: 1, model, provider, promptSha256: prompt, systemSha256: 'x', maxOutputTokens: 8192, samplingParams: 'NOT_SENT', reasoningParams: 'NOT_SENT', cacheDirectives: 'NONE', tools: 'NONE', maxRetries: 0 }, ctx);
  assert.equal(cp.inputUpperBoundTokens(plan('anthropic', 'claude-haiku-5-5', 'P'.repeat(64))), 88618);
  assert.equal(cp.inputUpperBoundTokens(plan('anthropic', 'claude-haiku-5-5', 'Q'.repeat(64))), Math.ceil(178793 / 1.647));
  assert.equal(cp.inputUpperBoundTokens(plan('openai', 'gpt-6-luna', 'P'.repeat(64))), Math.ceil(178793 / 2.388));
  assert.equal(cp.inputUpperBoundTokens(plan('google', 'gemini-3.1-flash-lite', 'P'.repeat(64))), Math.ceil(178793 / 1.593));
  const sem = econCapPolicy({ charsOf: chars, g7b: { estado: 'ABERTO' } });
  assert.equal(sem.inputUpperBoundTokens(plan('anthropic', 'claude-haiku-5-5', 'P'.repeat(64))), Math.ceil(178793 / 1.647), 'sem o parâmetro, nada muda');
});
test('[DELTA7] parâmetro diferente da medida congelada é recusado; corpus que não é o medido é recusado (nada criado)', async () => {
  const a = ambiente({ blocks: 1 });
  await assert.rejects(runEcon({ ...a.cfg, reservaPainel: { ...R, margemPct: 0 } }), /ECON_RESERVA_PAINEL_PARAM/);
  await assert.rejects(runEcon({ ...a.cfg, reservaPainel: { ...R, tokensMedidos: 80000 } }), /ECON_RESERVA_PAINEL_PARAM/);
  await assert.rejects(runEcon({ ...a.cfg, reservaPainel: { ...R } }), /ECON_RESERVA_PAINEL_CORPUS/);
  assert.equal(existsSync(path.join(a.cfg.batchDir, 'journal.jsonl')), false); assert.equal(a.sent.length, 0);
});
test('[DELTA7] GO: o parâmetro é explícito e tem de ser o mesmo do executor (ou ausente nos dois)', () => {
  const sha = sha256Canon(R);
  const base: Record<string, unknown> = { schema: 'h2eval.go.econ.v1', campaign: 'c', studyId: 's', preregistrationSha256: '9'.repeat(64), executorCodeSha: 'c'.repeat(40), cronogramaSha256: 'f'.repeat(64), timeoutMs: ECON_TIMEOUT_MS, g7bEstado: 'ABERTO', capsProfile: 'econ_dr277', caps: { perProviderSubLedgerUsd: { anthropic: '95', openai: '11', google: '28' }, globalCampaignUsd: '132', pauseAtFractionOfSubLedger: 0.8 }, scope: { providers: ['anthropic'], modelIds: ['claude-haiku-5-5'], seqFrom: 0, seqTo: 0, maxAttempts: 1 }, window: { notBeforeUtc: '2026-11-20T00:00:00Z', notAfterUtc: '2026-11-21T00:00:00Z' }, stops: ['STOP_FILE', 'STOP_BUDGET', 'STOP_CAP_VIOLATION', 'STOP_PRICE_UNKNOWN', 'STOP_PERSISTENCE', 'STOP_UNCERTAIN', 'no retry', 'no fallback', 'concurrency 1', 'STOP_ECON_ORDER'], signedBy: 'human:T', signatureStatement: 'GO de TESTE (fixture) do delta 7' };
  const txt = (o: Record<string, unknown>) => { const g = { ...base, ...o }; return JSON.stringify({ ...g, goDigestSha256: sha256Canon(g) }); };
  const c = (o: Partial<GoEconContext> = {}): GoEconContext => ({ campaign: 'c', studyId: 's', preregistrationSha256: '9'.repeat(64), executorCodeSha: 'c'.repeat(40), treeClean: true, cronogramaSha256: 'f'.repeat(64), cronogramaLength: 10, timeoutMs: ECON_TIMEOUT_MS, g7bEstado: 'ABERTO', ledgerCaps: { campaignUsd: '132', providersUsd: { anthropic: '95', openai: '11', google: '28' } }, nowMs: Date.parse('2026-11-20T12:00:00Z'), ...o });
  assert.equal(validateGoEconV1(txt({ reservaPainelSha256: sha }), c({ reservaPainelSha256: sha })), null);
  assert.equal(validateGoEconV1(txt({}), c()), null);
  assert.equal(validateGoEconV1(txt({}), c({ reservaPainelSha256: sha })), 'GO_RESERVA_PAINEL_MISMATCH');
  assert.equal(validateGoEconV1(txt({ reservaPainelSha256: sha }), c()), 'GO_RESERVA_PAINEL_MISMATCH');
  assert.equal(validateGoEconV1(txt({ reservaPainelSha256: 'e'.repeat(64) }), c({ reservaPainelSha256: sha })), 'GO_RESERVA_PAINEL_MISMATCH');
});

// ------------------------------------------------------------------ com o corpus e o cronograma REAIS (kit v3.5, só leitura)
test('[DELTA7] corpus v3.5: identidade = f7832807 / painel 5047ffef; K-CUSTO Anthropic com a medida ≈ 93,26 (X1 c′) e ≤ 95', { skip: temKit ? false : 'kit v3.5 ausente' }, () => {
  const id = corpusIdentity(path.join(V35, 'CORPUS'));
  assert.equal(id.corpusSha256, R.corpusSha256); assert.equal(id.painelSha256, R.painelSha256);
  const cron = readCronograma(path.join(V35, 'PLANOS', 'CRONOGRAMA.jsonl'), { expectedSha256: CRON_V35, timeoutMs: ECON_TIMEOUT_MS });
  const s = corpusContentStore(path.join(V35, 'CORPUS')); const dir = tmp('k7'); const prices = prices2_10(dir);
  const c = somaCostCap(cron, s.charsOf, prices, { estado: 'LIMITA', fonte: 'x' }, '2026-11-20T00:00:00Z', computeCostCap, undefined, { reserva: R, systemShaOf: s.systemShaOf });
  const sem = somaCostCap(cron, s.charsOf, prices, { estado: 'LIMITA', fonte: 'x' }, '2026-11-20T00:00:00Z', computeCostCap);
  writeFileSync(path.join(dir, 'K.json'), JSON.stringify({ c, sem }));
  assert.ok((c['anthropic'] as number) <= 95, `anthropic ${c['anthropic']}`); assert.ok(Math.abs((c['anthropic'] as number) - 93.26) <= 0.05, `anthropic ${c['anthropic']} vs 93,26`);
  assert.ok(Math.abs((sem['anthropic'] as number) - 118.69) <= 0.05, `sem a medida ${sem['anthropic']} vs 118,69 (opção b)`);
  assert.equal(c['openai'], sem['openai']); assert.equal(c['google'], sem['google']);
});
async function realPainel(extra: number) {
  const a = ambiente({ blocks: 1 }); const dir = a.dir;
  const s = corpusContentStore(path.join(V35, 'CORPUS'));
  const cron = readCronograma(path.join(V35, 'PLANOS', 'CRONOGRAMA.jsonl'), { expectedSha256: CRON_V35, timeoutMs: ECON_TIMEOUT_MS });
  const alvo = cron.find((l) => l.family === 'resposta' && l.provider === 'anthropic')!; // seq 31, claude-haiku-5-5
  const limite = boundByMeasure(s.charsOf(alvo.promptSha256), R);
  const batchDir = path.join(dir, 'batch-real'); mkdirSync(batchDir, { recursive: true });
  const sent: number[] = [];
  const double = async (req: { url: string; body: unknown }) => {
    const n = sent.length; sent.push(n);
    const p = req.url.includes('anthropic') ? 'anthropic' : req.url.includes('openai') ? 'openai' : 'google'; const model = (req.body as { model?: string }).model ?? /models\/([^:]+):/.exec(req.url)![1]!;
    const r = respostaDe(p, model, 'texto') as { httpStatus: number; body: Record<string, unknown> };
    if (n === alvo.seq) { const b = JSON.parse(JSON.stringify(r.body)) as { usage: Record<string, unknown> }; b.usage['input_tokens'] = limite + extra; return { httpStatus: 200, body: b }; }
    return r;
  };
  const s2 = await runEcon({ ...a.cfg, batchDir, cronogramaPath: path.join(V35, 'PLANOS', 'CRONOGRAMA.jsonl'), cronogramaSha256: CRON_V35, corpusDir: path.join(V35, 'CORPUS'), prices: prices2_10(dir), egress: { mode: 'OFFLINE', campaign: 'econ-teste', double }, reservaPainel: { ...R }, maxOps: alvo.seq + 1 });
  const j = readFileSync(path.join(batchDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; operationId: string; body: Record<string, unknown> });
  return { s2, j, alvo, limite };
}
test('[DELTA7] entrada no limite: a tentativa do painel (seq 31, Haiku) reserva pela medida e liquida', { skip: temKit ? false : 'kit v3.5 ausente' }, async () => {
  const { s2, j, alvo, limite } = await realPainel(0);
  assert.equal(s2.reservaPainelSha256, sha256Canon(R));
  const res = j.find((l) => l.kind === 'RESERVED' && l.operationId === alvo.opId)!; assert.equal(res.body['reservedInputUpperBoundTokens'], limite);
  assert.ok(j.some((l) => l.kind === 'SETTLED' && l.operationId === alvo.opId)); assert.equal(s2.parada, null); assert.equal(s2.executadasPrefixo, alvo.seq + 1);
});
test('[DELTA7] entrada acima do limite (+1 token): o executor PARA com latch (STOP_INPUT_ABOVE_RESERVATION); nada depois é enviado', { skip: temKit ? false : 'kit v3.5 ausente' }, async () => {
  const { s2, j, alvo } = await realPainel(1);
  assert.equal(s2.parada!.seq, alvo.seq); assert.equal(s2.parada!.stop, 'STOP_INPUT_ABOVE_RESERVATION');
  assert.ok(j.some((l) => l.kind === 'STOP_GLOBAL' && l.operationId === alvo.opId && l.body['reason'] === 'STOP_INPUT_ABOVE_RESERVATION'));
});
test('[DELTA7] T não é usado sem conferir o sha: cópia descartável do corpus v3.5 com GABARITO ou painel alterado (sistema medido presente) é recusada', { skip: temKit ? false : 'kit v3.5 ausente' }, async () => {
  const { cpSync, appendFileSync } = await import('node:fs');
  for (const alvo of ['GABARITO.jsonl', 'painel.txt']) {
    const a = ambiente({ blocks: 1 }); const copia = path.join(a.dir, 'CORPUS_COPIA'); cpSync(path.join(V35, 'CORPUS'), copia, { recursive: true });
    appendFileSync(path.join(copia, alvo), alvo === 'painel.txt' ? ' ' : '\n');
    assert.notEqual(corpusIdentity(copia)[alvo === 'painel.txt' ? 'painelSha256' : 'corpusSha256'], alvo === 'painel.txt' ? R.painelSha256 : R.corpusSha256);
    await assert.rejects(runEcon({ ...a.cfg, cronogramaPath: path.join(V35, 'PLANOS', 'CRONOGRAMA.jsonl'), cronogramaSha256: CRON_V35, corpusDir: copia, prices: prices2_10(a.dir), reservaPainel: { ...R }, maxOps: 1 }), /ECON_RESERVA_PAINEL_CORPUS: corpus\/painel nao sao os medidos/, alvo);
    assert.equal(existsSync(path.join(a.cfg.batchDir, 'journal.jsonl')), false, alvo);
  }
});
