/**
 * Deterministic matcher: OTK records × provider statement lines → classified differences.
 *
 * Join (never on amount): provider + model (canonical, via the explicit alias table) + period
 * (OTK observedAt inside the provider line period) + usage category; per request id when EVERY
 * provider line carries one. Provider exports are usually daily/hourly aggregates per model: then
 * per-operation matching is impossible and the comparison is aggregate-vs-aggregate (the report says so).
 *
 * Rounding policy (otk.reconciliation_rounding.v1):
 *  - OTK category amounts are exact (tokens × micro-USD/MTok = pico-USD, no rounding);
 *  - each provider line contributes half a unit of its last significant decimal (lexeme digits, or the
 *    mapping's declared precision, or 15 significant digits for binary-float exports);
 *  - an OTK value converted from a float source contributes half a pico-USD per rounded record;
 *  - |OTK − provider| ≤ the sum of these half units ⇒ ROUNDING (0 ⇒ MATCH). Nothing else is "rounding".
 *
 * Classification order for a category aggregate: MISSING_* when a side is absent; agreement → MATCH /
 * MODEL_ALIAS / ROUNDING; otherwise TIMING_WINDOW (moving boundary records resolves it), CACHE_CATEGORY
 * (input-family totals agree), PRICE_VERSION (same tokens, another price version explains the amount),
 * else UNMATCHED. Lines/records that cannot be interpreted are UNKNOWN; non-token costs are MISSING_OTK.
 *
 * @module reconciliation/match
 */
import type {
  Classification, Comparison, OtkRecord, ProviderStatement, ReconciliationDifference, ReconciliationMatch,
  ReconciliationReport, ReconciliationWindow, ReconProvider, ResultKey, ResultLevel, ScaledAmount, StatementLine, UsageCategory,
} from './types.js';
import { CLASSIFICATIONS } from './types.js';
import { absBig, maxScale, relDiffPercent, rescale, scaleDigits, subAmounts, sumAmounts, toDecimalString, pow10 } from './decimal.js';
import { canonicalModel, RECON_ALIAS_TABLE_V1 } from './aliases.js';
import type { AliasTable } from './aliases.js';
import { dayInZone } from './time.js';
import type { PriceTableV1 } from '../pricing/priceUsage.js';
import type { TokenCategoryName } from '../types/d1d8/index.js';
import type { OtkLoadResult } from './otkSource.js';

/**
 * Identifier of the rounding policy described above; written into every report.
 */
export const ROUNDING_POLICY_ID = 'otk.reconciliation_rounding.v1';
/**
 * Default tolerance (milliseconds) around a period boundary for the TIMING_WINDOW check.
 */
export const DEFAULT_TIMING_TOLERANCE_MS = 120_000;
const PICO = 1_000_000_000_000n;
const TOKEN_CATEGORIES: readonly UsageCategory[] = ['input', 'cache_read', 'cache_write', 'output', 'thinking'];
const INPUT_FAMILY: readonly UsageCategory[] = ['input', 'cache_read', 'cache_write'];
const PRICE_CATEGORY: Partial<Record<UsageCategory, TokenCategoryName>> = { input: 'input', output: 'output', cache_read: 'input_cache_read', cache_write: 'input_cache_write' };

/**
 * Input of {@link reconcile}.
 */
export interface ReconcileInput {
  statements: ProviderStatement[];
  otk: OtkLoadResult;
  window: ReconciliationWindow;
  /** Price tables used to price OTK categories and to test PRICE_VERSION; their aliases also join models. */
  priceTables?: PriceTableV1[];
  timingToleranceMs?: number;
  aliasTable?: AliasTable;
}

interface Group {
  id: string;
  model: string;
  start: string;
  end: string;
  orphan: boolean;
  requestId: string | null;
  lines: StatementLine[];
  records: OtkRecord[];
}

interface Side { present: boolean; qty: bigint | null; amount: ScaledAmount | null; currencyOk: boolean; tol2: (sDigits: number) => bigint; notes: string[] }
type AmtState = 'eq' | 'round' | 'diff' | null;
interface CatEval { category: UsageCategory; prov: Side; otk: Side; qtyEq: boolean | null; amt: AmtState; qtyCmp: Comparison | null; amtCmp: Comparison | null }

const ms = (iso: string): number => Date.parse(iso);
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function amountCmp(otk: ScaledAmount | null, prov: ScaledAmount | null, currency: string | null, tol2: (s: number) => bigint): { cmp: Comparison; state: AmtState } {
  if (otk === null || prov === null) {
    return {
      cmp: { metric: 'amount', currency, otk: otk ? toDecimalString(rescale(otk, maxScale(otk.scale, PICO))) : null, provider: prov ? toDecimalString(rescale(prov, maxScale(prov.scale, PICO))) : null, diff: null, absDiff: null, relDiff: null, relDiffNote: 'one side has no amount' },
      state: null,
    };
  }
  const S = maxScale(otk.scale, prov.scale, PICO);
  const o = rescale(otk, S); const p = rescale(prov, S);
  const diff = subAmounts(o, p);
  const rel = relDiffPercent(diff, p);
  const tol = tol2(scaleDigits(S));
  const state: AmtState = diff.units === 0n ? 'eq' : 2n * absBig(diff.units) <= tol ? 'round' : 'diff';
  return {
    cmp: {
      metric: 'amount', currency, otk: toDecimalString(o), provider: toDecimalString(p), diff: toDecimalString(diff),
      absDiff: toDecimalString({ units: absBig(diff.units), scale: S }), relDiff: rel,
      relDiffNote: rel === null ? 'undefined: provider amount is zero and OTK is not' : null,
    },
    state,
  };
}

