// SYNTHETIC — OFFLINE. E3G5 (C160 OPENAI-R-FIX, DR-221): contrato de usage dos tres provedores.
// Para cada forma de usage (escrita de cache, leitura, ausente, zero, null, subset maior que o container), o adaptador
// (ADAPTERS[api].parseUsage -> cacheObserved de modal/canonical.ts) e o validador (record/usage.ts cacheObservedOf) tem de concordar,
// e validateUsage nao pode recusar a usage. Casos [FALHA NO 2af9fe88]: gpt-6-luna com cache_write_tokens > 0 e leitura 0 (o summary-L
// da sonda OPENAI, que virou UsageInvalid -> ERROR_NO_USAGE -> incerta) e gpt-6-luna sem cache_write_tokens com leitura 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS } from '../../../scripts/h2eval/modal/index.js';
import { cacheObservedOf, validateUsage, UsageInvalid } from '../../../scripts/h2eval/record/usage.js';

type Exp = 'HIT' | 'CREATION' | 'NO_HIT' | 'UNKNOWN';
type Caso = { nome: string; body: unknown; ctx?: Record<string, unknown>; exp: Exp; check?: (u: Record<string, unknown>) => void };

const oai = (model: string, ptd: Record<string, unknown> | undefined | null, prompt: number | null = 4769) => {
  const usage: Record<string, unknown> = { completion_tokens: 600, total_tokens: (prompt ?? 0) + 600, completion_tokens_details: { reasoning_tokens: 300, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
  if (prompt !== null) usage['prompt_tokens'] = prompt;
  if (ptd !== undefined) usage['prompt_tokens_details'] = ptd;
  return { model, service_tier: 'default', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'x', refusal: null } }], usage };
};
const LUNA = 'gpt-6-luna-2026-10-01'; const MINI = 'gpt-4o-mini-2024-07-18';
const unk = (...f: string[]) => (u: Record<string, unknown>) => { for (const k of f) assert.equal(u[k], 'UNKNOWN', `${k} tem de ser UNKNOWN (nunca 0)`); };

function check(api: keyof typeof ADAPTERS, casos: Caso[]) {
  for (const c of casos) {
    const u = ADAPTERS[api]!.parseUsage(c.body, c.ctx as never) as unknown as Record<string, unknown> & Parameters<typeof cacheObservedOf>[0];
    assert.equal(u['cacheObserved'], c.exp, `${c.nome}: adaptador`);
    assert.equal(cacheObservedOf(u), c.exp, `${c.nome}: validador (por uso)`);
    assert.doesNotThrow(() => validateUsage(u as never), `${c.nome}: validateUsage`);
    c.check?.(u);
  }
}

test('[FALHA NO 2af9fe88] gpt-6-luna: escrita de cache > 0 sem leitura => CREATION no adaptador e no validador; usage valida, U = prompt_tokens', () => {
  const u = ADAPTERS['openai.chat_completions'].parseUsage(oai(LUNA, { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: 4736 })) as unknown as Record<string, unknown>;
  assert.equal(u['cacheObserved'], 'CREATION');
  const v = validateUsage(u as never);
  assert.equal(v.cacheObserved, 'CREATION'); assert.equal(v.cacheWrite, 4736); assert.equal(v.cacheRead, 0); assert.equal(v.inputUncached, 33); assert.equal(v.U, 4769);
  assert.equal(v.cacheWrite5m, 'NOT_APPLICABLE'); assert.equal(v.cacheWrite1h, 'NOT_APPLICABLE');
});

test('[FALHA NO 2af9fe88] gpt-6-luna: cache_write_tokens ausente (ou null/negativo) com leitura 0 => UNKNOWN coerente (nunca 0, nunca NO_HIT); usage valida e PARTIAL', () => {
  for (const ptd of [{ cached_tokens: 0, audio_tokens: 0 }, { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: null }, { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: -1 }]) {
    const u = ADAPTERS['openai.chat_completions'].parseUsage(oai(LUNA, ptd)) as unknown as Record<string, unknown>;
    const v = validateUsage(u as never);
    assert.equal(v.cacheObserved, 'UNKNOWN', JSON.stringify(ptd)); assert.equal(v.cacheWrite, 'UNKNOWN'); assert.equal(v.inputUncached, 'UNKNOWN'); assert.equal(v.U, 'UNKNOWN');
    assert.equal(v.usageCompleteness, 'PARTIAL');
  }
});

