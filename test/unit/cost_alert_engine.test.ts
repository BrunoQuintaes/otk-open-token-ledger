import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evalBudget } from '../../src/economics/CostAlertEngine.js';

describe('CostAlertEngine', () => {
  const p = { maxCU: 1000n, warnPct: 80, criticalPct: 95 };

  it('no alert under warn', () => {
    const r = evalBudget(100n, p);
    assert.equal(r.triggered, false);
  });

  it('warn at >=80%', () => {
    const r = evalBudget(800n, p);
    assert.equal(r.triggered, true);
    if (r.triggered) assert.equal(r.level, 'warn');
  });

  it('critical at >=95%', () => {
    const r = evalBudget(950n, p);
    assert.equal(r.triggered, true);
    if (r.triggered) assert.equal(r.level, 'critical');
  });

  it('throws when maxCU invalid', () => {
    assert.throws(() => evalBudget(1n, { maxCU: 0n, warnPct: 80, criticalPct: 95 }));
  });
});

// --- QA1 edge cases ---
describe('CostAlertEngine — QA1 edge cases', () => {
  const p = { maxCU: 1000n, warnPct: 80, criticalPct: 95 };

  it('consumed > maxCU (pct > 100%) → critical', () => {
    const r = evalBudget(1500n, p);
    assert.equal(r.triggered, true);
    if (r.triggered) assert.equal(r.level, 'critical');
  });

  it('zero consumed → not triggered, pctUsed==0', () => {
    const r = evalBudget(0n, p);
    assert.equal(r.triggered, false);
    assert.equal(r.pctUsed, 0);
  });

  it('just below criticalPct boundary → warn (not critical)', () => {
    // 949/1000 = 94.9% → below criticalPct(95) but above warnPct(80)
    const r = evalBudget(949n, p);
    assert.equal(r.triggered, true);
    if (r.triggered) assert.equal(r.level, 'warn');
  });
});