function qtyCmp(otk: bigint | null, prov: bigint | null): { cmp: Comparison; eq: boolean | null } {
  if (otk === null || prov === null) {
    return { cmp: { metric: 'tokens', currency: null, otk: otk?.toString() ?? null, provider: prov?.toString() ?? null, diff: null, absDiff: null, relDiff: null, relDiffNote: 'one side has no token count' }, eq: null };
  }
  const d = otk - prov;
  const rel = relDiffPercent({ units: d, scale: 1n }, { units: prov, scale: 1n });
  return { cmp: { metric: 'tokens', currency: null, otk: otk.toString(), provider: prov.toString(), diff: d.toString(), absDiff: absBig(d).toString(), relDiff: rel, relDiffNote: rel === null ? 'undefined: provider count is zero and OTK is not' : null }, eq: d === 0n };
}

/**
 * Exact OTK amount of one record for one category with one table (pico-USD), or null.
 *
 * @param tables - Loaded price tables.
 * @param version - Price table version frozen for the record; `null` gives `null`.
 * @param provider - Provider of the record.
 * @param model - Canonical model (mapped through the table's aliases).
 * @param cat - Statement category (thinking has no price here).
 * @param count - Tokens.
 * @param at - Instant used to pick the effective price entry.
 * @param anyWindow - When no entry is effective at `at`, accept the single entry of the table if there is only one.
 */
function priceOf(tables: PriceTableV1[], version: string | null, provider: ReconProvider, model: string, cat: UsageCategory, count: bigint, at: string, anyWindow = false): { amount: ScaledAmount; price: bigint } | null {
  if (count === 0n) return { amount: { units: 0n, scale: PICO }, price: 0n };
  const pc = PRICE_CATEGORY[cat];
  if (!pc || version === null) return null;
  const t = tables.find((x) => x.version === version);
  if (!t) return null;
  const mdl = t.aliases[model] ?? model;
  const cands = t.entries.filter((e) => e.provider === provider && e.model === mdl && e.category === pc);
  const at_ = ms(at);
  let e = cands.find((x) => ms(x.effectiveFrom) <= at_ && (x.effectiveUntil === null || at_ < ms(x.effectiveUntil)));
  if (!e && anyWindow && cands.length === 1) e = cands[0];
  if (!e) return null;
  return { amount: { units: count * e.pricePerMTokMicroUsd, scale: PICO }, price: e.pricePerMTokMicroUsd };
}

function lineTol(lines: StatementLine[]): (s: number) => bigint {
  return (s: number) => lines.reduce((acc, l) => (l.amount === null || l.amountPrecisionDecimals === null ? acc : acc + pow10(Math.max(0, s - Math.min(s, l.amountPrecisionDecimals)))), 0n);
}

function providerSide(lines: StatementLine[], cat: UsageCategory): Side {
  const ls = lines.filter((l) => l.usageCategory === cat);
  const qs = ls.filter((l) => l.quantity !== null);
  const usd = ls.filter((l) => l.amount !== null && l.currency === 'USD');
  const nonUsd = ls.filter((l) => l.amount !== null && l.currency !== 'USD');
  const notes: string[] = [];
  if (nonUsd.length > 0) notes.push(`${nonUsd.length} provider line(s) in ${[...new Set(nonUsd.map((l) => l.currency))].join('/')}: amounts not compared (no float FX conversion)`);
  return {
    present: ls.length > 0,
    qty: qs.length > 0 ? qs.reduce((a, l) => a + l.quantity!, 0n) : null,
    amount: nonUsd.length > 0 ? null : sumAmounts(usd.map((l) => l.amount!)),
    currencyOk: nonUsd.length === 0,
    tol2: lineTol(usd),
    notes,
  };
}

function otkSide(records: OtkRecord[], cat: UsageCategory, model: string, tables: PriceTableV1[]): Side {
  const notes: string[] = [];
  let qty: bigint | null = null;
  let amount: ScaledAmount | null = { units: 0n, scale: PICO };
  let any = false;
  for (const r of records) {
    const q = r.quantities.find((x) => x.category === cat);
    if (!q) continue;
    any = true;
    qty = (qty ?? 0n) + q.count;
    if (cat === 'thinking') { amount = null; continue; }
    const p = priceOf(tables, r.priceTableVersion, r.provider, model, cat, q.count, r.observedAt);
    if (p === null) {
      if (amount !== null) notes.push(`OTK amount per category unavailable: price table ${r.priceTableVersion ?? '(unknown)'} not loaded or without ${model}/${cat}`);
      amount = null;
    } else if (amount !== null) amount = { units: amount.units + p.amount.units, scale: PICO };
  }
  if (cat === 'thinking' && any) notes.push('thinking is a subset/addend already billed as output: compared in tokens only');
  return { present: any, qty, amount: any ? amount : null, currencyOk: true, tol2: () => 0n, notes };
}

function evalCategory(g: Group, cat: UsageCategory, tables: PriceTableV1[]): CatEval {
  const prov = providerSide(g.lines, cat);
  const otk = otkSide(g.records, cat, g.model, tables);
  const q = qtyCmp(otk.present ? otk.qty : null, prov.present ? prov.qty : null);
  const a = amountCmp(otk.present ? otk.amount : null, prov.present ? prov.amount : null, prov.currencyOk ? 'USD' : null, (s) => prov.tol2(s) + otk.tol2(s));
  return { category: cat, prov, otk, qtyEq: q.eq, amt: a.state, qtyCmp: otk.present || prov.present ? q.cmp : null, amtCmp: otk.present || prov.present ? a.cmp : null };
}

const isZeroSide = (s: Side): boolean => (s.qty === null || s.qty === 0n) && (s.amount === null || s.amount.units === 0n);