test('contrato OpenAI gpt-6-luna: adaptador e validador concordam em todas as formas (escrita, leitura, ausente, zero, null, subset)', () => {
  check('openai.chat_completions', [
    { nome: 'escrita>0 leitura 0', body: oai(LUNA, { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: 4736 }), exp: 'CREATION' },
    { nome: 'escrita>0 leitura>0', body: oai(LUNA, { cached_tokens: 1024, audio_tokens: 0, cache_write_tokens: 2048 }), exp: 'HIT', check: (u) => assert.equal(u['inputUncached'], 4769 - 1024 - 2048) },
    { nome: 'escrita 0 leitura>0', body: oai(LUNA, { cached_tokens: 4608, audio_tokens: 0, cache_write_tokens: 0 }), exp: 'HIT', check: (u) => assert.equal(u['U'], 4769) },
    { nome: 'zero', body: oai(LUNA, { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: 0 }), exp: 'NO_HIT', check: (u) => { assert.equal(u['cacheWrite'], 0); assert.equal(u['U'], 4769); } },
    { nome: 'escrita ausente leitura 0', body: oai(LUNA, { cached_tokens: 0, audio_tokens: 0 }), exp: 'UNKNOWN', check: unk('cacheWrite', 'inputUncached', 'U') },
    { nome: 'escrita ausente leitura>0', body: oai(LUNA, { cached_tokens: 4608, audio_tokens: 0 }), exp: 'HIT', check: unk('cacheWrite', 'U') },
    { nome: 'escrita null leitura 0', body: oai(LUNA, { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: null }), exp: 'UNKNOWN', check: unk('cacheWrite') },
    { nome: 'escrita null leitura>0', body: oai(LUNA, { cached_tokens: 4608, audio_tokens: 0, cache_write_tokens: null }), exp: 'HIT', check: unk('cacheWrite') },
    { nome: 'leitura ausente escrita>0', body: oai(LUNA, { audio_tokens: 0, cache_write_tokens: 4736 }), exp: 'UNKNOWN', check: unk('cacheRead') },
    { nome: 'leitura null escrita 0', body: oai(LUNA, { cached_tokens: null, audio_tokens: 0, cache_write_tokens: 0 }), exp: 'UNKNOWN', check: unk('cacheRead') },
    { nome: 'audio null escrita>0 leitura 0', body: oai(LUNA, { cached_tokens: 0, audio_tokens: null, cache_write_tokens: 4736 }), exp: 'CREATION' },
    { nome: 'subset: escrita > prompt - leitura', body: oai(LUNA, { cached_tokens: 4608, audio_tokens: 0, cache_write_tokens: 4736 }), exp: 'HIT', check: unk('inputUncached', 'U') },
    { nome: 'subset: escrita > prompt, leitura 0', body: oai(LUNA, { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: 9999 }), exp: 'CREATION', check: unk('inputUncached', 'U') },
    { nome: 'subset: leitura > prompt', body: oai(LUNA, { cached_tokens: 9999, audio_tokens: 0, cache_write_tokens: 0 }), exp: 'HIT', check: unk('inputUncached', 'U') },
    { nome: 'prompt_tokens_details ausente', body: oai(LUNA, undefined), exp: 'UNKNOWN', check: unk('cacheRead', 'cacheWrite') },
    { nome: 'prompt_tokens_details null', body: oai(LUNA, null), exp: 'UNKNOWN', check: unk('cacheRead', 'cacheWrite') },
    { nome: 'prompt_tokens ausente', body: oai(LUNA, { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: 4736 }, null), exp: 'CREATION', check: unk('inputUncached', 'U') },
    { nome: 'usage ausente', body: { model: LUNA, service_tier: 'default', choices: [] }, exp: 'UNKNOWN' },
  ]);
});

