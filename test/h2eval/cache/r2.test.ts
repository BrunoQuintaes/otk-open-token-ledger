import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as api from '../../../scripts/h2eval/cache/index.js';
import { createContentStore, contentHash, contentOfS1, ContentStoreError } from '../../../scripts/h2eval/cache/contentStore.js';
import { contentOf, renderCall, renderDialog, type Dialog, type Provider, type RenderOptions } from '../../../scripts/h2eval/cache/dialogs.js';
import { collisionReport, type RefCorpus } from '../../../scripts/h2eval/corpus/collision.js';
import { s1PlanFor, summarizeDesign, DEFAULT_DESIGNS } from '../../../scripts/h2eval/corpus/s1Plan.js';
import { assertFreshSeed, DEFAULT_SEED, FORBIDDEN_SEEDS, SeedRejectedError } from '../../../scripts/h2eval/corpus/seedGuard.js';
import { verifySeedUnused } from '../../../scripts/h2eval/corpus/seedVerify.js';
import { sha256Hex } from '../../../scripts/h2eval/corpus/util.js';
import { defaultBuild, loadCounters, TEST_SEED } from './helpers.js';

const ro = (provider: Provider, extra: Partial<RenderOptions> = {}): RenderOptions => ({ provider, model: { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-4-5', google: 'gemini-3.5-flash-lite' }[provider], maxOutputTokens: 24, ...extra });
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'h2c-'));
const s3 = (): Dialog => defaultBuild().dialogs.find((d) => d.arm === 'S3_HITATTEMPT' && d.phase === 'CONFIRMATORY')!;
const s2 = (): Dialog => defaultBuild().dialogs.find((d) => d.arm === 'S2_NOHIT' && d.phase === 'CONFIRMATORY')!;

test('semente: padrão 20261110 aceito; todas as sementes já usadas do SEED_VERIFICATION_R2 recusadas', () => {
  assert.equal(DEFAULT_SEED, 20261110); assert.equal(assertFreshSeed(DEFAULT_SEED), 20261110);
  for (const s of [1103515245, 20260930, 20261003, 20261006, 20261007, 20261014, 20261015, 20261016, 211920641]) {
    assert.ok(s in FORBIDDEN_SEEDS, `${s} ausente da lista`);
    assert.throws(() => assertFreshSeed(s), (e: unknown) => e instanceof SeedRejectedError && e.code === 'SEED_ALREADY_USED');
  }
});

test('varredura de semente (somente leitura): acha a semente num ref, não acha em outro, e ref inexistente => INCOMPLETE_SCAN (nunca "limpo")', () => {
  const d = tmp(); const g = (...a: string[]) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); fs.writeFileSync(path.join(d, 'cfg.json'), '{"seed": 777123, "x": 1}\n'); g('add', '.'); g('commit', '-q', '-m', 'c');
  const head = g('rev-parse', 'HEAD').stdout.trim();
  const hit = verifySeedUnused(777123, d, ['HEAD']); assert.equal(hit.verdict, 'FOUND'); assert.equal(hit.candidateFoundInAnyRef, true); assert.deepEqual(hit.refs[0]!.files, ['cfg.json']); assert.equal(hit.refs[0]!.commit, head);
  const miss = verifySeedUnused(555999, d, ['HEAD']); assert.equal(miss.verdict, 'NOT_FOUND_IN_SCANNED_REFS'); assert.equal(miss.allRefsScanned, true);
  const inc = verifySeedUnused(555999, d, ['HEAD', 'origin/nao-existe']); assert.equal(inc.verdict, 'INCOMPLETE_SCAN'); assert.equal(inc.refs[1]!.scanned, false); assert.equal(inc.refs[1]!.commit, 'NOT_RESOLVED');
  assert.equal(verifySeedUnused(1, path.join(d, 'nada'), ['HEAD']).verdict, 'INCOMPLETE_SCAN'); // repositório inexistente
  assert.equal(g('status', '--porcelain').stdout.trim(), ''); // nada foi escrito no repositório
  assert.equal(verifySeedUnused(777, d, ['HEAD']).verdict, 'NOT_FOUND_IN_SCANNED_REFS'); // -w: 777 não casa com 777123
});