/**
 * Do the comparable values of a category agree (missing side with all-zero counterpart counts as agreement)?
 *
 * @param e - Evaluation of one category in one group.
 */
function agrees(e: CatEval): boolean {
  if (!e.prov.present && !e.otk.present) return true;
  if (!e.prov.present) return isZeroSide(e.otk);
  if (!e.otk.present) return isZeroSide(e.prov);
  if (e.qtyEq === false) return false;
  if (e.amt === 'diff') return false;
  return e.qtyEq !== null || e.amt !== null;
}

function groupCategories(g: Group): UsageCategory[] {
  const s = new Set<UsageCategory>();
  for (const l of g.lines) s.add(l.usageCategory);
  for (const r of g.records) for (const q of r.quantities) if (TOKEN_CATEGORIES.includes(q.category)) s.add(q.category);
  return TOKEN_CATEGORIES.filter((c) => s.has(c));
}

function groupAgrees(g: Group, tables: PriceTableV1[]): boolean {
  return groupCategories(g).every((c) => agrees(evalCategory(g, c, tables)));
}

const fmtDur = (msd: number): string => (msd % 86_400_000 === 0 ? `${msd / 86_400_000}d` : msd % 3_600_000 === 0 ? `${msd / 3_600_000}h` : msd % 60_000 === 0 ? `${msd / 60_000}min` : `${msd}ms`);

/**
 * Reconciles OTK records with provider statements for one provider and window, classifying every difference.
 *
 * Deterministic: no clock or randomness is read, so the same input gives the same report. Inputs are not
 * modified.
 *
 * @param input - Statements, OTK records, window and optional price tables, tolerance and alias table.
 * @returns The full report (results, matches, adjustments, out-of-scope lines, totals and counts).
 * @throws {Error} When a statement is for a provider other than the window's provider.
 */
