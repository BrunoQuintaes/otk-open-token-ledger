import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditNonceTokens, checkTtl, controlOf, MIN_PREFIX_TOKENS, nonceOf, renderCall, renderDialog, TTL_ASSUMED, type Dialog, type Provider, type RenderOptions } from '../../../scripts/h2eval/cache/dialogs.js';
import { canonicalJson, sha256Hex } from '../../../scripts/h2eval/corpus/util.js';
import { defaultBuild, loadCounters, TEST_SEED } from './helpers.js';

const opts = (provider: Provider, extra: Partial<RenderOptions> = {}): RenderOptions => ({ provider, model: { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-4-5', google: 'gemini-3.5-flash-lite' }[provider], maxOutputTokens: 24, ...extra });
const s3 = (): Dialog => defaultBuild().dialogs.find((d) => d.arm === 'S3_HITATTEMPT' && d.phase === 'CONFIRMATORY')!;
const s2 = (): Dialog => defaultBuild().dialogs.find((d) => d.arm === 'S2_NOHIT' && d.phase === 'CONFIRMATORY')!;
const firstText = (b: Record<string, unknown>, p: Provider): string => {
  if (p === 'openai') return (b['messages'] as Array<{ role: string; content: string }>)[0]!.content; // mensagem de sistema = prefixo
  if (p === 'anthropic') return (b['system'] as Array<{ text: string }>).map((x) => x.text).join('\n');
  return (b['systemInstruction'] as { parts: Array<{ text: string }> }).parts[0]!.text;
};

test('3 turnos; a chamada k leva os turnos 1..k e as k-1 respostas ROTEIRIZADAS (histórico independe do modelo)', () => {
  const d = s3(); assert.equal(d.turns.length, 3); assert.ok(d.turns[0]!.assistant && d.turns[1]!.assistant); assert.equal(d.turns[2]!.assistant, null);
  for (const p of ['openai', 'anthropic', 'google'] as Provider[]) {
    const calls = renderDialog(d, opts(p));
    const nMsgs = (b: Record<string, unknown>) => ((b['messages'] ?? b['contents']) as unknown[]).length;
    assert.deepEqual(calls.map((c) => nMsgs(c.body)), p === 'openai' ? [2, 4, 6] : [1, 3, 5], p); // OpenAI leva o sistema dentro de messages
    assert.ok(JSON.stringify(calls[2]!.body).includes(d.turns[0]!.assistant!) && JSON.stringify(calls[2]!.body).includes(d.turns[1]!.assistant!));
    assert.ok(!JSON.stringify(calls[2]!.body).includes('undefined'));
  }
});

test('S3: o prefixo (e a 1ª mensagem inteira) é idêntico nas 3 chamadas e nos 3 provedores; sem nonce', () => {
  const d = s3();
  for (const p of ['openai', 'anthropic', 'google'] as Provider[]) {
    const calls = renderDialog(d, opts(p)); const f = calls.map((c) => firstText(c.body, p));
    assert.equal(new Set(f).size, 1, p); assert.ok(f[0]!.startsWith(d.prefix.slice(0, 200)));
    assert.ok(calls.every((c) => c.nonce === null && c.sentPrefixSha256 === d.prefixSha256 && c.prefixSha256 === d.prefixSha256));
  }
});

test('S2: nonce único no INÍCIO de cada chamada (também nos turnos seguintes), de largura fixa, único no estudo todo', () => {
  const all = defaultBuild().dialogs.filter((d) => d.arm === 'S2_NOHIT'); const seen = new Set<string>();
  for (const d of all) for (const p of ['openai', 'anthropic', 'google'] as Provider[]) {
    const calls = renderDialog(d, opts(p));
    for (const c of calls) { assert.match(c.nonce!, /^[0-9a-f]{16}$/); assert.ok(firstText(c.body, p).startsWith(`[ref ${c.nonce}]\n`), 'nonce no início'); assert.notEqual(c.sentPrefixSha256, d.prefixSha256); }
    assert.equal(new Set(calls.map((c) => firstText(c.body, p))).size, 3, 'a 1ª mensagem muda a cada chamada');
  }
  for (const d of all) for (const n of d.nonces) { assert.ok(!seen.has(n), 'nonce repetido'); seen.add(n); }
  assert.equal(seen.size, all.length * 3);
  assert.equal(nonceOf(TEST_SEED, 'S2-d00', 1), nonceOf(TEST_SEED, 'S2-d00', 1)); assert.notEqual(nonceOf(TEST_SEED, 'S2-d00', 1), nonceOf(TEST_SEED, 'S2-d00', 2));
});

test('cache_control: só Anthropic em S3, só no bloco do prefixo; ausente em S2 e em OpenAI/Gemini; ttl 1h opcional', () => {
  const marks = (x: unknown): number => (JSON.stringify(x).match(/cache_control/g) ?? []).length;
  const a3 = renderDialog(s3(), opts('anthropic')); const a2 = renderDialog(s2(), opts('anthropic'));
  for (const c of a3) {
    const sys = c.body['system'] as Array<Record<string, unknown>>;
    assert.equal(marks(c.body), 1); assert.deepEqual(sys[0]!['cache_control'], { type: 'ephemeral' }); assert.equal(sys.length, 1);
    assert.deepEqual(c.cacheDirective, { kind: 'cache_control', ttl: '5m' });
  }
  assert.ok(a2.every((c) => marks(c.body) === 0 && c.cacheDirective.kind === 'none'));
  const h1 = renderCall(s3(), 2, opts('anthropic', { anthropicCacheTtl: '1h' })); assert.deepEqual((h1.body['system'] as Array<{ cache_control?: unknown }>)[0]!.cache_control, { type: 'ephemeral', ttl: '1h' });
  for (const p of ['openai', 'google'] as Provider[]) { assert.ok(renderDialog(s3(), opts(p)).every((c) => marks(c.body) === 0 && c.cacheDirective.kind === 'automatic')); assert.ok(renderDialog(s2(), opts(p)).every((c) => c.cacheDirective.kind === 'none')); }
});

test('corpo determinístico e pré-registrável: sha256 do corpo = sha256 do JSON canônico; estável entre renderizações', () => {
  const d = s3();
  for (const p of ['openai', 'anthropic', 'google'] as Provider[]) {
    const a = renderDialog(d, opts(p)); const b = renderDialog(d, opts(p));
    assert.deepEqual(a.map((c) => c.bodySha256), b.map((c) => c.bodySha256)); assert.ok(a.every((c) => c.bodySha256 === sha256Hex(canonicalJson(c.body))));
    assert.equal(new Set(a.map((c) => c.bodySha256)).size, 3);
  }
});

test('parâmetros por API (corpo derivado do adaptador, R14-FIX): OpenAI max_completion_tokens; service_tier só quando pedido; Gemini thinkingLevel MINIMAL; stream:false, sem ferramentas', () => {
  const d = s3();
  const o1 = renderCall(d, 1, opts('openai')).body; assert.equal(o1['max_completion_tokens'], 24); assert.equal(o1['max_tokens'], undefined); assert.equal(o1['service_tier'], undefined);
  const o2 = renderCall(d, 1, opts('openai', { openaiTokenParam: 'max_completion_tokens', serviceTier: 'default' })).body; assert.equal(o2['max_completion_tokens'], 24); assert.equal(o2['max_tokens'], undefined); assert.equal(o2['service_tier'], 'default');
  assert.equal(renderCall(d, 1, opts('anthropic', { serviceTier: 'standard_only' })).body['service_tier'], 'standard_only');
  assert.deepEqual((renderCall(d, 1, opts('google')).body['generationConfig'] as Record<string, unknown>)['thinkingConfig'], { thinkingLevel: 'MINIMAL' });
  for (const p of ['openai', 'anthropic', 'google'] as Provider[]) { const b = renderCall(d, 3, opts(p)).body; assert.ok(!/"tools"/.test(JSON.stringify(b)), 'sem ferramentas'); if (p !== 'google') assert.equal(b['stream'], false); }
});

test('controle pareado: mesmo conteúdo do S3, só o nonce muda; a diferença de tokens do nonce é auditada (pequena e estável) e UNKNOWN sem contador', () => {
  const d = s3(); const ctl = controlOf(d, TEST_SEED);
  assert.equal(ctl.arm, 'S2_NOHIT'); assert.equal(ctl.prefix, d.prefix); assert.deepEqual(ctl.turns, d.turns); assert.equal(ctl.nonces.length, 3);
  const c = loadCounters();
  for (const enc of ['o200k_base', 'cl100k_base'] as const) {
    const audit = auditNonceTokens(ctl, c[enc]); assert.equal(audit.length, 3);
    for (const a of audit) { assert.ok(typeof a.delta === 'number' && a.delta > 0 && a.delta <= 25, `${enc} delta ${String(a.delta)}`); }
    const ds = audit.map((a) => a.delta as number); assert.ok(Math.max(...ds) - Math.min(...ds) <= 4, 'delta estável entre chamadas (largura fixa)');
  }
  assert.ok(auditNonceTokens(ctl, null).every((a) => a.delta === 'UNKNOWN' && a.tokensWith === 'UNKNOWN'));
  assert.throws(() => auditNonceTokens(s3(), c.o200k_base));
});

test('intervalo dentro do TTL: padrão 20 s << TTL; lacuna longa fora; Gemini TTL NOT_VERIFIED; mínimos de prefixo do R08 (gpt-4o-mini e gemini = null)', () => {
  for (const p of ['openai', 'anthropic', 'google'] as Provider[]) { const t = checkTtl(p); assert.deepEqual(t.offsetsSeconds, [0, 20, 40]); assert.equal(t.withinTtl, true); }
  assert.equal(checkTtl('anthropic', { gapsSeconds: [20, 400] }).withinTtl, false); assert.equal(checkTtl('anthropic', { gapsSeconds: [20, 400], ttlSeconds: 3600 }).withinTtl, true);
  assert.equal(checkTtl('google').ttlStatus, 'NOT_VERIFIED'); assert.equal(TTL_ASSUMED.anthropic.status, 'DOCUMENTED');
  assert.equal(MIN_PREFIX_TOKENS['claude-haiku-4-5']!.tokens, 4096); assert.equal(MIN_PREFIX_TOKENS['claude-haiku-5-5']!.tokens, 512);
  assert.equal(MIN_PREFIX_TOKENS['gpt-4o-mini']!.tokens, null); assert.equal(MIN_PREFIX_TOKENS['gemini-3.5-flash-lite']!.status, 'NOT_VERIFIED');
  assert.equal(renderDialog(s3(), opts('openai', { intervalSeconds: 45 })).map((c) => c.scheduledOffsetSeconds).join(), '0,45,90');
});

test('prefixo >= mínimo documentado do Haiku 4.5 (4096) nos dois tokenizadores locais; piloto tem diálogos próprios', () => {
  const c = loadCounters(); const d = s3();
  for (const enc of ['o200k_base', 'cl100k_base'] as const) assert.ok(c[enc](d.prefix) >= MIN_PREFIX_TOKENS['claude-haiku-4-5']!.tokens!, enc);
  const pil = defaultBuild().dialogs.filter((x) => x.phase === 'PILOT'); assert.ok(pil.every((x) => x.dialogId.startsWith('PILOT-')));
});

test('prefixos distintos entre diálogos: prefixo comum curto (< 150 caracteres) e quase nenhuma regra repetida (nada de cache cruzado nem de conteúdo clonado)', () => {
  const d = defaultBuild().dialogs; const lcp = (a: string, b: string): number => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return i; };
  const rules = d.map((x) => new Set(x.prefix.split('\n').filter((l) => l.startsWith('Regra '))));
  for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) {
    assert.ok(lcp(d[i]!.prefix, d[j]!.prefix) < 150, `${d[i]!.dialogId} x ${d[j]!.dialogId}`);
    let shared = 0; for (const l of rules[i]!) if (rules[j]!.has(l)) shared += 1; assert.ok(shared / Math.min(rules[i]!.size, rules[j]!.size) < 0.05, `regras repetidas ${d[i]!.dialogId} x ${d[j]!.dialogId}`);
  }
});
