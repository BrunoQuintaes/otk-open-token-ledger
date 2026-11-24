// SYNTHETIC — OFFLINE. E3G (C160 BRACO-GO; DR-205): braço Google (gemini-3.1-flash-lite) + OpenAI (gpt-6-luna) no executor científico, sobre o E3HRI 29a910aa.
// Casos marcados [FALHA NO 29a910aa] reprovam no E3HRI (modelo fora da matriz / modulo e3gArm ausente / lock do Google / request-id NOT_AVAILABLE) e passam no E3G.
// REAL so com fetch INJETADO (dublê offline: nenhum socket); credencial = canario sintetico em arquivo temporario (nunca process.env de verdade, nenhuma chave real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { syntheticGo } from './go.test.js';
import { tmp, memoryContentStore, plan as basePlan } from '../support/double.js';
import type { OperationPlan, Provider } from '../../../scripts/h2eval/types.js';

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const okChecks = { insideGitTree: () => false, insideSyncFolder: () => false, aclWide: () => false as boolean | null };
const CANARY = 'zq-e3g-canary-51f0a2c7d9';
const VAR = { google: 'H2EVAL_E3G_TEST_GOOGLE', openai: 'H2EVAL_E3G_TEST_OPENAI' } as const;
const GEM = 'gemini-3.1-flash-lite'; const LUNA = 'gpt-6-luna';
const TEXT = 'resuma em uma frase: o braco Google/OpenAI do executor cientifico e fail-closed.';
type Line = { kind: string; operationId: string; body: Record<string, unknown> };
type Arm = 'google' | 'openai';
const ARM_CAPS = (p: Arm) => ({ campaignUsd: '1', providersUsd: { anthropic: '0', openai: p === 'openai' ? '1' : '0', google: p === 'google' ? '1' : '0' } });

function armPlan(p: Arm, over: Partial<OperationPlan> = {}, store: ReturnType<typeof memoryContentStore>): OperationPlan {
  const b = basePlan({ promptSha256: store.sha['t']! });
  return p === 'google'
    ? { ...b, provider: 'google', api: 'gemini.generate_content', endpoint: `POST /v1beta/models/${GEM}:generateContent`, modelRequested: GEM, params: { ...b.params, maxTokens: 64, serviceTier: 'NONE', reasoning: { thinking_level: 'minimal' }, thinking: { mode: 'minimal', thinkingLevel: 'minimal' } }, ...over }
    : { ...b, provider: 'openai', api: 'openai.chat_completions', endpoint: 'POST /v1/chat/completions', modelRequested: LUNA, params: { ...b.params, maxTokens: 64, serviceTier: 'default', reasoning: 'NONE', thinking: { mode: 'none' } }, ...over };
}
const googleBody = (o: { prompt?: number; cached?: number | null; cand?: number; thoughts?: number; tier?: string | null; model?: string } = {}) => {
  const prompt = o.prompt ?? 40; const cand = o.cand ?? 12; const th = o.thoughts ?? 5;
  const um: Record<string, unknown> = { promptTokenCount: prompt, candidatesTokenCount: cand, thoughtsTokenCount: th, totalTokenCount: prompt + cand + th, promptTokensDetails: [{ modality: 'TEXT', tokenCount: prompt }] };
  if (o.cached !== null) um['cachedContentTokenCount'] = o.cached ?? 0;
  if (o.tier) um['serviceTier'] = o.tier;
  return { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: um, modelVersion: o.model ?? GEM };
};
const openaiBody = (o: { prompt?: number; cached?: number; write?: number | null; completion?: number; reasoning?: number; tier?: string | null; model?: string } = {}) => {
  const ptd: Record<string, unknown> = { cached_tokens: o.cached ?? 0, audio_tokens: 0 }; if (o.write !== null) ptd['cache_write_tokens'] = o.write ?? 0;
  const b: Record<string, unknown> = { id: 'chatcmpl-sim', object: 'chat.completion', model: o.model ?? LUNA, choices: [{ index: 0, message: { role: 'assistant', content: 'ok', refusal: null }, finish_reason: 'stop' }], usage: { prompt_tokens: o.prompt ?? 1000, completion_tokens: o.completion ?? 50, total_tokens: (o.prompt ?? 1000) + (o.completion ?? 50), prompt_tokens_details: ptd, completion_tokens_details: { reasoning_tokens: o.reasoning ?? 30, audio_tokens: 0 } } };
  if (o.tier !== null) b['service_tier'] = o.tier ?? 'default';
  return b;
};