test('contrato OpenAI gpt-4o-mini (inalterado): sem escrita cobrada; cache_write_tokens, se vier, e ignorado (NOT_APPLICABLE); concordam em todas as formas', () => {
  const na = (u: Record<string, unknown>) => { assert.equal(u['cacheWrite'], 'NOT_APPLICABLE'); assert.equal(u['cacheWrite5m'], 'NOT_APPLICABLE'); assert.equal(u['cacheWrite1h'], 'NOT_APPLICABLE'); };
  check('openai.chat_completions', [
    { nome: 'escrita>0 leitura 0 (campo estranho ao modelo)', body: oai(MINI, { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: 4736 }), exp: 'NO_HIT', check: na },
    { nome: 'leitura>0', body: oai(MINI, { cached_tokens: 4608, audio_tokens: 0 }), exp: 'HIT', check: na },
    { nome: 'zero', body: oai(MINI, { cached_tokens: 0, audio_tokens: 0 }), exp: 'NO_HIT', check: (u) => { na(u); assert.equal(u['U'], 4769); } },
    { nome: 'leitura ausente', body: oai(MINI, { audio_tokens: 0 }), exp: 'UNKNOWN', check: unk('cacheRead', 'inputUncached') },
    { nome: 'leitura null', body: oai(MINI, { cached_tokens: null, audio_tokens: 0 }), exp: 'UNKNOWN', check: unk('cacheRead') },
    { nome: 'subset: leitura > prompt', body: oai(MINI, { cached_tokens: 9999, audio_tokens: 0 }), exp: 'HIT', check: unk('inputUncached', 'U') },
    { nome: 'prompt_tokens_details ausente', body: oai(MINI, undefined), exp: 'UNKNOWN' },
    { nome: 'prompt_tokens_details null', body: oai(MINI, null), exp: 'UNKNOWN' },
    { nome: 'usage ausente', body: { model: MINI, service_tier: 'default', choices: [] }, exp: 'UNKNOWN' },
  ]);
});

const ant = (u: Record<string, unknown>) => ({ model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 100, output_tokens: 50, service_tier: 'standard', ...u } });
const split = (m5: unknown, h1: unknown) => ({ ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 });

test('contrato Anthropic (inalterado): adaptador e validador concordam nas formas documentadas', () => {
  const T = { thinkingRequested: false };
  check('anthropic.messages', [
    { nome: 'escrita 5m>0 leitura 0', body: ant({ cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: split(4000, 0) }), ctx: T, exp: 'CREATION', check: (u) => assert.equal(u['U'], 4100) },
    { nome: 'escrita 1h>0 leitura 0', body: ant({ cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: split(0, 4000) }), ctx: T, exp: 'CREATION' },
    { nome: 'leitura>0', body: ant({ cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, cache_creation: split(0, 0) }), ctx: T, exp: 'HIT' },
    { nome: 'leitura>0 escrita>0', body: ant({ cache_read_input_tokens: 2000, cache_creation_input_tokens: 2000, cache_creation: split(2000, 0) }), ctx: T, exp: 'HIT' },
    { nome: 'zero', body: ant({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: split(0, 0) }), ctx: T, exp: 'NO_HIT', check: (u) => assert.equal(u['U'], 100) },
    { nome: 'split 5m/1h ausente, escrita>0 leitura 0', body: ant({ cache_read_input_tokens: 0, cache_creation_input_tokens: 4000 }), ctx: T, exp: 'UNKNOWN', check: unk('cacheWrite5m', 'cacheWrite1h') },
    { nome: 'split 5m/1h ausente, zero', body: ant({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }), ctx: T, exp: 'UNKNOWN' },
    { nome: 'split 5m/1h ausente, leitura>0', body: ant({ cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }), ctx: T, exp: 'HIT' },
    { nome: 'cache ausente', body: ant({}), ctx: T, exp: 'UNKNOWN', check: unk('cacheRead', 'cacheWrite') },
    { nome: 'leitura ausente, escrita>0', body: ant({ cache_creation_input_tokens: 4000, cache_creation: split(4000, 0) }), ctx: T, exp: 'UNKNOWN', check: unk('cacheRead') },
    { nome: 'so 5m no split', body: ant({ cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: { ephemeral_5m_input_tokens: 4000 } }), ctx: T, exp: 'UNKNOWN' },
    { nome: 'escrita null', body: ant({ cache_read_input_tokens: 0, cache_creation_input_tokens: null, cache_creation: null }), ctx: T, exp: 'UNKNOWN', check: unk('cacheWrite') },
    { nome: 'leitura null', body: ant({ cache_read_input_tokens: null, cache_creation_input_tokens: 0, cache_creation: split(0, 0) }), ctx: T, exp: 'UNKNOWN', check: unk('cacheRead') },
    { nome: 'inconsistente: total 0, split 4000/0', body: ant({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: split(4000, 0) }), ctx: T, exp: 'CREATION' },
    { nome: 'usage ausente', body: { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [] }, ctx: T, exp: 'UNKNOWN' },
  ]);
});

