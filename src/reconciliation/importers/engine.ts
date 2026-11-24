/**
 * Generic statement import engine driven by a StatementMapping.
 *
 * Guarantees:
 *  - every source record becomes at least one StatementLine (nothing is dropped): a row that cannot be
 *    interpreted becomes an 'unknown' line with its issues; out-of-scope rows stay with inScope=false;
 *  - money is parsed from the source lexeme exactly (no float); cents are converted by a power of ten;
 *  - timestamps without timezone are rejected unless the mapping (or the caller) declares one;
 *  - taxes, credits and adjustments are separate lines (kind), never mixed into usage;
 *  - the import is deterministic: same bytes + same mapping → same statement.
 *
 * @module reconciliation/importers/engine
 */
import { createHash } from 'node:crypto';
import type { DataOrigin, IsoUtc, LineKind, ProviderStatement, ReconProvider, ScaledAmount, StatementLine, UsageCategory } from '../types.js';
import { DecimalParseError, parseDecimal, parseIntegerQuantity, pow10, scaleDigits } from '../decimal.js';
import { JsonNumber, flattenForRaw, getPath, lexemeOf, parseCsv, parseJsonLossless, StatementParseError } from '../parse.js';
import type { JsonValue } from '../parse.js';
import { parseInstant, parseLocalDay, TimestampError } from '../time.js';
import { canonicalModel, modelFromDescription, RECON_ALIAS_TABLE_V1 } from '../aliases.js';
import type { AliasTable } from '../aliases.js';
import type { StatementMapping } from './mapping.js';
import { referencedFields } from './mapping.js';

export type ImportErrorCode =
  | 'MISSING_COLUMNS' | 'AMBIGUOUS_TIMESTAMP' | 'INVALID_TIMESTAMP' | 'NONEXISTENT_LOCAL_TIME' | 'AMBIGUOUS_LOCAL_TIME' | 'INVALID_TIMEZONE'
  | 'PARSE_ERROR' | 'SHAPE_ERROR' | 'EMPTY_STATEMENT' | 'ORIGIN_CONFLICT' | 'PROVIDER_MISMATCH';

export class StatementImportError extends Error {
  constructor(public readonly code: ImportErrorCode, message: string) { super(`${code}: ${message}`); this.name = 'StatementImportError'; }
}

export interface ImportOptions {
  /** Origin the caller declares for the provider data. A synthetic marker in the file forces FIXTURE (and conflicts with REAL). */
  declaredOrigin: DataOrigin;
  /** Overrides mapping.timestamps.declaredTimezone (e.g. the timezone Bruno read in the console). */
  declaredTimezone?: string | null;
  aliasTable?: AliasTable;
  /** Extra exact aliases (alias → canonical), e.g. from the price tables. */
  extraAliases?: Record<string, string>;
}

interface SourceRecord {
  index: number;
  get(field: string): JsonValue | undefined;
  raw: Record<string, string | null>;
  /** For credits expansion (JSON only). */
  node: JsonValue | null;
}

const SYNTHETIC_RE = /SYNTHETIC/i;

const asLex = (v: JsonValue | undefined): string | null => {
  const l = lexemeOf(v);
  return l === null || l.trim() === '' ? null : l;
};

function ruleMatches(rec: SourceRecord, r: { field: string; equals?: string; pattern?: string; flags?: string }): boolean {
  const v = asLex(rec.get(r.field));
  if (v === null) return r.equals === '' ;
  if (r.equals !== undefined) return v.trim() === r.equals;
  return new RegExp(r.pattern!, r.flags ?? '').test(v);
}