/** One arm operation in REAL mode through the INTEGRATED executor (real adapters, real egress) with an injected fetch. */
async function armRun(p: Arm, o: { body?: () => unknown; headers?: unknown; prices?: 'arm' | 'default'; ledgerFile?: string; caps?: ReturnType<typeof ARM_CAPS>; plans?: number; inputBound?: number; planOver?: Partial<OperationPlan>; lockedProviders?: Provider[]; mode?: 'REAL' | 'OFFLINE' } = {}) {
  const { createH2EvalExecutor, loadE3GPriceTable } = await import('../../../scripts/h2eval/index.js');
  const dir = tmp('e3g'); const store = memoryContentStore({ t: TEXT });
  const fetched: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const respond = () => (o.body ?? (() => (p === 'google' ? googleBody() : openaiBody())))();
  const d = mkdtempSync(path.join(tmpdir(), 'h2eval-e3g-')); const envFile = path.join(d, 'h2eval.env'); writeFileSync(envFile, `${VAR[p]}=${CANARY}\r\n`);
  const model = p === 'google' ? GEM : LUNA; const caps = o.caps ?? ARM_CAPS(p);
  const go = path.join(d, 'GO.json');
  writeFileSync(go, syntheticGo({ campaign: 'h2eval-test', provider: p, modelIds: [model], caps: { perOperation: 'costCap gravado e hasheado ANTES do envio', perBatchUsd: '0.25', perProviderSubLedgerUsd: Number(caps.providersUsd[p]), globalCampaignUsd: Number(caps.campaignUsd), pauseAtFractionOfSubLedger: 0.8 }, window: { notBeforeUtc: new Date(Date.now() - 60_000).toISOString(), expiresUtc: new Date(Date.now() + 3_600_000).toISOString() } }));
  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => { fetched.push({ url, body: init.body, headers: init.headers }); return { status: 200, headers: o.headers ?? new Headers(p === 'google' ? { 'x-goog-request-id': 'gReqE3gSynthetic01' } : { 'x-request-id': 'req_e3g_synthetic_01' }), json: async () => respond() }; }) as unknown as typeof fetch;
  const host = p === 'google' ? 'generativelanguage.googleapis.com' : 'api.openai.com';
  const egress = o.mode === 'OFFLINE'
    ? { mode: 'OFFLINE' as const, campaign: 'h2eval-test', allowedHosts: [host], double: async (req: { url: string; body: unknown }) => { fetched.push({ url: req.url, body: JSON.stringify(req.body), headers: {} }); return { httpStatus: 200, body: respond() }; } }
    : { mode: 'REAL' as const, realFlag: true, campaign: 'h2eval-test', allowedHosts: [host], goFile: go, preregistrationSha256: 'ab'.repeat(32), credentialEnvVars: { [p]: VAR[p] }, envFile, envFileChecks: okChecks, fetchImpl, forbiddenEnvVars: [] };
  const ledgerPath = path.join(dir, o.ledgerFile ?? `ledger.${p}.jsonl`);
  const ex = createH2EvalExecutor({
    batchDir: dir, contentStore: store, ...(o.prices === 'default' ? {} : { prices: loadE3GPriceTable() }), ledger: caps, ledgerPath, egress,
    capPolicy: { inputUpperBoundTokens: () => o.inputBound ?? 400 }, executorCodeSha: 'c'.repeat(40), consecutiveFailureStop: 2, ...(o.lockedProviders ? { lockedProviders: o.lockedProviders } : {}),
  });
  const results = [];
  for (let i = 0; i < (o.plans ?? 1); i++) results.push(await ex.run(armPlan(p, { rep: i + 1, ...(o.planOver ?? {}) }, store)));
  const state = ex.ledger.state(); ex.close();
  const text = existsSync(path.join(dir, 'journal.jsonl')) ? readFileSync(path.join(dir, 'journal.jsonl'), 'utf8') : '';
  const lines = (text ? verifyJournalText(text) : []) as unknown as Line[];
  return { results, r: results[0]!, lines, fetched, state, text, ledgerPath, dir, line: (k: string, i = 0) => lines.filter((l) => l.kind === k)[i]?.body };
}

test('[FALHA NO 29a910aa] E3G Google REAL (fetch injetado): gemini-3.1-flash-lite Standard sai, custo pelo preco atestado (DR-168), R-INST com x-goog-request-id, ledger so do Google', async () => {
  const x = await armRun('google', { body: () => googleBody({ prompt: 40, cached: 0, cand: 12, thoughts: 5 }) });
  assert.equal(x.r.state, 'COST_COMPUTED', JSON.stringify(x.lines.map((l) => [l.kind, l.body['reason']])));
  assert.equal(x.r.stop, null);
  assert.equal(x.fetched.length, 1);
  assert.equal(new URL(x.fetched[0]!.url).pathname, `/v1beta/models/${GEM}:generateContent`, 'o caminho leva o ID atestado (DR-187)');
  const sent = JSON.parse(x.fetched[0]!.body) as Record<string, unknown>;
  assert.equal(JSON.stringify(sent).includes('serviceTier'), false, 'generateContent: nenhum parametro de tier (Standard por declaracao do autor, DR-194)');
  assert.equal(x.line('SENT')?.['wireBodySha256'], sha(x.fetched[0]!.body), 'R-INST: sha256 dos bytes enviados');
  assert.equal(x.line('RESPONSE_RECEIVED')?.['providerRequestId'], 'gReqE3gSynthetic01', 'R-INST: request-id do Google');
  // 40 x 0,25 + (12 + 5) x 1,50 USD/MTok = 10 000 000 + 25 500 000 pico-USD
  assert.equal(x.line('COST_COMPUTED')?.['usd'], String(40n * 250000n + 17n * 1500000n));
  assert.equal(x.line('COST_COMPUTED')?.['tierBasis'], 'AUTHOR_DECLARATION_DR-194');
  assert.equal(x.line('SETTLED')?.['usd'], String(40n * 250000n + 17n * 1500000n));
  assert.ok(existsSync(x.ledgerPath) && path.basename(x.ledgerPath) === 'ledger.google.jsonl');
  assert.equal(x.state.providers.google.spentUsd, String(40n * 250000n + 17n * 1500000n)); assert.equal(x.state.providers.openai.spentUsd, '0'); assert.equal(x.state.providers.anthropic.spentUsd, '0');
  assert.doesNotMatch(x.text, new RegExp(CANARY), 'nenhum segredo no journal');
  assert.equal(x.fetched[0]!.headers['x-goog-api-key'], CANARY, 'a credencial so vai no cabecalho do pedido');
});

