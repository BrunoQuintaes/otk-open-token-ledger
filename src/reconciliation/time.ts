/**
 * Explicit timestamp handling for provider exports.
 *
 * Rules:
 *  - a timestamp with 'Z', a numeric offset or a trailing ' UTC' is an instant and is used as is;
 *  - a naive date-time or a date-only value has NO instant until a timezone is declared by the mapping
 *    (or the caller); without one it is rejected (AMBIGUOUS_TIMESTAMP), never assumed to be UTC;
 *  - with a declared IANA zone, a local time that does not exist (DST gap) or exists twice (DST fold)
 *    is rejected too (NONEXISTENT_LOCAL_TIME / AMBIGUOUS_LOCAL_TIME);
 *  - unix seconds are UTC by definition.
 *
 * @module reconciliation/time
 */
import type { IsoUtc } from './types.js';

export type TimestampErrorCode = 'AMBIGUOUS_TIMESTAMP' | 'INVALID_TIMESTAMP' | 'NONEXISTENT_LOCAL_TIME' | 'AMBIGUOUS_LOCAL_TIME' | 'INVALID_TIMEZONE';

export class TimestampError extends Error {
  constructor(public readonly code: TimestampErrorCode, message: string) { super(`${code}: ${message}`); this.name = 'TimestampError'; }
}

const ISO_WITH_ZONE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/i;
const BQ_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)? UTC$/;
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_TZ_RE = /^([+-])(\d{2}):?(\d{2})$/;

interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number }

function checkedWall(w: Wall, lexeme: string): Wall {
  const back = new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, w.ms));
  if (back.getUTCFullYear() !== w.y || back.getUTCMonth() !== w.mo - 1 || back.getUTCDate() !== w.d || w.h > 23 || w.mi > 59 || w.s > 59) {
    throw new TimestampError('INVALID_TIMESTAMP', `not a calendar date-time: ${lexeme}`);
  }
  return w;
}

function wallFrom(m: RegExpExecArray): Wall {
  const frac = (m[7] ?? '').padEnd(3, '0').slice(0, 3);
  return checkedWall({ y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]!, s: m[6] ? +m[6] : 0, ms: frac ? +frac : 0 }, m[0]);
}

const wallUtcMs = (w: Wall): number => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s, w.ms);

export const toIso = (ms: number): IsoUtc => new Date(ms).toISOString();

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      throw new TimestampError('INVALID_TIMEZONE', `unknown timezone ${JSON.stringify(tz)}`);
    }
    fmtCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of an IANA zone at a UTC instant: wall(instant) - instant. */
