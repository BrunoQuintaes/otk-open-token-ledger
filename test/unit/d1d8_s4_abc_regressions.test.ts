/**
 * D1–D8 / S4 — regressions for the Codex audit findings ABC-01, ABC-02 and ABC-03
 * (docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/S4/input_audit/RELATORIO.md).
 *
 * Every scenario imports the candidate's own modules (never the A/B/C clones) and asserts the
 * corrected behaviour; on the merged-but-unfixed tree they fail (evidence in S4/S4_0/).
 * Expected values are computed by hand in the comments, not by the functions under test.
 *
 * Modules under test: `src/operations/spool.ts`, `src/operations/codec.ts`,
 * `src/operations/proxyDurable.ts`, `src/operations/transitions.ts`,
 * `src/providers/usage/normalizeUsage.ts` and `src/pricing/priceUsage.ts`.
 *
 * Strategy / partitions: spool recovery (torn tail then append, records before the tear kept,
 * corruption in the middle reported and quarantined, schema-invalid lines, append during
 * replay, crashes before the rename and between apply and rewrite, facts round trip); pricing
 * with a full table, a removed cache price (partial, never billed at the base rate), a
 * legitimate zero price, zero cached tokens, documented inheritance of the output price for
 * reasoning, and a partial quote through the codec; settlement of money when the price is
 * missing, partial, absent, zero or complete, and completion of a pending price exactly once.
 *
 * Needs: must be run from the repository root (reads
 * `test/fixtures/d1d8/b/price_table_illustrative_v1.json` by relative path); spool tests write to
 * fresh directories in the OS temporary folder. No database or network.
 *
 * Run just this file: `npx tsx --test test/unit/d1d8_s4_abc_regressions.test.ts`
 *
 * @module test/unit/d1d8_s4_abc_regressions.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MeasurementSpool } from '../../src/operations/spool.js';
import { encodeJson } from '../../src/operations/codec.js';
import { decodeFacts, patchFromFacts, type FinalFacts } from '../../src/operations/proxyDurable.js';
import { applyPatch } from '../../src/operations/transitions.js';
import { decodePrice } from '../../src/operations/codec.js';
import { normalizeUsage } from '../../src/providers/usage/normalizeUsage.js';
import { parsePriceTableV1, priceTableRef, priceUsageWithTable } from '../../src/pricing/priceUsage.js';
import type { DurableOperation, PriceQuote, VersionRef } from '../../src/types/d1d8/index.js';
import { admitReq, cuResult, usage } from '../fixtures/d1d8/c/builders.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'otkd1d8s4-spool-'));
const facts = (id: string): FinalFacts => ({ outcome: 'completed', usage: usage(10n, 5n), cu: null, price: null, delivery: 'delivered', providerRequestId: `p-${id}`, localCount: null, at: '2026-10-01T00:00:00.000Z' });
const rec = (id: string) => ({ id, key: { tenantId: 't', operationId: id }, patch: JSON.parse(encodeJson(facts(id))), localCount: null, enqueue: [] });

// ─────────────────────────────── ABC-01 ───────────────────────────────
describe('S4 ABC-01 — spool recovery after an interrupted write', () => {
  it('torn tail followed by a valid append: the new record is readable and replayed (audit vector)', async () => {
    const s = new MeasurementSpool(tmp(), 'audit');
    writeFileSync(s.file, '{"v":1,'); // crash in the middle of a previous append (never acknowledged)
    s.append(rec('valid-after-torn-tail'));
    assert.deepEqual(s.pending().map((r) => r.id), ['valid-after-torn-tail'], 'acknowledged append must be readable');
    const seen: string[] = [];
    const res = await s.replay(async (r) => { seen.push(r.id); return 'applied'; });
    assert.deepEqual(seen, ['valid-after-torn-tail']);
    assert.equal(res.applied, 1);
    assert.equal(res.left, 0);
  });

  it('records before the torn tail are preserved and the torn bytes are kept as evidence', () => {
    const dir = tmp();
    const s = new MeasurementSpool(dir, 'i');
    s.append(rec('a')); s.append(rec('b'));
    appendFileSync(s.file, '{"v":1,"id":"torn","key"');
    s.append(rec('c'));
    assert.deepEqual(s.pending().map((r) => r.id), ['a', 'b', 'c']);
    const q = s.quarantineFile;
    assert.ok(existsSync(q), 'quarantine file exists');
    const ev = readFileSync(q, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!['kind'], 'torn_tail');
    assert.equal(Buffer.from(String(ev[0]!['rawBase64']), 'base64').toString('utf8'), '{"v":1,"id":"torn","key"');
  });

  it('corruption in the middle is reported (not silently dropped), quarantined on replay, the rest applied', async () => {
    const s = new MeasurementSpool(tmp(), 'i');
    s.append(rec('a'));
    appendFileSync(s.file, '{"v":1,"id":"x" CORRUPTED\n'); // a complete (newline-terminated) but invalid line
    s.append(rec('c'));
    const ins = s.inspect();
    assert.deepEqual(ins.records.map((r) => r.id), ['a', 'c']);
    assert.equal(ins.corrupt.length, 1, 'middle corruption is visible');
    assert.equal(ins.tornTail, null, 'a terminated invalid line is not a torn tail');
    const res = await s.replay(async () => 'applied');
    assert.equal(res.applied, 2);
    assert.equal(res.corrupt, 1, 'replay result reports the corrupt line');
    assert.equal(res.left, 0);
    const ev = readFileSync(s.quarantineFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(ev.map((e) => e['kind']), ['corrupt_line']);
    assert.equal(s.inspect().corrupt.length, 0, 'moved out of the live file only after being kept as evidence');
  });

  it('schema-invalid JSON line counts as corruption, not as a record', () => {
    const s = new MeasurementSpool(tmp(), 'i');
    appendFileSync(s.file, '{"v":2,"id":5}\n');
    s.append(rec('ok'));
    const ins = s.inspect();
    assert.deepEqual(ins.records.map((r) => r.id), ['ok']);
    assert.equal(ins.corrupt.length, 1);
  });

  it('append during replay is kept; replay again does not apply twice', async () => {
    const s = new MeasurementSpool(tmp(), 'i');
    s.append(rec('a'));
    const applied = new Set<string>();
    const apply = async (r: { id: string }) => {
      if (applied.has(r.id)) return 'already' as const;
      applied.add(r.id);
      if (r.id === 'a') s.append(rec('during'));
      return 'applied' as const;
    };
    const r1 = await s.replay(apply);
    assert.equal(r1.applied, 1);
    assert.deepEqual(s.pending().map((r) => r.id), ['during']);
    const r2 = await s.replay(apply);
    assert.equal(r2.applied, 1);
    const r3 = await s.replay(apply);
    assert.deepEqual([r3.applied, r3.already, r3.left], [0, 0, 0]);
  });

  it('crash after the rewrite temp file is written but before rename: restart keeps every record', async () => {
    const dir = tmp();
    const s = new MeasurementSpool(dir, 'i');
    s.append(rec('a')); s.append(rec('b'));
    writeFileSync(`${s.file}.tmp`, ''); // replay applied everything, then died before renaming
    const s2 = new MeasurementSpool(dir, 'i'); // restart
    assert.deepEqual(s2.pending().map((r) => r.id), ['a', 'b']);
    assert.ok(!readdirSync(dir).includes(path.basename(`${s.file}.tmp`)), 'stale temp file removed at open');
  });

  it('crash between apply and rewrite: the second replay sees the records again and the store answers already', async () => {
    const s = new MeasurementSpool(tmp(), 'i');
    s.append(rec('a'));
    const store = new Set<string>();
    // first replay: apply succeeds, then the process "dies" before the rewrite (simulated by throwing from the
    // last step is not possible from outside, so we re-open a copy of the file taken before the rewrite)
    const before = readFileSync(s.file);
    await s.replay(async (r) => { store.add(r.id); return 'applied'; });
    writeFileSync(s.file, before);
    const r2 = await s.replay(async (r) => (store.has(r.id) ? 'already' : 'applied'));
    assert.deepEqual([r2.applied, r2.already, r2.left], [0, 1, 0]);
    assert.equal(store.size, 1);
  });

  it('decodeFacts round trip of a spooled record survives the recovery path', () => {
    const s = new MeasurementSpool(tmp(), 'i');
    writeFileSync(s.file, '{"v"');
    s.append(rec('a'));
    assert.deepEqual(decodeFacts(s.pending()[0]!.patch), facts('a'));
  });
});

// ─────────────────────────────── ABC-02 ───────────────────────────────
describe('S4 ABC-02 — category without a price is never billed at the base rate', () => {
  const raw = JSON.parse(readFileSync('test/fixtures/d1d8/b/price_table_illustrative_v1.json', 'utf8'));
  const full = parsePriceTableV1(raw);
  const noCache = parsePriceTableV1({ ...raw, version: 'no-cache-read', entries: raw.entries.filter((e: { category: string }) => e.category !== 'input_cache_read') });
  const at = '2026-09-30T12:00:00.000Z';
  const u = normalizeUsage('openai.chat_completions',
    { model: 'gpt-4o-mini', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 } } },
    { provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_response', observedAt: at });

  it('full table: 20×0.15 + 20×0.60 + 80×0.075 µUSD = 3 000 000 + 12 000 000 + 6 000 000 = 21 000 000 pico-USD, priced', () => {
    const q = priceUsageWithTable(u, at, full, priceTableRef(full));
    assert.equal(q.status, 'priced');
    assert.equal(q.total!.units, 21_000_000n);
  });

  it('cache price removed: partial with the cache line unpriced (null unit price), never 27 000 000 priced', () => {
    const q = priceUsageWithTable(u, at, noCache, priceTableRef(noCache));
    assert.notEqual(q.status, 'priced');
    assert.equal(q.status, 'partial');
    // known subtotal: input 20 × 150 000 + output 20 × 600 000 µUSD/MTok = 15 000 000 pico-USD (NOT a final total)
    assert.equal(q.total!.units, 15_000_000n);
    const cache = q.lines.find((l) => l.category === 'input_cache_read');
    assert.ok(cache, 'the cache tokens appear as their own unpriced line');
    assert.equal(cache!.count, 80n);
    assert.equal(cache!.amount, null);
    assert.equal(cache!.unitPricePerMTok, null, 'contract 1.1.0: unknown unit price is null, not a placeholder 0');
    assert.equal(q.lines.find((l) => l.category === 'input')!.count, 20n, 'cache tokens are not billed again in the base line');
  });

  it('legitimate zero price is priced (0 ≠ unknown)', () => {
    const zero = parsePriceTableV1({ ...raw, version: 'zero-cache', entries: raw.entries.map((e: { category: string }) => (e.category === 'input_cache_read' ? { ...e, pricePerMTokMicroUsd: '0' } : e)) });
    const q = priceUsageWithTable(u, at, zero, priceTableRef(zero));
    assert.equal(q.status, 'priced');
    assert.equal(q.total!.units, 15_000_000n);
    const cache = q.lines.find((l) => l.category === 'input_cache_read')!;
    assert.equal(cache.amount!.units, 0n);
    assert.equal(cache.unitPricePerMTok!.units, 0n);
  });

  it('zero cached tokens need no cache price', () => {
    const u0 = normalizeUsage('openai.chat_completions',
      { model: 'gpt-4o-mini', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 0 } } },
      { provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_response', observedAt: at });
    const q = priceUsageWithTable(u0, at, noCache, priceTableRef(noCache));
    assert.equal(q.status, 'priced');
    assert.equal(q.total!.units, 100n * 150_000n + 20n * 600_000n);
  });

  it('inheritance only by explicit versioned policy: OpenAI reasoning is billed as output (documented), recorded in the quote', () => {
    const ur = normalizeUsage('openai.chat_completions',
      { model: 'gpt-4o-mini', usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40, completion_tokens_details: { reasoning_tokens: 25 } } },
      { provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_response', observedAt: at });
    const q = priceUsageWithTable(ur, at, full, priceTableRef(full));
    assert.equal(q.status, 'priced');
    assert.equal(q.total!.units, 10n * 150_000n + 30n * 600_000n);
    assert.match(String(q.categoryPolicy), /^otk\.price_category_policy\.v1/);
  });

  it('partial quote survives the persistence codec with null unit price', () => {
    const q = priceUsageWithTable(u, at, noCache, priceTableRef(noCache));
    const back = decodePrice(JSON.parse(encodeJson(q)));
    assert.deepEqual(back, q);
  });
});

// ─────────────────────────────── ABC-03 ───────────────────────────────
describe('S4 ABC-03 — reservation or subtotal is never settled as money spent', () => {
  const at = '2026-10-01T12:00:00.000Z';
  const tableRef: VersionRef = { version: 'audit', digest: `0x${'11'.repeat(32)}` };
  const reservedPico = 100_000_000_000n; // US$ 0.10 reserved (worst case)
  const cur: DurableOperation = {
    ...(admitReq({ tenantId: 'audit', operationId: 'price' }, 10n, { money: reservedPico }) as unknown as DurableOperation),
    schema: 'otk.operation.v1', providerRequestId: null, execution: 'upstream_started', measurement: 'none', delivery: 'streaming', usage: null, cancellation: null,
    effects: { receiptDigest: null, conferenceDigest: null, debitApplied: false, proofJobId: null }, revision: 1n, createdAt: at, updatedAt: at,
    money: { state: 'held', reserved: { units: reservedPico, scale: 1_000_000_000_000n, currency: 'USD' }, confirmed: null, knownSubtotal: null, priceStatus: null, priceTable: null },
  } as DurableOperation;
  const base = { outcome: 'completed' as const, usage: usage(10n, 2n), cu: cuResult(5n), delivery: 'delivered' as const, providerRequestId: 'prov-1', localCount: null, at };
  const quote = (status: PriceQuote['status'], units: bigint | null): PriceQuote => ({ schema: 'otk.price_quote.v1', status, total: units === null ? null : { units, scale: 1_000_000_000_000n, currency: 'USD' }, lines: [], priceTable: tableRef, pricedAt: at });

  it('missing_price: CU settles, money stays pending with the reservation held (audit vector: was settled at US$ 0.10)', () => {
    const next = applyPatch(cur, patchFromFacts(cur, { ...base, price: quote('missing_price', null) }));
    assert.equal(next.reservation.state, 'settled', 'CU/quota settlement is independent of price');
    assert.equal(next.measurement, 'final');
    assert.equal(next.money!.state, 'pending_price');
    assert.equal(next.money!.confirmed, null, 'no money confirmed');
    assert.equal(next.money!.reserved.units, reservedPico, 'exposure kept');
  });

  it('partial: subtotal is informative only, never settled (audit vector: was settled at US$ 0.02)', () => {
    const next = applyPatch(cur, patchFromFacts(cur, { ...base, price: quote('partial', 20_000_000_000n) }));
    assert.equal(next.money!.state, 'pending_price');
    assert.equal(next.money!.confirmed, null);
    assert.equal(next.money!.knownSubtotal!.units, 20_000_000_000n);
  });

  it('no price at all (no table frozen): pending, not settled at the reservation', () => {
    const next = applyPatch(cur, patchFromFacts(cur, { ...base, price: null }));
    assert.equal(next.money!.state, 'pending_price');
    assert.equal(next.money!.priceStatus, null);
  });

  it('legitimate zero: settled at 0', () => {
    const next = applyPatch(cur, patchFromFacts(cur, { ...base, price: quote('priced', 0n) }));
    assert.equal(next.money!.state, 'settled');
    assert.equal(next.money!.confirmed!.units, 0n);
  });

  it('complete price: settled at the quoted total', () => {
    const next = applyPatch(cur, patchFromFacts(cur, { ...base, price: quote('priced', 30_000_000_000n) }));
    assert.equal(next.money!.state, 'settled');
    assert.equal(next.money!.confirmed!.units, 30_000_000_000n);
    assert.equal(next.reservation.money!.units, reservedPico, 'reservation keeps the reserved amount; confirmed money is separate');
  });

  it('pending price can be completed later exactly once (no new inference: same usage)', () => {
    const pending = applyPatch(cur, patchFromFacts(cur, { ...base, price: quote('missing_price', null) }));
    const settledLater = applyPatch(pending, { money: { ...pending.money!, state: 'settled', confirmed: quote('priced', 7n).total, priceStatus: 'priced', knownSubtotal: null, priceTable: tableRef } });
    assert.equal(settledLater.money!.state, 'settled');
    assert.throws(() => applyPatch(settledLater, { money: { ...settledLater.money!, confirmed: quote('priced', 8n).total } }), /money/);
    // writing the same final facts again (spool replay) does not touch money or CU
    assert.deepEqual(patchFromFacts(settledLater, { ...base, price: quote('missing_price', null) }), {});
  });
});
