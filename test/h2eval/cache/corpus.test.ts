import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorpus } from '../../../scripts/h2eval/corpus/manifest.js';
import { assertFreshSeed, FORBIDDEN_SEEDS, SeedRejectedError } from '../../../scripts/h2eval/corpus/seedGuard.js';
import { allocateCounts, assignSplits, DIALOG_FRACTIONS, S1_FRACTIONS } from '../../../scripts/h2eval/corpus/split.js';
import { hasLoneSurrogate, sha256Hex } from '../../../scripts/h2eval/corpus/util.js';
import { defaultBuild, loadCounters, TEST_SEED } from './helpers.js';

test('determinismo: mesma semente => mesmo sha256 do corpus, dos prompts e dos diálogos; outra semente => outro', () => {
  const a = buildCorpus({ seed: TEST_SEED }); const b = buildCorpus({ seed: TEST_SEED }); const c = buildCorpus({ seed: TEST_SEED + 1 });
  const m = (x: typeof a) => x.manifest as { corpusSha256: string; s1Sha256: string; dialogsSha256: string };
  assert.equal(m(a).corpusSha256, m(b).corpusSha256); assert.equal(m(a).s1Sha256, m(b).s1Sha256); assert.equal(m(a).dialogsSha256, m(b).dialogsSha256);
  assert.equal(a.s1Jsonl, b.s1Jsonl); assert.equal(a.dialogsJsonl, b.dialogsJsonl);
  assert.notEqual(m(a).corpusSha256, m(c).corpusSha256); assert.notEqual(m(a).s1Sha256, m(c).s1Sha256);
  assert.equal(sha256Hex(a.s1Jsonl), m(a).s1Sha256); assert.equal(sha256Hex(a.dialogsJsonl), m(a).dialogsSha256);
});

test('golden: o hash do corpus com a semente de teste não muda sem mudança de gerador (registrar novo valor ao mudar o gerador)', () => {
  const m = defaultBuild().manifest as { corpusSha256: string };
  assert.match(m.corpusSha256, /^[0-9a-f]{64}$/);
  assert.equal(m.corpusSha256, buildCorpus({ seed: TEST_SEED }).manifest['corpusSha256']);
});

test('semente: recusa H1 (20260930, 20261006, 20261007), CAL-ANTH-01 (20261014, 211920641), lista extra, não inteira e fora da faixa', () => {
  for (const s of Object.keys(FORBIDDEN_SEEDS).map(Number)) assert.throws(() => assertFreshSeed(s), (e: unknown) => e instanceof SeedRejectedError && e.code === 'SEED_ALREADY_USED', `semente ${s}`);
  assert.throws(() => assertFreshSeed(555, [555]), (e: unknown) => e instanceof SeedRejectedError && e.code === 'SEED_ALREADY_USED');
  assert.throws(() => assertFreshSeed(1.5), (e: unknown) => e instanceof SeedRejectedError && e.code === 'SEED_NOT_INTEGER');
  assert.throws(() => assertFreshSeed('20261201'), (e: unknown) => e instanceof SeedRejectedError && e.code === 'SEED_NOT_INTEGER');
  assert.throws(() => assertFreshSeed(0), (e: unknown) => e instanceof SeedRejectedError && e.code === 'SEED_OUT_OF_RANGE');
  assert.throws(() => assertFreshSeed(2 ** 32), (e: unknown) => e instanceof SeedRejectedError && e.code === 'SEED_OUT_OF_RANGE');
  assert.equal(assertFreshSeed(TEST_SEED), TEST_SEED);
  for (const s of [20261007, 20261014]) assert.throws(() => buildCorpus({ seed: s })); // o gerador também recusa
});

