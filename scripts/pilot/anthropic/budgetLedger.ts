/**
 * Budget ledger for paid Anthropic pilot calls (session 2026-09-29/30).
 *
 * Rules (authorised ceiling: USD 3.00 for the whole pilot, never reset):
 *   - one append-only JSONL file shared by every process; the file is the only state, so a
 *     restart or a context compaction re-reads it and the budget does not reset;
 *   - a call may start only after a reservation of its maximum conservative cost has been
 *     appended under an exclusive cross-process lock (no parallel call without reservation);
 *   - reservation = input bound × highest input-category rate + max_tokens × output rate, where the
 *     input bound is the model's documented context window (fechamento pós-S5, RV2-04; it replaced a
 *     UTF-8 byte count + 256 that had no documented basis);
 *   - settlement: known usage → cost from usage; request refused before processing
 *     (HTTP 400/401/403/404/413/429 with an error body) → 0; anything else (timeout, lost
 *     connection, 5xx, unparsable response, missing usage field) → the reservation stays;
 *   - retries and diagnostic calls are separate reservations under the same ceiling;
 *   - a lock that cannot be acquired is never removed here: the call is refused.
 * Prices are the official list prices consulted on 2026-09-29 (Anthropic) and 2026-10-03 (OpenAI gpt-4o-mini),
 * not an invoice. One canonical ledger FILE per provider, each with its own USD 3.00 ceiling (author decision
 * 2026-10-03: Anthropic, OpenAI and Google Gemini capped separately; Gemini prices consulted 2026-10-03).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HARD_CAP_USD = 3.0;

export interface ModelPrice {
  inputPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
  cacheReadPerMTok: number;
  outputPerMTok: number;
  source: string;
  consultedAt: string;
}

const HAIKU_45: ModelPrice = {
  inputPerMTok: 1.0,
  cacheWrite5mPerMTok: 1.25,
  cacheWrite1hPerMTok: 2.0,
  cacheReadPerMTok: 0.1,
  outputPerMTok: 5.0,
  source: 'https://platform.claude.com/docs/en/about-claude/pricing (Claude Haiku 4.5 row)',
  consultedAt: '2026-09-29',
};

// OpenAI has no cache-write tariff: writes are priced at the input rate so the worst input rate stays the input price
const GPT_4O_MINI: ModelPrice = {
  inputPerMTok: 0.15,
  cacheWrite5mPerMTok: 0.15,
  cacheWrite1hPerMTok: 0.15,
  cacheReadPerMTok: 0.075,
  outputPerMTok: 0.6,
  source: 'https://developers.openai.com/api/docs/pricing (gpt-4o-mini, Standard tier)',
  consultedAt: '2026-10-03',
};

// Gemini has no cache-write tariff for implicit caching (explicit cachedContent is refused): writes priced at the input rate
const GEMINI_25_FLASH_LITE: ModelPrice = {
  inputPerMTok: 0.1,
  cacheWrite5mPerMTok: 0.1,
  cacheWrite1hPerMTok: 0.1,
  cacheReadPerMTok: 0.01,
  outputPerMTok: 0.4,
  source: 'https://ai.google.dev/gemini-api/docs/pricing (gemini-2.5-flash-lite, Standard paid tier; output includes thinking)',
  consultedAt: '2026-10-03',
};

// author decision 2026-10-04: gemini-3.5-flash-lite (2.5 closed to the account); same Gemini ledger and US$ 3 cap
const GEMINI_35_FLASH_LITE: ModelPrice = {
  inputPerMTok: 0.3,
  cacheWrite5mPerMTok: 0.3,
  cacheWrite1hPerMTok: 0.3,
  cacheReadPerMTok: 0.03,
  outputPerMTok: 2.5,
  source: 'https://ai.google.dev/gemini-api/docs/pricing (gemini-3.5-flash-lite, Standard paid tier; output includes thinking)',
  consultedAt: '2026-10-04',
};

/** Only models with a verified price may be called. */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-4-5-20251001': HAIKU_45,
  'claude-haiku-4-5': HAIKU_45,
  'gpt-4o-mini': GPT_4O_MINI,
  'gpt-4o-mini-2024-07-18': GPT_4O_MINI,
  'gemini-2.5-flash-lite': GEMINI_25_FLASH_LITE,
  'gemini-3.5-flash-lite': GEMINI_35_FLASH_LITE,
};

/** Request refused before processing: settled at zero. */
const REFUSED_BEFORE_PROCESSING = new Set([400, 401, 403, 404, 413, 429]);

export class BudgetError extends Error {
  constructor(public readonly code: 'cap_exceeded' | 'unknown_price' | 'lock_timeout' | 'bad_limits' | 'unknown_reservation', message: string) {
    super(message);
  }
}

export interface ProviderUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  [k: string]: unknown;
}

