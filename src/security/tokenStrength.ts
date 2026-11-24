/**
 * H1 lane B (S06 residual, SEC02-N02): strength check for tenant tokens registered through the API.
 *
 * The 24-character minimum (H1-S06) still accepted tokens such as 'aaaa…' or '0123456789012345678901234', which are
 * guessed in a handful of attempts. A tenant token is a bearer secret accepted by the MITM proxy (it spends the
 * operator's provider keys), so new registrations must look random. The rules are deliberately conservative (they
 * reject only obviously structured strings, never a random one; a descriptive prefix followed by a random part passes):
 *   - fewer than 8 distinct characters;
 *   - a repeated pattern: the string is a repetition of a block of at most half its length;
 *   - a run: at least half of the adjacent pairs are consecutive characters (abcd…, 0123…, dcba…);
 *   - a character-frequency (Shannon) estimate below 3 bits per character, or below 72 bits in total.
 * The Shannon value is an estimate of the character distribution, NOT a measure of how the token was generated: it is a
 * floor against obvious mistakes, not a proof of randomness. Generate tokens with a CSPRNG (e.g. 24+ random bytes).
 *
 * Scope: POST/PUT /admin/tenants only. Tokens already in OTK_TENANTS or in the tenant log keep working.
 *
 * @module security/tokenStrength
 */

export const MIN_TOKEN_DISTINCT_CHARS = 8;
export const MIN_TOKEN_BITS_PER_CHAR = 3;
export const MIN_TOKEN_TOTAL_BITS = 72;

/** Shannon estimate in bits per character of the character distribution of `s`. */
export function shannonBitsPerChar(s: string): number {
  const chars = [...s];
  if (chars.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of chars) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / chars.length; h -= p * Math.log2(p); }
  return h;
}

/** Smallest period p (1 <= p <= len/2) such that s is a repetition of its first p characters, or 0. */
function shortPeriod(chars: string[]): number {
  const n = chars.length;
  for (let p = 1; p <= Math.floor(n / 2); p++) {
    let ok = true;
    for (let i = p; i < n; i++) if (chars[i] !== chars[i - p]) { ok = false; break; }
    if (ok) return p;
  }
  return 0;
}

/** Reason why `token` is too weak to be registered, or null when it passes. */
export function tenantTokenWeakness(token: string): string | null {
  const chars = [...token];
  if (chars.length === 0) return 'token is empty';
  const distinct = new Set(chars).size;
  if (distinct < MIN_TOKEN_DISTINCT_CHARS) return `token has fewer than ${MIN_TOKEN_DISTINCT_CHARS} distinct characters`;
  if (shortPeriod(chars) > 0) return 'token is a repeated pattern';
  let steps = 0;
  for (let i = 1; i < chars.length; i++) {
    const d = chars[i]!.codePointAt(0)! - chars[i - 1]!.codePointAt(0)!;
    if (d === 1 || d === -1) steps++;
  }
  if (chars.length > 1 && steps * 2 >= chars.length - 1) return 'token is a run of consecutive characters';
  const bpc = shannonBitsPerChar(token);
  if (bpc < MIN_TOKEN_BITS_PER_CHAR || bpc * chars.length < MIN_TOKEN_TOTAL_BITS) {
    return 'token has too little entropy (generate it from at least 24 random bytes)';
  }
  return null;
}