test('[FALHA NO 29a910aa] E3G OpenAI REAL: gpt-6-luna com service_tier "default" no corpo, cache write cobrado (DR-208), raciocinio como saida, x-request-id', async () => {
  const x = await armRun('openai', { body: () => openaiBody({ prompt: 1000, cached: 128, write: 256, completion: 50, reasoning: 30 }), inputBound: 1200 });
  assert.equal(x.r.state, 'COST_COMPUTED', JSON.stringify(x.lines.map((l) => [l.kind, l.body['reason']])));
  const sent = JSON.parse(x.fetched[0]!.body) as Record<string, unknown>;
  assert.equal(sent['service_tier'], 'default', 'tier fixo em toda requisicao'); assert.equal(sent['model'], LUNA);
  assert.equal(x.line('RESPONSE_RECEIVED')?.['providerRequestId'], 'req_e3g_synthetic_01');
  const exp = 616n * 100000n + 128n * 10000n + 256n * 125000n + 20n * 500000n + 30n * 500000n;
  assert.equal(x.line('COST_COMPUTED')?.['usd'], exp.toString());
  assert.equal(x.line('COST_COMPUTED')?.['tierServed'], 'default');
  assert.equal(path.basename(x.ledgerPath), 'ledger.openai.jsonl'); assert.equal(x.state.providers.openai.spentUsd, exp.toString());
  assert.equal(x.fetched[0]!.headers['authorization'], `Bearer ${CANARY}`);
});

test('[FALHA NO 29a910aa] E3G tier servido diferente de Standard => STOP_TIER_NOT_STANDARD (latch), custo UNKNOWN (nunca o preco Standard), dinheiro possivelmente cobrado; tier ausente na OpenAI tambem para', async () => {
  for (const [p, body] of [['openai', () => openaiBody({ tier: 'flex' })], ['openai', () => openaiBody({ tier: null })], ['google', () => googleBody({ tier: 'priority' })]] as const) {
    const x = await armRun(p, { body, plans: 2, inputBound: 1200 });
    assert.equal(x.r.stop, 'STOP_TIER_NOT_STANDARD', `${p}: ${JSON.stringify(x.lines.map((l) => [l.kind, l.body['reason']]))}`);
    assert.equal(x.line('COST_COMPUTED')?.['state'], 'UNKNOWN'); assert.equal(x.line('COST_COMPUTED')?.['usd'], 'UNKNOWN');
    assert.equal(x.line('SETTLED'), undefined, 'nada e liquidado ao preco Standard');
    assert.ok(BigInt(x.state.providers[p].possiblyChargedUsd) > 0n, 'a reserva fica como possivelmente cobrada');
    assert.equal(x.results[1]!.state, 'ABORTED_BEFORE_SEND'); assert.equal(x.results[1]!.stop, 'STOP_TIER_NOT_STANDARD'); assert.equal(x.fetched.length, 1, 'a operacao seguinte nao sai');
  }
});

test('[FALHA NO 29a910aa] E3G sem preco atestado => recusa antes de reservar; a tabela atestada recusa modelo sem atestacao, preco faltante e modelo estranho', async () => {
  for (const p of ['google', 'openai'] as const) {
    const x = await armRun(p, { prices: 'default' });
    assert.equal(x.r.stop, 'STOP_ARM_PRICE_NOT_ATTESTED'); assert.equal(x.fetched.length, 0); assert.equal(x.line('RESERVED'), undefined);
  }
  const { validateArmPriceTable, E3G_PRICE_TABLE_PATH } = await import('../../../scripts/h2eval/core/e3gArm.js');
  const raw = JSON.parse(readFileSync(E3G_PRICE_TABLE_PATH, 'utf8'));
  assert.deepEqual(validateArmPriceTable(Buffer.from(JSON.stringify(raw))).attestedModels, [GEM, LUNA]);
  const mut = (f: (t: typeof raw) => void) => { const t = structuredClone(raw); f(t); return Buffer.from(JSON.stringify(t)); };
  assert.throws(() => validateArmPriceTable(mut((t) => { delete t.models[LUNA].attestation; })), /ARM_PRICE_NOT_ATTESTED/);
  assert.throws(() => validateArmPriceTable(mut((t) => { t.models[GEM].attestation.attestedBy = 'BOT-01'; })), /ARM_PRICE_NOT_ATTESTED/);
  assert.throws(() => validateArmPriceTable(mut((t) => { t.models[LUNA].tiers[0].prices.cacheWrite = null; })), /ARM_PRICE_MISSING/);
  assert.throws(() => validateArmPriceTable(mut((t) => { t.models[GEM].tiers[0].prices.reasoning = '0'; })), /ARM_PRICE_MISSING/);
  assert.throws(() => validateArmPriceTable(mut((t) => { t.models['claude-sonnet-5-5'] = t.models[GEM]; })), /ARM_PRICE_TABLE_FOREIGN_MODEL/);
  // contexto > 272k: sem preco atestado => STOP_PRICE_UNKNOWN antes de reservar
  const big = await armRun('openai', { inputBound: 272_001 });
  assert.equal(big.r.stop, 'STOP_PRICE_UNKNOWN'); assert.equal(big.fetched.length, 0);
});