test('colisão de texto: igualdade byte a byte do texto e do corpo é detectada; texto diferente não; contagem esperada conferida', () => {
  const b = defaultBuild(); const p = b.s1.prompts[0]!; const body = p.text.slice(p.text.indexOf('\n\n') + 2);
  const mine = b.s1.prompts.slice(0, 5).map((x) => ({ id: x.promptId, kind: 's1' as const, text: x.text }));
  const ref = (texts: string[], expected: number | null = null): RefCorpus => ({ name: 'REF', source: 'teste', fileSha256: 'x', expectedCount: expected, texts: texts.map((t, i) => ({ id: `r${i}`, text: t })) });
  const none = collisionReport(mine, [ref(['outro texto totalmente diferente', 'mais um'], 2)]); assert.equal(none.verdict, 'NO_EXACT_COLLISION'); assert.equal(none.refs[0]!.countMatchesExpected, true);
  const full = collisionReport(mine, [ref([p.text])]); assert.equal(full.verdict, 'EXACT_COLLISION'); assert.deepEqual(full.exactCollisions.map((c) => [c.mine, c.on]).filter((c) => c[0] === p.promptId), [[p.promptId, 'text']]);
  const onlyBody = collisionReport(mine, [ref([body])]); assert.equal(onlyBody.verdict, 'EXACT_COLLISION'); assert.ok(onlyBody.exactCollisions.some((c) => c.mine === p.promptId && c.on === 'body'));
  assert.equal(collisionReport(mine, [ref([p.text + ' '])]).verdict, 'NO_EXACT_COLLISION'); // um byte a mais não é igual
  assert.equal(collisionReport(mine, [ref(['a'], 5)]).refs[0]!.countMatchesExpected, false);
  const ov = collisionReport(mine, [ref([body.split('\n').slice(0, 6).join('\n') + '\noutra coisa'])], { flagThresholdLines: 1 }); assert.equal(ov.verdict, 'NO_EXACT_COLLISION'); assert.ok(ov.lineOverlap.totalSharedLongLines >= 1 && ov.lineOverlap.textsWithOverlap.length >= 1);
  assert.equal(collisionReport([], []).verdict, 'NO_EXACT_COLLISION');
});

test('desenho do S1 por modelo (R07 R2): completo = 216; Haiku 4.5 opção B = 174 (144 + 12 comparativos + 18 repetições), mínimos da política atendidos', () => {
  const s1 = defaultBuild().s1;
  const full = s1PlanFor(s1, 'FULL'); const sf = summarizeDesign(full, 'FULL'); assert.equal(full.length, 216); assert.deepEqual(sf.profileObservations, { train: 96, validation: 48, holdout: 48 }); assert.equal(sf.repeats, 24);
  const b = s1PlanFor(s1, 'B_REDUZIDO'); const sb = summarizeDesign(b, 'B_REDUZIDO');
  assert.equal(b.length, 174); assert.equal(sb.repeats, 18); assert.equal(sb.comparativePrompts, 12);
  assert.deepEqual(sb.profileObservations, { train: 72, validation: 36, holdout: 36 }); assert.deepEqual(sb.profileGroups, { train: 24, validation: 12, holdout: 12 });
  assert.ok(sb.profileObservations['train']! >= 60 && sb.profileObservations['validation']! >= 30 && sb.profileObservations['holdout']! >= 30 && sb.profileGroups['holdout']! >= 10);
  const cmp = b.filter((o) => o.phase === 'COMPARATIVE_PAIRED'); assert.ok(cmp.every((o) => o.split === 'COMPARATIVE' && !o.inProfile && o.cellId.startsWith('summary-') && o.rep === 0));
  assert.equal(new Set(cmp.map((o) => o.groupId)).size, 4); assert.equal(cmp.filter((o) => o.cellId === 'summary-S').length, 6); // 2 grupos × 3 variantes por célula de resumo
  assert.ok(b.filter((o) => o.inProfile).every((o) => !o.cellId.startsWith('summary-')));
  const fullIds = new Set(full.map((o) => o.promptId)); assert.ok(cmp.every((o) => fullIds.has(o.promptId)), 'o comparativo usa os MESMOS prompts dos outros modelos (pareável)');
  assert.deepEqual(s1PlanFor(s1, 'B_REDUZIDO'), b); // determinístico
  assert.equal(DEFAULT_DESIGNS['claude-haiku-4-5'], 'B_REDUZIDO'); assert.equal(DEFAULT_DESIGNS['gpt-4o-mini'], 'FULL');
  assert.equal(s1PlanFor(s1, 'B_REDUZIDO', { comparativeGroupsPerCell: 1 }).filter((o) => o.phase === 'COMPARATIVE_PAIRED').length, 6);
});

