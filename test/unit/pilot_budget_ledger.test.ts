/**
 * Budget ledger of the paid Anthropic pilot (scripts/pilot/anthropic/budgetLedger.ts).
 * Values checked by hand from the official Haiku 4.5 list prices (USD per MTok:
 * input 1, cache write 5m 1.25 / 1h 2, cache read 0.10, output 5), consulted 2026-09-29.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BudgetLedger, BudgetError, costFromUsage, maxCostUsd, maxInputTokensFor, HARD_CAP_USD,
} from '../../scripts/pilot/anthropic/budgetLedger.js';

const M = 'claude-haiku-4-5-20251001';
const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'otk-ledger-')), 'ledger.jsonl');
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

describe('pilot budget — prices and bounds', () => {
  it('cost from usage: 25 in / 15 out = 0.000025 + 0.000075 = USD 0.0001', () => {
    const c = costFromUsage(M, { input_tokens: 25, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    assert.ok(c);
    close(c.usd, 0.0001);
  });

  it('cache categories priced separately (1000 write-5m, 2000 write-1h, 10000 read)', () => {
    const c = costFromUsage(M, {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 3000, cache_read_input_tokens: 10000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    });
    assert.ok(c);
    // 1000×1.25 + 2000×2 + 10000×0.10 = 1250 + 4000 + 1000 = 6250 per 1e6
    close(c.usd, 0.00625);
  });

  it('missing usage field → cost unknown (absent is not zero)', () => {
    assert.equal(costFromUsage(M, { input_tokens: 5, output_tokens: 3 }), null);
    assert.equal(costFromUsage(M, undefined), null);
  });

  it('reservation bound uses the dearest input category and max_tokens', () => {
    // 1000 input × 2.00 + 100 output × 5.00 = 2500 per 1e6
    close(maxCostUsd(M, 1000, 100), 0.0025);
    // RV2-04: the input bound is the documented 200K context window, not a byte count
    assert.equal(maxInputTokensFor(M), 200_000);
    // 200 000 × 2.00 (1 h cache write, dearest input category) + 64 × 5.00 = 400 320 per 1e6
    close(maxCostUsd(M, maxInputTokensFor(M), 64), 0.40032);
    assert.throws(() => maxInputTokensFor('claude-opus-5'), (e: unknown) => e instanceof BudgetError && e.code === 'unknown_price');
  });

  it('model without verified price cannot be reserved', () => {
    const l = new BudgetLedger(tmpLedger(), 1);
    assert.throws(() => l.reserve('x', 'claude-opus-5', 10, 10), (e: unknown) => e instanceof BudgetError && e.code === 'unknown_price');
  });

  it('configured cap cannot raise the authorised ceiling', () => {
    assert.equal(new BudgetLedger(tmpLedger(), 50).capUsd, HARD_CAP_USD);
  });

  it('non-finite or negative cap is refused (NaN would disable every comparison)', () => {
    assert.throws(() => new BudgetLedger(tmpLedger(), Number.NaN), BudgetError);
    assert.throws(() => new BudgetLedger(tmpLedger(), -1), BudgetError);
  });

  it('cache split with only the 1h field: the rest is charged as 5m writes', () => {
    const c = costFromUsage(M, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 2000 } });
    assert.ok(c);
    close(c.usd, (1000 * 1.25 + 2000 * 2) / 1e6);
    // inconsistent split → unknown
    assert.equal(costFromUsage(M, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 10, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 50 } }), null);
  });
});

describe('pilot budget — settlement and persistence', () => {
  it('ok → usage cost; refused 401 → 0; timeout/5xx/missing usage → reservation kept', () => {
    const file = tmpLedger();
    const l = new BudgetLedger(file, 1);
    const a = l.reserve('ok', M, 1000, 100);
    const b = l.reserve('refused', M, 1000, 100);
    const c = l.reserve('timeout', M, 1000, 100);
    const d = l.reserve('5xx', M, 1000, 100);
    const e = l.reserve('no-usage', M, 1000, 100);
    const f = l.reserve('in-flight', M, 1000, 100);
    l.settle(a.id, { httpStatus: 200, usage: { input_tokens: 25, output_tokens: 15, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    l.settle(b.id, { httpStatus: 401, errorBody: true });
    l.settle(c.id, { note: 'timeout' });
    l.settle(d.id, { httpStatus: 529, errorBody: true });
    l.settle(e.id, { httpStatus: 200, usage: { input_tokens: 25 } });
    void f;
    const s = l.summary();
    assert.deepEqual([s.settledOk, s.refused, s.uncertain, s.open], [1, 1, 3, 1]);
    close(s.confirmedUsd, 0.0001);
    close(s.uncertainUsd, 3 * 0.0025);
    close(s.openUsd, 0.0025);
    close(s.exposureUsd, 0.0001 + 4 * 0.0025);
    // "Restart": a new instance reads the same file; nothing resets
    assert.deepEqual(new BudgetLedger(file, 1).summary(), s);
    assert.throws(() => l.settle(a.id, { httpStatus: 200 }), BudgetError, 'no double settlement');
  });

  it('reservation refused when exposure + reservation would pass the cap', () => {
    const l = new BudgetLedger(tmpLedger(), 0.006);
    l.reserve('1', M, 1000, 100); // 0.0025
    l.reserve('2', M, 1000, 100); // 0.0050
    assert.throws(() => l.reserve('3', M, 1000, 100), (e: unknown) => e instanceof BudgetError && e.code === 'cap_exceeded');
  });

  it('busy lock is not removed: reservation refused with lock_timeout', () => {
    const file = tmpLedger();
    fs.writeFileSync(`${file}.lock`, 'another-process');
    const l = new BudgetLedger(file, 1, 200);
    assert.throws(() => l.reserve('x', M, 10, 10), (e: unknown) => e instanceof BudgetError && e.code === 'lock_timeout');
    assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'another-process', 'foreign lock untouched');
  });
});

describe('pilot budget — concurrent processes', () => {
  it('8 processes race for 0.0025 each under a 0.01 cap: exactly 4 reservations', async () => {
    const file = tmpLedger();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const child = path.join(path.dirname(file), 'child.mts');
    const mod = path.resolve(here, '../../scripts/pilot/anthropic/budgetLedger.ts').replace(/\\/g, '/');
    fs.writeFileSync(child, `import { BudgetLedger } from 'file:///${mod.replace(/^\//, '')}';
const l = new BudgetLedger(${JSON.stringify(file)}, 0.01, 20000);
try { l.reserve('race', '${M}', 1000, 100); console.log('OK'); } catch (e) {
  // OTK-H1-FREEZE-01 F1.1: a non-budget error (seen once on Windows under full-suite load: EPERM) also reports the system
  // call and the file, so the next occurrence can be diagnosed; budget outcomes print just their code, as before
  console.log(e.syscall ? e.code + ':' + e.syscall + ':' + String(e.path ?? '').split(/[\\\\/]/).pop() : (e.code ?? 'ERR ' + e.message));
}
`);
    const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ['--import', 'tsx', child], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { out += d; });
      p.on('error', reject);
      p.on('close', () => resolve(out.trim()));
    })));
    assert.equal(outs.filter(o => o === 'OK').length, 4, outs.join(' | '));
    assert.equal(outs.filter(o => o === 'cap_exceeded').length, 4, outs.join(' | '));
    const s = new BudgetLedger(file, 0.01).summary();
    assert.equal(s.reservations, 4);
    close(s.openUsd, 0.01);
  });
});
