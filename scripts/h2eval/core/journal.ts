/**
 * Append-only journal with a hash chain, fsync'd on every append (contract §0.1, §9).
 * Each line: {schema, seq, tsUtc, kind, operationId, body, prevHash, hash}; hash = sha256(canon(line without hash));
 * prevHash = previous line's hash (GENESIS for the first). Reading verifies seq, chain and hashes and refuses any gap,
 * reorder or edit. Bodies carry ids, hashes, counts and pico-USD only — the writer refuses strings that look like text content
 * or credentials (basic guard; the real guarantee is that callers never put content here).
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { H2EVAL_SCHEMA, type JournalKind, type JournalLine, type OperationId } from '../types.js';
import { canon, sha256Hex } from './canon.js';

export const GENESIS_PREV = '0'.repeat(64);
const MAX_STRING = 256; // ids, hashes, codes, ISO timestamps, pico-USD strings; never prompt/response text

export class JournalIntegrityError extends Error {
  constructor(public readonly code: string, detail = '') { super(`journal integrity: ${code}${detail ? ` (${detail})` : ''}`); this.name = 'JournalIntegrityError'; }
}
export class JournalPersistenceError extends Error {
  constructor(public readonly cause2: unknown) { super('journal persistence failed'); this.name = 'JournalPersistenceError'; }
}

function guardBody(v: unknown, path = 'body'): void {
  if (v === null || v === undefined) return;
  if (typeof v === 'string') { if (v.length > MAX_STRING || /\n/.test(v)) throw new TypeError(`journal body ${path}: string too long or multi-line (content is never journaled)`); return; }
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new TypeError(`journal body ${path}: non-finite`); return; }
  if (typeof v === 'boolean') return;
  if (typeof v === 'bigint') throw new TypeError(`journal body ${path}: bigint must be serialized as pico-USD string`);
  if (Array.isArray(v)) { v.forEach((x, i) => guardBody(x, `${path}[${i}]`)); return; }
  if (typeof v === 'object') { for (const [k, x] of Object.entries(v as Record<string, unknown>)) guardBody(x, `${path}.${k}`); return; }
  throw new TypeError(`journal body ${path}: unsupported type`);
}

export interface Journal {
  readonly path: string;
  readonly seq: number;
  readonly lastHash: string;
  /** Appends, fsyncs, returns the line. Throws JournalPersistenceError (caller must STOP) if the write/fsync fails. */
  append(kind: JournalKind, operationId: OperationId | 'NONE', body: Record<string, unknown>): JournalLine;
  /** All lines (verified). */
  lines(): JournalLine[];
  /** Lines of one operation, in order. */
  of(operationId: OperationId): JournalLine[];
}

/** Verifies a whole file; throws JournalIntegrityError on any gap, reorder, edit or bad hash. */
export function verifyJournalText(text: string): JournalLine[] {
  const out: JournalLine[] = [];
  let prev = GENESIS_PREV;
  const raw = text.split('\n').filter((l) => l.length > 0);
  for (let i = 0; i < raw.length; i++) {
    let l: JournalLine;
    try { l = JSON.parse(raw[i]!) as JournalLine; } catch { throw new JournalIntegrityError('format_line', `line ${i + 1}`); }
    if (l.schema !== H2EVAL_SCHEMA.journal) throw new JournalIntegrityError('schema', `line ${i + 1}`);
    if (l.seq !== i + 1) throw new JournalIntegrityError('seq', `line ${i + 1}: seq ${l.seq}`);
    if (l.prevHash !== prev) throw new JournalIntegrityError('chain', `line ${i + 1}`);
    const { hash, ...rest } = l;
    if (sha256Hex(canon(rest)) !== hash) throw new JournalIntegrityError('hash', `line ${i + 1}`);
    prev = hash;
    out.push(l);
  }
  return out;
}

export function openJournal(path: string, clock: () => string = () => new Date().toISOString()): Journal {
  const existing = existsSync(path) ? verifyJournalText(readFileSync(path, 'utf8')) : [];
  let seq = existing.length;
  let lastHash = existing.length ? existing[existing.length - 1]!.hash : GENESIS_PREV;
  const lines = [...existing];
  const api: Journal = {
    path,
    get seq() { return seq; },
    get lastHash() { return lastHash; },
    append(kind, operationId, body) {
      guardBody(body);
      const rest = { schema: H2EVAL_SCHEMA.journal, seq: seq + 1, tsUtc: clock(), kind, operationId, body, prevHash: lastHash };
      const line: JournalLine = { ...rest, hash: sha256Hex(canon(rest)) };
      const text = JSON.stringify(line) + '\n';
      try {
        const fd = openSync(path, 'a');
        try { appendFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      } catch (e) { throw new JournalPersistenceError(e); }
      seq += 1; lastHash = line.hash; lines.push(line);
      return line;
    },
    lines: () => [...lines],
    of: (id) => lines.filter((l) => l.operationId === id),
  };
  return api;
}