/**
 * Documented context window per priced model (tokens). The API refuses (HTTP 400) a request whose
 * input alone exceeds it, and every input category counts toward it, so it bounds the billable input
 * of one request. Sources: https://platform.claude.com/docs/en/about-claude/models/overview and
 * https://platform.claude.com/docs/en/build-with-claude/context-windows, consulted 2026-10-02.
 */
export const CONTEXT_WINDOW_TOKENS: Readonly<Record<string, number>> = {
  'claude-haiku-4-5-20251001': 200_000,
  'claude-haiku-4-5': 200_000,
  // https://developers.openai.com/api/docs/models/gpt-4o-mini, consulted 2026-10-03
  'gpt-4o-mini': 128_000,
  'gpt-4o-mini-2024-07-18': 128_000,
  // https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite (input token limit), consulted 2026-10-03
  'gemini-2.5-flash-lite': 1_048_576,
  // https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite (input token limit), consulted 2026-10-04
  'gemini-3.5-flash-lite': 1_048_576,
};

/** Upper bound for the billable input tokens of one request to `model`: its documented context window. */
export function maxInputTokensFor(model: string): number {
  const w = CONTEXT_WINDOW_TOKENS[model];
  if (!w) throw new BudgetError('unknown_price', `no documented context window for model ${model}`);
  return w;
}

export function maxCostUsd(model: string, maxInputTokens: number, maxOutputTokens: number): number {
  const p = PRICES[model];
  if (!p) throw new BudgetError('unknown_price', `no verified price for model ${model}`);
  if (!(Number.isInteger(maxInputTokens) && maxInputTokens > 0 && Number.isInteger(maxOutputTokens) && maxOutputTokens > 0)) {
    throw new BudgetError('bad_limits', 'input/output limits must be positive integers');
  }
  const inputRate = Math.max(p.inputPerMTok, p.cacheWrite5mPerMTok, p.cacheWrite1hPerMTok, p.cacheReadPerMTok);
  return (maxInputTokens * inputRate + maxOutputTokens * p.outputPerMTok) / 1e6;
}

/**
 * Cost of one response from its usage. Returns null (unknown) when a field the price needs
 * is missing: absent is not zero.
 */
export function costFromUsage(model: string, usage: ProviderUsage | undefined | null): { usd: number; breakdown: Record<string, number> } | null {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const { input_tokens: inp, output_tokens: out } = usage;
  const cw = usage.cache_creation_input_tokens;
  const cr = usage.cache_read_input_tokens;
  if (typeof inp !== 'number' || typeof out !== 'number' || typeof cw !== 'number' || typeof cr !== 'number') return null;
  // a malformed count (negative, fractional) cannot price a call: unknown, never under-priced
  if (![inp, out, cw, cr].every((v) => Number.isInteger(v) && v >= 0)) return null;
  // Cache writes: split by TTL when reported; otherwise charge the dearer 1h rate
  const cc = usage.cache_creation ?? undefined;
  const has5 = typeof cc?.ephemeral_5m_input_tokens === 'number';
  const has1 = typeof cc?.ephemeral_1h_input_tokens === 'number';
  // Without a split, all writes are charged at the dearer 1h rate
  const w5 = has5 ? cc!.ephemeral_5m_input_tokens! : has1 ? cw - cc!.ephemeral_1h_input_tokens! : 0;
  const w1 = has1 ? cc!.ephemeral_1h_input_tokens! : cw - w5;
  if (w5 < 0 || w1 < 0 || w5 + w1 !== cw) return null; // inconsistent split: cost unknown
  const breakdown = {
    input: inp * p.inputPerMTok / 1e6,
    cacheWrite5m: w5 * p.cacheWrite5mPerMTok / 1e6,
    cacheWrite1h: w1 * p.cacheWrite1hPerMTok / 1e6,
    cacheRead: cr * p.cacheReadPerMTok / 1e6,
    output: out * p.outputPerMTok / 1e6,
  };
  return { usd: Object.values(breakdown).reduce((a, b) => a + b, 0), breakdown };
}

type Entry =
  | { type: 'reserve'; id: string; ts: string; pid: number; purpose: string; model: string;
      maxInputTokens: number; maxOutputTokens: number; reservedUsd: number }
  | { type: 'settle'; id: string; ts: string; outcome: 'ok' | 'refused' | 'uncertain';
      httpStatus?: number; costUsd?: number; usage?: ProviderUsage; note?: string;
      providerRequestId?: string; providerMessageId?: string };

export interface BudgetSummary {
  capUsd: number;
  reservations: number;
  settledOk: number;
  refused: number;
  uncertain: number;
  open: number;
  confirmedUsd: number;       // cost computed from provider-reported usage
  uncertainUsd: number;       // reservations kept for timeouts/lost/unknown cost
  openUsd: number;            // reservations not yet settled (call in flight or crashed)
  exposureUsd: number;        // confirmed + uncertain + open
  remainingUsd: number;
}

export class BudgetLedger {
  readonly capUsd: number;
  private readonly lockPath: string;