test('[FALHA NO 29a910aa] E3G ledger separado por provedor: arquivo comum, perfil de tetos errado ou teto de US$ 1,00 estourado => nada sai', async () => {
  const a = await armRun('google', { ledgerFile: 'ledger.jsonl' }); assert.equal(a.r.stop, 'STOP_ARM_LEDGER'); assert.equal(a.fetched.length, 0);
  const b = await armRun('openai', { ledgerFile: 'ledger.google.jsonl' }); assert.equal(b.r.stop, 'STOP_ARM_LEDGER');
  const c = await armRun('google', { caps: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } } }); assert.equal(c.r.stop, 'STOP_ARM_LEDGER');
  const d = await armRun('openai', { caps: { campaignUsd: '1', providersUsd: { anthropic: '0', openai: '1', google: '1' } } }); assert.equal(d.r.stop, 'STOP_ARM_LEDGER');
  // costCap acima do sub-ledger de US$ 1,00: input bound 9 000 000 x 0,25 USD/MTok = 2,25 USD => STOP_BUDGET antes do envio
  const e = await armRun('google', { inputBound: 9_000_000 }); assert.equal(e.r.state, 'STOP_BUDGET', JSON.stringify(e.lines.map((l) => [l.kind, l.body['reason']]))); assert.equal(e.fetched.length, 0);
  const { capsAreAllowedFor } = await import('../../../scripts/h2eval/core/ledger.js'); const { usdToPico } = await import('../../../scripts/h2eval/core/ledger.js');
  assert.equal(capsAreAllowedFor(usdToPico('1'), 'google', usdToPico('1')), true); assert.equal(capsAreAllowedFor(usdToPico('1'), 'openai', usdToPico('1')), true);
  assert.equal(capsAreAllowedFor(usdToPico('1'), 'anthropic', usdToPico('1')), false, 'o perfil do braco nao vale para a Anthropic');
});

test('[FALHA NO 29a910aa] E3G UNKNOWN nunca vira 0: cache write ausente no gpt-6-luna => custo UNKNOWN, operacao isolada, possivelmente cobrada', async () => {
  for (const [p, body] of [['openai', () => openaiBody({ write: null })]] as const) {
    const x = await armRun(p, { body, inputBound: 1200 });
    assert.equal(x.r.state, 'UNCERTAIN', p); assert.equal(x.r.stop, 'STOP_UNCERTAIN');
    assert.equal(x.line('COST_COMPUTED')?.['usd'], 'UNKNOWN'); assert.equal(x.line('UNCERTAIN_ISOLATED')?.['possiblyCharged'], true);
    assert.equal(x.state.providers[p].spentUsd, '0'); assert.ok(BigInt(x.state.providers[p].possiblyChargedUsd) > 0n);
  }
});

