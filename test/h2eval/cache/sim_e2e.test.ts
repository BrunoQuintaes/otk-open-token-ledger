/**
 * End-to-end offline simulation of the cache study: rendered dialogs go through simulated provider caches, and the
 * returned usage is classified, diagnosed, priced and fed to the planner.
 *
 * Modules under test: `scripts/h2eval/cache/classify.ts`, `scripts/h2eval/cache/costInterval.ts`,
 * `scripts/h2eval/cache/dialogs.ts` and `scripts/h2eval/cache/planner.ts`, driven by the `SimProvider` doubles in
 * `./doubles.ts`.
 *
 * Strategy / scenarios: hit-attempt dialogs inside the TTL for each provider; no-hit control dialogs; isolation
 * between dialogs; TTL expiry after a 400-second gap and the 1-hour TTL that survives it; a provider that ignores
 * the cache mark; a prefix below the provider minimum; a partial hit; a response without usage; a contaminated
 * control whose nonce does not break the prefix; the paired token audit of control against hit-attempt; the ex-ante
 * cost interval covering the observed cost in every scenario; the pilot-to-planner pipeline; and no cross-provider
 * false hits.
 *
 * Needs: nothing external (simulated time in seconds, no network, no real tokenizer).
 *
 * Run just this file: `npx tsx --test test/h2eval/cache/sim_e2e.test.ts`
 *
 * @module test/h2eval/cache/sim_e2e.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCache, diagnose, resolveArm, summarizeDialog, type CacheObservation, type Observed, type Provider } from '../../../scripts/h2eval/cache/classify.js';
import { costFromObservation, costInterval, inInterval, R08_PRICES } from '../../../scripts/h2eval/cache/costInterval.js';
import { checkTtl, controlOf, MIN_PREFIX_TOKENS, renderDialog, type Dialog, type RenderOptions } from '../../../scripts/h2eval/cache/dialogs.js';
import { planCacheArm } from '../../../scripts/h2eval/cache/planner.js';
import { SimProvider, type SimConfig } from './doubles.js';
import { defaultBuild, TEST_SEED } from './helpers.js';

const PROVS: Provider[] = ['openai', 'anthropic', 'google'];
const MODEL: Record<Provider, string> = { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-4-5', google: 'gemini-3.5-flash-lite' };
const MIN: Record<Provider, number> = { openai: 1024, anthropic: 4096, google: 1024 };
const ropts = (p: Provider): RenderOptions => ({ provider: p, model: MODEL[p], maxOutputTokens: 24 });
const dialogs = () => defaultBuild().dialogs;
const s3 = (i = 0): Dialog => dialogs().filter((d) => d.arm === 'S3_HITATTEMPT' && d.phase === 'CONFIRMATORY')[i]!;
const s2 = (i = 0): Dialog => dialogs().filter((d) => d.arm === 'S2_NOHIT' && d.phase === 'CONFIRMATORY')[i]!;
const prefixTokens = (d: Dialog): number => Math.ceil(d.prefix.length / 4);

interface Step { obs: CacheObservation; usage: unknown; bodyTokens: number }
function run(p: Provider, d: Dialog, cfg: Partial<SimConfig> = {}, gaps?: number[], sim?: SimProvider): { steps: Step[]; sim: SimProvider } {
  const s = sim ?? new SimProvider({ provider: p, minPrefixTokens: MIN[p], ttlSeconds: 300, ...cfg });
  const offs = checkTtl(p, { gapsSeconds: gaps }).offsetsSeconds; const base = sim ? Math.max(0, ...sim.calls.map((c) => c.at)) + 1 : 0;
  const steps = renderDialog(d, ropts(p)).map((c, i) => { const usage = s.send(c.body, base + offs[i]!); return { usage, obs: classifyCache(p, usage), bodyTokens: 0 }; });
  return { steps, sim: s };
}
const seq = (st: Step[]): Observed[] => st.map((x) => x.obs.observed);

test('S3 dentro do TTL: Anthropic [CREATION,HIT,HIT]; OpenAI e Gemini [NO_HIT,HIT,HIT] (sem escrita reportada); leitura = prefixo cacheado', () => {
  const a = run('anthropic', s3()); assert.deepEqual(seq(a.steps), ['CREATION', 'HIT', 'HIT']);
  assert.equal(a.steps[0]!.obs.cacheWrite, prefixTokens(s3())); assert.equal(a.steps[1]!.obs.cacheRead, prefixTokens(s3())); assert.equal(a.steps[2]!.obs.cacheRead, prefixTokens(s3()));
  const o = run('openai', s3()); assert.deepEqual(seq(o.steps), ['NO_HIT', 'HIT', 'HIT']);
  for (const k of [1, 2]) { const r = o.steps[k]!.obs.cacheRead as number; assert.equal(r % 128, 0); assert.ok(r > 0 && r <= prefixTokens(s3()) + 20); assert.deepEqual(o.steps[k]!.obs.flags, []); }
  const g = run('google', s3()); assert.deepEqual(seq(g.steps), ['NO_HIT', 'HIT', 'HIT']); for (const k of [1, 2]) assert.equal((g.steps[k]!.obs.cacheRead as number) % 16, 0);
  for (const r of [a, o, g]) assert.ok(r.steps.every((x) => x.obs.totalInput !== 'UNKNOWN'));
});

test('S2 (controle com nonce): NO_HIT nas 3 chamadas em todos os provedores, e o braço fica S2_NOHIT (não contaminado)', () => {
  for (const p of PROVS) { const r = run(p, s2()); assert.deepEqual(seq(r.steps), ['NO_HIT', 'NO_HIT', 'NO_HIT'], p); assert.ok(r.steps.every((x) => { const a = resolveArm('S2_NOHIT', x.obs.observed); return a.finalArm === 'S2_NOHIT' && !a.controlContaminated; })); }
  // dois controles diferentes na mesma conta: também sem hit entre diálogos
  for (const p of PROVS) { const r1 = run(p, s2(0)); const r2 = run(p, s2(1), {}, undefined, r1.sim); assert.deepEqual(seq(r2.steps), ['NO_HIT', 'NO_HIT', 'NO_HIT'], p); }
});

test('isolamento entre diálogos: o 1º pedido de outro diálogo S3 não reaproveita o cache do anterior (prefixo único)', () => {
  for (const p of PROVS) { const r1 = run(p, s3(0)); const r2 = run(p, s3(1), {}, undefined, r1.sim); assert.equal(r2.steps[0]!.obs.observed, p === 'anthropic' ? 'CREATION' : 'NO_HIT', p); assert.deepEqual(seq(r2.steps).slice(1), ['HIT', 'HIT']); }
});

test('expiração de TTL: lacuna de 400 s entre as chamadas 2 e 3 => a chamada 3 perde o hit (Anthropic recria; OpenAI/Gemini sem hit); 1h mantém', () => {
  const a = run('anthropic', s3(), {}, [20, 400]); assert.deepEqual(seq(a.steps), ['CREATION', 'HIT', 'CREATION']);
  assert.equal(checkTtl('anthropic', { gapsSeconds: [20, 400] }).withinTtl, false); // o plano de intervalo também acusa
  for (const p of ['openai', 'google'] as Provider[]) assert.deepEqual(seq(run(p, s3(), {}, [20, 400]).steps), ['NO_HIT', 'HIT', 'NO_HIT'], p);
  const first = run('anthropic', s3(), {}, [400, 20]); assert.deepEqual(seq(first.steps), ['CREATION', 'CREATION', 'HIT']);
});

test('TTL de 1 h pedido ao Anthropic: a escrita aparece em ephemeral_1h e o hit sobrevive a 400 s', () => {
  const d = s3(); const sim = new SimProvider({ provider: 'anthropic', minPrefixTokens: 4096, ttlSeconds: 300 });
  const calls = renderDialog(d, { ...ropts('anthropic'), anthropicCacheTtl: '1h' }); const offs = [0, 20, 420];
  const obs = calls.map((c, i) => classifyCache('anthropic', sim.send(c.body, offs[i]!)));
  assert.deepEqual(obs.map((o) => o.observed), ['CREATION', 'HIT', 'HIT']); assert.equal(obs[0]!.cacheWrite1h, prefixTokens(d)); assert.equal(obs[0]!.cacheWrite5m, 0);
});

test('provedor que IGNORA a marcação: [NO_HIT x3] e o diagnóstico acusa MARKED_BUT_NOT_APPLIED (a flag não conta, o usage conta)', () => {
  const r = run('anthropic', s3(), { ignoreMarks: true }); assert.deepEqual(seq(r.steps), ['NO_HIT', 'NO_HIT', 'NO_HIT']);
  const calls = renderDialog(s3(), ropts('anthropic')); assert.equal(calls[0]!.cacheDirective.kind, 'cache_control'); // a intenção era cachear
  assert.deepEqual(diagnose({ cacheDirective: calls[0]!.cacheDirective.kind, estimatedPrefixTokens: prefixTokens(s3()), minPrefixTokens: 4096 }, r.steps[1]!.obs), ['MARKED_BUT_NOT_APPLIED']);
  assert.ok(r.steps.every((x) => resolveArm('S3_HITATTEMPT', x.obs.observed).finalArm === 'S3_NO_HIT' && resolveArm('S3_HITATTEMPT', x.obs.observed).kept));
});

test('prefixo abaixo do mínimo do provedor: sem escrita nem leitura, sem erro; diagnóstico cita o mínimo documentado', () => {
  const r = run('anthropic', s3(), { minPrefixTokens: 6000 }); assert.deepEqual(seq(r.steps), ['NO_HIT', 'NO_HIT', 'NO_HIT']);
  assert.deepEqual(diagnose({ cacheDirective: 'cache_control', estimatedPrefixTokens: prefixTokens(s3()), minPrefixTokens: 6000 }, r.steps[1]!.obs), ['MARKED_BUT_NOT_APPLIED', 'PREFIX_BELOW_DOCUMENTED_MINIMUM']);
  assert.deepEqual(seq(run('openai', s3(), { minPrefixTokens: 10_000 }).steps), ['NO_HIT', 'NO_HIT', 'NO_HIT']); // mínimo do automático acima do prefixo
  assert.equal(MIN_PREFIX_TOKENS['gpt-4o-mini']!.tokens, null); // mínimo real do gpt-4o-mini: NOT_VERIFIED (o dublê usa 1024 só como parâmetro)
});

test('hit PARCIAL: HIT com fração < 1, sinalizado pelo diagnóstico (e a taxa por provedor é uma estatística, não um lote de falhas)', () => {
  const g = run('google', s3(), { partialFraction: 0.5 }); assert.deepEqual(seq(g.steps), ['NO_HIT', 'HIT', 'HIT']);
  const frac = g.steps[1]!.obs.hitFraction as number; assert.ok(frac > 0.3 && frac < 0.7);
  assert.deepEqual(diagnose({ cacheDirective: 'automatic', estimatedPrefixTokens: prefixTokens(s3()) }, g.steps[1]!.obs), ['PARTIAL_HIT']);
  const o = run('openai', s3(), { partialFraction: 0.5 }); assert.equal(o.steps[1]!.obs.observed, 'HIT'); assert.deepEqual(diagnose({ cacheDirective: 'automatic', estimatedPrefixTokens: prefixTokens(s3()) }, o.steps[1]!.obs), ['PARTIAL_HIT']);
});

test('resposta SEM uso: UNKNOWN (nem hit nem miss), fora da taxa, contado à parte; piloto só com UNKNOWN => INSUFFICIENT_PILOT', () => {
  for (const p of PROVS) { const r = run(p, s3(), { noUsage: true }); assert.deepEqual(seq(r.steps), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']); const s = summarizeDialog(r.steps.map((x) => x.obs)); assert.deepEqual([s.hitEligibleCalls, s.hits, s.unknowns], [0, 0, 3]); assert.equal(planCacheArm({ model: p, hits: s.hits, attempts: s.hitEligibleCalls }).status, 'INSUFFICIENT_PILOT'); }
});

test('controle CONTAMINADO (o provedor normaliza o início e o nonce não quebra o prefixo): S2 observa HIT => S2_HIT_CONTAMINATED, registrado', () => {
  for (const p of ['openai', 'google'] as Provider[]) { const r = run(p, s2(), { stripNonce: true }); assert.deepEqual(seq(r.steps), ['NO_HIT', 'HIT', 'HIT'], p); const a = resolveArm('S2_NOHIT', r.steps[1]!.obs.observed); assert.equal(a.finalArm, 'S2_HIT_CONTAMINATED'); assert.equal(a.controlContaminated, true); assert.equal(a.kept, true); }
});

test('auditoria S2 x S3 pareados: mesmo conteúdo, a diferença de tokens vem só do nonce (pequena e positiva), medida no total de entrada observado', () => {
  for (const p of PROVS) {
    const d = s3(); const ctl = controlOf(d, TEST_SEED);
    const a = run(p, d, { minPrefixTokens: 99_999 }); const b = run(p, ctl, { minPrefixTokens: 99_999 }); // cache desligado nos dois: só compara tokens
    for (let k = 0; k < 3; k++) { const x = a.steps[k]!.obs.totalInput as number; const y = b.steps[k]!.obs.totalInput as number; assert.ok(y > x && y - x <= 10, `${p} chamada ${k + 1}: ${y - x}`); }
  }
});

test('intervalo de custo ex ante cobre o custo observado em TODOS os cenários (hit, miss, criação, expiração, parcial); hit < miss', () => {
  const scenarios: Array<{ name: string; p: Provider; cfg?: Partial<SimConfig>; gaps?: number[]; d: Dialog }> = [
    ...PROVS.map((p) => ({ name: `${p} S3`, p, d: s3() })), ...PROVS.map((p) => ({ name: `${p} S2`, p, d: s2() })),
    { name: 'anthropic expiração', p: 'anthropic', gaps: [20, 400], d: s3() }, { name: 'gemini parcial', p: 'google', cfg: { partialFraction: 0.5 }, d: s3() }, { name: 'openai parcial', p: 'openai', cfg: { partialFraction: 0.5 }, d: s3() },
    { name: 'anthropic marca ignorada', p: 'anthropic', cfg: { ignoreMarks: true }, d: s3() },
  ];
  for (const sc of scenarios) {
    const prices = R08_PRICES[MODEL[sc.p]]!; const r = run(sc.p, sc.d, sc.cfg, sc.gaps);
    r.steps.forEach((st, i) => {
      const total = st.obs.totalInput as number; const out = (r.sim.calls[i]!.usage as { output_tokens?: number; completion_tokens?: number; candidatesTokenCount?: number });
      const outTok = out.output_tokens ?? out.completion_tokens ?? out.candidatesTokenCount!;
      const iv = costInterval({ provider: sc.p, prices, inputTokensLow: total, inputTokensHigh: total, prefixTokens: prefixTokens(sc.d), outputTokensLow: 0, outputTokensHigh: 24 });
      const actual = costFromObservation(st.obs, outTok, prices); assert.notEqual(actual, 'UNKNOWN'); assert.equal(inInterval(actual, iv), true, `${sc.name} chamada ${i + 1}`);
    });
  }
  const p = 'anthropic'; const r = run(p, s3()); const pr = R08_PRICES[MODEL[p]]!;
  const c = r.steps.map((st) => costFromObservation(st.obs, 24, pr) as bigint); assert.ok(c[1]! < c[0]!, 'hit mais barato que a criação'); assert.ok(c[2]! < c[0]!);
  const miss = run(p, s2()).steps.map((st) => costFromObservation(st.obs, 24, pr) as bigint); assert.ok(c[1]! < miss[1]!, 'hit mais barato que sem hit');
});

test('pipeline piloto -> planejador: 3 diálogos S3 por provedor viram taxa de hit (chamadas 2 e 3) e o número de diálogos do braço', () => {
  for (const p of PROVS) {
    let hits = 0; let attempts = 0;
    const sim = new SimProvider({ provider: p, minPrefixTokens: MIN[p], ttlSeconds: 300 });
    for (const d of dialogs().filter((x) => x.phase === 'PILOT' && x.arm === 'S3_HITATTEMPT')) { const r = run(p, d, {}, undefined, sim); const s = summarizeDialog(r.steps.map((x) => x.obs)); hits += s.hits; attempts += s.hitEligibleCalls; }
    assert.equal(attempts, 6); assert.equal(hits, 6);
    const plan = planCacheArm({ model: MODEL[p], hits, attempts }); assert.equal(plan.status, 'PLANNED'); assert.ok((plan.dialogs as number) >= 15 && (plan.dialogs as number) <= 40);
  }
  // provedor que ignora o cache no piloto: taxa 0/6 => NOT_RUN com a taxa registrada
  const sim = new SimProvider({ provider: 'anthropic', minPrefixTokens: 4096, ttlSeconds: 300, ignoreMarks: true }); let h = 0; let a = 0;
  for (const d of dialogs().filter((x) => x.phase === 'PILOT' && x.arm === 'S3_HITATTEMPT')) { const s = summarizeDialog(run('anthropic', d, {}, undefined, sim).steps.map((x) => x.obs)); h += s.hits; a += s.hitEligibleCalls; }
  const plan = planCacheArm({ model: 'claude-haiku-4-5', hits: h, attempts: a }); assert.equal(plan.status, 'NOT_RUN'); assert.equal(plan.pHat, 0);
});

test('sem mistura de provedores: cada dublê só lê o formato da sua API (um corpo de outra API não produz um hit falso)', () => {
  const calls = renderDialog(s3(), ropts('openai'));
  assert.throws(() => new SimProvider({ provider: 'anthropic', minPrefixTokens: 4096, ttlSeconds: 300 }).send(calls[0]!.body, 0));
});
