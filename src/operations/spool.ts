/**
 * D1–D8 / C — local measurement spool (D7 §4, D7-G04).
 *
 * When the final usage of an operation arrives while PostgreSQL is unreachable, the transition
 * that would settle it cannot be written. The numbers (never prompt/response text) are appended
 * to a per-instance JSONL file and fsync'd before the request finishes; a replayer applies them
 * when the database is back. Bounded: past `maxEntries` new entries are refused (the operation is
 * then recovered as process_lost/uncertain — never zero, never silently dropped).
 *
 * Integrity (S4, audit ABC-01). The file is a sequence of newline-terminated records:
 *  - a final segment WITHOUT newline is a torn tail: an append that crashed before its fsync, so
 *    it was never acknowledged. Before the next append it is moved to the quarantine file (raw
 *    bytes, offset, digest) and the live file is truncated back to the last newline, so the new
 *    record never fuses with the broken bytes (the audit's lost-append defect);
 *  - a newline-terminated line that does not parse, or is not a v1 record, is corruption of an
 *    acknowledged write: it is reported by inspect()/replay() (`corrupt`) and moved to the
 *    quarantine file by the next replay, never silently dropped;
 *  - the rewrite after a replay goes through a 0600 temp file, fsync, rename and (POSIX) a
 *    directory fsync; a temp file left by a crash before the rename is ignored and removed at
 *    open (the live file still holds every record).
 * The quarantine file is append-only evidence (numbers and ids only, like the spool itself).
 *
 * Intervention queue (fechamento pós-S5, RV2-05 / AUD-5). Quarantine is for PHYSICAL damage: bytes that
 * cannot be read back as a record. A record that parses but that PostgreSQL rejects for a LOGICAL,
 * permanent reason (illegal transition, scale loss, codec error, ledger identity clash) is different: it
 * is intact consumption that cannot be applied as is. replay() moves it, whole, to the append-only
 * intervention file (reason, source, sha256 of the original line), durably (fsync) BEFORE removing it
 * from the live file; if that write fails the record stays live and is retried. The other records keep
 * progressing. An operator fixes the cause and re-applies (reapplyInterventions in proxyDurable), which
 * appends a 'resolved' line: nothing is ever deleted, nothing is counted twice (the operation's revision
 * and ledger identity guard the apply).
 *
 * Append-only logs (F-FPS5-01, revisão independente de 02/10). The intervention queue and the quarantine
 * file are append-only, so a torn final line is never cut off: before the next append a newline closes it
 * IN PLACE, where it stays as a visible corrupt line (offset, length, sha256 via inspectInterventions()),
 * and the new line starts on its own. Every append writes all bytes (short writes looped), fsyncs, and
 * reads its own bytes back from the end of the file; any mismatch throws, so the caller keeps the source
 * record (replay() only drops a record from the live spool after this). Reading never skips a bad line
 * silently: it is reported, and an entry that an older build fused onto torn bytes is recovered only if its
 * own sha256 checks.
 *
 * Unrecoverable window (declared): between receiving the provider's final event and the fsync
 * here, and the simultaneous loss of PostgreSQL and this disk. The operation still exists in
 * PostgreSQL (it was admitted durably) and recovery marks it uncertain.
 *
 * @module operations/spool
 */
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import type { OperationKey } from '../types/d1d8/index.js';
import { encodeJson } from './codec.js';

export interface SpoolRecord {
  v: 1;
  id: string;
  key: OperationKey;
  /** Encoded (codec) OperationPatch and extras; decoded by the replayer. */
  patch: unknown;
  localCount: unknown;
  enqueue: unknown[];
  at: string;
}

/** A newline-terminated line that is not a valid record (corruption of an acknowledged write). */
export interface SpoolCorruptLine {
  /** Byte offset of the line in the live file. */
  offset: number;
  raw: Buffer;
  reason: 'json' | 'schema';
}

export interface SpoolInspection {
  records: SpoolRecord[];
  corrupt: SpoolCorruptLine[];
  /** Unterminated final segment (an append that never completed), or null. */
  tornTail: { offset: number; raw: Buffer } | null;
}