test('contrato Anthropic (inalterado, PINADO fail-closed): formas fora da documentacao ou inconsistentes em que adaptador e validador discordam continuam recusadas (UsageInvalid), nunca aceitas com classe inventada', () => {
  // Achado A1/A2 do OPENAI-R-FIX: discordancia preexistente fora do escopo (Anthropic nao muda neste delta). Se alguem alinhar, este teste
  // deve ser revisto com G15 proprio, nunca afrouxado em silencio.
  for (const [nome, u, ad, uso] of [
    ['escrita total ausente, split presente', { cache_read_input_tokens: 0, cache_creation: split(4000, 0) }, 'CREATION', 'UNKNOWN'],
    ['escrita total ausente, split zero', { cache_read_input_tokens: 0, cache_creation: split(0, 0) }, 'NO_HIT', 'UNKNOWN'],
    ['inconsistente: total 4000, split 0/0', { cache_read_input_tokens: 0, cache_creation_input_tokens: 4000, cache_creation: split(0, 0) }, 'NO_HIT', 'CREATION'],
  ] as const) {
    const p = ADAPTERS['anthropic.messages'].parseUsage(ant(u), { thinkingRequested: false } as never);
    assert.equal(p.cacheObserved, ad, nome); assert.equal(cacheObservedOf(p), uso, nome);
    assert.throws(() => validateUsage(p), (e: unknown) => e instanceof UsageInvalid && /cacheObserved/.test(e.message), nome);
  }
});

const gem = (model: string, cached: unknown, prompt = 4228) => {
  const um: Record<string, unknown> = { promptTokenCount: prompt, candidatesTokenCount: 12, thoughtsTokenCount: 5, totalTokenCount: prompt + 17, promptTokensDetails: [{ modality: 'TEXT', tokenCount: prompt }] };
  if (cached !== undefined) um['cachedContentTokenCount'] = cached;
  return { modelVersion: model, candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: um };
};

test('contrato Google (inalterado): matriz 3.5 e braco 3.1 (textOnly) concordam em todas as formas; leitura ausente nunca vira 0', () => {
  for (const [model, ctx] of [['gemini-3.5-flash-lite', undefined], ['gemini-3.1-flash-lite', { textOnly: true }]] as const) {
    check('gemini.generate_content', [
      { nome: `${model} leitura>0`, body: gem(model, 2032), ctx, exp: 'HIT' },
      { nome: `${model} leitura 0`, body: gem(model, 0), ctx, exp: 'NO_HIT' },
      { nome: `${model} leitura ausente`, body: gem(model, undefined), ctx, exp: 'UNKNOWN', check: unk('cacheRead', 'inputUncached') },
      { nome: `${model} leitura null`, body: gem(model, null), ctx, exp: 'UNKNOWN', check: unk('cacheRead') },
      { nome: `${model} subset: leitura > prompt`, body: gem(model, 9999), ctx, exp: 'HIT', check: unk('inputUncached') },
      { nome: `${model} usageMetadata ausente`, body: { modelVersion: model, candidates: [] }, ctx, exp: 'UNKNOWN' },
    ]);
  }
});