  constructor(readonly file: string, capUsd = HARD_CAP_USD, private readonly lockTimeoutMs = 10_000) {
    // The configured cap can only lower the authorised ceiling
    if (!Number.isFinite(capUsd) || capUsd < 0) throw new BudgetError('bad_limits', `invalid cap ${capUsd}`);
    this.capUsd = Math.min(capUsd, HARD_CAP_USD);
    this.lockPath = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  private read(): Entry[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as Entry);
  }

  private append(e: Entry): void {
    const fd = fs.openSync(this.file, 'a');
    try { fs.writeSync(fd, JSON.stringify(e) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  private withLock<T>(fn: () => T): T {
    const token = `${process.pid}:${crypto.randomUUID()}`;
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, token); fs.closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (Date.now() > deadline) {
          throw new BudgetError('lock_timeout', `ledger lock busy: ${this.lockPath} (not removed automatically)`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try { return fn(); } finally {
      // Never mask fn's own error; a lock removed by someone else is simply gone
      try { if (fs.readFileSync(this.lockPath, 'utf8') === token) fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
    }
  }

  summary(entries = this.read()): BudgetSummary {
    const res = new Map<string, Extract<Entry, { type: 'reserve' }>>();
    const settle = new Map<string, Extract<Entry, { type: 'settle' }>>();
    for (const e of entries) (e.type === 'reserve' ? res.set(e.id, e) : settle.set(e.id, e));
    const s: BudgetSummary = { capUsd: this.capUsd, reservations: res.size, settledOk: 0, refused: 0, uncertain: 0, open: 0,
      confirmedUsd: 0, uncertainUsd: 0, openUsd: 0, exposureUsd: 0, remainingUsd: 0 };
    for (const [id, r] of res) {
      const st = settle.get(id);
      if (!st) { s.open++; s.openUsd += r.reservedUsd; continue; }
      if (st.outcome === 'refused') { s.refused++; continue; }
      if (st.outcome === 'ok' && typeof st.costUsd === 'number') {
        s.settledOk++;
        // A cost above the reservation would mean the bound was wrong: count the larger
        s.confirmedUsd += st.costUsd;
        continue;
      }
      s.uncertain++; s.uncertainUsd += r.reservedUsd;
    }
    s.exposureUsd = s.confirmedUsd + s.uncertainUsd + s.openUsd;
    s.remainingUsd = this.capUsd - s.exposureUsd;
    return s;
  }

  /** Reserve the maximum cost of one attempt; throws if it would pass the ceiling. */
  reserve(purpose: string, model: string, maxInputTokens: number, maxOutputTokens: number): { id: string; reservedUsd: number } {
    const reservedUsd = maxCostUsd(model, maxInputTokens, maxOutputTokens);
    return this.withLock(() => {
      const sum = this.summary();
      if (sum.exposureUsd + reservedUsd > this.capUsd + 1e-12) {
        throw new BudgetError('cap_exceeded', `reservation ${reservedUsd.toFixed(6)} would exceed cap (exposure ${sum.exposureUsd.toFixed(6)} of ${this.capUsd})`);
      }
      const id = crypto.randomUUID();
      this.append({ type: 'reserve', id, ts: new Date().toISOString(), pid: process.pid, purpose, model, maxInputTokens, maxOutputTokens, reservedUsd });
      return { id, reservedUsd };
    });
  }

  /**
   * Settle one reservation. `usage` from the provider gives the cost; a refusal before
   * processing gives zero; any other case keeps the reservation (uncertain).
   */
  settle(id: string, info: { httpStatus?: number; usage?: ProviderUsage | null; errorBody?: boolean; note?: string;
    providerRequestId?: string; providerMessageId?: string }): Extract<Entry, { type: 'settle' }> {
    return this.withLock(() => {
      const entries = this.read();
      const r = entries.find(e => e.type === 'reserve' && e.id === id) as Extract<Entry, { type: 'reserve' }> | undefined;
      if (!r) throw new BudgetError('unknown_reservation', `no reservation ${id}`);
      if (entries.some(e => e.type === 'settle' && e.id === id)) throw new BudgetError('unknown_reservation', `already settled ${id}`);
      const base = { type: 'settle' as const, id, ts: new Date().toISOString(), httpStatus: info.httpStatus, note: info.note,
        providerRequestId: info.providerRequestId, providerMessageId: info.providerMessageId };
      let e: Extract<Entry, { type: 'settle' }>;
      const cost = info.httpStatus === 200 ? costFromUsage(r.model, info.usage) : null;
      if (cost) e = { ...base, outcome: 'ok', costUsd: cost.usd, usage: info.usage ?? undefined };
      else if (info.httpStatus !== undefined && REFUSED_BEFORE_PROCESSING.has(info.httpStatus) && info.errorBody) e = { ...base, outcome: 'refused', costUsd: 0 };
      else e = { ...base, outcome: 'uncertain', usage: info.usage ?? undefined };
      this.append(e);
      return e;
    });
  }
}
