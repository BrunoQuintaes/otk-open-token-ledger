/**
 * Phase 10 reconciliation — exact decimals, explicit timezones and lossless readers.
 *
 * Modules under test: `src/reconciliation/decimal.ts`, `src/reconciliation/time.ts` and
 * `src/reconciliation/parse.ts`.
 *
 * Strategy / partitions: decimals (exact lexemes and exponents, refused non-decimals, rescale and half-even
 * rounding, the zero rule of the relative difference); timestamps (instants with a zone, naive values with and
 * without a declared zone, DST gaps and folds, local day bounds across DST); CSV and JSON readers (quoting,
 * CRLF, preamble, mismatched records, number lexemes).
 *
 * Needs: nothing external (pure functions).
 *
 * Run just this file: `npx tsx --test test/unit/reconciliation_parsing.test.ts`
 *
 * @module test/unit/reconciliation_parsing.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimal, parseIntegerQuantity, relDiffPercent, rescale, roundHalfEvenToScale, toDecimalString, DecimalParseError } from '../../src/reconciliation/decimal.js';
import { dayInZone, parseInstant, parseLocalDay, TimestampError } from '../../src/reconciliation/time.js';
import { JsonNumber, parseCsv, parseJsonLossless, getPath, StatementParseError } from '../../src/reconciliation/parse.js';

describe('reconciliation decimal (no float ever carries money)', () => {
  it('parses lexemes exactly, including JSON-float exponents and cents', () => {
    assert.deepEqual(parseDecimal('0.000036').amount, { units: 36n, scale: 1_000_000n });
    assert.deepEqual(parseDecimal('3.6e-06').amount, { units: 36n, scale: 10_000_000n });
    assert.deepEqual(parseDecimal('-2.82e-05').amount, { units: -282n, scale: 10_000_000n });
    assert.deepEqual(parseDecimal('1e3').amount, { units: 1000n, scale: 1n });
    assert.equal(parseDecimal('123.78912').msdExponent, 2);
    // 0.1 + 0.2 in binary float is 0.30000000000000004; here it is exact
    const a = parseDecimal('0.1').amount; const b = parseDecimal('0.2').amount;
    assert.equal(toDecimalString({ units: rescale(a, 10n).units + rescale(b, 10n).units, scale: 10n }), '0.3');
  });

  it('refuses anything that is not a plain decimal (no guessing)', () => {
    for (const bad of ['', ' ', 'NaN', 'Infinity', '1,000.00', '$1', '.', 'e5', '0x10']) assert.throws(() => parseDecimal(bad), DecimalParseError, bad);
    assert.equal(parseIntegerQuantity('1549.0'), 1549n);
    assert.throws(() => parseIntegerQuantity('1549.5'), DecimalParseError);
  });

  it('rescale never drops digits; half-even rounding reports what it lost', () => {
    assert.throws(() => rescale({ units: 1234n, scale: 1000n }, 100n), /lose digits/);
    const r = roundHalfEvenToScale(parseDecimal('0.0008320000000000001').amount, 1_000_000_000_000n);
    assert.deepEqual(r, { amount: { units: 832_000_000n, scale: 1_000_000_000_000n }, lostHalfUnits: 1n });
    assert.deepEqual(roundHalfEvenToScale({ units: 25n, scale: 10n }, 1n).amount, { units: 2n, scale: 1n });
    assert.deepEqual(roundHalfEvenToScale({ units: 35n, scale: 10n }, 1n).amount, { units: 4n, scale: 1n });
    assert.equal(roundHalfEvenToScale({ units: 36n, scale: 1_000_000n }, 1_000_000_000_000n).lostHalfUnits, 0n);
  });

  it('relative difference: explicit rule for zero', () => {
    assert.equal(relDiffPercent({ units: 0n, scale: 1n }, { units: 0n, scale: 1n }), '0.000000%');
    assert.equal(relDiffPercent({ units: 5n, scale: 1n }, { units: 0n, scale: 1n }), null);
    assert.equal(relDiffPercent({ units: -1n, scale: 1n }, { units: 3n, scale: 1n }), '33.333333%');
  });
});

describe('reconciliation timestamps (explicit timezone handling)', () => {
  it('values with Z, an offset or " UTC" are instants', () => {
    assert.equal(parseInstant('2026-10-04T03:00:00Z', null), '2026-10-04T03:00:00.000Z');
    assert.equal(parseInstant('2026-10-03T20:00:00-07:00', null), '2026-10-04T03:00:00.000Z');
    assert.equal(parseInstant('2026-10-04 03:00:00 UTC', null), '2026-10-04T03:00:00.000Z');
    assert.equal(parseInstant('1791072000', null, 'unix_seconds'), '2026-10-04T00:00:00.000Z');
  });

  it('naive date-times and dates are REJECTED unless a timezone is declared', () => {
    assert.throws(() => parseInstant('2026-10-04 03:00:00', null), (e: unknown) => e instanceof TimestampError && e.code === 'AMBIGUOUS_TIMESTAMP');
    assert.throws(() => parseInstant('2026-10-04', null), (e: unknown) => e instanceof TimestampError && e.code === 'AMBIGUOUS_TIMESTAMP');
    assert.equal(parseInstant('2026-10-04 03:00:00', 'America/Sao_Paulo'), '2026-10-04T06:00:00.000Z');
    assert.equal(parseInstant('2026-10-04 03:00:00', '+05:30'), '2026-10-03T21:30:00.000Z');
  });

  it('a declared IANA zone refuses DST gaps and folds instead of guessing', () => {
    assert.throws(() => parseInstant('2026-03-08 02:30:00', 'America/Los_Angeles'), (e: unknown) => e instanceof TimestampError && e.code === 'NONEXISTENT_LOCAL_TIME');
    assert.throws(() => parseInstant('2026-11-01 01:30:00', 'America/Los_Angeles'), (e: unknown) => e instanceof TimestampError && e.code === 'AMBIGUOUS_LOCAL_TIME');
    assert.throws(() => parseInstant('2026-10-04 03:00:00', 'Mars/Olympus'), (e: unknown) => e instanceof TimestampError && e.code === 'INVALID_TIMEZONE');
  });

  it('a local day is [local midnight, next local midnight), also across DST', () => {
    assert.deepEqual(parseLocalDay('2026-10-03', 'America/Los_Angeles'), { start: '2026-10-03T07:00:00.000Z', end: '2026-10-04T07:00:00.000Z' });
    const dstDay = parseLocalDay('2026-11-01', 'America/Los_Angeles');
    assert.equal(Date.parse(dstDay.end) - Date.parse(dstDay.start), 25 * 3_600_000);
    assert.equal(dayInZone('2026-10-04T03:57:22.000Z', 'America/Los_Angeles').day, '2026-10-03');
    assert.equal(dayInZone('2026-10-04T03:57:22.000Z', 'UTC').day, '2026-10-04');
  });
});

describe('reconciliation readers', () => {
  it('CSV: quotes, doubled quotes, CRLF, preamble marker; mismatched records refused', () => {
    const t = parseCsv('# SYNTHETIC marker\r\na,b,c\r\n"x, y","say ""hi""",\r\n1,2,3');
    assert.deepEqual(t.preamble, ['SYNTHETIC marker']);
    assert.deepEqual(t.header, ['a', 'b', 'c']);
    assert.deepEqual(t.rows, [['x, y', 'say "hi"', ''], ['1', '2', '3']]);
    assert.throws(() => parseCsv('a,b\n1,2,3\n'), StatementParseError);
    assert.throws(() => parseCsv('a,a\n1,2\n'), /duplicated column/);
  });

  it('JSON: numbers keep their source lexeme (no binary float)', () => {
    const v = parseJsonLossless('{"amount":{"value":0.00012209999999999999,"currency":"usd"},"n":3.6e-06}');
    const val = getPath(v, 'amount.value');
    assert.ok(val instanceof JsonNumber);
    assert.equal((val as JsonNumber).lexeme, '0.00012209999999999999');
    assert.equal((getPath(v, 'n') as JsonNumber).lexeme, '3.6e-06');
    assert.throws(() => parseJsonLossless('{"a":1,"a":2}'), /duplicated key/);
    assert.throws(() => parseJsonLossless('{"a":1} x'), /trailing/);
  });
});
