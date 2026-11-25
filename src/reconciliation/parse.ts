/**
 * Lossless readers for provider exports.
 *
 *  - parseCsv: RFC 4180 (quoted fields, doubled quotes, CRLF/LF). Leading lines starting with '#'
 *    before the header are kept as a preamble (used by synthetic fixtures to carry their marker);
 *    real provider exports have none.
 *  - parseJsonLossless: JSON where every number is kept as its source LEXEME (JsonNumber), so money
 *    written as a JSON number (e.g. OpenAI amount.value) is never rounded through a binary float.
 *
 * @module reconciliation/parse
 */

/**
 * Raised when a CSV or JSON export cannot be read losslessly.
 */
export class StatementParseError extends Error {
  constructor(message: string) { super(message); this.name = 'StatementParseError'; }
}

/**
 * A parsed CSV file: `#` preamble lines (without the `#`), trimmed header names and the raw data rows.
 */
export interface CsvTable { preamble: string[]; header: string[]; rows: string[][] }

/**
 * Parses CSV text (RFC 4180) without converting any value; a leading byte-order mark is ignored.
 *
 * @param text - Whole file content.
 * @param delimiter - Field separator (one character; default comma).
 * @returns The preamble, header and rows; blank lines are skipped.
 * @throws {@link StatementParseError} On a stray or unterminated quote, an empty file, a duplicated column or a
 *   row whose field count differs from the header.
 */
export function parseCsv(text: string, delimiter = ','): CsvTable {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const preamble: string[] = [];
  while (src.startsWith('#')) {
    const nl = src.indexOf('\n');
    const line = nl < 0 ? src : src.slice(0, nl);
    preamble.push(line.replace(/\r$/, '').slice(1).trim());
    src = nl < 0 ? '' : src.slice(nl + 1);
  }
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let i = 0;
  let inQuotes = false;
  let fieldStarted = false;
  while (i < src.length) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; i++; continue; }
    if (c === '"') throw new StatementParseError(`CSV: stray quote at record ${records.length + 1}`);
    if (c === delimiter) { row.push(field); field = ''; fieldStarted = false; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = ''; fieldStarted = false;
      if (!(row.length === 1 && row[0] === '')) records.push(row);
      row = [];
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; fieldStarted = true; i++;
  }
  if (inQuotes) throw new StatementParseError('CSV: unterminated quoted field');
  if (fieldStarted || row.length > 0) { row.push(field); if (!(row.length === 1 && row[0] === '')) records.push(row); }
  if (records.length === 0) throw new StatementParseError('CSV: no header');
  const header = records[0]!.map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of header) {
    if (seen.has(h)) throw new StatementParseError(`CSV: duplicated column ${JSON.stringify(h)}`);
    seen.add(h);
  }
  const rows = records.slice(1);
  rows.forEach((r, k) => {
    if (r.length !== header.length) throw new StatementParseError(`CSV: record ${k + 2} has ${r.length} fields, header has ${header.length}`);
  });
  return { preamble, header, rows };
}

/** A JSON number kept as its exact source text. */
export class JsonNumber {
  constructor(public readonly lexeme: string) {}
  /**
   * Returns the number exactly as written in the source.
   *
   * @returns The source text of the number.
   */
  toString(): string { return this.lexeme; }
}

/**
 * A JSON value as read by {@link parseJsonLossless}: numbers stay {@link JsonNumber} lexemes.
 */
export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | { [k: string]: JsonValue };

/**
 * Parses JSON keeping every number as its exact source text; a leading byte-order mark is ignored.
 *
 * @param text - JSON text.
 * @returns The parsed value.
 * @throws {@link StatementParseError} On invalid syntax, a duplicated object key or trailing data.
 */
export function parseJsonLossless(text: string): JsonValue {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let i = 0;
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  const fail = (msg: string): never => { throw new StatementParseError(`JSON: ${msg} at offset ${i}`); };
  const value = (): JsonValue => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++; const o: { [k: string]: JsonValue } = {}; ws();
      if (s[i] === '}') { i++; return o; }
      for (;;) {
        ws(); if (s[i] !== '"') fail('object key expected');
        const k = str(); ws(); if (s[i] !== ':') fail('":" expected'); i++;
        if (Object.prototype.hasOwnProperty.call(o, k)) fail(`duplicated key ${JSON.stringify(k)}`);
        o[k] = value(); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return o; }
        fail('"," or "}" expected');
      }
    }
    if (c === '[') {
      i++; const a: JsonValue[] = []; ws();
      if (s[i] === ']') { i++; return a; }
      for (;;) {
        a.push(value()); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return a; }
        fail('"," or "]" expected');
      }
    }
    if (c === '"') return str();
    if (s.startsWith('true', i)) { i += 4; return true; }
    if (s.startsWith('false', i)) { i += 5; return false; }
    if (s.startsWith('null', i)) { i += 4; return null; }
    const numRe = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    numRe.lastIndex = i;
    const m = numRe.exec(s);
    if (!m) return fail('value expected');
    i += m[0].length;
    return new JsonNumber(m[0]);
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
    if (i >= s.length) fail('unterminated string');
    i++;
    return JSON.parse(s.slice(start, i)) as string;
  };
  const v = value();
  ws();
  if (i !== s.length) fail('trailing data');
  return v;
}

/**
 * Value at a dot path ('a.b.c'); keys containing dots are not supported (JSON exports here have none).
 *
 * @param obj - JSON value to read.
 * @param path - Dot-separated member names.
 * @returns The value found, or `undefined` when a step is missing or not an object.
 */
export function getPath(obj: JsonValue | undefined, path: string): JsonValue | undefined {
  let cur: JsonValue | undefined = obj;
  for (const k of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || Array.isArray(cur) || cur instanceof JsonNumber) return undefined;
    cur = (cur as { [k: string]: JsonValue })[k];
  }
  return cur;
}

/**
 * Scalar → its source lexeme; objects/arrays → canonical JSON text; null/undefined → null.
 *
 * @param v - JSON value.
 * @returns The text form; numbers inside objects/arrays are written as `#num:<lexeme>` strings.
 */
export function lexemeOf(v: JsonValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof JsonNumber) return v.lexeme;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v, (_k, x) => (x instanceof JsonNumber ? `#num:${x.lexeme}` : x));
}

/**
 * Flatten a JSON object to { 'a.b': lexeme } for the audit copy of a row (sorted keys).
 *
 * @param v - JSON value to flatten (arrays are kept whole as one text value).
 * @param prefix - Path of `v`; empty at the top level.
 * @param out - Object that receives the entries (mutated).
 * @returns `out`.
 */
export function flattenForRaw(v: JsonValue, prefix = '', out: Record<string, string | null> = {}): Record<string, string | null> {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNumber)) {
    for (const k of Object.keys(v).sort()) flattenForRaw(v[k]!, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = lexemeOf(v);
  }
  return out;
}
