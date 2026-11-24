// SYNTHETIC — OFFLINE. B2 integration: core/record (BOT-02) + modal adapters and tiered price table (MET-02) + cache ContentStore and
// dialogs (E2E-01). The egress double answers with MET-02's documented response fixtures. No network, no credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createH2EvalExecutor, priceTableFromModal, ADAPTERS, MATRIX_MODELS, contentOf, renderCall, operationIdOf, readSnapshot, type H2EvalExecutorOptions } from '../../../scripts/h2eval/index.js';
import { bodyOf } from '../../../scripts/h2eval/modal/index.js';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { contentHash, createContentStore } from '../../../scripts/h2eval/cache/contentStore.js';
import { canonicalJson, sha256Hex } from '../../../scripts/h2eval/corpus/util.js';
import { H2EVAL_SCHEMA, type OperationPlan, type ResolvedContent } from '../../../scripts/h2eval/types.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const FIX = path.join(ROOT, 'test', 'h2eval', 'modal', 'fixtures');
const CANARY = 'zq-integration-canary-5c1d';
process.env['H2EVAL_ANTHROPIC_API_KEY'] = CANARY; // the R16 name itself; OFFLINE never reads it

type Fx = { httpStatus: number; body: unknown };
const fixture = (file: string, key: string): Fx => (JSON.parse(readFileSync(path.join(FIX, 'responses', `${file}.json`), 'utf8')) as Record<string, Fx>)[key]!;
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-int-${p}-`));
/** Everything the executor writes EXCEPT content/<sha256> (the hash-addressed store holds the text by design; journal/ledger/snapshots/records never do). */
const allText = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).filter((e) => !String(e.parentPath ?? (e as unknown as { path: string }).path).split(/[\\/]/).includes('content')).map((e) => readFileSync(path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name), 'utf8')).join('\n');

const PARAMS = {
  'claude-haiku-5-5': { maxTokens: 64, temperature: 'DEFAULT', reasoning: { effort: 'low' }, serviceTier: 'standard_only', cacheDirectives: 'NONE', thinking: { mode: 'adaptive', effort: 'low' }, cacheTtlRequested: 'NOT_APPLICABLE' },
  'claude-haiku-4-5-20251001': { maxTokens: 64, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'standard_only', cacheDirectives: 'NONE', thinking: { mode: 'none' }, cacheTtlRequested: 'NOT_APPLICABLE' },
  'gpt-4o-mini-2024-07-18': { maxTokens: 64, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'default', cacheDirectives: 'NONE', thinking: { mode: 'none' }, cacheTtlRequested: 'NOT_APPLICABLE' },
  'gemini-3.5-flash-lite': { maxTokens: 64, temperature: 'DEFAULT', reasoning: { thinking_level: 'minimal' }, serviceTier: 'NONE', cacheDirectives: 'NONE', thinking: { mode: 'minimal', thinkingLevel: 'minimal' }, cacheTtlRequested: 'NOT_APPLICABLE' },
} as const satisfies Record<string, OperationPlan['params']>;
const API = { 'claude-haiku-5-5': ['anthropic', 'anthropic.messages'], 'claude-haiku-4-5-20251001': ['anthropic', 'anthropic.messages'], 'gpt-4o-mini-2024-07-18': ['openai', 'openai.chat_completions'], 'gemini-3.5-flash-lite': ['google', 'gemini.generate_content'] } as const;

function plan(model: keyof typeof PARAMS, promptSha256: string, over: Partial<OperationPlan> = {}): OperationPlan {
  const [provider, api] = API[model];
  return { schema: H2EVAL_SCHEMA.plan, studyId: 'h2eval-int', protocolHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), batchId: `b-${model}`, phase: 'PILOT', cellId: 'C1', groupId: 'G1', promptId: 'P1', rep: 1, variant: 'v1', split: 'NONE', provider, api, endpoint: '', modelRequested: model, task: 'summary', sizeBucket: 'S', structure: 'S1', modality: 'text', plannedCacheArm: 'S1', promptSha256, prefixSha256: 'NOT_APPLICABLE', nonce: 'NOT_APPLICABLE', params: PARAMS[model], ...over };
}

function setup(steps: Array<Fx | 'throw'>, over: Partial<H2EvalExecutorOptions> = {}) {
  const dir = tmp('run'); const seen: BuiltRequest[] = [];
  const store = createContentStore(dir);
  const ex = createH2EvalExecutor({
    batchDir: dir, contentStore: store, ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-int', allowedHosts: ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com'], double: async (req) => { seen.push(req); const s = steps.shift(); if (!s) throw new Error('no scripted step'); if (s === 'throw') throw new Error('SYN'); return s; } },
    capPolicy: { inputUpperBoundTokens: () => 2000 }, executorCodeSha: 'c'.repeat(40), ...over,
  });
  return { dir, store, ex, seen };
}
const putText = (store: ReturnType<typeof createContentStore>, text: string) => store.put({ messages: [{ role: 'user', parts: [{ type: 'text', text }] }], prefixMessages: 'NOT_APPLICABLE' });

test('S1 texto, claude-haiku-5-5 via adaptador real (MET-02) + fixture documentada + tabela h2eval-v1 (tier <=100k): custo exato, snapshot com thinking/TTL/folga 1024, sem credencial no pedido', async () => {
  const { dir, store, ex, seen } = setup([fixture('anthropic_messages', 'ok_text_haiku55_thinking')]);
  const sha = putText(store, 'Resuma este manual sintético em três frases.');
  const p = plan('claude-haiku-5-5', sha);
  const r = await ex.run(p);
  assert.deepEqual([r.state, r.stop, seen.length], ['COST_COMPUTED', null, 1]);
  assert.equal(Object.keys(seen[0]!.headers).some((h) => h.toLowerCase() === 'x-api-key'), false);
  const snap = readSnapshot(dir, operationIdOf(p));
  assert.deepEqual([snap.params.thinking, snap.costCap.reasoningAllowanceTokens, snap.costCap.capBasis.cacheWriteTtlUsed, snap.priceSnapshot.id], [{ mode: 'adaptive', effort: 'low' }, 1024, '1h', 'h2eval-v3-2026-11-13']); // C159C E-1: active table v3
  // cap = 2000 × max(0.10, 0.20 [1h write]) + (64 + 1024) × 0.50 USD/MTok = 400_000_000 + 544_000_000 = 944_000_000 pico
  assert.equal(snap.costCap.usd, (2000n * 200_000n + 1088n * 500_000n).toString());
  assert.equal(typeof snap.counter.L0, 'number'); assert.equal(snap.estimateStatus, 'ESTIMATED');
  const rec = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(p)}.json`), 'utf8'));
  // usage fixture: 820 in, 60 out (36 thinking inside) => 820 × 0.10 + 60 × 0.50 = 82_000_000 + 30_000_000 pico
  assert.deepEqual([rec.cost.state, rec.cost.usd, rec.cost.capCovered, rec.usage.modelServed, rec.modelDeprecation, rec.exclusion, rec.usage.cacheObserved], ['CALCULATED', (820n * 100_000n + 60n * 500_000n).toString(), true, 'claude-haiku-5-5', 'ACTIVE', 'NONE', 'NO_HIT']);
  assert.deepEqual([rec.usage.outputVisible, rec.usage.reasoning, rec.cost.byCategory.reasoning], [24, 36, (36n * 500_000n).toString()], 'categorias disjuntas: 24 visíveis + 36 de raciocínio, ambos ao preço de saída');
  assert.equal(ex.ledger.state().providers.anthropic.spentUsd, rec.cost.usd);
});

