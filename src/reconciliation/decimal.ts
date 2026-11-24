/**
 * Exact decimal arithmetic for reconciliation (bigint units + power-of-ten scale).
 *
 * Provider exports carry money as decimal text ("0.000036", "123.78912" cents, "3.6e-06" from a JSON
 * float). The lexeme is parsed exactly; nothing passes through a JS number. Comparisons rescale both
 * sides UP to the larger scale (lossless); a conversion that would drop digits is refused.
 *
 * @module reconciliation/decimal
 */
import type { ScaledAmount } from './types.js';

const DECIMAL_RE = /^([+-])?(\d+)?(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export class DecimalParseError extends Error {
  constructor(message: string) { super(message); this.name = 'DecimalParseError'; }
}

export const pow10 = (k: number): bigint => {
  if (!Number.isInteger(k) || k < 0) throw new RangeError(`pow10: invalid exponent ${k}`);
  return 10n ** BigInt(k);
};

/** log10 of a power-of-ten scale (throws if not a power of ten). */
export function scaleDigits(scale: bigint): number {
  if (scale <= 0n) throw new RangeError('scale must be positive');
  const s = scale.toString(10);
  if (!/^10*$/.test(s)) throw new RangeError(`scale ${s} is not a power of ten`);
  return s.length - 1;
}

export interface ParsedDecimal {
  amount: ScaledAmount;
  /** Decimal places written in the lexeme after applying the exponent (precision of the source text). */
  decimals: number;
  /** Position of the most significant non-zero digit (10^msd), null for zero. */
  msdExponent: number | null;
}

/**
 * Parse a decimal lexeme exactly. Accepts sign, fraction and exponent ("-1.5", ".5", "3.6e-06").
 * Rejects empty strings, NaN/Infinity, thousands separators and anything else (no guessing).
 */
export function parseDecimal(lexeme: string): ParsedDecimal {
  const t = lexeme.trim();
  const m = DECIMAL_RE.exec(t);
  if (!t || !m || (m[2] === undefined && (m[3] === undefined || m[3] === ''))) throw new DecimalParseError(`not a decimal: ${JSON.stringify(lexeme)}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const intPart = m[2] ?? '0';
  const frac = m[3] ?? '';
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) throw new DecimalParseError(`exponent out of range: ${lexeme}`);
  const digits = (intPart + frac).replace(/^0+(?=\d)/, '');
  let decimals = frac.length - exp;
  let units = BigInt(digits === '' ? '0' : digits);
  if (decimals < 0) { units *= pow10(-decimals); decimals = 0; }
  const allDigits = intPart + frac;
  const firstNz = allDigits.search(/[1-9]/);
  const msdExponent = firstNz < 0 ? null : (intPart.length - 1 - firstNz) + exp;
  return { amount: { units: sign * units, scale: pow10(decimals) }, decimals, msdExponent };
}

/** Parse an integer lexeme (tokens). "1549.0" is accepted only when the fraction is all zeros. */
export function parseIntegerQuantity(lexeme: string): bigint {
  const p = parseDecimal(lexeme);
  const s = p.amount.scale;
  if (p.amount.units % s !== 0n) throw new DecimalParseError(`not an integer quantity: ${JSON.stringify(lexeme)}`);
  return p.amount.units / s;
}

/** Rescale to a larger (or equal) scale; refuses to lose digits. */
export function rescale(a: ScaledAmount, scale: bigint): ScaledAmount {
  if (scale === a.scale) return a;
  if (scale > a.scale) {
    if (scale % a.scale !== 0n) throw new RangeError('incompatible scales');
    return { units: a.units * (scale / a.scale), scale };
  }
  const f = a.scale / scale;
  if (a.units % f !== 0n) throw new RangeError(`rescale would lose digits (${toDecimalString(a)} to scale ${scale})`);
  return { units: a.units / f, scale };
}

export const maxScale = (...xs: bigint[]): bigint => xs.reduce((m, x) => (x > m ? x : m), 1n);

export function addAmounts(a: ScaledAmount, b: ScaledAmount): ScaledAmount {
  const s = maxScale(a.scale, b.scale);
  return { units: rescale(a, s).units + rescale(b, s).units, scale: s };
}

export function subAmounts(a: ScaledAmount, b: ScaledAmount): ScaledAmount {
  const s = maxScale(a.scale, b.scale);
  return { units: rescale(a, s).units - rescale(b, s).units, scale: s };
}

export function sumAmounts(xs: ScaledAmount[]): ScaledAmount | null {
  if (xs.length === 0) return null;
  return xs.reduce((acc, x) => addAmounts(acc, x));
}

export const absBig = (x: bigint): bigint => (x < 0n ? -x : x);

/** Exact decimal string with every digit of the scale, e.g. {36000000, 10^12} → "0.000036000000". */
export function toDecimalString(a: ScaledAmount): string {
  const k = scaleDigits(a.scale);
  const neg = a.units < 0n;
  const s = absBig(a.units).toString(10).padStart(k + 1, '0');
  const out = k === 0 ? s : `${s.slice(0, s.length - k)}.${s.slice(s.length - k)}`;
  return neg ? `-${out}` : out;
}

/**
 * Round a value to `scale` with round-half-even (banker's). Used ONLY to bring a float-derived
 * source value onto a fixed scale; returns the half-units lost so the caller can widen tolerance.
 */
export function roundHalfEvenToScale(a: ScaledAmount, scale: bigint): { amount: ScaledAmount; lostHalfUnits: bigint } {
  if (a.scale <= scale) return { amount: rescale(a, scale), lostHalfUnits: 0n };
  const f = a.scale / scale;
  const q = a.units / f; // truncates toward zero
  const r = a.units - q * f;
  if (r === 0n) return { amount: { units: q, scale }, lostHalfUnits: 0n };
  const twice = absBig(r) * 2n;
  let qq = q;
  const away = a.units < 0n ? -1n : 1n;
  if (twice > f || (twice === f && (absBig(q) % 2n === 1n))) qq = q + away;
  return { amount: { units: qq, scale }, lostHalfUnits: 1n };
}

/**
 * Relative difference |diff| / |base| as a percentage string with 6 decimals, rounded half up.
 * Zero rule: base 0 and diff 0 → '0.000000%'; base 0 and diff ≠ 0 → null (undefined).
 */
export function relDiffPercent(diff: ScaledAmount, base: ScaledAmount): string | null {
  const s = maxScale(diff.scale, base.scale);
  const d = absBig(rescale(diff, s).units);
  const b = absBig(rescale(base, s).units);
  if (b === 0n) return d === 0n ? '0.000000%' : null;
  // percent × 10^6 = d × 100 × 10^6 / b, rounded half up
  const num = d * 100_000_000n;
  const q = (num * 2n + b) / (2n * b);
  return `${toDecimalString({ units: q, scale: 1_000_000n })}%`;
}
