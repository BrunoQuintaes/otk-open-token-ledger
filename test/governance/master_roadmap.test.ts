/**
 * OTK-H1-STOPGATE-01 P5/P6: roadmap mestre autoritativo (docs/governance/OTK_MASTER_ROADMAP_CURRENT.json).
 * Confere o contrato do JSON, as regras de horizonte (M2/M3/H3 nunca bloqueiam H1), a reconciliação de contagens,
 * o determinismo do gerador e se as saídas geradas (MD, Gantt, grafo, HTML) estão em dia com o JSON.
 * Cada regra tem um caso negativo: o validador precisa recusar uma cópia adulterada.
 *
 * Rodar: npx tsx --test test/governance/master_roadmap.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: módulo .mjs sem tipos
import * as gen from '../../scripts/ops/generate_master_roadmap.mjs';

type Any = any;
const rm: Any = gen.load();
const clone = (): Any => JSON.parse(JSON.stringify(rm));
const errs = (x: Any) => gen.validate(x).errors as string[];
const item = (x: Any, id: string) => x.items.find((i: Any) => i.ID === id);
const firstWith = (x: Any, f: (i: Any) => boolean) => x.items.find(f);

describe('roadmap mestre: estado atual', () => {
  it('JSON válido (0 erros)', () => {
    const v = gen.validate(rm);
    assert.deepEqual(v.errors, []);
  });

  it('saídas geradas estão em dia com o JSON', () => {
    assert.deepEqual(gen.checkOutputsUpToDate(rm), []);
  });

  it('gerador é determinístico (duas gerações idênticas byte a byte)', () => {
    assert.deepEqual(gen.checkDeterminism(rm), []);
    const a = gen.generateAll(rm); const b = gen.generateAll(clone());
    for (const [k, v] of a) assert.equal(b.get(k), v, k);
  });

  it('inventário do pacote 20261008 confere com os dados (316 WPs, 26 domínios, 89 fases, 146 subfases, 108 gates, 17 runs)', () => {
    const inv = rm.historical_inventory_20261008;
    assert.equal(inv.matches, true);
    assert.equal(rm.items.filter((i: Any) => /^OTK-D\d\d-F\d\d-S\d\d-W\d\d$/.test(i.ID)).length, 316);
    assert.equal(rm.gates.filter((g: Any) => g.KIND !== 'STOPGATE_DIMENSION').length, 108);
  });

  it('legado reconciliado: 528 registros recuperados (418 CSV + 83 só no gantt + 5 IDs duplicados + 22 W10–W13)', () => {
    const c = rm.legacy_import.counts;
    assert.deepEqual(c, { csv: 418, gantt_only: 83, gantt_duplicate_id_variants: 5, crc_part9: 22 });
    const leg = rm.items.filter((i: Any) => i.ID.startsWith('LEG-'));
    assert.equal(leg.length, 528);
    assert.ok(leg.every((i: Any) => i.STATUS !== 'VERIFIED_COMPLETE' && i.ACTUAL_START === null && i.ACTUAL_FINISH === null));
  });

  it('itens da run STOPGATE-01 (P1..P7) e marcos obrigatórios presentes', () => {
    for (let k = 1; k <= 7; k++) assert.ok(item(rm, `OTK-STOPGATE01-P${k}`), `P${k}`);
    for (const m of ['MS-M0', 'MS-M1', 'MS-H1-TECH', 'MS-H1-WIN', 'MS-H1-REPRO', 'MS-H1-SCI', 'MS-H1-DEFENSE', 'MS-M2-T1', 'MS-M2-T2', 'MS-M2-T3', 'MS-M2-T4', 'MS-M2-T5', 'MS-M3', 'MS-H3']) {
      const ms = rm.milestones.find((x: Any) => x.ID === m);
      assert.ok(ms && ms.DOD.length > 0, m);
    }
  });

  it('nenhuma decisão aparece como aprovada; decididas têm registro em git', () => {
    for (const d of rm.decisions) {
      assert.ok(['PENDING', 'DECIDED_RECORDED', 'DECIDED_SCOPED_RECORDED'].includes(d.STATE), d.ID);
      if (d.STATE !== 'PENDING') assert.ok(d.RECORD && !d.RECORD.startsWith('local:'), d.ID);
    }
  });

  it('caminho crítico H1: só itens H1 obrigatórios e abertos, encadeados por PREDECESSORS', () => {
    const A = gen.analyze(rm);
    assert.ok(A.criticalItems.length > 0);
    for (const id of A.criticalItems) {
      const i = item(rm, id);
      assert.ok(['H1-CORE', 'H1-HUMAN'].includes(i.HORIZON), id);
      assert.ok(!['VERIFIED_COMPLETE', 'IMPLEMENTED_WITH_LIMITATION', 'SUPERSEDED_WITH_EVIDENCE', 'EXCLUDED_WITH_REASON'].includes(i.STATUS), id);
    }
    for (let k = 1; k < A.criticalItems.length; k++) assert.ok(item(rm, A.criticalItems[k]).PREDECESSORS.includes(A.criticalItems[k - 1]));
  });
});

describe('roadmap mestre: o validador recusa cópias adulteradas', () => {
  const expectErr = (mut: (x: Any) => void, re: RegExp) => {
    const x = clone(); mut(x);
    const e = errs(x);
    assert.ok(e.some((m) => re.test(m)), `esperava erro ${re}, veio: ${e.slice(0, 5).join(' | ')}`);
  };

  it('ID duplicado', () => expectErr((x) => { x.items.push({ ...x.items[0] }); }, /ID duplicado/));
  it('predecessor que não resolve', () => expectErr((x) => { item(x, 'OTK-STOPGATE01-P7').PREDECESSORS.push('OTK-INEXISTENTE'); item(x, 'OTK-STOPGATE01-P7').PREDECESSORS.sort(); }, /não resolve/));
  it('ciclo de dependências', () => expectErr((x) => { const p5 = item(x, 'OTK-STOPGATE01-P5'); p5.PREDECESSORS = ['OTK-STOPGATE01-P6']; item(x, 'OTK-STOPGATE01-P6').SUCCESSORS = ['OTK-STOPGATE01-P5', 'OTK-STOPGATE01-P7']; }, /ciclo/));
  it('SUCCESSORS diferente do inverso', () => expectErr((x) => { item(x, 'OTK-STOPGATE01-P5').SUCCESSORS = []; }, /SUCCESSORS/));
  it('VERIFIED_COMPLETE sem evidência em git', () => expectErr((x) => { const i = firstWith(x, (j: Any) => j.STATUS === 'VERIFIED_COMPLETE'); i.EVIDENCE_SHA = null; }, /sem EVIDENCE|40 hex/));
  it('VERIFIED_COMPLETE com evidência só local', () => expectErr((x) => { const i = firstWith(x, (j: Any) => j.STATUS === 'VERIFIED_COMPLETE'); i.EVIDENCE = 'local:pacote'; }, /fora do git/));
  it('valor fora do enum', () => expectErr((x) => { x.items[0].STATUS = 'DONE'; }, /fora do enum/));
  it('campo extra no item', () => expectErr((x) => { x.items[0].NOTES = 'x'; }, /fora do contrato/));
  it('generated_at proibido', () => expectErr((x) => { x.generated_at = 'agora'; }, /generated_at/));
  it('item H1 dependendo de item M2', () => expectErr((x) => {
    const h1 = item(x, 'OTK-STOPGATE01-P7'); const m2 = firstWith(x, (j: Any) => j.HORIZON === 'M2');
    h1.PREDECESSORS = [...h1.PREDECESSORS, m2.ID].sort(); m2.SUCCESSORS = [...m2.SUCCESSORS, h1.ID].sort();
  }, /não podem bloquear H1/));
  it('marco H1 dependendo de marco M2', () => expectErr((x) => { const m = x.milestones.find((y: Any) => y.ID === 'MS-H1-DEFENSE'); m.DEPENDENCIES = [...m.DEPENDENCIES, 'MS-M2-T1'].sort(); }, /marco H1 MS-H1-DEFENSE depende/));
  it('item ativo com predecessor excluído', () => expectErr((x) => {
    const ex = firstWith(x, (j: Any) => j.STATUS === 'EXCLUDED_WITH_REASON' && j.HORIZON === 'EXCLUDED'); const a = item(x, 'OTK-STOPGATE01-P7');
    a.PREDECESSORS = [...a.PREDECESSORS, ex.ID].sort(); ex.SUCCESSORS = [...ex.SUCCESSORS, a.ID].sort();
  }, /predecessor excluído|não podem bloquear H1/));
  it('registro legado com data real', () => expectErr((x) => { firstWith(x, (j: Any) => j.ID.startsWith('LEG-')).ACTUAL_FINISH = '2026-04-01'; }, /legado não pode ter data real|não concluído/));
  it('decisão marcada como aprovada', () => expectErr((x) => { x.decisions[0].STATE = 'APPROVED_BY_BRUNO'; }, /estado inválido|APPROVED/));
  it('saída gerada editada à mão é detectada', () => {
    const x = clone(); x.items[0].TITLE += ' (alterado)';
    assert.ok(gen.checkOutputsUpToDate(x).length > 0);
  });
});