test('[FALHA NO 29a910aa] E3G OFFLINE (dublê): o braco Google nao fica no lock padrao; lock EXPLICITO ainda vale; adaptador recusa luna sem tier fixo e entrada nao-texto', async () => {
  const off = await armRun('google', { mode: 'OFFLINE' });
  assert.equal(off.r.state, 'COST_COMPUTED', JSON.stringify(off.lines.map((l) => [l.kind, l.body['reason']])));
  assert.deepEqual([off.line('RESPONSE_RECEIVED')?.['providerRequestId'], off.line('RESPONSE_RECEIVED')?.['providerRequestIdReason']], ['NOT_AVAILABLE', 'NO_HEADERS'], 'OFFLINE: dublê sem headers');
  const locked = await armRun('google', { mode: 'OFFLINE', lockedProviders: ['google'] });
  assert.equal(locked.r.state, 'NOT_RUN_BRANCH_LOCKED');
  const { ADAPTERS } = await import('../../../scripts/h2eval/modal/index.js');
  const store = memoryContentStore({ t: TEXT }); const content = await store.get(store.sha['t']!);
  const lp = armPlan('openai', {}, store);
  assert.throws(() => ADAPTERS['openai.chat_completions'].buildRequest({ ...lp, params: { ...lp.params, serviceTier: 'NONE' } }, content), /H2EVAL_ARM_TIER_NOT_FIXED/);
  assert.equal((ADAPTERS['openai.chat_completions'].buildRequest(lp, content).body as Record<string, unknown>)['service_tier'], 'default');
  const img = { ...content, messages: [{ role: 'user' as const, parts: [{ type: 'image' as const, mime: 'image/png', bytesSha256: 'a'.repeat(64), bytesBase64: 'AA==', width: 1, height: 1 }] }] };
  assert.throws(() => ADAPTERS['gemini.generate_content'].buildRequest(armPlan('google', {}, store), img as never), /H2EVAL_MODALITY_NOT_SUPPORTED/);
  // the legacy Gemini (3.5) stays under the default lock exactly as before
  const { createH2EvalExecutor, loadE3GPriceTable } = await import('../../../scripts/h2eval/index.js');
  const dir = tmp('e3g-legacy'); const s2 = memoryContentStore({ t: TEXT });
  const ex = createH2EvalExecutor({ batchDir: dir, contentStore: s2, prices: loadE3GPriceTable(), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } }, egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: ['generativelanguage.googleapis.com'], double: async () => ({ httpStatus: 200, body: googleBody({ model: 'gemini-3.5-flash-lite' }) }) }, capPolicy: { inputUpperBoundTokens: () => 400 }, executorCodeSha: 'c'.repeat(40) });
  const r = await ex.run({ ...armPlan('google', {}, s2), modelRequested: 'gemini-3.5-flash-lite' }); ex.close();
  assert.equal(r.state, 'NOT_RUN_BRANCH_LOCKED');
});

test('[FALHA NO f15c6679] E3G2 Gemini: cachedContentTokenCount AUSENTE => liquida pelo limite superior (toda a entrada a 0,25), marcado ABSENT_FIELD_UPPER_BOUND no journal e no registro', async () => {
  const x = await armRun('google', { body: () => googleBody({ prompt: 40, cached: null, cand: 12, thoughts: 5 }) });
  const exp = String(40n * 250000n + 17n * 1500000n);
  assert.equal(x.r.state, 'COST_COMPUTED', JSON.stringify(x.lines.map((l) => [l.kind, l.body['reason']]))); assert.equal(x.r.stop, null);
  assert.equal(x.line('COST_COMPUTED')?.['usd'], exp); assert.equal(x.line('COST_COMPUTED')?.['cacheReadEvidence'], 'ABSENT_FIELD_UPPER_BOUND'); assert.equal(x.line('COST_COMPUTED')?.['boundInputTokens'], 40);
  assert.equal(x.line('SETTLED')?.['cacheReadEvidence'], 'ABSENT_FIELD_UPPER_BOUND'); assert.equal(x.state.providers.google.spentUsd, exp);
  assert.ok(BigInt(exp) >= 40n * 25000n + 17n * 1500000n, 'limite superior >= custo com toda a entrada em cache');
  const { readdirSync } = await import('node:fs'); const recs = readdirSync(path.join(x.dir, 'records'));
  assert.equal(JSON.parse(readFileSync(path.join(x.dir, 'records', recs[0]!), 'utf8'))['cacheReadEvidence'], 'ABSENT_FIELD_UPPER_BOUND');
});

test('[FALHA NO f15c6679] E3G2 Gemini: campo presente => usa o valor (sem marca); campo invalido => UNKNOWN; saida ausente => UNKNOWN', async () => {
  const pres = await armRun('google', { body: () => googleBody({ prompt: 40, cached: 16, cand: 12, thoughts: 5 }) });
  assert.equal(pres.line('COST_COMPUTED')?.['usd'], String(24n * 250000n + 16n * 25000n + 17n * 1500000n)); assert.equal(pres.line('COST_COMPUTED')?.['cacheReadEvidence'], undefined);
  const inval = await armRun('google', { body: () => { const b = googleBody({ cached: 0 }); (b.usageMetadata as Record<string, unknown>)['cachedContentTokenCount'] = 'muitos'; return b; } });
  assert.equal(inval.r.stop, 'STOP_UNCERTAIN'); assert.equal(inval.line('COST_COMPUTED')?.['usd'], 'UNKNOWN'); assert.equal(inval.line('COST_COMPUTED')?.['cacheReadEvidence'], undefined);
  const noOut = await armRun('google', { body: () => { const b = googleBody({ cached: null }); const um = b.usageMetadata as Record<string, unknown>; delete um['candidatesTokenCount']; return b; } });
  assert.equal(noOut.r.stop, 'STOP_UNCERTAIN'); assert.equal(noOut.line('COST_COMPUTED')?.['usd'], 'UNKNOWN');
  const noPrompt = await armRun('google', { body: () => { const b = googleBody({ cached: null }); delete (b.usageMetadata as Record<string, unknown>)['promptTokenCount']; return b; } });
  assert.equal(noPrompt.line('COST_COMPUTED')?.['usd'], 'UNKNOWN');
  const { googleCacheUpperBound } = await import('../../../scripts/h2eval/core/e3gArm.js');
  assert.equal(googleCacheUpperBound('gemini-3.5-flash-lite', { inputUncached: 'UNKNOWN', cacheRead: 'UNKNOWN', U: 'UNKNOWN' }, googleBody({ cached: null })), null, 'so o modelo do braco');
  assert.equal(googleCacheUpperBound(GEM, { inputUncached: 'UNKNOWN', cacheRead: 'UNKNOWN', U: 'UNKNOWN' }, googleBody({ cached: null, prompt: -1 })), null, 'prompt invalido');
});