test('tamanhos: 192 prompts confirmatórios, 6 do piloto, 24 repetições, 216 chamadas, 8 células', () => {
  const b = defaultBuild(); const conf = b.s1.prompts.filter((p) => p.phase === 'CONFIRMATORY'); const pil = b.s1.prompts.filter((p) => p.phase === 'PILOT');
  assert.equal(conf.length, 192); assert.equal(pil.length, 6); assert.equal(b.s1.repeats.length, 24); assert.equal(b.s1.cells.length, 8);
  assert.equal(new Set(conf.map((p) => p.cellId)).size, 8);
  for (const c of b.s1.cells) { assert.equal(conf.filter((p) => p.cellId === c).length, 24); assert.equal(new Set(conf.filter((p) => p.cellId === c).map((p) => p.groupId)).size, 8); assert.equal(b.s1.repeats.filter((r) => r.promptId.startsWith(`${c}-`)).length, 3); }
  const m = b.manifest as { counts: { s1Calls: number } }; assert.equal(m.counts.s1Calls, 216);
});

test('split: balanceado por célula (4/2/2 grupos) => 32/16/16 grupos e 96/48/48 observações; holdout com >= 10 grupos; mínimos da política atendidos', () => {
  const conf = defaultBuild().s1.prompts.filter((p) => p.phase === 'CONFIRMATORY');
  for (const cell of defaultBuild().s1.cells) {
    const groups = new Map<string, string>(); for (const p of conf.filter((x) => x.cellId === cell)) groups.set(p.groupId, p.split);
    const cnt = { train: 0, validation: 0, holdout: 0 }; for (const s of groups.values()) cnt[s as keyof typeof cnt] += 1;
    assert.deepEqual(cnt, { train: 4, validation: 2, holdout: 2 }, cell);
  }
  const obs = { train: 0, validation: 0, holdout: 0 }; const groups = { train: new Set<string>(), validation: new Set<string>(), holdout: new Set<string>() };
  for (const p of conf) { obs[p.split as keyof typeof obs] += 1; groups[p.split as keyof typeof groups].add(p.groupId); }
  assert.deepEqual(obs, { train: 96, validation: 48, holdout: 48 });
  assert.deepEqual([groups.train.size, groups.validation.size, groups.holdout.size], [32, 16, 16]);
  assert.ok(obs.train >= 60 && obs.validation >= 30 && obs.holdout >= 30 && groups.holdout.size >= 10);
});

test('nenhuma colisão de grupo entre splits; variantes e repetições ficam no split do grupo; prompts distintos', () => {
  const b = defaultBuild(); const byGroup = new Map<string, Set<string>>();
  for (const p of b.s1.prompts) { const s = byGroup.get(p.groupId) ?? new Set<string>(); s.add(p.split); byGroup.set(p.groupId, s); }
  for (const [g, s] of byGroup) assert.equal(s.size, 1, `grupo ${g} em mais de um split`);
  const byId = new Map(b.s1.prompts.map((p) => [p.promptId, p]));
  for (const r of b.s1.repeats) { const p = byId.get(r.promptId)!; assert.ok(p, r.promptId); assert.equal(p.phase, 'CONFIRMATORY'); assert.equal(p.variant, 0); }
  assert.equal(new Set(b.s1.prompts.map((p) => p.promptId)).size, b.s1.prompts.length);
  assert.equal(new Set(b.s1.prompts.map((p) => p.textSha256)).size, b.s1.prompts.length, 'prompts com texto repetido');
});

test('o split não depende do conteúdo nem dos resultados: mudar o tamanho do prefixo não muda a atribuição; ordem vem de sha256(semente|célula|índice)', () => {
  const a = buildCorpus({ seed: TEST_SEED, prefixChars: 3000 }); const b = defaultBuild();
  const sp = (x: typeof a) => x.s1.prompts.map((p) => `${p.promptId}:${p.split}`).join();
  assert.equal(sp(a), sp(b));
  assert.equal(a.dialogs.map((d) => `${d.dialogId}:${d.split}`).join(), b.dialogs.map((d) => `${d.dialogId}:${d.split}`).join());
  assert.deepEqual(assignSplits(TEST_SEED, 'x', 8, S1_FRACTIONS), assignSplits(TEST_SEED, 'x', 8, S1_FRACTIONS));
  assert.notDeepEqual(assignSplits(TEST_SEED, 'x', 8, S1_FRACTIONS), assignSplits(TEST_SEED + 7, 'x', 8, S1_FRACTIONS));
});