test('os quatro modelos da matriz: OpenAI e Haiku 4.5 rodam com seus fixtures; Google é NOT_RUN_BRANCH_LOCKED (nada sai); 429 sem uso => UNCERTAIN possivelmente cobrado', async () => {
  // input bound 6000: the ok_cache_creation_5m fixture declares 4 600 cache-write tokens; with the default 2 000 bound the executor correctly raises STOP_CAP_VIOLATION
  const { dir, store, ex, seen } = setup([fixture('openai_chat', 'ok_text'), fixture('anthropic_messages', 'ok_cache_creation_5m'), fixture('anthropic_messages', 'error_429_no_usage')], { capPolicy: { inputUpperBoundTokens: () => 6000 } });
  const sha = putText(store, 'Resuma este manual sintético em três frases.');
  const ro = await ex.run(plan('gpt-4o-mini-2024-07-18', sha));
  const recO = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(plan('gpt-4o-mini-2024-07-18', sha))}.json`), 'utf8'));
  assert.deepEqual([ro.state, recO.cost.state, recO.modelDeprecation, recO.usage.cacheObserved], ['COST_COMPUTED', 'CALCULATED', 'DEPRECATED_SHUTDOWN_2027-01-14', 'NO_HIT']);
  // F-INT-2 CORRIGIDO (R14-FIX 6b6f89f7): Haiku 4.5 sem output_tokens_details e sem thinking => reasoning NOT_APPLICABLE, outputVisible = output_tokens;
  // custo CALCULATED: 120 × 1.00 + 4600 × 1.25 (escrita 5m) + 24 × 5.00 USD/MTok = 120_000_000 + 5_750_000_000 + 120_000_000 pico
  const ra = await ex.run(plan('claude-haiku-4-5-20251001', sha));
  const recA = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(plan('claude-haiku-4-5-20251001', sha))}.json`), 'utf8'));
  assert.deepEqual([ra.state, ra.stop, recA.outcome, recA.usage.cacheObserved, recA.usage.cacheWrite5m, recA.usage.outputVisible, recA.usage.reasoning, recA.cost.state, recA.cost.usd, recA.modelDeprecation], ['COST_COMPUTED', null, 'OK', 'CREATION', 4600, 24, 'NOT_APPLICABLE', 'CALCULATED', (120n * 1_000_000n + 4600n * 1_250_000n + 24n * 5_000_000n).toString(), 'LEGACY']);
  const rg = await ex.run(plan('gemini-3.5-flash-lite', sha));
  assert.deepEqual([rg.state, seen.length, ex.ledger.state().providers.google.reservedUsd], ['NOT_RUN_BRANCH_LOCKED', 2, '0']);
  const r429 = await ex.run(plan('claude-haiku-4-5-20251001', sha, { promptId: 'P2' }));
  const rec429 = JSON.parse(readFileSync(path.join(dir, 'records', `${operationIdOf(plan('claude-haiku-4-5-20251001', sha, { promptId: 'P2' }))}.json`), 'utf8'));
  assert.deepEqual([r429.state, r429.stop, rec429.outcome, rec429.cost.usd, rec429.cost.possiblyCharged, rec429.refusal.code], ['UNCERTAIN', 'STOP_UNCERTAIN', 'ERROR_NO_USAGE', 'UNKNOWN', true, 'rate_limit']);
  assert.doesNotMatch(allText(dir), new RegExp(CANARY)); assert.doesNotMatch(allText(dir), /Resuma este manual/);
});