// ===== C160 E3G3 (ressalva R3 do G15 E3G2): casos que mataram os mutantes ME8 (G7 sem limite) e ME14 (limite com tier ruim) so nos ataques do auditor =====
// Origem: runs/C160/BRACO_GO_G15/replica/g15_e3g2_adversarial.test.ts (AUD-G3, AUD-G4), incorporados sem mudanca de assercao.
const stopsOf = (x: { lines: Line[] }) => x.lines.filter((l) => l.kind === 'STOP_GLOBAL').map((l) => String(l.body['reason']));

test('[R3/ME14] E3G3 Google tier: serviceTier presente e diferente de standard => STOP (e o limite superior NAO e aplicado); standard/STANDARD aceitos', async () => {
  for (const t of ['priority', 'flex', 'batch']) {
    const x = await armRun('google', { body: () => googleBody({ cached: null, tier: t }), plans: 2 });
    assert.ok(stopsOf(x).includes('STOP_TIER_NOT_STANDARD'), t); assert.equal(x.line('COST_COMPUTED')?.['usd'], 'UNKNOWN', t); assert.equal(x.line('COST_COMPUTED')?.['cacheReadEvidence'], undefined, t); assert.equal(x.fetched.length, 1, t);
  }
  for (const t of ['standard', 'STANDARD']) { const x = await armRun('google', { body: () => googleBody({ cached: 0, tier: t }) }); assert.equal(x.r.stop, null, t); }
});

test('[R3/ME8] E3G3 Gemini limite superior: G7 usa a entrada limitada (promptTokenCount > reserva => STOP_INPUT_ABOVE_RESERVATION); igual a reserva passa; cached 0 presente usa o valor', async () => {
  const g7 = await armRun('google', { body: () => googleBody({ prompt: 401, cached: null }), inputBound: 400, plans: 2 });
  assert.ok(stopsOf(g7).includes('STOP_INPUT_ABOVE_RESERVATION'), String(stopsOf(g7))); assert.equal(g7.lines.find((l) => l.kind === 'STOP_GLOBAL')?.body['measuredInputTokens'], 401); assert.equal(g7.fetched.length, 1);
  const eq = await armRun('google', { body: () => googleBody({ prompt: 400, cached: null }), inputBound: 400 }); assert.equal(eq.r.stop, null);
  const z = await armRun('google', { body: () => googleBody({ prompt: 40, cached: 0 }) }); assert.equal(z.line('COST_COMPUTED')?.['cacheReadEvidence'], undefined); assert.equal(z.line('COST_COMPUTED')?.['usd'], String(40n * 250000n + 17n * 1500000n));
});

// ===== C160 E3G4 (B4 e B5 do ensaio do kit PROTO-GO v2) =====
const recOf = async (dir: string) => { const { readdirSync } = await import('node:fs'); const rs = readdirSync(path.join(dir, 'records')); return JSON.parse(readFileSync(path.join(dir, 'records', rs[0]!), 'utf8')); };
const rowOf = async (dir: string) => { const { exportDataset } = await import('../../../scripts/h2eval/cli/status.js'); const out = path.join(dir, 'ds.jsonl'); exportDataset(dir, out); return JSON.parse(readFileSync(out, 'utf8').trim().split('\n')[0]!); };

test('[FALHA NO 356146e7] E3G4 B4: Gemini 3.1 sem cachedContentTokenCount => registro e dataset com U = promptTokenCount, usage COMPLETE, divisao de cache UNKNOWN e marca ABSENT_FIELD_UPPER_BOUND; custo pelo limite', async () => {
  const x = await armRun('google', { body: () => googleBody({ prompt: 40, cached: null, cand: 12, thoughts: 5 }) });
  assert.equal(x.r.stop, null); assert.equal(x.line('COST_COMPUTED')?.['usd'], String(40n * 250000n + 17n * 1500000n));
  assert.equal(x.line('COST_COMPUTED')?.['recordedU'], 40); assert.equal(x.line('COST_COMPUTED')?.['recordedUsageCompleteness'], 'COMPLETE');
  const rec = await recOf(x.dir); assert.equal(rec.usage.U, 40); assert.equal(rec.usage.usageCompleteness, 'COMPLETE'); assert.equal(rec.usage.cacheRead, 'UNKNOWN'); assert.equal(rec.usage.inputUncached, 'UNKNOWN'); assert.equal(rec.cacheReadEvidence, 'ABSENT_FIELD_UPPER_BOUND');
  const row = await rowOf(x.dir); assert.equal(row.declared.U, 40); assert.equal(row.declared.usageCompleteness, 'COMPLETE'); assert.equal(row.declared.cacheRead, 'UNKNOWN'); assert.equal(row.declared.cacheReadEvidence, 'ABSENT_FIELD_UPPER_BOUND'); assert.equal(row.cost.state, 'CALCULATED');
  // chave presente: valor medido, sem marca, usage COMPLETE (pedido so-texto: imagem/audio NOT_APPLICABLE)
  const p = await armRun('google', { body: () => googleBody({ prompt: 40, cached: 16, cand: 12, thoughts: 5 }) }); const pr = await rowOf(p.dir);
  assert.equal(pr.declared.U, 40); assert.equal(pr.declared.cacheRead, 16); assert.equal(pr.declared.usageCompleteness, 'COMPLETE'); assert.equal(pr.declared.cacheReadEvidence, undefined);
});