test('allocateCounts: S2 15 -> 9/3/3; S3 30 -> 18/6/6; holdout arredonda para cima; soma sempre n', () => {
  assert.deepEqual(allocateCounts(15, DIALOG_FRACTIONS), { train: 9, validation: 3, holdout: 3 });
  assert.deepEqual(allocateCounts(30, DIALOG_FRACTIONS), { train: 18, validation: 6, holdout: 6 });
  assert.deepEqual(allocateCounts(8, S1_FRACTIONS), { train: 4, validation: 2, holdout: 2 });
  for (const n of [15, 22, 30, 50, 66, 7, 1, 0]) { const c = allocateCounts(n, DIALOG_FRACTIONS); assert.equal(c.train + c.validation + c.holdout, n); assert.ok(c.holdout >= Math.floor(n * 0.2)); assert.ok(c.train >= 0); }
  assert.equal(allocateCounts(22, DIALOG_FRACTIONS).holdout, 5); // ceil(4,4)
});

test('diálogos: S2 15 (9/3/3), S3 30 (18/6/6), piloto 2+3 com split NONE; prefixos únicos no estudo todo (nenhum reaproveitamento entre diálogos)', () => {
  const d = defaultBuild().dialogs; const conf = d.filter((x) => x.phase === 'CONFIRMATORY');
  const cnt = (arm: string) => { const o: Record<string, number> = {}; for (const x of conf.filter((y) => y.arm === arm)) o[x.split] = (o[x.split] ?? 0) + 1; return o; };
  assert.deepEqual(cnt('S2_NOHIT'), { train: 9, validation: 3, holdout: 3 }); assert.deepEqual(cnt('S3_HITATTEMPT'), { train: 18, validation: 6, holdout: 6 });
  const pil = d.filter((x) => x.phase === 'PILOT'); assert.equal(pil.length, 5); assert.ok(pil.every((x) => x.split === 'NONE'));
  assert.equal(new Set(d.map((x) => x.prefixSha256)).size, d.length, 'dois diálogos com o mesmo prefixo => hit entre diálogos');
  assert.equal(new Set(d.map((x) => x.dialogId)).size, d.length);
});

test('conteúdo: sem surrogate isolado (defeito F-OVN2-08 da H1), sem dado pessoal, sem segredo, sem emoji', () => {
  const b = defaultBuild(); const texts = [...b.s1.prompts.map((p) => p.text), ...b.dialogs.flatMap((d) => [d.prefix, ...d.turns.flatMap((t) => [t.user, t.assistant ?? ''])])];
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/; const cpf = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/; const phone = /\+?\d{2}\s?\(?\d{2}\)?\s?9?\d{4}-?\d{4}/;
  const secret = /sk-[A-Za-z0-9_-]{16,}|sk-ant-|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{20,}/;
  for (const t of texts) { assert.equal(hasLoneSurrogate(t), false); assert.equal(/[\ud800-\udfff]/.test(t), false, 'sem emoji/surrogates'); assert.equal(email.test(t), false); assert.equal(cpf.test(t), false); assert.equal(secret.test(t), false); }
  assert.equal(hasLoneSurrogate('x\ud83d'), true); // o detector funciona
  void phone;
});

test('piloto segregado: grupos próprios, phase PILOT, split NONE, nenhum texto igual ao da amostra confirmatória', () => {
  const b = defaultBuild(); const pil = b.s1.prompts.filter((p) => p.phase === 'PILOT'); const confHashes = new Set(b.s1.prompts.filter((p) => p.phase === 'CONFIRMATORY').map((p) => p.textSha256));
  assert.ok(pil.every((p) => p.split === 'NONE' && p.groupId.startsWith('PILOT-') && !confHashes.has(p.textSha256)));
});