test('tabela de preços tiered (MET-02) adaptada ao core: tier por comprimento do prompt; null nunca vira 0; modelo fora da matriz => desconhecido', () => {
  const px = priceTableFromModal();
  const at = '2026-11-10T23:00:00.000Z';
  assert.equal(px.micro('anthropic', 'claude-haiku-5-5', 'input', at, 5000), 100_000n);
  assert.equal(px.micro('anthropic', 'claude-haiku-5-5', 'input', at, 150_000), 500_000n, 'tier > 100k');
  assert.equal(px.micro('anthropic', 'claude-haiku-5-5', 'input', at), 100_000n, 'sem dica: tier base');
  assert.equal(px.micro('anthropic', 'claude-haiku-5-5', 'input_cache_write_1h', at, 10), 200_000n);
  assert.equal(px.micro('google', 'gemini-3.5-flash-lite', 'input_cache_write', at, 10), null, 'não publicado => null');
  assert.equal(px.micro('google', 'gemini-3.5-flash-lite', 'input', at, 10), 300_000n, 'tier standard (batch REFERENCE_ONLY nunca usado)');
  assert.equal(px.micro('openai', 'claude-haiku-5-5', 'input', at, 10), null, 'provedor errado');
  assert.equal(px.micro('anthropic', 'sim-haiku', 'input', at, 10), null);
  assert.equal(px.schema, 'otk.h2eval.price_table.v1'); assert.match(px.sha256, /^[0-9a-f]{64}$/);
});