function readRecords(text: string, m: StatementMapping): { records: SourceRecord[]; marker: string | null; buckets: Array<{ start: string; end: string }> | null } {
  const r = m.records;
  if (r.kind === 'csv_rows') {
    const t = parseCsv(text, r.delimiter);
    const missing = referencedFields(m).filter((f) => !t.header.includes(f));
    if (missing.length > 0) {
      throw new StatementImportError('MISSING_COLUMNS', `mapping ${m.id} expects column(s) ${JSON.stringify(missing)}; header has ${JSON.stringify(t.header)} (fix the mapping, do not rename the export)`);
    }
    const marker = t.preamble.find((l) => SYNTHETIC_RE.test(l)) ?? null;
    const records = t.rows.map((row, i): SourceRecord => {
      const raw: Record<string, string | null> = {};
      t.header.forEach((h, k) => { raw[h] = row[k] === '' ? null : row[k]!; });
      return { index: i + 1, get: (f) => (raw[f] ?? null), raw, node: null };
    });
    return { records, marker, buckets: null };
  }
  if (r.kind === 'ndjson') {
    const records: SourceRecord[] = [];
    let marker: string | null = null;
    const lines = text.split(/\r?\n/);
    let n = 0;
    for (const line of lines) {
      if (line.trim() === '') continue;
      const v = parseJsonLossless(line);
      const syn = getPath(v, '_synthetic');
      if (syn !== undefined && records.length === 0 && marker === null) { marker = asLex(syn) ?? 'SYNTHETIC'; continue; }
      n++;
      records.push({ index: n, get: (f) => getPath(v, f), raw: flattenForRaw(v), node: v });
    }
    return { records, marker, buckets: null };
  }
  const root = parseJsonLossless(text);
  const synRoot = getPath(root, '_synthetic');
  const marker = synRoot === undefined ? null : (asLex(synRoot) ?? 'SYNTHETIC');
  if (r.kind === 'json_array') {
    const arr = r.rowsPath === null ? root : getPath(root, r.rowsPath);
    if (!Array.isArray(arr)) throw new StatementImportError('SHAPE_ERROR', `mapping ${m.id}: ${r.rowsPath ?? '<root>'} is not an array`);
    return { records: arr.map((v, i) => ({ index: i + 1, get: (f: string) => getPath(v, f), raw: flattenForRaw(v), node: v })), marker, buckets: null };
  }
  const buckets = getPath(root, r.bucketsPath);
  if (!Array.isArray(buckets)) throw new StatementImportError('SHAPE_ERROR', `mapping ${m.id}: ${r.bucketsPath} is not an array of buckets`);
  const out: SourceRecord[] = [];
  const bucketPeriods: Array<{ start: string; end: string }> = [];
  const p = m.period as { start: string; end: string };
  let n = 0;
  for (const b of buckets) {
    const bs = p.start.startsWith('$bucket.') ? asLex(getPath(b, p.start.slice(8))) : null;
    const be = p.end.startsWith('$bucket.') ? asLex(getPath(b, p.end.slice(8))) : null;
    if (bs !== null && be !== null) bucketPeriods.push({ start: bs, end: be });
    const results = getPath(b, r.resultsPath);
    if (!Array.isArray(results)) throw new StatementImportError('SHAPE_ERROR', `mapping ${m.id}: bucket without ${r.resultsPath} array`);
    for (const res of results) {
      n++;
      const raw = flattenForRaw(res);
      for (const [k, v] of Object.entries(flattenForRaw(b))) if (!k.startsWith(`${r.resultsPath}`)) raw[`$bucket.${k}`] = v;
      out.push({ index: n, get: (f) => (f.startsWith('$bucket.') ? getPath(b, f.slice(8)) : getPath(res, f)), raw, node: res });
    }
  }
  return { records: out, marker, buckets: bucketPeriods };
}

function wrapTime<T>(fn: () => T, m: StatementMapping, where: string): T {
  try { return fn(); } catch (e) {
    if (e instanceof TimestampError) throw new StatementImportError(e.code, `mapping ${m.id}, ${where}: ${e.message}`);
    throw e;
  }
}

interface AmountParse { amount: ScaledAmount; precision: number }