export interface SpoolReplayResult {
  applied: number;
  already: number;
  left: number;
  /** Corrupt lines found and moved to the quarantine file in this replay. */
  corrupt: number;
  /** RV2-05: records rejected for a permanent logical reason, moved to the intervention file. */
  intervention: number;
}

/** Outcome of applying one record: `intervention` carries the permanent reason (RV2-05). */
export type SpoolApplyOutcome = 'applied' | 'already' | 'retry' | { intervention: string };

/** RV2-05: a record that needs an operator (append-only line of the intervention file). */
export interface InterventionEntry {
  v: 1;
  kind: 'intervention';
  /** The original spool record id (traceability). */
  id: string;
  record: SpoolRecord;
  reason: string;
  source: 'replay' | 'live';
  detectedAt: string;
  /** sha256 of the record as written in the live spool (integrity). */
  sha256: string;
}
export interface InterventionResolution { v: 1; kind: 'resolved'; id: string; at: string; outcome: string }

export class SpoolFullError extends Error {
  constructor(max: number) { super(`measurement spool full (${max} entries)`); this.name = 'SpoolFullError'; }
}

/** One line of the intervention file that does not parse as a whole (reported, never dropped silently). */
export interface InterventionCorruptLine {
  offset: number;
  length: number;
  sha256: string;
  reason: 'json' | 'schema';
  /** An intact entry/resolution embedded after the defective bytes (written before F-FPS5-01) was recovered. */
  recovered: boolean;
}

export interface InterventionInspection {
  open: Array<InterventionEntry & { intact: boolean }>;
  corrupt: InterventionCorruptLine[];
  /** Unterminated final segment (an interrupted append), or null. */
  tornTail: { offset: number; length: number; sha256: string } | null;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Write every byte (a single writeSync may write fewer bytes than asked). */
function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error(`short write: ${off}/${buf.length} bytes`);
    off += n;
  }
}

function isInterventionLine(o: unknown): o is InterventionEntry | InterventionResolution {
  if (!o || typeof o !== 'object') return false;
  const x = o as Record<string, unknown>;
  if (x['v'] !== 1 || typeof x['id'] !== 'string' || x['id'] === '') return false;
  if (x['kind'] === 'resolved') return typeof x['outcome'] === 'string';
  return x['kind'] === 'intervention' && isRecord(x['record']) && typeof x['sha256'] === 'string';
}

/**
 * Durable append of one line to an append-only log (F-FPS5-01): close a torn tail in place with a newline,
 * write all bytes, fsync, read them back. Throws on any failure (the caller keeps its source).
 */
