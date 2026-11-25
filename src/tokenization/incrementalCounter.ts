/**
 * Incremental token counting over streamed text with BPE boundaries preserved (D8 §2, U2-03).
 *
 * Counting each chunk separately is wrong: 'hello' is 1 token but 'hel' + 'lo' are 2. tiktoken
 * splits text into pieces with its pre-tokenizer regex and merges bytes only inside a piece, so
 * counting is additive across a cut point when no regex piece crosses it. This counter only
 * cuts at two kinds of points, both verified against whole-text counts by
 * test/unit/d1d8_b_counter.test.ts for o200k_base and cl100k_base:
 *   (a) after a '\n' and before a letter or digit — no alternative of either regex extends
 *       from a newline into a letter/digit, and newline runs ending there are closed. Not
 *       before punctuation: o200k's ` ?[^\s\p{L}\p{N}]+[\r\n/]*` lets a piece continue from
 *       '\n' into '/' (e.g. ".\n//" is 1 token whole, 2 if cut — found in review, regression
 *       test kept);
 *   (b) between a letter and ' ' + letter — the letter run closes at the space and the next
 *       piece starts with the space.
 * Memory is bounded: text is buffered only until such a point exists; if the pending buffer
 * exceeds maxPendingChars without one (e.g. one enormous word) or the total exceeds
 * maxTextBytes, counting stops and the result is marked truncated — never silently summed.
 * CPU is bounded too: a regex piece longer than MAX_PIECE_CHARS truncates ('max_piece_chars').
 *
 * Used by `localCounter.ts` for streamed output. In-memory only; it never keeps text after counting it.
 *
 * @module src/tokenization/incrementalCounter
 */
import type { Tiktoken } from 'js-tiktoken';
import { countWith, hasOversizedPiece } from './tokenizerIdentity.js';

/**
 * Result and diagnostics of an {@link IncrementalCounter}.
 */
export interface IncrementalCountState {
  /** Tokens counted; 0 when `truncated` is true (read `truncated` before using it). */
  count: number;
  truncated: boolean;
  truncationReason: 'max_text_bytes' | 'max_pending_chars' | 'max_piece_chars' | null;
  /** UTF-8 bytes received (up to the truncation point). */
  bytesSeen: number;
  /** Largest number of UTF-8 bytes buffered while waiting for a safe cut. */
  peakPendingBytes: number;
  /** CPU time spent encoding, in microseconds (user + system). */
  cpuMicros: bigint;
}

const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;

/**
 * Index of the last safe cut point in s (0 = none). Exported for tests.
 *
 *
 * @param s - Pending text.
 * @returns UTF-16 index where the text can be cut without changing the token count, or 0.
 */
export function lastSafeCut(s: string): number {
  for (let i = s.length - 1; i > 0; i--) {
    const prev = s.charCodeAt(i - 1);
    const cur = s[i]!;
    if (prev === 10 /* \n */ && (isLetterAt(s, i) || DIGIT.test(cur))) return i;
    if (cur === ' ' && i + 1 < s.length && isLetterAt(s, i - 1) && isLetterAt(s, i + 1)) return i;
  }
  return 0;
}

/**
 * True when the UTF-16 unit at i is a BMP letter (surrogate halves are never cut points).
 *
 *
 * @param s - Text.
 * @param i - UTF-16 index.
 */
function isLetterAt(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdfff) return false;
  return LETTER.test(s[i]!);
}

/**
 * Counts the tokens of text that arrives in pieces, giving the same result as counting the whole text.
 *
 * One instance per stream. Limits: `maxTextBytes` (UTF-8 bytes in total), `maxPendingChars` (default 65536)
 * and `flushAtChars` (how many characters to wait between cut attempts, default 2048).
 */
export class IncrementalCounter {
  private pending = '';
  private pendingBytes = 0;
  private nextAttemptAt: number;
  private readonly state: IncrementalCountState = {
    count: 0, truncated: false, truncationReason: null, bytesSeen: 0, peakPendingBytes: 0, cpuMicros: 0n,
  };

  constructor(
    private readonly encoder: Tiktoken,
    private readonly limits: { maxTextBytes: number; maxPendingChars?: number; flushAtChars?: number },
  ) {
    this.nextAttemptAt = limits.flushAtChars ?? 2048;
  }

  /**
   * Adds the next piece of text; ignored after truncation.
   *
   * @param text - Next text delta.
   */
  push(text: string): void {
    if (this.state.truncated || text.length === 0) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.state.bytesSeen + bytes > this.limits.maxTextBytes) {
      this.truncate('max_text_bytes');
      return;
    }
    this.state.bytesSeen += bytes;
    this.pending += text;
    this.pendingBytes += bytes;
    if (this.pendingBytes > this.state.peakPendingBytes) this.state.peakPendingBytes = this.pendingBytes;
    const flushAt = this.limits.flushAtChars ?? 2048;
    // Look for a cut only after another flushAt characters arrived since the last attempt.
    if (this.pending.length >= this.nextAttemptAt) {
      const cut = lastSafeCut(this.pending);
      if (cut > 0) {
        const head = this.pending.slice(0, cut);
        this.countNow(head);
        this.pending = this.pending.slice(cut);
        this.pendingBytes -= Buffer.byteLength(head, 'utf8');
        this.nextAttemptAt = flushAt;
      } else if (this.pending.length > (this.limits.maxPendingChars ?? 65536)) {
        this.truncate('max_pending_chars');
      } else {
        this.nextAttemptAt = this.pending.length + flushAt;
      }
    }
  }

  /**
   * Counts what is still buffered and returns the final state.
   *
   * @returns A copy of the state; `count` is 0 when truncated.
   */
  finish(): IncrementalCountState {
    if (!this.state.truncated && this.pending.length > 0) this.countNow(this.pending);
    if (this.state.truncated) this.state.count = 0;
    this.pending = '';
    return { ...this.state };
  }

  private countNow(text: string): void {
    if (hasOversizedPiece(text)) {
      this.truncate('max_piece_chars');
      return;
    }
    const t0 = process.cpuUsage();
    this.state.count += countWith(this.encoder, text);
    const d = process.cpuUsage(t0);
    this.state.cpuMicros += BigInt(d.user + d.system);
  }

  private truncate(reason: 'max_text_bytes' | 'max_pending_chars' | 'max_piece_chars'): void {
    this.state.truncated = true;
    this.state.truncationReason = reason;
    this.pending = '';
    this.pendingBytes = 0;
  }
}