test('[FALHA NO 356146e7] E3G4 B4: chave presente e invalida (null, negativa, fracao, objeto) => U UNKNOWN, sem marca, custo UNKNOWN e STOP; saida ausente => usage PARTIAL', async () => {
  for (const [nome, v] of [['null', null], ['negativo', -3], ['fracao', 1.5], ['objeto', {}]] as Array<[string, unknown]>) {
    const x = await armRun('google', { body: () => { const b = googleBody({ cached: 0 }); (b.usageMetadata as Record<string, unknown>)['cachedContentTokenCount'] = v; return b; } });
    assert.equal(x.r.stop, 'STOP_UNCERTAIN', nome); const row = await rowOf(x.dir); assert.equal(row.declared.U, 'UNKNOWN', nome); assert.equal(row.declared.cacheReadEvidence, undefined, nome); assert.notEqual(row.declared.usageCompleteness, 'COMPLETE', nome);
  }
  const noOut = await armRun('google', { body: () => { const b = googleBody({ cached: null }); delete (b.usageMetadata as Record<string, unknown>)['candidatesTokenCount']; return b; } });
  assert.equal(noOut.r.stop, 'STOP_UNCERTAIN'); const r2 = await recOf(noOut.dir); assert.equal(r2.usage.usageCompleteness, 'PARTIAL', 'resto da contagem desconhecido nao vira COMPLETE');
  const { googleUpperBoundRecordUsage } = await import('../../../scripts/h2eval/core/e3gArm.js');
  const u = { U: 'UNKNOWN', usageCompleteness: 'PARTIAL', cacheWrite5m: 'NOT_APPLICABLE', cacheWrite1h: 'NOT_APPLICABLE', cacheWrite: 'NOT_APPLICABLE', outputVisible: 1, reasoning: 0, imageUnits: 'NOT_APPLICABLE', audioUnits: 'NOT_APPLICABLE', toolTokens: 'NOT_APPLICABLE' };
  assert.equal(googleUpperBoundRecordUsage(u, null), u, 'sem limite: a mesma usage'); assert.equal(googleUpperBoundRecordUsage(u, { U: 'UNKNOWN' }), u);
  assert.equal(googleUpperBoundRecordUsage({ ...u, imageUnits: 'UNKNOWN' }, { U: 9 }).usageCompleteness, 'PARTIAL');
  assert.equal(googleUpperBoundRecordUsage(u, { U: 9 }).usageCompleteness, 'COMPLETE'); assert.equal(googleUpperBoundRecordUsage(u, { U: 9 }).U, 9);
});

