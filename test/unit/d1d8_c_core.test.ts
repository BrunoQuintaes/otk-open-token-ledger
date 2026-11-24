/**
 * D1–D8 / C — pure pieces of the durable operation model: DDL ↔ migration files, accounting
 * scales and the two admission rules (hand vectors), state machine, codec round trip, ids.
 * No database here; the stores are exercised against real PostgreSQL in test/services/.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1D8_COLUMNS, D1D8_MIGRATIONS, D1D8_RELATIONS } from '../../src/operations/schema.js';
import { ACCOUNTING_SCALE, MONEY_SCALE, ScaleLossError, admitByMoney, admitByQuota, quotaUnits, settlementPolicy, toAccountingUnits, toMoneyUnits } from '../../src/operations/accounting.js';
import { applyPatch, IllegalTransitionError } from '../../src/operations/transitions.js';
import { big, decodeConference, decodeReceiptV3, decodeUsage, encodeJson, CodecError } from '../../src/operations/codec.js';
import { effectId, requestDigest } from '../../src/operations/ids.js';
import type { DurableOperation } from '../../src/types/d1d8/index.js';
import { CONFIG, CU, conference, receiptV3, reservation, usage } from '../fixtures/d1d8/c/builders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Top-level SQL statements (split on ';' outside $tag$…$tag$ bodies), `--` comments removed first. */
function sqlStatements(text: string): string[] {
  const sql = text.replace(/--.*$/gm, '');
  const out: string[] = [];
  let cur = '';
  let tag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    if (tag) {
      if (sql.startsWith(tag, i)) { cur += tag; i += tag.length - 1; tag = null; } else cur += sql[i];
      continue;
    }
    const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
    if (m) { tag = m[0]; cur += tag; i += tag.length - 1; continue; }
    if (sql[i] === ';') { out.push(cur); cur = ''; } else cur += sql[i];
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

describe('D1D8-C schema: migration files are the canonical DDL', () => {
  for (const m of D1D8_MIGRATIONS) {
    it(`scripts/migrations/${m.version}.sql equals src/operations/schema.ts`, () => {
      const file = readFileSync(path.join(ROOT, 'scripts', 'migrations', `${m.version}.sql`), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(file, m.sql);
    });
  }
  it('D1D8_RELATIONS lists exactly the relations the DDL creates (boot skips DDL only when all exist)', () => {
    const names = D1D8_MIGRATIONS.flatMap((m) => [...m.sql.matchAll(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map((x) => x[1]!));
    assert.deepEqual([...names].sort(), [...D1D8_RELATIONS].sort());
  });
  it('D1D8_COLUMNS lists exactly the columns added by column-only migrations (boot must also see those)', () => {
    const columnOnly = D1D8_MIGRATIONS.filter((m) => !/CREATE (TABLE|INDEX) IF NOT EXISTS/.test(m.sql));
    const added = columnOnly.flatMap((m) => [...m.sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map((x) => `${x[1]}.${x[2]}`));
    assert.deepEqual([...added].sort(), D1D8_COLUMNS.map((c) => `${c.table}.${c.column}`).sort());
  });
  it('only new versions 100–149 (C) and 150–199 (S4), all idempotent', () => {
    for (const m of D1D8_MIGRATIONS) {
      assert.match(m.version, /^1[0-9][0-9]_/);
      for (const stmt of sqlStatements(m.sql)) {
        if (/^1[0-4][0-9]_/.test(m.version)) assert.match(stmt, /^CREATE (TABLE|INDEX) IF NOT EXISTS /, stmt.slice(0, 60));
        // S4 (ABC-03/04): additive columns and a backfill guarded by its own WHERE are also idempotent
        else if (m.version.startsWith('150_')) assert.match(stmt, /^(CREATE (TABLE|INDEX) IF NOT EXISTS |ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS |UPDATE otk_operations SET money = [\s\S]*WHERE money IS NULL AND reserved_money IS NOT NULL$)/, stmt.slice(0, 60));
        // fechamento pós-S5 (RV2-01/02): also replaceable functions/triggers, column defaults/NOT NULL and the
        // money_policy backfill guarded by its own WHERE — re-running any of them changes nothing
        else assert.match(stmt, /^(CREATE (TABLE|INDEX) IF NOT EXISTS |ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS |ALTER TABLE \w+ ALTER COLUMN \w+ SET (DEFAULT '[^']*'|NOT NULL)$|CREATE OR REPLACE (FUNCTION|TRIGGER) \w+|UPDATE otk_money_budget SET money_policy = '[^']*' WHERE money_policy IS NULL$)/, stmt.slice(0, 60));
      }
    }
  });
  it('the statement splitter keeps dollar-quoted bodies whole', () => {
    assert.deepEqual(sqlStatements("CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN PERFORM 1; END $fn$;\n-- a comment; with a semicolon\nSELECT 2;"),
      ['CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN PERFORM 1; END $fn$', 'SELECT 2']);
  });
});

describe('D1D8-C accounting scales (exact or refused)', () => {
  it('legacy integer CU (scale 1) → micro-CU exactly; micro-CU stays', () => {
    assert.equal(toAccountingUnits({ units: 3000n, scale: 1n }), 3_000_000_000n);
    assert.equal(toAccountingUnits({ units: 400_000n, scale: 1_000_000n }), 400_000n); // 0.4 CU (B: CU-03)
  });
  it('a finer scale that would lose digits is refused, an exact one converts', () => {
    assert.throws(() => toAccountingUnits({ units: 1n, scale: 10_000_000n }), ScaleLossError);
    assert.equal(toAccountingUnits({ units: 10n, scale: 10_000_000n }), 1n);
    assert.throws(() => toAccountingUnits({ units: 1n, scale: 3n }), ScaleLossError);
    assert.throws(() => toAccountingUnits({ units: -1n, scale: 1n }), RangeError);
  });
  it('money to pico-USD; quota 0 = unlimited', () => {
    assert.equal(toMoneyUnits({ units: 3n, scale: 1n, currency: 'USD' }), 3n * MONEY_SCALE);
    assert.equal(quotaUnits(0n), null);
    assert.equal(quotaUnits(10_000n), 10_000n * ACCOUNTING_SCALE);
  });
});

describe('D1D8-C quota rule check_before_crossing_admitted@1 (hand vector D7-G07)', () => {
  it('quota 10 000, requests of 3 000 in sequence: 0, 3 000, 6 000, 9 000 admitted; 12 000 refused', () => {
    const quota = quotaUnits(10_000n);
    const step = 3_000n * ACCOUNTING_SCALE;
    let held = 0n; const admitted: bigint[] = [];
    for (let i = 0; i < 20; i++) {
      if (admitByQuota(0n, held, quota)) { admitted.push(held); held += step; }
    }
    assert.deepEqual(admitted.map((x) => x / ACCOUNTING_SCALE), [0n, 3000n, 6000n, 9000n]);
    assert.equal(held / ACCOUNTING_SCALE, 12_000n);
  });
});

describe('D1D8-C money rule strict_ceiling_worst_case@1', () => {
  it('ceiling US$ 1.00, worst cases of US$ 0.40: two admitted (0.80), third (1.20) refused', () => {
    const c = 1n * MONEY_SCALE; const w = 40n * MONEY_SCALE / 100n;
    assert.equal(admitByMoney(0n, 0n, w, c), true);
    assert.equal(admitByMoney(0n, w, w, c), true);
    assert.equal(admitByMoney(0n, 2n * w, w, c), false);
    assert.equal(admitByMoney(0n, 0n, 100n * MONEY_SCALE / 100n, c), true, 'exactly at the ceiling is allowed (≤)');
  });
  it('unknown worst case under a ceiling is refused, never treated as zero', () => {
    assert.equal(admitByMoney(0n, 0n, null, 1n * MONEY_SCALE), false);
  });
  it('settlement policy flags an excess over the reservation without truncating it', () => {
    assert.equal(settlementPolicy(100n, 120n), 'excess_over_reservation');
    assert.equal(settlementPolicy(100n, 100n), 'within_reservation');
  });
});

function op(over: Partial<DurableOperation> = {}): DurableOperation {
  return {
    schema: 'otk.operation.v1', key: { tenantId: 't', operationId: 'o' }, requestDigest: `0x${'aa'.repeat(32)}`,
    provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-4o-mini', config: CONFIG,
    limits: { maxOutputTokens: 10n, maxDurationMs: 1000n, maxCost: null }, reservation: reservation(10n),
    providerRequestId: null, execution: 'admitted', measurement: 'none', delivery: 'pending', usage: null, cancellation: null,
    effects: { receiptDigest: null, conferenceDigest: null, debitApplied: false, proofJobId: null },
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', revision: 0n, ...over,
  };
}

describe('D1D8-C state machine (D7 §1–3)', () => {
  it('completed with final usage settles; settled requires final', () => {
    const started = applyPatch(op(), { execution: 'upstream_started' });
    const done = applyPatch(started, { execution: 'completed', measurement: 'final', usage: usage(100n, 20n), reservation: { ...reservation(48n), state: 'settled' } });
    assert.equal(done.reservation.state, 'settled');
    assert.throws(() => applyPatch(started, { reservation: { ...reservation(48n), state: 'settled' } }), IllegalTransitionError);
  });
  it('partial usage never becomes final; cancel without final usage keeps exposure (held_uncertain)', () => {
    const started = applyPatch(op(), { execution: 'upstream_started' });
    const partial = { ...usage(100n, 7n), completeness: 'partial' as const };
    assert.throws(() => applyPatch(started, { measurement: 'final', usage: partial }), IllegalTransitionError);
    assert.throws(() => applyPatch(started, { execution: 'cancelled' }), IllegalTransitionError, 'an explicit cancel is requested first');
    const requested = applyPatch(started, { execution: 'cancel_requested' });
    assert.throws(() => applyPatch(requested, { execution: 'cancelled', measurement: 'partial', usage: partial }), IllegalTransitionError, 'a plain hold is not allowed after a terminal execution without final usage');
    const cancelled = applyPatch(requested, { execution: 'cancelled', measurement: 'partial', usage: partial, reservation: { ...requested.reservation, state: 'held_uncertain' } });
    assert.equal(cancelled.reservation.state, 'held_uncertain');
    assert.throws(() => applyPatch(cancelled, { reservation: { ...cancelled.reservation, state: 'released' } }), IllegalTransitionError, 'uncertain exposure is never released');
  });
  it('client disconnect changes delivery only; upstream failure is uncertain, not zero', () => {
    const started = applyPatch(op(), { execution: 'upstream_started', delivery: 'streaming' });
    const gone = applyPatch(started, { delivery: 'client_disconnected' });
    assert.equal(gone.execution, 'upstream_started');
    assert.equal(gone.measurement, 'none');
    assert.throws(() => applyPatch(gone, { delivery: 'delivered' }), IllegalTransitionError);
    const failed = applyPatch(gone, { execution: 'upstream_failed', measurement: 'uncertain', reservation: { ...gone.reservation, state: 'held_uncertain' } });
    assert.equal(failed.usage, null);
  });
  it('a late measurement (spool replay) may settle an uncertain operation; final usage is immutable', () => {
    const lost = applyPatch(applyPatch(op(), { execution: 'upstream_started' }), { execution: 'process_lost', measurement: 'uncertain', reservation: { ...reservation(10n), state: 'held_uncertain' } });
    const settled = applyPatch(lost, { measurement: 'final', usage: usage(1n, 1n), reservation: { ...reservation(1n), state: 'settled' } });
    assert.equal(settled.execution, 'process_lost');
    assert.throws(() => applyPatch(settled, { usage: usage(2n, 2n) }), IllegalTransitionError);
  });
  it('released only when nothing was measured; write-once fields', () => {
    const released = applyPatch(op(), { execution: 'process_lost', reservation: { ...reservation(10n), state: 'released' } });
    assert.equal(released.measurement, 'none');
    const withId = applyPatch(op(), { providerRequestId: 'p1' });
    assert.throws(() => applyPatch(withId, { providerRequestId: 'p2' }), IllegalTransitionError);
  });
});

describe('D1D8-C codec: bigint as decimal strings, unknown additive fields preserved', () => {
  it('usage round trip keeps null vs 0 and a 1.1.0 additive field (issues)', () => {
    const u = usage(0n, 5n, { issues: [{ kind: 'invalid', field: 'usage.x' }] });
    const back = decodeUsage(JSON.parse(encodeJson(u)));
    assert.deepEqual(back, u);
    assert.equal(back.categories[2]!.count, null);
    assert.equal(back.categories[0]!.count, 0n);
  });
  it('receipt v3 and conference report round trip exactly', () => {
    const r = receiptV3({ tenantId: 'a', operationId: '1' });
    assert.deepEqual(decodeReceiptV3(JSON.parse(encodeJson(r))), r);
    const c = { ...conference({ tenantId: 'a', operationId: '1' }, `0x${'55'.repeat(32)}`), support: 'exact', catalogVersion: 'c1' };
    assert.deepEqual(decodeConference(JSON.parse(encodeJson(c))), c);
  });
  it('strict integers: empty string or float text never become 0n', () => {
    assert.throws(() => big('', 'x'), CodecError);
    assert.throws(() => big('1e3', 'x'), CodecError);
    assert.equal(big('-12', 'x'), -12n);
  });
  it('JSON never contains undefined and bigint travels as string', () => {
    assert.equal(encodeJson({ a: 1n, b: undefined, c: CU(1n) }), '{"a":"1","c":{"units":"1000000","scale":"1000000"}}');
  });
});

describe('review M3: receipt effects and operation effects never share an id', () => {
  it('legacy receipt X and operation X of the same tenant → different effect ids', async () => {
    const { legacyKey } = await import('../../src/api/PostgresReceiptStore.js');
    assert.notEqual(effectId('project_redis', legacyKey('t', 'X')), effectId('project_redis', { tenantId: 't', operationId: 'X' }));
  });
});

describe('review H2: no terminal execution keeps a plain hold', () => {
  it('completed + final usage + held is refused; held_uncertain with final usage (CU not computable) is accepted', () => {
    const started = applyPatch(op(), { execution: 'upstream_started' });
    assert.throws(() => applyPatch(started, { execution: 'completed', measurement: 'final', usage: usage(1n, 1n) }), IllegalTransitionError);
    const kept = applyPatch(started, { execution: 'completed', measurement: 'final', usage: usage(1n, 1n), reservation: { ...started.reservation, state: 'held_uncertain' } });
    assert.equal(kept.reservation.state, 'held_uncertain');
  });
});

describe('D1D8-C identities', () => {
  it('effect ids separate tenants and cannot collide through ":"', () => {
    assert.notEqual(effectId('persist_receipt', { tenantId: 'a:b', operationId: 'c' }), effectId('persist_receipt', { tenantId: 'a', operationId: 'b:c' }));
  });
  it('request digest depends on metering fields, not on prompt text', () => {
    const f = { provider: 'openai', api: 'openai.chat_completions', path: '/v1/chat/completions', modelRequested: 'gpt-4o', maxOutputTokens: 100n, stream: false, bodyBytes: 42 };
    assert.equal(requestDigest(f), requestDigest({ ...f }));
    assert.notEqual(requestDigest(f), requestDigest({ ...f, modelRequested: 'gpt-4o-mini' }));
    assert.match(requestDigest(f), /^0x[0-9a-f]{64}$/);
  });
});