test('imagem (PNG sintético do MET-02) via ContentStore (E2E-01): bytes resolvidos por hash só para o adaptador; L0 UNKNOWN + fórmula exploratória anthropic_28px; base64 nunca em journal/snapshot/registro', async () => {
  const { dir, store, ex, seen } = setup([fixture('anthropic_messages', 'ok_text_haiku55_thinking')]);
  const png = readFileSync(path.join(FIX, 'images', 'synthetic_200x200_flat.png'));
  const bsha = store.putBytes(new Uint8Array(png));
  const messages = [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'descreva' }, { type: 'image' as const, mime: 'image/png', bytesSha256: bsha, width: 200, height: 200 }] }];
  const sha = store.put({ messages: messages as unknown as Parameters<typeof store.put>[0]['messages'], prefixMessages: 'NOT_APPLICABLE' });
  assert.equal(sha, contentHash({ messages: messages as never, prefixMessages: 'NOT_APPLICABLE' }));
  const p = plan('claude-haiku-5-5', sha, { modality: 'image', phase: 'EXPLORATORY_MODALITY' });
  const r = await ex.run(p);
  assert.equal(r.state, 'COST_COMPUTED');
  const b64 = png.toString('base64');
  assert.ok(JSON.stringify(seen[0]!.body).includes(b64.slice(0, 64)), 'o adaptador recebeu os bytes');
  const snap = readSnapshot(dir, operationIdOf(p));
  assert.deepEqual([snap.counter.L0, snap.estimateStatus, snap.counter.exploratoryFormulaEstimate?.formula, snap.counter.exploratoryFormulaEstimate?.tokens], ['UNKNOWN', 'UNSUPPORTED_FOR_ESTIMATION', 'anthropic_28px', 64]);
  assert.doesNotMatch(allText(path.join(dir, 'snapshots')) + allText(path.join(dir, 'records')) + readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), new RegExp(b64.slice(0, 32)));
});

test('F-INT-1 FECHADO: corpo do adaptador (fonte única, bodyOf) == corpo de referência renderCall (derivado) == canon do core, nos 4 modelos; S2 e S3; o canon do core e o canonicalJson do modal coincidem', () => {
  const fx0 = JSON.parse(readFileSync(path.join(ROOT, 'test', 'h2eval', 'cache', 'fixtures', 'dialogs.testseed.json'), 'utf8')) as { dialogs: Array<{ dialog: Parameters<typeof contentOf>[0] }> };
  for (const arm of ['S3_HITATTEMPT', 'S2_NOHIT'] as const) {
    const d0 = fx0.dialogs.find((x) => x.dialog.arm === arm)!.dialog;
    for (const call of [1, 2, 3] as const) {
      const c0 = contentOf(d0, call) as unknown as ResolvedContent;
      for (const model of MATRIX_MODELS.filter((m) => !/^claude-(sonnet|opus)-5-5$/.test(m))) { // the 4 legacy models: the pilot models (C157 §9.2) have no S2/S3 dialogs
        const provider = API[model][0];
        const pl = plan(model, c0.promptSha256, { structure: arm === 'S2_NOHIT' ? 'S2' : 'S3', plannedCacheArm: arm, prefixSha256: d0.prefixSha256, nonce: arm === 'S2_NOHIT' ? d0.nonces[call - 1]! : 'NOT_APPLICABLE', params: { ...PARAMS[model], ...(arm === 'S3_HITATTEMPT' && provider === 'anthropic' ? { cacheDirectives: { cache_control: 'ephemeral', ttl: '5m' as const }, cacheTtlRequested: '5m' as const } : {}) } });
        const sent = ADAPTERS[pl.api]!.buildRequest(pl, c0).body;
        const derived = bodyOf(pl as never, c0 as never);
        const ref = renderCall(d0, call, { provider, model, maxOutputTokens: 64, serviceTier: PARAMS[model].serviceTier === 'NONE' ? undefined : PARAMS[model].serviceTier, anthropicCacheTtl: '5m' });
        assert.equal(sha256Canon(sent), derived.bodySha256, `${model} ${arm} call ${call}: canon do core == canonicalJson do modal`);
        assert.equal(ref.bodySha256, derived.bodySha256, `${model} ${arm} call ${call}: referência renderCall == corpo enviado`);
        assert.equal(sha256Hex(canonicalJson(ref.body)), derived.bodySha256);
      }
    }
  }
});