function zoneOffsetMs(tz: string, instantMs: number): number {
  const parts = zoneFormatter(tz).formatToParts(new Date(instantMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wall = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return wall - (instantMs - (((instantMs % 1000) + 1000) % 1000));
}

/** Validate a declared timezone ('UTC', '+HH:MM' or IANA name). */
export function assertTimezone(tz: string): void {
  if (tz === 'UTC' || OFFSET_TZ_RE.test(tz)) return;
  zoneFormatter(tz);
}

/** Convert a wall-clock time in `tz` to a UTC instant; rejects DST gaps and folds. */
function wallToUtc(w: Wall, tz: string, lexeme: string): number {
  if (tz === 'UTC') return wallUtcMs(w);
  const om = OFFSET_TZ_RE.exec(tz);
  if (om) {
    const off = (Number(om[2]) * 60 + Number(om[3])) * 60_000 * (om[1] === '-' ? -1 : 1);
    return wallUtcMs(w) - off;
  }
  const guess = wallUtcMs(w);
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) offsets.add(zoneOffsetMs(tz, guess + delta * 3_600_000));
  const valid = new Set<number>();
  for (const off of offsets) {
    const cand = guess - off;
    if (zoneOffsetMs(tz, cand) === off) valid.add(cand);
  }
  if (valid.size === 0) throw new TimestampError('NONEXISTENT_LOCAL_TIME', `${lexeme} does not exist in ${tz} (DST gap)`);
  if (valid.size > 1) throw new TimestampError('AMBIGUOUS_LOCAL_TIME', `${lexeme} occurs twice in ${tz} (DST fold)`);
  return [...valid][0]!;
}

export type TimestampFormat = 'auto' | 'unix_seconds';

/**
 * Parse one timestamp lexeme to an ISO UTC instant.
 * @param declaredTimezone timezone for naive values (null = naive values are rejected)
 */
export function parseInstant(lexeme: string, declaredTimezone: string | null, format: TimestampFormat = 'auto'): IsoUtc {
  const t = lexeme.trim();
  if (format === 'unix_seconds') {
    if (!/^\d{1,12}$/.test(t)) throw new TimestampError('INVALID_TIMESTAMP', `unix seconds expected, got ${JSON.stringify(lexeme)}`);
    return toIso(Number(t) * 1000);
  }
  let m = ISO_WITH_ZONE_RE.exec(t);
  if (m) {
    const w = wallFrom(m);
    const z = m[8]!.toUpperCase();
    if (z === 'Z') return toIso(wallUtcMs(w));
    const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(z)!;
    const off = (Number(zm[2]) * 60 + Number(zm[3])) * 60_000 * (zm[1] === '-' ? -1 : 1);
    return toIso(wallUtcMs(w) - off);
  }
  m = BQ_UTC_RE.exec(t);
  if (m) return toIso(wallUtcMs(wallFrom(m)));
  m = NAIVE_RE.exec(t);
  if (m) {
    if (!declaredTimezone) throw new TimestampError('AMBIGUOUS_TIMESTAMP', `${JSON.stringify(lexeme)} has no timezone and the mapping declares none`);
    return toIso(wallToUtc(wallFrom(m), declaredTimezone, t));
  }
  const dm = DATE_RE.exec(t);
  if (dm) {
    if (!declaredTimezone) throw new TimestampError('AMBIGUOUS_TIMESTAMP', `date ${JSON.stringify(lexeme)} has no timezone and the mapping declares none`);
    const w = checkedWall({ y: +dm[1]!, mo: +dm[2]!, d: +dm[3]!, h: 0, mi: 0, s: 0, ms: 0 }, t);
    return toIso(wallToUtc(w, declaredTimezone, t));
  }
  throw new TimestampError('INVALID_TIMESTAMP', `unrecognized timestamp ${JSON.stringify(lexeme)}`);
}

/** A date-only value is a whole local day: [local midnight, next local midnight) in the declared zone. */
export function parseLocalDay(lexeme: string, declaredTimezone: string | null): { start: IsoUtc; end: IsoUtc } {
  const t = lexeme.trim();
  const dm = DATE_RE.exec(t);
  if (!dm) throw new TimestampError('INVALID_TIMESTAMP', `date YYYY-MM-DD expected, got ${JSON.stringify(lexeme)}`);
  const start = parseInstant(t, declaredTimezone);
  const next = new Date(Date.UTC(+dm[1]!, +dm[2]! - 1, +dm[3]! + 1));
  const nextLex = next.toISOString().slice(0, 10);
  return { start, end: parseInstant(nextLex, declaredTimezone) };
}

export const isDateOnly = (lexeme: string): boolean => DATE_RE.test(lexeme.trim());

/** Calendar day of an instant in a zone, as YYYY-MM-DD, and that day's [start, end) in UTC. */
export function dayInZone(iso: IsoUtc, tz: string): { day: string; start: IsoUtc; end: IsoUtc } {
  const ms = Date.parse(iso);
  let day: string;
  if (tz === 'UTC') day = iso.slice(0, 10);
  else {
    const om = OFFSET_TZ_RE.exec(tz);
    const off = om ? (Number(om[2]) * 60 + Number(om[3])) * 60_000 * (om[1] === '-' ? -1 : 1) : zoneOffsetMs(tz, ms);
    day = new Date(ms + off).toISOString().slice(0, 10);
  }
  const r = parseLocalDay(day, tz);
  return { day, ...r };
}