function appendDurable(file: string, dir: string, line: string): void {
  const data = Buffer.from(`${line}\n`, 'utf8');
  const existed = existsSync(file);
  const before = existed ? readFileSync(file) : Buffer.alloc(0);
  const fd = openSync(file, 'a', 0o600);
  try {
    // the torn bytes stay where they are, as their own (corrupt) line
    if (before.length > 0 && before[before.length - 1] !== 0x0a) writeAll(fd, Buffer.from('\n'));
    writeAll(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!existed) fsyncDir(dir);
  const back = readFileSync(file);
  if (back.length < data.length || !back.subarray(back.length - data.length).equals(data)) {
    throw new Error(`append to ${path.basename(file)} could not be verified`);
  }
}

function isRecord(v: unknown): v is SpoolRecord {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const k = o['key'] as Record<string, unknown> | null;
  return o['v'] === 1 && typeof o['id'] === 'string' && o['id'] !== '' && !!k && typeof k === 'object'
    && typeof k['tenantId'] === 'string' && typeof k['operationId'] === 'string';
}

/** fsync a directory after a rename (POSIX); Windows does not allow opening directories for it. */
function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class MeasurementSpool {
  readonly file: string;
  /** Append-only evidence of torn tails and corrupt lines removed from the live file. */
  readonly quarantineFile: string;
  /** RV2-05: append-only queue of intact records rejected for a permanent logical reason. */
  readonly interventionFile: string;
  private readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, instanceId: string, private readonly opts: { maxEntries?: number } = {}) {
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
    const base = `spool-${instanceId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    this.file = path.join(dir, `${base}.jsonl`);
    this.quarantineFile = path.join(dir, `${base}.quarantine.jsonl`);
    this.interventionFile = path.join(dir, `${base}.intervention.jsonl`);
    // a temp file left by a crash before rename: the live file is still complete
    rmSync(`${this.file}.tmp`, { force: true });
  }

  /** Parse the live file into records, corrupt lines and a possible torn tail (no side effects). */
  inspect(): SpoolInspection {
    if (!existsSync(this.file)) return { records: [], corrupt: [], tornTail: null };
    const buf = readFileSync(this.file);
    const records: SpoolRecord[] = [];
    const corrupt: SpoolCorruptLine[] = [];
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) {
        // unterminated: an append that never reached its newline+fsync
        return { records, corrupt, tornTail: { offset: start, raw: buf.subarray(start) } };
      }
      const raw = buf.subarray(start, nl);
      const text = raw.toString('utf8');
      if (text.trim()) {
        let parsed: unknown;
        let ok = true;
        try { parsed = JSON.parse(text); } catch { ok = false; }
        if (!ok) corrupt.push({ offset: start, raw: Buffer.from(raw), reason: 'json' });
        else if (!isRecord(parsed)) corrupt.push({ offset: start, raw: Buffer.from(raw), reason: 'schema' });
        else records.push(parsed);
      }
      start = nl + 1;
    }
    return { records, corrupt, tornTail: null };
  }

  pending(): SpoolRecord[] {
    return this.inspect().records;
  }

  private quarantine(kind: 'torn_tail' | 'corrupt_line', offset: number, raw: Buffer, extra: Record<string, unknown> = {}): void {
    const evidence = {
      kind, detectedAt: new Date().toISOString(), file: path.basename(this.file), offset, length: raw.length,
      sha256: sha256(raw), rawBase64: raw.toString('base64'), ...extra,
    };
    appendDurable(this.quarantineFile, this.dir, JSON.stringify(evidence));
  }

  private appendLine(file: string, line: string): void {
    appendDurable(file, this.dir, line);
  }

  /** RV2-05: durably record an intact record that needs an operator. Throws if it cannot be written. */
  recordIntervention(record: SpoolRecord, reason: string, source: 'replay' | 'live'): InterventionEntry {
    const line = JSON.stringify(record);
    const entry: InterventionEntry = { v: 1, kind: 'intervention', id: record.id, record, reason, source, detectedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(line).digest('hex') };
    this.appendLine(this.interventionFile, JSON.stringify(entry));
    return entry;
  }

  /** RV2-05: append the resolution of an intervention entry (the entry itself is never removed). */
  markResolved(id: string, outcome: string): void {
    const r: InterventionResolution = { v: 1, kind: 'resolved', id, at: new Date().toISOString(), outcome };
    this.appendLine(this.interventionFile, JSON.stringify(r));
  }

  /** RV2-05: intervention entries without a later resolution, in file order (integrity re-checked). */
  openInterventions(): Array<InterventionEntry & { intact: boolean }> {
    return this.inspectInterventions().open;
  }

  /**
   * F-FPS5-01: read the intervention file without hiding anything. Lines that do not parse are reported
   * (offset, length, sha256); an entry or resolution embedded after defective bytes on the same line (what
   * the previous append produced after a torn tail) is recovered, and an entry's integrity is still judged
   * by its sha256, like any other line. An unterminated final segment is reported as tornTail.
   */
  inspectInterventions(): InterventionInspection {
    if (!existsSync(this.interventionFile)) return { open: [], corrupt: [], tornTail: null };
    const buf = readFileSync(this.interventionFile);
    const open = new Map<string, InterventionEntry & { intact: boolean }>();
    const corrupt: InterventionCorruptLine[] = [];
    let tornTail: InterventionInspection['tornTail'] = null;
    const apply = (o: InterventionEntry | InterventionResolution) => {
      if (o.kind === 'intervention') open.set(o.id, { ...o, intact: sha256(JSON.stringify(o.record)) === o.sha256 });
      else open.delete(o.id);
    };
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) {
        const raw = buf.subarray(start);
        if (raw.toString('utf8').trim()) tornTail = { offset: start, length: raw.length, sha256: sha256(raw) };
        break;
      }
      const raw = buf.subarray(start, nl);
      const text = raw.toString('utf8');
      if (text.trim()) {
        let parsed: unknown; let ok = true;
        try { parsed = JSON.parse(text); } catch { ok = false; }
        if (ok && isInterventionLine(parsed)) apply(parsed);
        else {
          // salvage: the last embedded line that parses whole as an entry/resolution
          let recovered: InterventionEntry | InterventionResolution | null = null;
          for (let i = text.lastIndexOf('{"v":1,"kind":"'); i > 0; i = text.lastIndexOf('{"v":1,"kind":"', i - 1)) {
            try { const o: unknown = JSON.parse(text.slice(i)); if (isInterventionLine(o)) { recovered = o; break; } } catch { /* keep looking */ }
          }
          corrupt.push({ offset: start, length: raw.length, sha256: sha256(raw), reason: ok ? 'schema' : 'json', recovered: recovered !== null });
          if (recovered) apply(recovered);
        }
      }
      start = nl + 1;
    }
    return { open: [...open.values()], corrupt, tornTail };
  }

  /** Durable append (fsync) before returning. Throws SpoolFullError past the bound. */
  append(rec: Omit<SpoolRecord, 'v' | 'at'>): void {
    const max = this.opts.maxEntries ?? 10_000;
    const ins = this.inspect();
    if (ins.records.length >= max) throw new SpoolFullError(max);
    if (ins.tornTail) {
      // keep the broken bytes as evidence, then cut them off so the new record starts on its own
      // line ('r+': an append-mode descriptor cannot be truncated on Windows)
      this.quarantine('torn_tail', ins.tornTail.offset, ins.tornTail.raw);
      const tfd = openSync(this.file, 'r+');
      try { ftruncateSync(tfd, ins.tornTail.offset); fsyncSync(tfd); } finally { closeSync(tfd); }
    }
    const fd = openSync(this.file, 'a', 0o600); // owner-only: the spool can settle operations
    try {
      writeAll(fd, Buffer.from(encodeJson({ v: 1, at: new Date().toISOString(), ...rec }) + '\n', 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Apply every pending record; records whose apply() returns 'retry' (or throws) stay in the
   * file, rewritten atomically (0600 tmp + fsync + rename + dir fsync). Corrupt lines are moved
   * to the quarantine file and counted. Serialized inside this process.
   */
  replay(apply: (rec: SpoolRecord) => Promise<SpoolApplyOutcome>): Promise<SpoolReplayResult> {
    const run = async (): Promise<SpoolReplayResult> => {
      const first = this.inspect();
      const keep: SpoolRecord[] = [];
      let applied = 0; let already = 0; let intervention = 0;
      for (const r of first.records) {
        let outcome: SpoolApplyOutcome;
        try { outcome = await apply(r); } catch { outcome = 'retry'; }
        if (outcome === 'applied') applied++;
        else if (outcome === 'already') already++;
        else if (typeof outcome === 'object') {
          // RV2-05: leaves the live file only once the intervention entry is durable
          try { this.recordIntervention(r, outcome.intervention, 'replay'); intervention++; } catch { keep.push(r); }
        } else keep.push(r);
      }
      // records appended while apply() awaited are kept: re-read and rewrite with no await in
      // between (the event loop cannot interleave an append here)
      const now = this.inspect();
      const seen = new Set(first.records.map((r) => r.id));
      for (const r of now.records) if (!seen.has(r.id)) keep.push(r);
      for (const c of now.corrupt) this.quarantine('corrupt_line', c.offset, c.raw, { reason: c.reason });
      // an unterminated tail at this point is an append in flight in another process or a crash
      // remnant; it is preserved as evidence like any torn tail (never acknowledged)
      if (now.tornTail) this.quarantine('torn_tail', now.tornTail.offset, now.tornTail.raw);
      if (first.records.length > 0 || now.corrupt.length > 0 || now.tornTail) {
        const tmp = `${this.file}.tmp`;
        const fd = openSync(tmp, 'w', 0o600);
        try {
          writeAll(fd, Buffer.from(keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf8'));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, this.file);
        fsyncDir(this.dir);
      }
      return { applied, already, left: keep.length, corrupt: now.corrupt.length, intervention };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}