test('manifesto: desenhos por modelo, hash de conteúdo de cada prompt e de cada chamada de diálogo, e referências à varredura e à colisão', () => {
  const m = defaultBuild().manifest as { modelDesigns: Record<string, { calls: number; design: string }>; s1: { prompts: Array<{ promptId: string; promptSha256: string }> }; dialogs: Array<{ dialogId: string; calls: Array<{ call: number; promptSha256: string; nonce?: string }> }>; seedVerification: { verdict: string }; textCollision: { verdict: string } };
  assert.deepEqual(Object.fromEntries(Object.entries(m.modelDesigns).map(([k, v]) => [k, v.calls])), { 'gpt-4o-mini': 216, 'claude-haiku-4-5': 174, 'claude-haiku-5-5': 216, 'gemini-3.5-flash-lite': 216 });
  const byId = new Map(defaultBuild().s1.prompts.map((p) => [p.promptId, p]));
  for (const e of m.s1.prompts.slice(0, 20)) assert.equal(e.promptSha256, contentOfS1(byId.get(e.promptId)!).promptSha256);
  const d = defaultBuild().dialogs.find((x) => x.dialogId === m.dialogs[0]!.dialogId)!; for (const c of m.dialogs[0]!.calls) assert.equal(c.promptSha256, contentOf(d, c.call as 1 | 2 | 3).promptSha256);
  assert.equal(m.seedVerification.verdict, 'NOT_SCANNED'); assert.equal(m.textCollision.verdict, 'NOT_COMPARED'); // a biblioteca pura não varre nem compara; a CLI faz e grava os relatórios
});

test('ContentStore: roundtrip por hash, idempotente, adulteração e conflito detectados, hash inválido recusado', async () => {
  const dir = tmp(); const st = createContentStore(dir); const c = contentOfS1(defaultBuild().s1.prompts[0]!);
  const sha = st.put(c); assert.equal(sha, c.promptSha256); assert.equal(st.put(c), sha); assert.ok(st.has(sha));
  const back = await st.get(sha); assert.deepEqual(back, c); assert.equal(back.prefixMessages, 'NOT_APPLICABLE');
  const d = contentOf(s3(), 2); const sd = st.put(d); assert.equal(sd, d.promptSha256); const bd = await st.get(sd); assert.equal(bd.prefixMessages, 1); assert.equal(bd.messages[0]!.role, 'system'); assert.equal(bd.messages.length, 4);
  await assert.rejects(() => st.get('0'.repeat(64)), (e: unknown) => e instanceof ContentStoreError && e.code === 'NOT_FOUND');
  await assert.rejects(() => st.get('xyz'), (e: unknown) => e instanceof ContentStoreError && e.code === 'BAD_HASH');
});

test('ContentStore: adulterar um byte do arquivo é detectado em toda leitura; binários por hash', async () => {
  const dir = tmp(); const st = createContentStore(dir); const c = contentOfS1(defaultBuild().s1.prompts[3]!); const sha = st.put(c); const f = path.join(dir, 'content', sha);
  const txt = fs.readFileSync(f, 'utf8'); const i = txt.indexOf('a'); fs.writeFileSync(f, txt.slice(0, i) + 'b' + txt.slice(i + 1));
  await assert.rejects(() => st.get(sha), (e: unknown) => e instanceof ContentStoreError && e.code === 'TAMPERED');
  const bytes = new Uint8Array([1, 2, 3, 250]); const bsha = st.putBytes(bytes); assert.deepEqual([...(await st.getBytes(bsha))], [1, 2, 3, 250]); assert.equal(st.putBytes(bytes), bsha);
  fs.writeFileSync(path.join(dir, 'content', `${bsha}.bin`), Buffer.from([9]));
  await assert.rejects(() => st.getBytes(bsha), (e: unknown) => e instanceof ContentStoreError && e.code === 'TAMPERED');
  await assert.rejects(() => st.getBytes('1'.repeat(64)), (e: unknown) => e instanceof ContentStoreError && e.code === 'NOT_FOUND');
  assert.equal(contentHash({ messages: c.messages, prefixMessages: 'NOT_APPLICABLE' }), c.promptSha256);
  fs.writeFileSync(path.join(dir, 'content', sha), 'outro conteúdo qualquer'); // conflito: put com bytes diferentes no mesmo hash
  assert.throws(() => st.put(c), (e: unknown) => e instanceof ContentStoreError && e.code === 'CONFLICT');
});