export function reconcile(input: ReconcileInput): ReconciliationReport {
  const { window } = input;
  const provider = window.provider;
  const tables = input.priceTables ?? [];
  const tol = input.timingToleranceMs ?? DEFAULT_TIMING_TOLERANCE_MS;
  const aliases = input.aliasTable ?? RECON_ALIAS_TABLE_V1;
  const extraAliases: Record<string, string> = {};
  for (const t of tables) Object.assign(extraAliases, t.aliases);
  const warnings: string[] = [];
  const results: ReconciliationDifference[] = [];
  const excluded: ReconciliationReport['excluded'] = input.otk.excluded.map((x) => ({ side: 'otk' as const, id: x.id, reason: x.reason }));
  const adjustments: ReconciliationReport['adjustments'] = [];
  const outOfScope: ReconciliationReport['outOfScope'] = [];
  const describe = (l: StatementLine): string => Object.entries(l.raw).filter(([k, v]) => v !== null && /desc|line_item|token_type|cost_type|credit|sku|name|type/i.test(k)).map(([k, v]) => `${k}=${v}`).sort().join('; ');
  const amtStr = (a: ScaledAmount | null) => (a === null ? null : toDecimalString(rescale(a, maxScale(a.scale, PICO))));

  for (const s of input.statements) {
    if (s.provider !== provider) throw new Error(`statement ${s.mappingId} is for ${s.provider}, window is for ${provider}`);
  }
  const coverage = input.statements.flatMap((s) => s.coverage).sort((a, b) => cmpStr(a.start, b.start));
  const covered = (t: string, slack: number) => coverage.some((c) => ms(c.start) - slack <= ms(t) && ms(t) < ms(c.end) + slack);

  const key = (model: string | null, category: UsageCategory | null, start: string | null, end: string | null, requestId: string | null = null): ResultKey => ({ provider, model, category, periodStart: start, periodEnd: end, requestId });
  const push = (level: ResultLevel, id: string, k: ResultKey, classification: Classification, agree: boolean, quantity: Comparison | null, amount: Comparison | null, explanation: string, lines: string[], ops: string[]) => {
    results.push({ id, level, key: k, classification, agrees: agree, quantity, amount, explanation, providerLineIds: [...lines].sort(), otkOperationIds: [...ops].sort() });
  };

  // 1. provider lines
  const matchable: StatementLine[] = [];
  const allLines = input.statements.flatMap((s) => s.lines).sort((a, b) => cmpStr(a.lineId, b.lineId));
  for (const l of allLines) {
    if (ms(l.periodEnd) <= ms(window.start) || ms(l.periodStart) >= ms(window.end)) { excluded.push({ side: 'provider', id: l.lineId, reason: `period [${l.periodStart}, ${l.periodEnd}) outside the window` }); continue; }
    if (ms(l.periodStart) < ms(window.start) || ms(l.periodEnd) > ms(window.end)) warnings.push(`line ${l.lineId} period [${l.periodStart}, ${l.periodEnd}) only partially overlaps the window; kept whole`);
    if (!l.inScope) { outOfScope.push({ lineId: l.lineId, amount: amtStr(l.amount), currency: l.currency, description: describe(l) }); continue; }
    if (l.kind !== 'usage') { adjustments.push({ lineId: l.lineId, kind: l.kind, amount: amtStr(l.amount), currency: l.currency, description: describe(l) }); continue; }
    const amountCmpLine = l.amount ? { metric: 'amount' as const, currency: l.currency, otk: null, provider: amtStr(l.amount), diff: null, absDiff: null, relDiff: null, relDiffNote: 'no OTK counterpart' } : null;
    const qtyCmpLine = l.quantity !== null ? { metric: 'tokens' as const, currency: null, otk: null, provider: l.quantity.toString(), diff: null, absDiff: null, relDiff: null, relDiffNote: 'no OTK counterpart' } : null;
    if (l.usageCategory === 'unknown' || l.issues.length > 0 || (l.usageCategory !== 'other' && l.canonicalModel === null)) {
      push('statement_line', `line:${l.lineId}`, key(l.model, l.usageCategory, l.periodStart, l.periodEnd, l.requestId), 'UNKNOWN', false, qtyCmpLine, amountCmpLine,
        `provider row could not be interpreted (${l.issues.join('; ') || 'unrecognized category'}); kept, not matched. ${describe(l)}`.trim(), [l.lineId], []);
      continue;
    }
    if (l.usageCategory === 'other') {
      const zero = (l.amount === null || l.amount.units === 0n) && (l.quantity === null || l.quantity === 0n);
      push('statement_line', `line:${l.lineId}`, key(l.model, 'other', l.periodStart, l.periodEnd, l.requestId), zero ? 'MATCH' : 'MISSING_OTK', zero, qtyCmpLine, amountCmpLine,
        `non-token cost (${describe(l)}): OTK does not meter it${zero ? '; zero amount, nothing to reconcile' : ''}`, [l.lineId], []);
      continue;
    }
    matchable.push(l);
  }

  // 2. OTK records
  const recs: Array<OtkRecord & { canon: string; canonRule: string | null }> = [];
  const inWindow = input.otk.records.filter((r) => {
    if (r.provider !== provider) { excluded.push({ side: 'otk', id: r.operationId, reason: `provider ${r.provider}` }); return false; }
    if (ms(r.observedAt) < ms(window.start) || ms(r.observedAt) >= ms(window.end)) { excluded.push({ side: 'otk', id: r.operationId, reason: `observedAt ${r.observedAt} outside the window` }); return false; }
    return true;
  }).sort((a, b) => cmpStr(a.observedAt, b.observedAt) || cmpStr(a.operationId, b.operationId));
  for (const r of inWindow) {
    let c = canonicalModel(provider, r.modelReturned, aliases, extraAliases);
    if (c.canonical === null) c = canonicalModel(provider, r.modelRequested, aliases, extraAliases);
    const money = r.confirmedMoney ? { metric: 'amount' as const, currency: 'USD', otk: amtStr(r.confirmedMoney), provider: null, diff: null, absDiff: null, relDiff: null, relDiffNote: 'no provider counterpart' } : null;
    if (c.canonical === null) {
      push('otk_record', `otk:${r.operationId}`, key(r.modelReturned ?? r.modelRequested, null, r.observedAt, r.observedAt), 'UNKNOWN', false, null, money,
        `OTK record model ${JSON.stringify(r.modelReturned ?? r.modelRequested)} not in alias table ${aliases.id}; not matched`, [], [r.operationId]);
      continue;
    }
    if (coverage.length > 0 && !covered(r.observedAt, tol)) {
      excluded.push({ side: 'otk', id: r.operationId, reason: `observedAt ${r.observedAt} outside the periods the statement covers (not evidence of a missing provider charge)` });
      continue;
    }
    for (const n of r.notes) if (/absent|unparseable/.test(n)) warnings.push(`${r.operationId}: ${n}`);
    recs.push({ ...r, canon: c.canonical, canonRule: c.rule });
  }

  // 3. aggregation level and groups
  const perRequest = matchable.length > 0 && matchable.every((l) => l.requestId !== null);
  const groups: Group[] = [];
  if (perRequest) {
    const byReq = new Map<string, StatementLine[]>();
    for (const l of matchable) byReq.set(`${l.canonicalModel}|${l.requestId}`, [...(byReq.get(`${l.canonicalModel}|${l.requestId}`) ?? []), l]);
    for (const [k, ls] of [...byReq.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
      const [model, rid] = [ls[0]!.canonicalModel!, ls[0]!.requestId!];
      groups.push({ id: `req:${k}`, model, requestId: rid, orphan: false, start: ls.map((l) => l.periodStart).sort()[0]!, end: ls.map((l) => l.periodEnd).sort().reverse()[0]!, lines: ls, records: [] });
    }
    for (const r of recs) {
      const g = groups.find((x) => x.model === r.canon && x.requestId !== null && x.requestId === r.providerRequestId);
      if (g) g.records.push(r);
      else groups.push({ id: `req-orphan:${r.canon}|${r.operationId}`, model: r.canon, requestId: r.providerRequestId, orphan: true, start: r.observedAt, end: r.observedAt, lines: [], records: [r] });
    }
  } else {
    const models = [...new Set(matchable.map((l) => l.canonicalModel!))].sort();
    for (const m of models) {
      const ls = matchable.filter((l) => l.canonicalModel === m).sort((a, b) => cmpStr(a.periodStart, b.periodStart) || cmpStr(a.lineId, b.lineId));
      const ivs: Group[] = [];
      for (const l of ls) {
        const last = ivs[ivs.length - 1];
        if (last && ms(l.periodStart) < ms(last.end)) { last.lines.push(l); if (ms(l.periodEnd) > ms(last.end)) last.end = l.periodEnd; } else ivs.push({ id: '', model: m, start: l.periodStart, end: l.periodEnd, orphan: false, requestId: null, lines: [l], records: [] });
      }
      for (const g of ivs) { g.id = `agg:${m}:${g.start}`; groups.push(g); }
    }
    for (const r of recs) {
      const g = groups.find((x) => !x.orphan && x.model === r.canon && ms(x.start) <= ms(r.observedAt) && ms(r.observedAt) < ms(x.end));
      if (g) { g.records.push(r); continue; }
      const d = dayInZone(r.observedAt, window.timezone);
      const id = `orphan:${r.canon}:${d.day}`;
      let og = groups.find((x) => x.id === id);
      if (!og) { og = { id, model: r.canon, start: d.start, end: d.end, orphan: true, requestId: null, lines: [], records: [] }; groups.push(og); }
      og.records.push(r);
    }
  }
  groups.sort((a, b) => cmpStr(a.model, b.model) || cmpStr(a.start, b.start) || cmpStr(a.id, b.id));

  const viaAlias = (g: Group): boolean => {
    if (g.lines.length === 0 || g.records.length === 0) return false;
    const provNames = new Set(g.lines.map((l) => (l.model ?? '').trim().toLowerCase()));
    const otkNames = new Set(g.records.flatMap((r) => [r.modelRequested, r.modelReturned]).filter((x): x is string => !!x).map((x) => x.trim().toLowerCase()));
    return ![...provNames].some((n) => otkNames.has(n));
  };

  // 4. per-category evaluation and cross passes
  const classes = new Map<string, { cls: Classification; explanation: string }>();
  const ckey = (g: Group, c: UsageCategory) => `${g.id}|${c}`;
  const pending = new Set<string>();
  for (const g of groups) {
    for (const c of groupCategories(g)) {
      const e = evalCategory(g, c, tables);
      if (agrees(e)) {
        let cls: Classification = 'MATCH';
        let ex = 'agree';
        if (!e.prov.present) ex = 'OTK reports zero; provider has no line for this category (nothing to reconcile)';
        else if (!e.otk.present) ex = 'provider reports zero; OTK has no such category (nothing to reconcile)';
        else if (e.amt === 'round') { cls = 'ROUNDING'; ex = `amount differs within the rounding tolerance (${ROUNDING_POLICY_ID}: half unit of each provider line's last decimal)`; }
        else if (viaAlias(g)) { cls = 'MODEL_ALIAS'; ex = `joined only through the alias table: provider ${[...new Set(g.lines.map((l) => l.model))].join(', ')} = OTK ${[...new Set(g.records.map((r) => r.modelReturned ?? r.modelRequested))].join(', ')} (${[...new Set(g.lines.map((l) => l.modelRule).concat(g.records.map((r) => (r as { canonRule?: string | null }).canonRule ?? null)).filter(Boolean))].join('; ') || 'canonical'}); values agree`; }
        else ex = e.qtyEq === null && e.amt !== null ? 'amount agrees exactly (no token count on one side)' : e.amt === null ? 'tokens agree exactly (no amount on one side)' : 'tokens and amount agree exactly';
        if (cls === 'ROUNDING' && viaAlias(g)) ex += '; joined through the alias table';
        classes.set(ckey(g, c), { cls, explanation: ex });
      } else pending.add(ckey(g, c));
    }
  }

  // 4a. timing window
  const resolvedTiming = new Set<string>();
  if (!perRequest) {
    for (const g of groups) {
      const mine = groupCategories(g).filter((c) => pending.has(ckey(g, c)));
      if (mine.length === 0 || resolvedTiming.has(g.id)) continue;
      const sameModel = groups.filter((x) => x.model === g.model && x !== g);
      const near = (t: string, b: string) => Math.abs(ms(t) - ms(b)) <= tol;
      // scenario A: pull records observed just outside g's boundaries into g
      const inbound = sameModel.flatMap((x) => x.records.filter((r) => (ms(r.observedAt) < ms(g.start) && near(r.observedAt, g.start)) || (ms(r.observedAt) >= ms(g.end) && near(r.observedAt, g.end))).map((r) => ({ r, from: x })));
      // scenario B: push records observed just inside g's boundaries out of g
      const outbound = g.records.filter((r) => (g.lines.length > 0 || g.orphan) && (near(r.observedAt, g.start) || near(r.observedAt, g.end)));
      const tryScenario = (moves: Array<{ r: OtkRecord; from: Group; to: Group | null }>): Group[] | null => {
        if (moves.length === 0) return null;
        const clones = new Map<Group, Group>();
        const cl = (x: Group) => { let c = clones.get(x); if (!c) { c = { ...x, records: [...x.records] }; clones.set(x, c); } return c; };
        for (const m of moves) {
          const f = cl(m.from); f.records = f.records.filter((r) => r !== m.r);
          if (m.to) cl(m.to).records.push(m.r);
        }
        const affected = [...clones.values()];
        return affected.every((x) => (x.lines.length === 0 && x.records.length === 0) || groupAgrees(x, tables)) ? [...clones.keys()] : null;
      };
      let affected: Group[] | null = null;
      let story = '';
      if (inbound.length > 0) {
        affected = tryScenario(inbound.map((x) => ({ r: x.r, from: x.from, to: g })));
        if (affected) story = inbound.map((x) => `${x.r.operationId} observed ${x.r.observedAt} (${Math.abs(ms(x.r.observedAt) - ms(ms(x.r.observedAt) < ms(g.start) ? g.start : g.end))} ms from the boundary) counted by the provider in [${g.start}, ${g.end})`).join('; ');
      }
      if (!affected && outbound.length > 0) {
        const moves = outbound.map((r) => {
          const toStart = near(r.observedAt, g.start);
          const b = toStart ? g.start : g.end;
          const to = sameModel.find((x) => !x.orphan && (toStart ? x.end === b : x.start === b)) ?? null;
          return { r, from: g, to };
        }).filter((mv) => {
          if (mv.to !== null) return true;
          // "counted outside the statement" is only plausible at the EDGE of the statement coverage (never into a
          // covered period that shows nothing), and draining an OTK-only bucket to nowhere explains nothing
          if (g.orphan) return false;
          const atStart = near(mv.r.observedAt, g.start);
          return atStart ? !covered(new Date(ms(g.start) - 1).toISOString(), 0) : !covered(g.end, 0);
        });
        affected = tryScenario(moves);
        if (affected) story = moves.map((m) => `${m.r.operationId} observed ${m.r.observedAt} counted by the provider ${m.to ? `in the adjacent period [${m.to.start}, ${m.to.end})` : 'outside the statement periods'}`).join('; ');
      }
      if (affected) {
        for (const x of affected) {
          resolvedTiming.add(x.id);
          for (const c of groupCategories(x)) {
            if (!pending.has(ckey(x, c))) continue;
            pending.delete(ckey(x, c));
            classes.set(ckey(x, c), { cls: 'TIMING_WINDOW', explanation: `difference disappears if ${story} (tolerance ${tol} ms); provider and OTK timestamp the same usage on different sides of a period boundary` });
          }
        }
      }
    }
  }

  // 4b. cache category, 4c. price version, 4d. remainder
  for (const g of groups) {
    const cats = groupCategories(g);
    const evals = new Map(cats.map((c) => [c, evalCategory(g, c, tables)] as const));
    const famPending = INPUT_FAMILY.filter((c) => pending.has(ckey(g, c)));
    if (famPending.length > 0) {
      const sumSide = (side: 'prov' | 'otk'): bigint | null => {
        let s = 0n;
        for (const c of INPUT_FAMILY) {
          const e = evals.get(c);
          if (!e || !e[side].present) continue;
          if (e[side].qty === null) return null;
          s += e[side].qty!;
        }
        return s;
      };
      const ps = sumSide('prov'); const os = sumSide('otk');
      if (ps !== null && os !== null && ps === os && famPending.some((c) => evals.get(c)?.qtyEq === false || !evals.get(c)?.prov.present || !evals.get(c)?.otk.present)) {
        const detail = INPUT_FAMILY.map((c) => { const e = evals.get(c); return `${c} OTK ${e?.otk.qty ?? 0} / provider ${e?.prov.qty ?? 0}`; }).join(', ');
        for (const c of famPending) {
          pending.delete(ckey(g, c));
          classes.set(ckey(g, c), { cls: 'CACHE_CATEGORY', explanation: `input + cache_read + cache_write agree (${os} tokens) but the split differs (${detail}); amounts differ because cache tokens have their own price` });
        }
      }
    }
    for (const c of cats) {
      const k = ckey(g, c);
      if (!pending.has(k)) continue;
      const e = evals.get(c)!;
      if (!e.prov.present) { pending.delete(k); classes.set(k, { cls: 'MISSING_PROVIDER', explanation: g.orphan ? `no provider period/line for ${g.model} covers these OTK records` : `provider period exists but has no ${c} line for ${g.model}` }); continue; }
      if (!e.otk.present) { pending.delete(k); classes.set(k, { cls: 'MISSING_OTK', explanation: `provider bills ${c} for ${g.model} in this period; OTK has no record reporting it` }); continue; }
      if (e.qtyEq !== false && e.amt === 'diff' && e.prov.amount !== null) {
        const versions = [...new Set(g.records.filter((r) => r.quantities.some((q) => q.category === c && q.count > 0n)).map((r) => r.priceTableVersion ?? '(unknown)'))].sort();
        let ex: string | null = null;
        if (versions.length > 1) ex = `OTK records in this aggregate were priced with ${versions.length} price-table versions (${versions.join(', ')})`;
        else {
          for (const t of [...tables].sort((a, b) => cmpStr(a.version, b.version))) {
            if (versions.includes(t.version)) continue;
            let sum: ScaledAmount | null = { units: 0n, scale: PICO };
            const used = new Set<string>();
            for (const r of g.records) {
              const q = r.quantities.find((x) => x.category === c);
              if (!q) continue;
              const p = priceOf([t], t.version, r.provider, g.model, c, q.count, r.observedAt, true);
              if (!p) { sum = null; break; }
              used.add(p.price.toString());
              sum = { units: sum.units + p.amount.units, scale: PICO };
            }
            if (sum === null) continue;
            const a = amountCmp(sum, e.prov.amount, 'USD', e.prov.tol2);
            if (a.state === 'eq' || a.state === 'round') {
              const qtot = e.otk.qty ?? 0n;
              ex = `same tokens; provider amount is consistent with price table ${t.version} (${[...used].join('/')} micro-USD/MTok), OTK priced with ${versions.join(', ')}${qtot > 0n ? `; provider implied price ≈ ${toDecimalString({ units: (rescale(e.prov.amount, maxScale(e.prov.amount.scale, PICO)).units * 1_000_000n) / qtot, scale: maxScale(e.prov.amount.scale, PICO) })} USD/MTok` : ''}`;
              break;
            }
          }
        }
        if (ex) { pending.delete(k); classes.set(k, { cls: 'PRICE_VERSION', explanation: ex }); continue; }
      }
      pending.delete(k);
      const parts: string[] = [];
      if (e.qtyEq === false) parts.push(`tokens differ by ${e.qtyCmp?.diff}`);
      if (e.amt === 'diff') parts.push(`amount differs by ${e.amtCmp?.diff} beyond the rounding tolerance`);
      if (e.qtyEq === null && e.amt === null) parts.push('no comparable dimension (provider gives only amount and OTK amount per category is unavailable, or the reverse)');
      classes.set(k, { cls: e.qtyEq === null && e.amt === null ? 'UNKNOWN' : 'UNMATCHED', explanation: `${parts.join('; ')}; no timing, cache-split or price-version explanation found` });
    }
  }

  // 5. emit category/request rows, model-period rows and matches
  const matches: ReconciliationMatch[] = [];
  for (const g of groups) {
    const cats = groupCategories(g);
    const lvl: ResultLevel = perRequest ? 'request' : 'category';
    const childClasses: Classification[] = [];
    for (const c of cats) {
      const e = evalCategory(g, c, tables);
      const cl = classes.get(ckey(g, c))!;
      childClasses.push(cl.cls);
      const notes = [...e.prov.notes, ...e.otk.notes];
      push(lvl, `${perRequest ? 'req' : 'cat'}:${g.model}:${g.start}:${g.requestId ?? ''}:${c}`, key(g.model, c, g.start, g.end, g.requestId), cl.cls,
        ['MATCH', 'ROUNDING', 'MODEL_ALIAS'].includes(cl.cls), e.qtyCmp, e.amtCmp,
        [cl.explanation, ...notes].join(' | '), g.lines.filter((l) => l.usageCategory === c).map((l) => l.lineId), g.records.filter((r) => r.quantities.some((q) => q.category === c)).map((r) => r.operationId));
    }
    // model × period: OTK confirmed money vs provider amount of every matchable line of the group
    const recMoney = g.records.map((r) => r.confirmedMoney);
    const otkTotal = recMoney.length > 0 && recMoney.every((x) => x !== null) ? sumAmounts(recMoney as ScaledAmount[]) : null;
    const usdLines = g.lines.filter((l) => l.amount !== null && l.currency === 'USD');
    const nonUsd = g.lines.some((l) => l.amount !== null && l.currency !== 'USD');
    const provTotal = nonUsd ? null : sumAmounts(usdLines.map((l) => l.amount!));
    const halfUnits = g.records.reduce((a, r) => a + r.moneyRoundingHalfUnits, 0n);
    const a = amountCmp(otkTotal, provTotal, nonUsd ? null : 'USD', (s) => lineTol(usdLines)(s) + halfUnits * pow10(Math.max(0, s - 12)));
    const bad = childClasses.filter((c) => !['MATCH', 'ROUNDING', 'MODEL_ALIAS'].includes(c));
    let cls: Classification; let ex: string;
    if (bad.length === 0) {
      if (a.state === 'diff') { cls = 'UNMATCHED'; ex = 'every category agrees but the OTK confirmed money differs from the provider total: check OTK confirmed money against its per-category price (and non-category provider lines)'; }
      else { cls = a.state === 'round' || childClasses.includes('ROUNDING') ? 'ROUNDING' : childClasses.includes('MODEL_ALIAS') ? 'MODEL_ALIAS' : 'MATCH'; ex = `all ${childClasses.length} categories agree`; }
    } else {
      const u = [...new Set(bad)].sort();
      cls = u.length === 1 ? u[0]! : 'UNMATCHED';
      ex = u.length === 1 ? `category rows: ${u[0]}` : `mixed causes in the category rows: ${u.join(', ')}`;
    }
    if (otkTotal === null && g.records.length > 0) ex += '; some OTK records have no confirmed money';
    if (provTotal === null && g.lines.length > 0) ex += nonUsd ? '; provider amounts are not in USD (not compared)' : '; provider gives no amount (usage-only statement)';
    if (!perRequest) ex += `; aggregate of ${g.records.length} OTK operation(s) vs ${g.lines.length} provider line(s) over [${g.start}, ${g.end})${g.orphan ? ' (no provider period: OTK day bucket)' : ''}`;
    push('model_period', `mp:${g.model}:${g.start}:${g.requestId ?? ''}`, key(g.model, null, g.start, g.end, g.requestId), cls, bad.length === 0 && a.state !== 'diff', null, a.cmp, ex, g.lines.map((l) => l.lineId), g.records.map((r) => r.operationId));
    // OTK self-consistency: confirmed money vs per-category recomputation
    for (const r of g.records) {
      const parts = r.quantities.filter((q) => PRICE_CATEGORY[q.category]).map((q) => priceOf(tables, r.priceTableVersion, r.provider, g.model, q.category, q.count, r.observedAt));
      if (r.confirmedMoney && parts.length > 0 && parts.every((p) => p !== null)) {
        const s = sumAmounts(parts.map((p) => p!.amount))!;
        const d = subAmounts(r.confirmedMoney, s);
        if (2n * absBig(rescale(d, maxScale(d.scale, PICO)).units) > r.moneyRoundingHalfUnits * pow10(Math.max(0, scaleDigits(maxScale(d.scale, PICO)) - 12))) {
          warnings.push(`${r.operationId}: confirmed money ${toDecimalString(r.confirmedMoney)} differs from its per-category recomputation ${toDecimalString(s)} with table ${r.priceTableVersion}`);
        }
      }
    }
    if (g.lines.length > 0 && g.records.length > 0) {
      matches.push({
        groupId: g.id, aggregationLevel: perRequest ? 'per_request' : 'aggregate',
        joinedOn: perRequest ? ['provider', 'request_id', viaAlias(g) ? 'model(alias)' : 'model', 'category'] : ['provider', viaAlias(g) ? 'model(alias)' : 'model', 'period(observedAt in provider period)', 'category'],
        providerLineIds: g.lines.map((l) => l.lineId).sort(), otkOperationIds: g.records.map((r) => r.operationId).sort(),
      });
    }
  }

  // 6. totals
  const usageLines = allLines.filter((l) => l.inScope && l.kind === 'usage' && !excluded.some((x) => x.side === 'provider' && x.id === l.lineId));
  const currencies = new Set(usageLines.filter((l) => l.amount !== null).map((l) => l.currency));
  const cur = currencies.size === 1 ? [...currencies][0]! : currencies.size === 0 ? null : 'MIXED';
  const provUsage = cur === null || cur === 'MIXED' ? null : sumAmounts(usageLines.filter((l) => l.amount !== null).map((l) => l.amount!));
  const incl = recs;
  const otkMoney = incl.length > 0 && incl.every((r) => r.confirmedMoney !== null) ? sumAmounts(incl.map((r) => r.confirmedMoney!)) : incl.length === 0 ? { units: 0n, scale: PICO } : null;
  const sumKind = (k: string) => {
    const xs = adjustments.filter((x) => x.kind === k);
    if (xs.length === 0) return null;
    const ls = allLines.filter((l) => xs.some((x) => x.lineId === l.lineId) && l.amount !== null);
    return ls.length === 0 ? null : amtStr(sumAmounts(ls.map((l) => l.amount!)));
  };
  const totalTol = (s: number) => lineTol(usageLines.filter((l) => l.amount !== null))(s) + incl.reduce((a2, r) => a2 + r.moneyRoundingHalfUnits, 0n) * pow10(Math.max(0, s - 12));
  const usageCmp = cur === 'USD' || cur === null ? amountCmp(otkMoney, provUsage, 'USD', totalTol) : null;
  const netParts = allLines.filter((l) => l.inScope && !excluded.some((x) => x.side === 'provider' && x.id === l.lineId) && l.amount !== null);
  const netCurrencies = new Set(netParts.map((l) => l.currency));
  const providerNet = netParts.length > 0 && netCurrencies.size === 1 ? amtStr(sumAmounts(netParts.map((l) => l.amount!))) : null;
  {
    const otherBad = results.filter((r) => !r.agrees).length;
    let cls: Classification; let ex: string;
    if (usageCmp && usageCmp.state !== null) {
      cls = usageCmp.state === 'eq' ? (otherBad === 0 ? 'MATCH' : 'UNMATCHED') : usageCmp.state === 'round' ? 'ROUNDING' : 'UNMATCHED';
      ex = `OTK confirmed money of ${incl.length} in-window operation(s) vs provider usage subtotal of ${usageLines.length} line(s) (taxes, credits and adjustments excluded; see adjustments)`;
      if (usageCmp.state === 'eq' && otherBad > 0) ex += `; totals agree but ${otherBad} row(s) disagree (compensating differences)`;
    } else {
      cls = results.every((r) => r.agrees) ? 'MATCH' : 'UNMATCHED';
      ex = cur !== 'USD' && cur !== null ? `provider currency ${cur}: totals not compared in money (no float FX conversion); classification from the rows` : 'no comparable money total (usage-only statement or OTK money missing); classification from the rows';
    }
    push('total', 'total', key(null, null, window.start, window.end), cls, cls === 'MATCH' || cls === 'ROUNDING', null, usageCmp ? usageCmp.cmp : null, ex, usageLines.map((l) => l.lineId), incl.map((r) => r.operationId));
  }

  // 7. ordering, counts, notes
  const LEVEL_ORDER: ResultLevel[] = ['total', 'model_period', 'category', 'request', 'statement_line', 'otk_record'];
  results.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || cmpStr(a.key.model ?? '', b.key.model ?? '') || cmpStr(a.key.periodStart ?? '', b.key.periodStart ?? '') || TOKEN_CATEGORIES.indexOf(a.key.category ?? 'other') - TOKEN_CATEGORIES.indexOf(b.key.category ?? 'other') || cmpStr(a.id, b.id));
  const counts = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, 0])) as Record<Classification, number>;
  for (const r of results) if (r.level !== 'total' && r.level !== 'model_period') counts[r.classification]++;
  const durations = [...new Set(matchable.map((l) => fmtDur(ms(l.periodEnd) - ms(l.periodStart))))].sort();
  const aggregationNote = matchable.length === 0
    ? 'no matchable provider line'
    : perRequest
      ? 'every provider line carries a request id: matched per request (provider request id = OTK provider_request_id)'
      : `provider lines carry no request id: per-operation matching is IMPOSSIBLE; reconciled aggregate-vs-aggregate per model × provider period (${durations.join(', ')}) × category; ${recs.length} OTK operation(s) fall into ${groups.filter((g) => !g.orphan).length} provider period(s) and ${groups.filter((g) => g.orphan).length} OTK-only day(s)`;
  for (const s of input.statements) {
    if (s.mappingProvenance.status !== 'VERIFIED_OFFICIAL_DOC') warnings.push(`mapping ${s.mappingId} is ${s.mappingProvenance.status}: ${s.mappingProvenance.unverified.join('; ')}`);
  }
  excluded.sort((a, b) => cmpStr(a.side, b.side) || cmpStr(a.id, b.id));
  return {
    schema: 'otk.reconciliation_report.v1',
    provider,
    providerDataOrigin: input.statements.some((s) => s.origin === 'FIXTURE') || input.statements.length === 0 ? 'FIXTURE' : 'REAL',
    window,
    statements: input.statements.map((s) => ({ mappingId: s.mappingId, provenance: s.mappingProvenance.status, sourceDigest: s.sourceDigest, origin: s.origin, syntheticMarker: s.syntheticMarker, lineCount: s.lines.length, period: s.period })),
    otkSource: { kind: [...new Set(input.otk.records.map((r) => r.source))].sort().join('+') || 'none', description: input.otk.description, digests: input.otk.digests, recordCount: recs.length },
    aggregationLevel: matchable.length === 0 ? 'none' : perRequest ? 'per_request' : 'aggregate',
    aggregationNote,
    roundingPolicy: ROUNDING_POLICY_ID,
    aliasTable: aliases.id,
    timingToleranceMs: tol,
    priceTables: tables.map((t) => t.version).sort(),
    results, matches, adjustments, outOfScope, excluded,
    totals: {
      usage: usageCmp ? usageCmp.cmp : null,
      providerTax: sumKind('tax'), providerCredits: sumKind('credit'), providerAdjustments: sumKind('adjustment'),
      providerNet: providerNet, currency: cur,
    },
    counts,
    warnings: [...new Set(warnings)].sort(),
  };
}