test('F-INT-1 (histórico): as divergências que existiam antes do R14-FIX não existem mais (normalização antiga vira identidade)', () => {
  const fx = JSON.parse(readFileSync(path.join(ROOT, 'test', 'h2eval', 'cache', 'fixtures', 'dialogs.testseed.json'), 'utf8')) as { dialogs: Array<{ dialog: Parameters<typeof contentOf>[0] }> };
  const d = fx.dialogs.find((x) => x.dialog.arm === 'S3_HITATTEMPT')!.dialog;
  const c = contentOf(d, 2) as unknown as ResolvedContent;
  const cases = [
    { model: 'claude-haiku-4-5-20251001' as const, over: { params: { ...PARAMS['claude-haiku-4-5-20251001'], cacheDirectives: { cache_control: 'ephemeral', ttl: '5m' }, cacheTtlRequested: '5m' as const } }, ro: { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', maxOutputTokens: 64, serviceTier: 'standard_only', anthropicCacheTtl: '5m' as const } },
    { model: 'gpt-4o-mini-2024-07-18' as const, over: {}, ro: { provider: 'openai' as const, model: 'gpt-4o-mini-2024-07-18', maxOutputTokens: 64, serviceTier: 'default' } },
    { model: 'gemini-3.5-flash-lite' as const, over: {}, ro: { provider: 'google' as const, model: 'gemini-3.5-flash-lite', maxOutputTokens: 64 } },
  ];
  const diffs: Record<string, string[]> = {};
  for (const k of cases) {
    const p = plan(k.model, c.promptSha256, { structure: 'S3', plannedCacheArm: 'S3_HITATTEMPT', prefixSha256: d.prefixSha256, ...k.over });
    const body = ADAPTERS[p.api]!.buildRequest(p, c).body as Record<string, unknown>;
    const ref = renderCall(d, 2, k.ro).body;
    assert.equal(sha256Hex(canonicalJson(body)), sha256Hex(canonicalJson(ref)), `${k.model}: idênticos após o R14-FIX`);
    const a = structuredClone(body) as Record<string, unknown>;
    if (k.ro.provider === 'anthropic') { assert.ok(Array.isArray(a['system']), 'system como bloco'); assert.deepEqual(((a['system'] as Array<Record<string, unknown>>)[0]!['cache_control']), { type: 'ephemeral' }, 'breakpoint no bloco de sistema'); assert.equal(a['stream'], false); assert.equal(JSON.stringify(a['messages']).includes('cache_control'), false, 'nenhum breakpoint nas mensagens'); }
    else if (k.ro.provider === 'openai') { assert.equal(a['max_completion_tokens'], 64); assert.equal(a['n'], undefined); assert.equal(typeof (a['messages'] as Array<{ content: unknown }>)[1]!.content, 'string'); }
    else { const gc = a['generationConfig'] as Record<string, unknown>; assert.equal(gc['candidateCount'], undefined); assert.deepEqual(gc['thinkingConfig'], { thinkingLevel: 'MINIMAL' }); }
    diffs[k.model] = [];
  }
  assert.equal(Object.keys(diffs).length, 3);
});

test('matriz exportada e adaptadores com modelDeprecation (R2 item 10)', () => {
  assert.deepEqual([...MATRIX_MODELS], ['gpt-4o-mini-2024-07-18', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gemini-3.5-flash-lite']);
  assert.equal(ADAPTERS['anthropic.messages']!.modelDeprecation!('claude-haiku-5-5'), 'ACTIVE');
  assert.equal(ADAPTERS['openai.chat_completions']!.modelDeprecation!('gpt-4o-mini-2024-07-18'), 'DEPRECATED_SHUTDOWN_2027-01-14');
  assert.equal(ADAPTERS['anthropic.messages']!.modelDeprecation!('other-id'), 'UNKNOWN');
});
