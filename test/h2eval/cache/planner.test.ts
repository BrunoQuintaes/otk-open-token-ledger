import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dialogsFor, planCacheArm, R07_TABLE, wilsonLower, Z80_ONE_SIDED, Z80_TWO_SIDED } from '../../../scripts/h2eval/cache/planner.js';

// referência independente (álgebra alternativa) do limite inferior de Wilson
const ref = (k: number, n: number, z: number): number => (2 * n * (k / n) + z * z - z * Math.sqrt(z * z + 4 * n * (k / n) * (1 - k / n))) / (2 * (n + z * z));

test('fórmula do R07: D = ceil(30/(2·p_baixo)) reproduz a tabela (1,0→15; 0,7→22; 0,5→30; 0,3→50) e as chamadas (×3)', () => {
  for (const r of R07_TABLE) { assert.equal(dialogsFor(r.pLower), r.dialogs, `p=${r.pLower}`); assert.equal(r.dialogs * 3, r.calls); }
  assert.equal(dialogsFor(0.3), 50); // sem erro de ponto flutuante (30/0,6)
});

test('Wilson: confere com a álgebra alternativa em vários (k, n, z); limites 0 e 1; monotonia', () => {
  for (const z of [Z80_TWO_SIDED, Z80_ONE_SIDED, 1.96]) for (const [k, n] of [[0, 6], [1, 6], [3, 6], [5, 6], [6, 6], [2, 4], [10, 30], [30, 30]] as Array<[number, number]>) assert.ok(Math.abs(wilsonLower(k, n, z) - ref(k, n, z)) < 1e-12, `k=${k} n=${n} z=${z}`);
  assert.equal(wilsonLower(0, 10), 0); assert.ok(wilsonLower(10, 10) < 1 && wilsonLower(10, 10) > 0.8);
  assert.ok(wilsonLower(5, 6) < wilsonLower(6, 6)); assert.ok(wilsonLower(3, 6) < wilsonLower(30, 60)); // mais dados => limite sobe
  assert.ok(wilsonLower(5, 6, Z80_ONE_SIDED) > wilsonLower(5, 6, Z80_TWO_SIDED)); // bilateral é mais conservador
  assert.throws(() => wilsonLower(7, 6)); assert.throws(() => wilsonLower(1, 0)); assert.throws(() => wilsonLower(1.5, 6)); assert.throws(() => wilsonLower(-1, 6));
});

test('piloto de 3 diálogos S3 (até 6 tentativas de hit): 6/6 => PLANNED com D conservador; resultado e fórmula registrados', () => {
  const p = planCacheArm({ model: 'claude-haiku-4-5', hits: 6, attempts: 6 });
  assert.equal(p.status, 'PLANNED'); assert.equal(p.pHat, 1); assert.ok(typeof p.pLower === 'number' && p.pLower > 0.6 && p.pLower < 0.9);
  assert.equal(p.dialogs, Math.ceil(30 / (2 * (p.pLower as number)) - 1e-9)); assert.equal(p.calls, (p.dialogs as number) * 3); assert.ok((p.dialogs as number) > 15);
  assert.match(p.formula, /ceil\(30 \/ \(2 \* p_baixo\)\)/); assert.equal(p.z, Z80_TWO_SIDED);
  const q = planCacheArm({ model: 'm', hits: 6, attempts: 6 }, { z: Z80_ONE_SIDED }); assert.ok((q.dialogs as number) < (p.dialogs as number));
});

test('p_baixo < 0,3 => braço NOT_RUN (taxa registrada, 0 diálogos); 0 hits NOT_RUN; limite exato 0,3 não é NOT_RUN', () => {
  const a = planCacheArm({ model: 'gpt-4o-mini', hits: 0, attempts: 6 }); assert.equal(a.status, 'NOT_RUN'); assert.equal(a.dialogs, 0); assert.equal(a.calls, 0); assert.equal(a.pHat, 0); assert.ok(typeof a.pLower === 'number');
  const b = planCacheArm({ model: 'x', hits: 1, attempts: 6 }); assert.equal(b.status, 'NOT_RUN'); assert.equal(b.pHat, 1 / 6);
  const c = planCacheArm({ model: 'x', hits: 3, attempts: 6 }, { threshold: wilsonLower(3, 6) }); assert.equal(c.status, 'PLANNED'); // pLower == limiar => planeja
});

test('piloto sem tentativas observadas: INSUFFICIENT_PILOT com taxa UNKNOWN (nunca 0 nem 1)', () => {
  const p = planCacheArm({ model: 'gemini-3.5-flash-lite', hits: 0, attempts: 0 }); assert.equal(p.status, 'INSUFFICIENT_PILOT'); assert.equal(p.pHat, 'UNKNOWN'); assert.equal(p.pLower, 'UNKNOWN'); assert.equal(p.dialogs, null); assert.equal(p.calls, null);
});

test('limite por orçamento/decisão (maxDialogs) é sinalizado, não escondido; máximo de hits por diálogo é parâmetro', () => {
  const p = planCacheArm({ model: 'm', hits: 5, attempts: 6 }, { maxDialogs: 20 }); assert.equal(p.status, 'PLANNED'); assert.equal(p.dialogs, 20); assert.equal(p.cappedByLimit, true); assert.match(p.note, /maxDialogs/);
  assert.equal(dialogsFor(0.5, 30, 1), 60); assert.equal(dialogsFor(0.5, 30, 2), 30);
  assert.throws(() => dialogsFor(0)); assert.throws(() => dialogsFor(-1));
  const q = planCacheArm({ model: 'm', hits: 6, attempts: 6 }, { callsPerDialog: 2 }); assert.equal(q.calls, (q.dialogs as number) * 2);
});