test('params do plano: serviceTierRequested, cacheTtlRequested (só Anthropic S3) e nonceTokensDeclared (só S2; UNKNOWN sem contador, nunca 0)', () => {
  const c = loadCounters();
  const a3 = renderCall(s3(), 2, ro('anthropic', { serviceTier: 'standard_only' })); assert.deepEqual(a3.params, { serviceTierRequested: 'standard_only', cacheTtlRequested: '5m', nonceTokensDeclared: 'NOT_APPLICABLE', maxOutputTokens: 24 });
  assert.equal(renderCall(s3(), 2, ro('anthropic', { anthropicCacheTtl: '1h' })).params.cacheTtlRequested, '1h');
  for (const p of ['openai', 'google'] as Provider[]) { const x = renderCall(s3(), 2, ro(p)).params; assert.equal(x.cacheTtlRequested, 'NOT_APPLICABLE'); assert.equal(x.nonceTokensDeclared, 'NOT_APPLICABLE'); assert.equal(x.serviceTierRequested, 'NONE'); }
  assert.equal(renderCall(s2(), 1, ro('anthropic')).params.cacheTtlRequested, 'NOT_APPLICABLE'); // controle sem cache_control
  for (const p of ['openai', 'anthropic', 'google'] as Provider[]) {
    assert.equal(renderCall(s2(), 1, ro(p)).params.nonceTokensDeclared, 'UNKNOWN');
    const counted = renderDialog(s2(), ro(p, { nonceTokenCounter: c.o200k_base })).map((x) => x.params.nonceTokensDeclared);
    assert.ok(counted.every((n) => typeof n === 'number' && n > 0 && n <= 25), `${p} ${counted.join()}`);
  }
});

test('API pública para a integradora: createContentStore e planArm existem e funcionam', () => {
  assert.equal(typeof api.createContentStore, 'function'); assert.equal(typeof api.planArm, 'function'); assert.equal(api.planArm({ model: 'm', hits: 6, attempts: 6 }).status, 'PLANNED');
  for (const k of ['classifyCache', 'costInterval', 'buildCorpus', 'verifySeedUnused', 'collisionReport', 'renderDialog', 'resolveArm', 'contentOf']) assert.equal(typeof (api as unknown as Record<string, unknown>)[k], 'function', k);
});

test('piloto segregado de cache: 6 S1 + 2 S2 + 3 S3 = 21 chamadas de texto (+ imagens/áudio do MET-02 => 23, Gemini 25); tudo fora do split', () => {
  const b = defaultBuild(); const s1p = b.s1.prompts.filter((p) => p.phase === 'PILOT'); const dp = b.dialogs.filter((d) => d.phase === 'PILOT');
  assert.equal(s1p.length, 6); assert.equal(dp.filter((d) => d.arm === 'S2_NOHIT').length, 2); assert.equal(dp.filter((d) => d.arm === 'S3_HITATTEMPT').length, 3);
  assert.equal(s1p.length + dp.length * 3, 21); assert.ok(s1p.every((p) => p.split === 'NONE') && dp.every((d) => d.split === 'NONE'));
});

test('golden do corpus com a semente de teste (muda só se o gerador mudar; então registrar o novo valor e o motivo)', () => {
  const m = defaultBuild().manifest as { corpusSha256: string; s1Sha256: string; dialogsSha256: string };
  assert.equal(sha256Hex(defaultBuild().s1Jsonl), m.s1Sha256);
  assert.match(m.corpusSha256, /^[0-9a-f]{64}$/); assert.equal(TEST_SEED, 424242);
  assert.equal(m.corpusSha256, '1060e86cf351112bb2b71ef071df55d5b0875252e3b83e70d19fe48460e56d5b');
});