function parseAmount(lex: string, m: NonNullable<StatementMapping['amount']>): AmountParse {
  const p = parseDecimal(lex);
  const shift = scaleDigits(BigInt(m.divisor));
  const amount = { units: p.amount.units, scale: p.amount.scale * pow10(shift) };
  const lexDecimals = p.decimals + shift;
  let precision = lexDecimals;
  if (m.precisionDecimals !== null) precision = m.precisionDecimals;
  else if (m.binaryFloat && p.msdExponent !== null) precision = Math.min(lexDecimals, Math.max(0, 14 - (p.msdExponent - shift)));
  return { amount, precision };
}

const merge = (xs: Array<{ start: string; end: string }>): Array<{ start: string; end: string }> => {
  const s = [...xs].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const out: Array<{ start: string; end: string }> = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) { if (x.end > last.end) last.end = x.end; } else out.push({ ...x });
  }
  return out;
};

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Import a statement. `bytes` is the exact file content (digest is computed over it). */
export function importStatement(bytes: string | Uint8Array, m: StatementMapping, opts: ImportOptions): ProviderStatement {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  const sourceDigest = sha256Hex(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
  const tz = opts.declaredTimezone !== undefined ? opts.declaredTimezone : m.timestamps.declaredTimezone;
  const aliases = opts.aliasTable ?? RECON_ALIAS_TABLE_V1;
  let read: ReturnType<typeof readRecords>;
  try { read = readRecords(text, m); } catch (e) {
    if (e instanceof StatementParseError) throw new StatementImportError('PARSE_ERROR', `mapping ${m.id}: ${e.message}`);
    throw e;
  }
  if (read.marker !== null && opts.declaredOrigin === 'REAL') {
    throw new StatementImportError('ORIGIN_CONFLICT', `file carries a synthetic marker (${read.marker}) but was declared REAL`);
  }
  const origin: DataOrigin = read.marker !== null ? 'FIXTURE' : opts.declaredOrigin;
  const provider: ReconProvider = m.provider;
  const lines: StatementLine[] = [];
  const timeOf = (rec: SourceRecord, field: string): IsoUtc => {
    const lex = asLex(rec.get(field));
    if (lex === null) throw new StatementImportError('INVALID_TIMESTAMP', `mapping ${m.id}, record ${rec.index}: ${field} is empty`);
    return wrapTime(() => parseInstant(lex, tz ?? null, m.timestamps.format), m, `record ${rec.index} field ${field}`);
  };

  for (const rec of read.records) {
    const issues: string[] = [];
    let periodStart: IsoUtc; let periodEnd: IsoUtc;
    if ('day' in m.period) {
      const lex = asLex(rec.get(m.period.day));
      if (lex === null) throw new StatementImportError('INVALID_TIMESTAMP', `mapping ${m.id}, record ${rec.index}: ${m.period.day} is empty`);
      const d = wrapTime(() => parseLocalDay(lex, tz ?? null), m, `record ${rec.index} field ${m.period.day}`);
      periodStart = d.start; periodEnd = d.end;
    } else {
      periodStart = timeOf(rec, m.period.start);
      periodEnd = timeOf(rec, m.period.end);
      if (periodEnd <= periodStart) issues.push(`period end ${periodEnd} is not after start ${periodStart}`);
    }

    let kind: LineKind = 'usage';
    for (const k of m.kind.rules) if (ruleMatches(rec, k)) { kind = k.kind; break; }
    const inScope = m.scope === null ? true : m.scope.allowed.includes((asLex(rec.get(m.scope.field)) ?? '').trim());

    let modelRaw: string | null = null;
    let canon: ReturnType<typeof canonicalModel> = { canonical: null, viaAlias: false, rule: null };
    if (m.model && 'fromDescription' in m.model) {
      modelRaw = asLex(rec.get(m.model.fromDescription));
      canon = modelFromDescription(provider, modelRaw, aliases);
    } else if (m.model) {
      const v = asLex(rec.get(m.model.field));
      if (v !== null && m.model.regex) {
        const mm = new RegExp(m.model.regex).exec(v);
        modelRaw = mm ? (mm[m.model.group ?? 1] ?? null)?.trim() ?? null : null;
      } else modelRaw = v;
      canon = canonicalModel(provider, modelRaw, aliases, opts.extraAliases ?? {});
    }

    let currency: string | null = null;
    if (m.currency && 'constant' in m.currency) currency = m.currency.constant;
    else if (m.currency) currency = asLex(rec.get(m.currency.field))?.trim().toUpperCase() ?? null;

    const requestId = m.requestId ? asLex(rec.get(m.requestId.field)) : null;
    const projectOrKey = m.projectOrKey.map((f) => [f, asLex(rec.get(f))] as const).filter(([, v]) => v !== null).map(([f, v]) => `${f}=${v}`).join(';') || null;

    const base = {
      provider, model: modelRaw, canonicalModel: canon.canonical, modelRule: canon.rule,
      periodStart, periodEnd, requestId, projectOrKey, kind, isTax: kind === 'tax', isCredit: kind === 'credit', inScope, raw: rec.raw,
    };

    if (m.expand) {
      const q = new Map<UsageCategory, bigint | null>();
      for (const e of m.expand) {
        const lex = asLex(rec.get(e.quantityField));
        let val: bigint | null = null;
        if (lex === null) issues.push(`${e.quantityField} absent`);
        else {
          try { val = parseIntegerQuantity(lex); } catch (err) { issues.push(`${e.quantityField}: ${(err as Error).message}`); }
        }
        q.set(e.category, (q.get(e.category) ?? 0n) + (val ?? 0n));
        if (val === null) q.set(e.category, null);
      }
      if (m.subtractFromInput.length > 0 && q.get('input') != null) {
        let inp = q.get('input')!;
        for (const c of m.subtractFromInput) { const v = q.get(c); if (v != null) inp -= v; }
        if (inp < 0n) { issues.push(`input minus ${m.subtractFromInput.join('+')} is negative`); q.set('input', null); } else q.set('input', inp);
      }
      const modelIssue = canon.canonical === null ? [`model ${JSON.stringify(modelRaw)} not in alias table ${aliases.id}`] : [];
      let sub = 0;
      for (const [cat, qty] of [...q.entries()]) {
        sub++;
        const lineIssues = [...issues, ...modelIssue];
        lines.push({
          ...base, lineId: `${m.id}#${rec.index}.${sub}`,
          usageCategory: lineIssues.length > 0 ? 'unknown' : cat,
          quantity: qty, unit: qty === null ? null : 'tokens',
          amount: null, amountPrecisionDecimals: null, currency: null, issues: lineIssues,
        });
      }
      continue;
    }

    let usageCategory: UsageCategory = m.category!.fallback;
    for (const r of m.category!.rules) if (ruleMatches(rec, r)) { usageCategory = r.category; break; }

    let amount: ScaledAmount | null = null;
    let precision: number | null = null;
    if (m.amount) {
      const lex = asLex(rec.get(m.amount.field));
      if (lex === null) issues.push(`${m.amount.field} absent`);
      else {
        try { const a = parseAmount(lex, m.amount); amount = a.amount; precision = a.precision; } catch (err) {
          if (!(err instanceof DecimalParseError)) throw err;
          issues.push(`${m.amount.field}: ${err.message}`);
        }
      }
    }

    let quantity: bigint | null = null;
    let unit: string | null = null;
    if (m.quantity) {
      const lex = asLex(rec.get(m.quantity.field));
      const u = m.quantity.unitField ? asLex(rec.get(m.quantity.unitField)) : m.quantity.unit;
      if (lex !== null && kind === 'usage') {
        if (m.quantity.allowedUnits !== null && (u === null || !m.quantity.allowedUnits.includes(u.trim()))) {
          issues.push(`quantity unit ${JSON.stringify(u)} not recognized as tokens (allowed ${JSON.stringify(m.quantity.allowedUnits)}); quantity not used`);
        } else {
          try { quantity = parseIntegerQuantity(lex); unit = u ?? m.quantity.unit; } catch (err) { issues.push(`${m.quantity.field}: ${(err as Error).message}`); }
        }
      }
    }

    const tokenCategory = usageCategory !== 'other' && usageCategory !== 'unknown';
    const hardIssues = issues.filter((x) => !x.includes('quantity not used'));
    if (kind === 'usage' && inScope && tokenCategory && canon.canonical === null) hardIssues.push(`model ${JSON.stringify(modelRaw)} not in alias table ${aliases.id}`);
    if (kind === 'usage' && inScope && amount !== null && currency === null) hardIssues.push('amount without currency');
    const allIssues = [...new Set([...issues, ...hardIssues])];
    lines.push({
      ...base, lineId: `${m.id}#${rec.index}`,
      usageCategory: kind === 'usage' && inScope && hardIssues.length > 0 ? 'unknown' : usageCategory,
      quantity, unit, amount, amountPrecisionDecimals: amount === null ? null : precision,
      currency, issues: allIssues,
    });

    if (m.credits && rec.node !== null) {
      const arr = getPath(rec.node, m.credits.arrayField);
      if (Array.isArray(arr)) {
        arr.forEach((c, k) => {
          const lex = asLex(getPath(c, m.credits!.amountField));
          const cIssues: string[] = [];
          let camt: ScaledAmount | null = null; let cprec: number | null = null;
          if (lex === null) cIssues.push('credit amount absent');
          else {
            try { const a = parseAmount(lex, m.amount ?? { field: '', divisor: '1', binaryFloat: true, precisionDecimals: null }); camt = a.amount; cprec = a.precision; } catch (err) { cIssues.push(`credit amount: ${(err as Error).message}`); }
          }
          lines.push({
            ...base, lineId: `${m.id}#${rec.index}.c${k + 1}`, kind: 'credit', isTax: false, isCredit: true,
            usageCategory: 'other', quantity: null, unit: null, amount: camt, amountPrecisionDecimals: cprec, currency,
            raw: { ...flattenForRaw(c, 'credit'), ...rec.raw }, issues: cIssues,
          });
        });
      } else if (arr !== undefined && arr !== null && !(arr instanceof JsonNumber)) {
        lines.push({ ...base, lineId: `${m.id}#${rec.index}.c?`, kind: 'credit', isTax: false, isCredit: true, usageCategory: 'unknown', quantity: null, unit: null, amount: null, amountPrecisionDecimals: null, currency, issues: [`${m.credits.arrayField} is not an array`] });
      }
    }
  }

  const coverageParts: Array<{ start: string; end: string }> = [];
  if (read.buckets) {
    for (const b of read.buckets) coverageParts.push({ start: wrapTime(() => parseInstant(b.start, tz ?? null, m.timestamps.format), m, 'bucket start'), end: wrapTime(() => parseInstant(b.end, tz ?? null, m.timestamps.format), m, 'bucket end') });
  }
  for (const l of lines) if (l.periodEnd > l.periodStart) coverageParts.push({ start: l.periodStart, end: l.periodEnd });
  const coverage = merge(coverageParts);
  if (coverage.length === 0) throw new StatementImportError('EMPTY_STATEMENT', `mapping ${m.id}: no record and no bucket; check the export filters and period`);
  const currencies = new Set(lines.filter((l) => l.kind === 'usage' && l.inScope && l.amount !== null).map((l) => l.currency ?? '?'));
  return {
    schema: 'otk.provider_statement.v1', provider, source: m.format === 'csv' ? 'csv' : 'json', mappingId: m.id,
    mappingProvenance: m.provenance, sourceDigest, origin, syntheticMarker: read.marker,
    period: { start: coverage[0]!.start, end: coverage[coverage.length - 1]!.end, declaredTimezone: tz ?? 'none (all values carried their own offset)' },
    currency: currencies.size === 0 ? null : currencies.size === 1 ? [...currencies][0]! : 'MIXED',
    coverage, lines,
  };
}