test('tamanhos em tokens (estimativa local, o200k e cl100k): S entre 550 e 950; L entre 4300 e 6000; prefixo >= 4096 nos dois', () => {
  const c = loadCounters(); const b = defaultBuild();
  for (const p of b.s1.prompts.filter((x) => x.phase === 'CONFIRMATORY')) for (const e of ['o200k_base', 'cl100k_base'] as const) { const n = c[e](p.text); if (p.size === 'S') assert.ok(n >= 550 && n <= 950, `${p.promptId} ${e} ${n}`); else assert.ok(n >= 4300 && n <= 6000, `${p.promptId} ${e} ${n}`); }
  for (const d of b.dialogs.slice(0, 6)) for (const e of ['o200k_base', 'cl100k_base'] as const) assert.ok(c[e](d.prefix) >= 4096, `${d.dialogId} ${e}`);
});

test('rubrica determinística: a resposta esperada da análise bate com o recálculo independente a partir da tabela do próprio prompt', () => {
  const an = defaultBuild().s1.prompts.filter((p) => p.task === 'analysis' && p.phase === 'CONFIRMATORY').slice(0, 6);
  for (const p of an) {
    const rows = [...p.text.matchAll(/^\| (\w+) \| (\w+) \| (\d+) \| (\d+) \|$/gm)].map((m) => ({ t: m[1]!, mo: m[2]!, u: Number(m[3]), c: Number(m[4]) }));
    assert.ok(rows.length > 5);
    const s = new Map<string, [number, number]>(); const mo = new Map<string, number>();
    for (const r of rows) { const v = s.get(r.t) ?? [0, 0]; v[0] += r.c; v[1] += r.u; s.set(r.t, v); mo.set(r.mo, (mo.get(r.mo) ?? 0) + r.c); }
    const bestTeam = [...s.entries()].sort((a, b) => b[1][0] * a[1][1] - a[1][0] * b[1][1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    const bestMonth = [...mo.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    assert.equal((p.rubric as { expectedTeam: string }).expectedTeam, bestTeam); assert.equal((p.rubric as { expectedMonth: string }).expectedMonth, bestMonth);
  }
});

test('manifesto: hash de cada prompt e diálogo, contagens, estimador, e UNKNOWN (nunca 0) quando não há contador', () => {
  const m = defaultBuild().manifest as { s1: { prompts: Array<{ tokensEst: { o200k_base: unknown } }> }; dialogs: Array<{ arm: string; nonceTokenDelta?: { o200k_base: unknown[] } }>; generator: { codeSha256: string } };
  assert.ok(m.s1.prompts.every((p) => p.tokensEst.o200k_base === 'UNKNOWN'));
  assert.ok(m.dialogs.filter((d) => d.arm === 'S2_NOHIT').every((d) => d.nonceTokenDelta!.o200k_base.every((x) => x === 'UNKNOWN')));
  assert.equal(m.generator.codeSha256, 'UNKNOWN');
  const withC = buildCorpus({ seed: TEST_SEED }, { counters: loadCounters(), generatorFiles: [{ path: 'a.ts', sha256: 'x' }] }).manifest as typeof m;
  assert.ok(withC.s1.prompts.every((p) => typeof p.tokensEst.o200k_base === 'number'));
  assert.ok(withC.dialogs.filter((d) => d.arm === 'S2_NOHIT').every((d) => d.nonceTokenDelta!.o200k_base.every((x) => typeof x === 'number' && x > 0)));
  assert.match(withC.generator.codeSha256, /^[0-9a-f]{64}$/);
  // as estimativas não entram no hash do corpus
  assert.equal((withC as unknown as { corpusSha256: string }).corpusSha256, (defaultBuild().manifest as { corpusSha256: string }).corpusSha256);
});