test('[FALHA NO 356146e7] E3G4 B5: simulador offline do executor responde com o id do braco (Gemini 3.1) e com usage completa do luna; matriz inalterada', async () => {
  const { createOfflineProvider } = await import('../../../scripts/h2eval/cli/offlineProvider.js');
  const sim = createOfflineProvider({}); const g = (m: string) => ({ url: `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, body: { contents: [{ role: 'user', parts: [{ text: 'oi' }] }] } });
  const o = (m: string) => ({ url: 'https://api.openai.com/v1/chat/completions', body: { model: m, messages: [{ role: 'user', content: 'oi' }] } });
  assert.equal(((await sim.double(g(GEM) as never)).body as Record<string, unknown>)['modelVersion'], GEM);
  assert.equal(((await sim.double(g('gemini-3.5-flash-lite') as never)).body as Record<string, unknown>)['modelVersion'], 'gemini-3.5-flash-lite');
  const ul = ((await sim.double(o(LUNA) as never)).body as { usage: { prompt_tokens_details: Record<string, unknown> } }).usage.prompt_tokens_details; assert.equal(ul['cache_write_tokens'], 0);
  const um = ((await sim.double(o('gpt-4o-mini-2024-07-18') as never)).body as { usage: { prompt_tokens_details: Record<string, unknown> } }).usage.prompt_tokens_details; assert.equal('cache_write_tokens' in um, false, 'gpt-4o-mini sem o campo (inalterado)');
  // executor integrado em OFFLINE com o simulador: os dois liquidam; dataset com modelo servido = pedido e usage COMPLETE
  const { createH2EvalExecutor, loadE3GPriceTable } = await import('../../../scripts/h2eval/index.js');
  for (const p of ['google', 'openai'] as const) {
    const dir = tmp('e3g4sim'); const store = memoryContentStore({ t: TEXT }); const sim2 = createOfflineProvider({});
    const ex = createH2EvalExecutor({ batchDir: dir, contentStore: store, prices: loadE3GPriceTable(), ledger: ARM_CAPS(p), ledgerPath: path.join(dir, `ledger.${p}.jsonl`), egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [p === 'google' ? 'generativelanguage.googleapis.com' : 'api.openai.com'], double: sim2.double }, capPolicy: { inputUpperBoundTokens: () => 400 }, executorCodeSha: 'c'.repeat(40), consecutiveFailureStop: 2 });
    const r = await ex.run(armPlan(p, { rep: 1 }, store)); ex.close();
    assert.equal(r.stop, null, p); assert.equal(r.state, 'COST_COMPUTED', p);
    const row = await rowOf(dir); assert.equal(row.declared.modelServed, p === 'google' ? GEM : LUNA, p); assert.equal(row.declared.usageCompleteness, 'COMPLETE', p); assert.equal(typeof row.declared.U, 'number', p); assert.equal(row.declared.exclusion, 'NONE', p);
    assert.equal(row.declared.cacheReadEvidence, p === 'google' ? 'ABSENT_FIELD_UPPER_BOUND' : undefined, p);
  }
});

test('[MD6] E3G4 textOnly so para o braco: o gemini-3.5-flash-lite da matriz continua com imagem/audio UNKNOWN quando ausentes (usage PARTIAL, como antes)', async () => {
  const x = await armRun('google', { mode: 'OFFLINE', lockedProviders: [], prices: 'default', planOver: { modelRequested: 'gemini-3.5-flash-lite', endpoint: 'POST /v1beta/models/gemini-3.5-flash-lite:generateContent' }, body: () => googleBody({ prompt: 40, cached: 0, model: 'gemini-3.5-flash-lite' }) });
  assert.equal(x.fetched.length, 1, JSON.stringify(x.lines.map((l) => [l.kind, l.body['reason']])));
  const rec = await recOf(x.dir); assert.equal(rec.usage.imageUnits, 'UNKNOWN'); assert.equal(rec.usage.audioUnits, 'UNKNOWN'); assert.equal(rec.usage.usageCompleteness, 'PARTIAL'); assert.equal(rec.cacheReadEvidence, undefined);
  const arm = await armRun('google', { mode: 'OFFLINE', body: () => googleBody({ prompt: 40, cached: 0 }) }); const ra = await recOf(arm.dir);
  assert.equal(ra.usage.imageUnits, 'NOT_APPLICABLE'); assert.equal(ra.usage.usageCompleteness, 'COMPLETE');
});

// E3G5 (C160 OPENAI-R-FIX, DR-221): a sonda OPENAI parou no summary-L (L0 = 4769 tokens) porque o adaptador classificava a escrita de cache
// do gpt-6-luna como NO_HIT e o validador como CREATION => UsageInvalid => ERROR_NO_USAGE => incerta. Executor integrado, fetch injetado.
test('[FALHA NO 2af9fe88] E3G5 luna REAL: escrita de cache > 0 sem leitura (prompt longo) => COST_COMPUTED com a escrita cobrada; nunca ERROR_NO_USAGE/incerta', async () => {
  const x = await armRun('openai', { body: () => openaiBody({ prompt: 4769, cached: 0, write: 4736, completion: 50, reasoning: 30 }), inputBound: 5000 });
  assert.equal(x.r.state, 'COST_COMPUTED', JSON.stringify(x.lines.map((l) => [l.kind, l.body['reason']])));
  assert.equal(x.r.stop, null);
  assert.equal(x.line('ERROR_NO_USAGE'), undefined); assert.equal(x.line('TIMEOUT_UNCERTAIN'), undefined);
  const up = x.line('USAGE_PARSED');
  assert.equal(up?.['cacheObserved'], 'CREATION'); assert.equal(up?.['cacheWrite'], 4736); assert.equal(up?.['inputUncached'], 33); assert.equal(up?.['U'], 4769);
  const exp = 33n * 100000n + 4736n * 125000n + 50n * 500000n;
  assert.equal(x.line('COST_COMPUTED')?.['usd'], exp.toString()); assert.equal(x.line('SETTLED')?.['usd'], exp.toString());
});

test('[FALHA NO 2af9fe88] E3G5 luna REAL: cache_write_tokens ausente com leitura 0 => usage registrada (escrita/U UNKNOWN, nunca 0), custo UNKNOWN; nunca ERROR_NO_USAGE', async () => {
  const x = await armRun('openai', { body: () => openaiBody({ prompt: 4769, cached: 0, write: null, completion: 50, reasoning: 30 }), inputBound: 5000 });
  assert.equal(x.line('ERROR_NO_USAGE'), undefined, JSON.stringify(x.lines.map((l) => [l.kind, l.body['reason']])));
  const up = x.line('USAGE_PARSED');
  assert.equal(up?.['cacheObserved'], 'UNKNOWN'); assert.equal(up?.['cacheWrite'], 'UNKNOWN'); assert.equal(up?.['U'], 'UNKNOWN'); assert.equal(up?.['completeness'], 'PARTIAL');
  assert.equal(x.line('COST_COMPUTED')?.['usd'], 'UNKNOWN'); assert.equal(x.line('SETTLED'), undefined, 'nada liquidado com escrita desconhecida');
});
