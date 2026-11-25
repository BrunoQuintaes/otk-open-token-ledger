/**
 * Budget ledger (contract §8, R10 §7): independent sub-ledgers per provider (default US$ 5 / 3 / 3), campaign cap (11),
 * per-batch caps (R10 R2 §5.1: a batch cap is never above 25% of the provider sub-ledger; absent ⇒ exactly 25%); no cross-transfer.
 * 80% of a sub-ledger reached ⇒ `pauseThresholdReached` (runner pauses for human review). Reserve = costCap recorded BEFORE egress; settle with the calculated cost;
 * UNKNOWN cost keeps the reservation as possiblyCharged until reconciliation. All money is pico-USD BigInt; persisted as
 * append-only events in ledger.jsonl (replayed on open). Caps are configuration (never hard-coded in the runner).
 *
 * In short: the money guard of the H2 evaluation. Before each call the runner reserves the operation's worst-case
 * cost; the reservation is refused (a {@link BudgetStop}) when any cap would be exceeded. Caps above the defaults are
 * accepted only as one of the named, frozen profiles below. The only side effect is appending events, with fsync, to
 * the ledger file given to {@link openLedger}. Money is in pico-USD (1 USD = 10^12 pico-USD).
 *
 * @module scripts/h2eval/core/ledger
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { H2EVAL_SCHEMA, PICO_PER_USD, type LedgerState, type PicoUsd, type Provider, type StopReason } from '../types.js';
import { sha256Canon } from './canon.js';

/** Default caps in USD: campaign 11; sub-ledgers Anthropic 5, OpenAI 3, Google 3. */
export const DEFAULT_CAPS_USD = Object.freeze({ campaign: '11', providers: Object.freeze({ anthropic: '5', openai: '3', google: '3' }) });
/**
 * C158 ciclo 3: the ONLY non-default ceiling profile the executor accepts, named and frozen in code (never a free number): the author's ratified cumulative ceiling for the Anthropic programme
 * (US$ 32,00, already including what was spent), Anthropic only (OpenAI and Google at 0: nothing of this programme may be spent there). A plan declares it explicitly (--caps-profile ciclo3_c158),
 * the GO and the ledger must carry the SAME numbers (GO_CAPS_MISMATCH otherwise). Any other combination (e.g. 32 with an Anthropic sub-ledger of 5, or 100) is refused as before.
 */
export const CAPS_PROFILE_CICLO3 = Object.freeze({ campaign: '32', providers: Object.freeze({ anthropic: '32', openai: '0', google: '0' }) });
/** E3G (C160 BRACO-GO; DR-205 literal C160X item 2): paid calibration arm, US$ 1,00 per provider, SEPARATE accounting (one ledger per provider, the other providers at 0). */
export const CAPS_PROFILE_BRACO_GO_GOOGLE = Object.freeze({ campaign: '1', providers: Object.freeze({ anthropic: '0', openai: '0', google: '1' }) });
/** OpenAI counterpart of {@link CAPS_PROFILE_BRACO_GO_GOOGLE}: campaign 1 USD, OpenAI 1 USD, the others 0. */
export const CAPS_PROFILE_BRACO_GO_OPENAI = Object.freeze({ campaign: '1', providers: Object.freeze({ anthropic: '0', openai: '1', google: '0' }) });
/** EXEC-ECON C160 (delta v3.1 item 4): the ECON study (E1/E2 v3) single ledger with the DR-277 PLANNING ceilings (Anthropic 95, OpenAI 11, Google 28; aggregate 132).
 *  Named and frozen (never a free number). The final ceilings belong to the author's MVP5-9 text (literal C160CA): a different final value needs its own named profile and a new G15. */
export const CAPS_PROFILE_ECON_DR277 = Object.freeze({ campaign: '132', providers: Object.freeze({ anthropic: '95', openai: '11', google: '28' }) });
/** Named cap profiles accepted on the GO paths (the default caps and the ratified Anthropic-only profile). */
export const CAPS_PROFILES = Object.freeze({ default: DEFAULT_CAPS_USD, ciclo3_c158: CAPS_PROFILE_CICLO3 });
// EXEC-ECON: the ECON profile is accepted ONLY by openLedger (assertCapsWithinDefaults); it is deliberately NOT in CAPS_PROFILES, so no GO path (single or multi) admits it before its own GO/G15.
/** E3G: the arm profiles are matched ONLY for their own provider (a single-provider GO of another provider never matches them). */
export const ARM_CAPS_PROFILES = Object.freeze({ braco_go_google: Object.freeze({ provider: 'google' as Provider, profile: CAPS_PROFILE_BRACO_GO_GOOGLE }), braco_go_openai: Object.freeze({ provider: 'openai' as Provider, profile: CAPS_PROFILE_BRACO_GO_OPENAI }) });
/** Name of a profile in {@link CAPS_PROFILES}. */
export type CapsProfileName = keyof typeof CAPS_PROFILES;
const profileEq = (pr: { campaign: string; providers: Readonly<Record<Provider, string>> }, campaign: bigint, providers: Readonly<Record<Provider, bigint>>): boolean =>
  usdToPico(pr.campaign) === campaign && (['anthropic', 'openai', 'google'] as const).every((p) => usdToPico(pr.providers[p]) === providers[p]);
/**
 * the effective caps (campaign + the three sub-ledgers) must equal ONE named profile, as a whole
 *
 * @param campaign - Campaign cap in pico-USD.
 * @param providers - Sub-ledger caps in pico-USD.
 * @returns `true` when they equal a profile of {@link CAPS_PROFILES} or {@link ARM_CAPS_PROFILES}.
 */
export function capsAreAllowedProfile(campaign: bigint, providers: Readonly<Record<Provider, bigint>>): boolean { return Object.values(CAPS_PROFILES).some((pr) => profileEq(pr, campaign, providers)) || Object.values(ARM_CAPS_PROFILES).some((a) => profileEq(a.profile, campaign, providers)); }
/**
 * single-provider GO path: campaign + that provider's sub-ledger must equal the same named profile's values
 *
 * @param campaign - Campaign cap in pico-USD.
 * @param provider - The GO's provider.
 * @param providerCap - That provider's sub-ledger cap in pico-USD.
 * @returns `true` when a named profile (an arm profile only for its own provider) has these values.
 */
export function capsAreAllowedFor(campaign: bigint, provider: Provider, providerCap: bigint): boolean { return Object.values(CAPS_PROFILES).some((pr) => usdToPico(pr.campaign) === campaign && usdToPico(pr.providers[provider]) === providerCap) || Object.values(ARM_CAPS_PROFILES).some((a) => a.provider === provider && usdToPico(a.profile.campaign) === campaign && usdToPico(a.profile.providers[provider]) === providerCap); }

/**
 * Converts a USD amount to pico-USD exactly.
 *
 * @param usd - Non-negative decimal with up to 12 decimals, as text or number (a number is converted with
 *   `toString`, so exponent notation is refused).
 * @returns The amount in pico-USD.
 * @throws {TypeError} When the literal is not a non-negative decimal with at most 12 decimals.
 * @example
 * usdToPico('0.30'); // 300000000000n
 */
export function usdToPico(usd: string | number): bigint {
  const s = typeof usd === 'number' ? usd.toString() : usd;
  const m = /^(\d+)(?:\.(\d{1,12}))?$/.exec(s.trim());
  if (!m) throw new TypeError(`usdToPico: invalid USD literal ${JSON.stringify(usd)}`);
  return BigInt(m[1]!) * PICO_PER_USD + BigInt((m[2] ?? '').padEnd(12, '0'));
}
/**
 * Formats a non-negative pico-USD amount as USD text with 12 decimals.
 *
 * @param p - Amount in pico-USD.
 * @returns For example `0.300000000000`.
 */
export const picoToUsdString = (p: bigint): string => `${p / PICO_PER_USD}.${(p % PICO_PER_USD).toString().padStart(12, '0')}`;
const P = (s: PicoUsd): bigint => { if (!/^\d+$/.test(s)) throw new TypeError('pico-USD must be a decimal integer string'); return BigInt(s); };

/**
 * One line of `ledger.jsonl`: the event kind, operation, provider and batch, the amount in pico-USD (integer text),
 * the time (ISO-8601 UTC) and an optional note (opening digest, or the signed cap-raise details).
 */
export interface LedgerEvent { kind: 'reserve' | 'settle' | 'release' | 'uncertain' | 'stop' | 'inherit' | 'cap_raise'; operationId: string; provider: Provider; batchId: string; usd: PicoUsd; tsUtc: string; note?: string }

/**
 * VNEXT-5 (C151 item 5): OPENING BALANCE inherited from a previous study. A NEW study ledger starts with signed `inherit` lines (one per
 * provider with a non-zero amount) so that what the previous study already settled or left uncertain is COMMITTED against the same
 * 5/3/3/11 caps. The opening file (`<campaignDir>/LEDGER_OPENING.json`, h2eval.ledger_opening.v1) names the source ledger (sha256),
 * the per-provider amounts, a human signature and a canonical digest. It is applied exactly once, only when the ledger file does not
 * exist yet; a ledger that already started without it refuses the opening (LEDGER_OPENING_AFTER_START) and a ledger whose inherit
 * lines differ from the file refuses to open (LEDGER_OPENING_MISMATCH). Inherited money is never released, settled or reconciled with
 * journals of THIS study: reconciliation compares journal-derived spent/uncertain/reserved and ignores `inherit`.
 */
export const LEDGER_OPENING_SCHEMA = 'h2eval.ledger_opening.v1';
/**
 * Content of `LEDGER_OPENING.json`: the source study (label, ledger SHA-256, close time), settled and uncertain USD
 * per provider, the human signature (`human:<name>`), an optional note and the SHA-256 of the canonical JSON of all
 * other fields.
 */
export interface LedgerOpening { schema: typeof LEDGER_OPENING_SCHEMA; fromStudy: { label: string; ledgerSha256: string; closedUtc: string }; providers: Partial<Record<Provider, { settledUsd: string; uncertainUsd: string }>>; signedBy: string; note?: string; digestSha256: string }
/** Error raised when an opening balance is invalid or does not match the ledger; `code` says which rule failed. */
export class LedgerOpeningError extends Error { constructor(public readonly code: 'LEDGER_OPENING_SCHEMA' | 'LEDGER_OPENING_UNSIGNED' | 'LEDGER_OPENING_DIGEST' | 'LEDGER_OPENING_INVALID' | 'LEDGER_OPENING_AFTER_START' | 'LEDGER_OPENING_MISMATCH' | 'LEDGER_OPENING_FILE_MISSING', detail = '') { super(`ledger opening: ${code}${detail ? ` (${detail})` : ''}`); this.name = 'LedgerOpeningError'; } }
/**
 * Validates an opening balance: schema, signature, source study, provider amounts and digest.
 *
 * @param o - Parsed JSON of the opening file.
 * @returns The same object, typed.
 * @throws {@link LedgerOpeningError} With `LEDGER_OPENING_SCHEMA`, `LEDGER_OPENING_UNSIGNED`, `LEDGER_OPENING_INVALID`
 *   or `LEDGER_OPENING_DIGEST`.
 */
export function validateLedgerOpening(o: unknown): LedgerOpening {
  const d = o as LedgerOpening;
  if (!d || typeof d !== 'object' || d.schema !== LEDGER_OPENING_SCHEMA) throw new LedgerOpeningError('LEDGER_OPENING_SCHEMA');
  if (typeof d.signedBy !== 'string' || !/^human:\S/.test(d.signedBy)) throw new LedgerOpeningError('LEDGER_OPENING_UNSIGNED');
  if (!d.fromStudy || typeof d.fromStudy.label !== 'string' || !/^[0-9a-f]{64}$/.test(d.fromStudy.ledgerSha256 ?? '') || typeof d.fromStudy.closedUtc !== 'string') throw new LedgerOpeningError('LEDGER_OPENING_INVALID', 'fromStudy');
  if (!d.providers || typeof d.providers !== 'object') throw new LedgerOpeningError('LEDGER_OPENING_INVALID', 'providers');
  for (const [p, v] of Object.entries(d.providers)) { if (!(p in DEFAULT_CAPS_USD.providers) || !v) throw new LedgerOpeningError('LEDGER_OPENING_INVALID', `provider ${p}`); try { usdToPico(v.settledUsd); usdToPico(v.uncertainUsd); } catch { throw new LedgerOpeningError('LEDGER_OPENING_INVALID', `${p} amounts`); } }
  const { digestSha256, ...rest } = d; if (typeof digestSha256 !== 'string' || sha256Canon(rest) !== digestSha256) throw new LedgerOpeningError('LEDGER_OPENING_DIGEST');
  return d;
}
/**
 * pico-USD inherited per provider = settled + uncertain of the previous study (both count as committed).
 *
 * @param o - A validated opening.
 * @returns Inherited pico-USD per provider (0 for a provider not listed).
 * @throws {TypeError} When an amount is not a valid USD literal.
 */
export const inheritedPicoOf = (o: LedgerOpening): Record<Provider, bigint> => Object.fromEntries((['anthropic', 'openai', 'google'] as const).map((p) => [p, o.providers[p] ? usdToPico(o.providers[p]!.settledUsd) + usdToPico(o.providers[p]!.uncertainUsd) : 0n])) as Record<Provider, bigint>;

/** Ledger caps in USD (decimal text): campaign, one sub-ledger per provider, and optional per-batch caps. */
export interface LedgerConfig { campaignUsd: string; providersUsd: Record<Provider, string>; batchesUsd?: Record<string, string> }

/** R15-A1: an effective cap above the campaign defaults (11 / 5 / 3 / 3) is refused at open time; smaller caps are allowed. */
export class CapsAboveDefault extends Error { constructor(public readonly detail: string) { super(`ledger caps above defaults: ${detail}`); this.name = 'CapsAboveDefault'; } }
/**
 * EXEC-ECON delta 7b (X1 ECON v3.5 R2): o ENVELOPE do estudo ECON. Os tetos do autor vêm do GO assinado e podem ser MENORES que os de
 * planejamento da DR-277 (limites do protocolo): cada sub-teto 0 < v <= 95 / 11 / 28 e o agregado 0 < v <= 132, exatamente os 3 provedores.
 * Só vale no caminho do estudo (openLedger com { econEnvelope: true }, que o runner passa só com cfg.econ); fora dele nada muda.
 *
 * In English: tells whether the caps fit inside the economic study's planning envelope (each cap above 0 and at most
 * the planning ceiling).
 *
 * @param campaign - Campaign cap in pico-USD.
 * @param providers - Sub-ledger caps in pico-USD.
 * @returns `true` when every cap is inside the envelope.
 */
export function capsWithinEconEnvelope(campaign: bigint, providers: Readonly<Record<Provider, bigint>>): boolean {
  const pr = CAPS_PROFILE_ECON_DR277;
  if (!(campaign > 0n && campaign <= usdToPico(pr.campaign))) return false;
  return (['anthropic', 'openai', 'google'] as const).every((p) => providers[p] > 0n && providers[p] <= usdToPico(pr.providers[p]));
}
/**
 * Refuses caps above the defaults unless they are, as a whole, one of the accepted named profiles (or, with
 * `econEnvelope`, inside the economic study's envelope).
 *
 * @param cfg - Ledger caps.
 * @param opts - `econEnvelope: true` only on the economic study path.
 * @throws {@link CapsAboveDefault} When a cap is above its default (or outside the envelope) and no profile matches,
 *   or a provider has no default sub-ledger.
 * @throws {TypeError} When a cap is not a valid USD literal.
 */
export function assertCapsWithinDefaults(cfg: LedgerConfig, opts: { econEnvelope?: boolean } = {}): void {
  if (opts.econEnvelope === true && JSON.stringify(Object.keys(cfg.providersUsd).sort()) === JSON.stringify(['anthropic', 'google', 'openai'])) {
    let ok = false; try { ok = capsWithinEconEnvelope(usdToPico(cfg.campaignUsd), { anthropic: usdToPico(cfg.providersUsd.anthropic), openai: usdToPico(cfg.providersUsd.openai), google: usdToPico(cfg.providersUsd.google) }); } catch { ok = false; }
    if (ok) return;
    throw new CapsAboveDefault(`ECON caps outside the DR-277 envelope (${cfg.campaignUsd}; ${JSON.stringify(cfg.providersUsd)})`);
  }
  // C158 ciclo 3 (found by the synthetic rehearsal: openLedger still pinned 11/5/3/3 after the GO validators were changed): the named ratified profile, EXACTLY and as a whole, is the only way above the defaults
  // BOT-01 E2-2: the profile branch requires EXACTLY the three known providers (an extra provider key, even with a huge cap, is never covered by the profile)
  if (JSON.stringify(Object.keys(cfg.providersUsd).sort()) === JSON.stringify(['anthropic', 'google', 'openai'])) try { const pv = { anthropic: usdToPico(cfg.providersUsd.anthropic), openai: usdToPico(cfg.providersUsd.openai), google: usdToPico(cfg.providersUsd.google) }; if (profileEq(CAPS_PROFILE_CICLO3, usdToPico(cfg.campaignUsd), pv) || profileEq(CAPS_PROFILE_ECON_DR277, usdToPico(cfg.campaignUsd), pv)) return; } catch { /* missing or invalid provider cap: falls through to the default rule */ }
  if (usdToPico(cfg.campaignUsd) > usdToPico(DEFAULT_CAPS_USD.campaign)) throw new CapsAboveDefault(`campaign ${cfg.campaignUsd} > ${DEFAULT_CAPS_USD.campaign}`);
  for (const [p, u] of Object.entries(cfg.providersUsd)) {
    const d = (DEFAULT_CAPS_USD.providers as Record<string, string>)[p];
    if (d === undefined) throw new CapsAboveDefault(`provider ${p} has no default sub-ledger`);
    if (usdToPico(u) > usdToPico(d)) throw new CapsAboveDefault(`${p} ${u} > ${d}`);
  }
}

/** Refusal of a ledger operation: `reason` is the stop reason the runner records, `detail` the non-secret amounts and ids. */
export class BudgetStop extends Error {
  constructor(public readonly reason: StopReason, public readonly detail: Record<string, string>) { super(`budget stop: ${reason}`); this.name = 'BudgetStop'; }
}

/** An open ledger. All amounts are pico-USD. `state` returns caps, spent, reserved, possibly charged and inherited per provider and per batch. */
export interface Ledger {
  state(): LedgerState;
  /** Reserve the cap for an operation BEFORE egress. Throws BudgetStop (no event written) if any sub-ledger would be exceeded. */
  reserve(operationId: string, provider: Provider, batchId: string, capPico: bigint): void;
  /** Settle a reservation with the calculated cost (<= reserved: the excess is released). */
  settle(operationId: string, provider: Provider, batchId: string, costPico: bigint): void;
  /** Keep the whole reservation as possibly charged (UNCERTAIN/TIMEOUT); never released automatically. */
  markUncertain(operationId: string, provider: Provider, batchId: string): void;
  /** Release a reservation that never reached the provider (ABORTED_BEFORE_SEND after reserve). */
  release(operationId: string, provider: Provider, batchId: string): void;
  /** Open reservation of an operation in pico-USD, or `null` when none is open. */
  reservedOf(operationId: string): bigint | null;
  /**
   * C157 9.2 (pilots): the ONE financial duplication of a batch cap (e.g. US$ 0.30 -> 0.60), recorded in the ledger as a signed `cap_raise` event.
   * Exactly 2x the current batch cap, once per batch, never above 25 % of the provider sub-ledger, only with a human signature. Replayed on reopen.
   * It cannot raise the provider sub-ledger, the campaign cap or the number of calls (those stay as configured).
   */
  raiseBatchCap(batchId: string, provider: Provider, toPico: bigint, signedBy: string, reason: string): { fromPico: string; toPico: string };
  /** committed (spent + possibly charged + reserved) / cap, as a rational test against a fraction given in percent. */
  pauseThresholdReached(provider: Provider, percent?: number): boolean;
}

/**
 * Opens a ledger, replaying the existing events of the file and applying the opening balance on a new file.
 *
 * The returned methods throw {@link BudgetStop} on a refused reservation, a settlement above its reservation
 * (`STOP_CAP_VIOLATION`) or an invalid cap raise, and `Error` when settling, marking or releasing an operation that
 * has no open reservation.
 *
 * @param path - Ledger file (created on the first event).
 * @param cfg - Caps in USD.
 * @param clock - Clock returning ISO-8601 UTC.
 * @param opening - Opening balance inherited from a previous study, when the GO pins one.
 * @param opts - `econEnvelope: true` only on the economic study path.
 * @returns The ledger.
 * @throws {@link CapsAboveDefault} When the caps are not allowed.
 * @throws {@link LedgerOpeningError} When the opening does not match the file, arrives after the ledger started, or
 *   is missing for a ledger that carries inherited lines.
 * @throws {Error} When the existing file has an unparsable line or an event without its reservation.
 */
export function openLedger(path: string, cfg: LedgerConfig, clock: () => string = () => new Date().toISOString(), opening?: LedgerOpening, opts: { econEnvelope?: boolean } = {}): Ledger {
  assertCapsWithinDefaults(cfg, opts);
  const inherited: Record<string, bigint> = {};
  const caps = { campaign: usdToPico(cfg.campaignUsd), providers: Object.fromEntries(Object.entries(cfg.providersUsd).map(([p, u]) => [p, usdToPico(u)])) as Record<Provider, bigint>, batches: Object.fromEntries(Object.entries(cfg.batchesUsd ?? {}).map(([b, u]) => [b, usdToPico(u)])) };
  const spent: Record<string, bigint> = {}; const reserved: Record<string, bigint> = {}; const uncertain: Record<string, bigint> = {}; const ops: Record<string, number> = {};
  const bSpent: Record<string, bigint> = {}; const bReserved: Record<string, bigint> = {}; const raised = new Set<string>();
  const open: Map<string, { provider: Provider; batchId: string; usd: bigint }> = new Map();
  const add = (m: Record<string, bigint>, k: string, v: bigint) => { m[k] = (m[k] ?? 0n) + v; };
  const apply = (e: LedgerEvent) => {
    const usd = P(e.usd);
    if (e.kind === 'reserve') { add(reserved, e.provider, usd); add(bReserved, e.batchId, usd); open.set(e.operationId, { provider: e.provider, batchId: e.batchId, usd }); }
    else if (e.kind === 'settle') { const r = open.get(e.operationId); if (!r) throw new Error('ledger: settle without reservation'); add(reserved, e.provider, -r.usd); add(bReserved, e.batchId, -r.usd); add(spent, e.provider, usd); add(bSpent, e.batchId, usd); ops[e.provider] = (ops[e.provider] ?? 0) + 1; open.delete(e.operationId); }
    else if (e.kind === 'uncertain') { const r = open.get(e.operationId); if (!r) throw new Error('ledger: uncertain without reservation'); add(reserved, e.provider, -r.usd); add(bReserved, e.batchId, -r.usd); add(uncertain, e.provider, r.usd); add(bSpent, e.batchId, r.usd); ops[e.provider] = (ops[e.provider] ?? 0) + 1; open.delete(e.operationId); }
    else if (e.kind === 'release') { const r = open.get(e.operationId); if (!r) throw new Error('ledger: release without reservation'); add(reserved, e.provider, -r.usd); add(bReserved, e.batchId, -r.usd); open.delete(e.operationId); }
    else if (e.kind === 'inherit') { add(inherited, e.provider, usd); }
    else if (e.kind === 'cap_raise') { caps.batches[e.batchId] = usd; raised.add(e.batchId); }
  };
  const existingLines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerEvent) : [];
  for (const e of existingLines) apply(e);
  const write = (e: LedgerEvent) => { const fd = openSync(path, 'a'); try { appendFileSync(fd, JSON.stringify(e) + '\n'); fsyncSync(fd); } finally { closeSync(fd); } apply(e); };
  if (opening) {
    // VNEXT-5: the opening is applied exactly once, as the FIRST lines of a new ledger; afterwards the file must still carry the same inherit lines
    const want = inheritedPicoOf(opening); const inheritLines = existingLines.filter((e) => e.kind === 'inherit');
    if (existingLines.length === 0) { for (const p of ['anthropic', 'openai', 'google'] as const) if (want[p] > 0n) write({ kind: 'inherit', operationId: 'OPENING', provider: p, batchId: 'OPENING', usd: want[p].toString(), tsUtc: clock(), note: opening.digestSha256 }); }
    else if (inheritLines.length === 0) throw new LedgerOpeningError('LEDGER_OPENING_AFTER_START', 'the ledger already has events without an opening');
    else { for (const p of ['anthropic', 'openai', 'google'] as const) { const got = inheritLines.filter((e) => e.provider === p).reduce((a, e) => a + P(e.usd), 0n); if (got !== want[p] || inheritLines.some((e) => e.note !== opening.digestSha256)) throw new LedgerOpeningError('LEDGER_OPENING_MISMATCH', p); } }
  } else if (existingLines.some((e) => e.kind === 'inherit')) {
    // VNEXT-F (R17-V-3): a ledger that started with inherit lines can only be reopened WITH the opening file (the lines are re-checked against it)
    throw new LedgerOpeningError('LEDGER_OPENING_FILE_MISSING', 'the ledger carries inherit lines; LEDGER_OPENING.json is required to reopen it');
  }
  const committed = (p: Provider) => (spent[p] ?? 0n) + (uncertain[p] ?? 0n) + (reserved[p] ?? 0n) + (inherited[p] ?? 0n);
  const campaignCommitted = () => (Object.keys(caps.providers) as Provider[]).reduce((a, p) => a + committed(p), 0n);
  return {
    state: () => ({
      schema: H2EVAL_SCHEMA.ledger, campaignCapUsd: caps.campaign.toString(),
      providers: Object.fromEntries((Object.keys(caps.providers) as Provider[]).map((p) => [p, { capUsd: caps.providers[p].toString(), spentUsd: (spent[p] ?? 0n).toString(), reservedUsd: (reserved[p] ?? 0n).toString(), possiblyChargedUsd: (uncertain[p] ?? 0n).toString(), inheritedUsd: (inherited[p] ?? 0n).toString(), operations: ops[p] ?? 0 }])) as LedgerState['providers'],
      batches: Object.fromEntries(Object.entries(caps.batches).map(([b, cap]) => [b, { capUsd: cap.toString(), spentUsd: (bSpent[b] ?? 0n).toString(), reservedUsd: (bReserved[b] ?? 0n).toString() }])),
    }),
    reserve(operationId, provider, batchId, capPico) {
      if (capPico <= 0n) throw new BudgetStop('STOP_BUDGET_OPERATION', { operationId, reason: 'cap_not_positive' });
      if (!(provider in caps.providers)) throw new BudgetStop('STOP_BUDGET_PROVIDER', { operationId, provider, reason: 'provider_without_subledger' });
      if (open.has(operationId)) throw new BudgetStop('STOP_BUDGET_OPERATION', { operationId, reason: 'already_reserved' });
      if (committed(provider) + capPico > caps.providers[provider]) throw new BudgetStop('STOP_BUDGET_PROVIDER', { operationId, provider, committed: committed(provider).toString(), cap: caps.providers[provider].toString(), wanted: capPico.toString() });
      const batchMax = caps.providers[provider] / 4n; // 25% of the sub-ledger (R10 R2 §5.1)
      const batchCap = batchId in caps.batches ? caps.batches[batchId]! : batchMax;
      if (batchCap > batchMax) throw new BudgetStop('STOP_BUDGET_BATCH', { operationId, batchId, reason: 'batch_cap_above_25pct_of_provider', cap: batchCap.toString(), max: batchMax.toString() });
      if ((bSpent[batchId] ?? 0n) + (bReserved[batchId] ?? 0n) + capPico > batchCap) throw new BudgetStop('STOP_BUDGET_BATCH', { operationId, batchId, cap: batchCap.toString() });
      if (campaignCommitted() + capPico > caps.campaign) throw new BudgetStop('STOP_BUDGET_CAMPAIGN', { operationId, committed: campaignCommitted().toString(), cap: caps.campaign.toString() });
      write({ kind: 'reserve', operationId, provider, batchId, usd: capPico.toString(), tsUtc: clock() });
    },
    settle(operationId, provider, batchId, costPico) {
      const r = open.get(operationId); if (!r) throw new Error('ledger: settle without reservation');
      if (costPico > r.usd) throw new BudgetStop('STOP_CAP_VIOLATION', { operationId, cost: costPico.toString(), reserved: r.usd.toString() });
      write({ kind: 'settle', operationId, provider, batchId, usd: costPico.toString(), tsUtc: clock() });
    },
    markUncertain(operationId, provider, batchId) { const r = open.get(operationId); if (!r) throw new Error('ledger: uncertain without reservation'); write({ kind: 'uncertain', operationId, provider, batchId, usd: r.usd.toString(), tsUtc: clock() }); },
    release(operationId, provider, batchId) { const r = open.get(operationId); if (!r) throw new Error('ledger: release without reservation'); write({ kind: 'release', operationId, provider, batchId, usd: r.usd.toString(), tsUtc: clock() }); },
    raiseBatchCap(batchId, provider, toPico, signedBy, reason) {
      if (!/^human:\S/.test(signedBy)) throw new BudgetStop('STOP_BUDGET_BATCH', { batchId, reason: 'cap_raise_unsigned' });
      if (!(provider in caps.providers)) throw new BudgetStop('STOP_BUDGET_PROVIDER', { batchId, provider, reason: 'provider_without_subledger' });
      if (raised.has(batchId)) throw new BudgetStop('STOP_BUDGET_BATCH', { batchId, reason: 'cap_raise_already_applied' });
      const batchMax = caps.providers[provider] / 4n; const from = batchId in caps.batches ? caps.batches[batchId]! : batchMax;
      if (toPico !== from * 2n) throw new BudgetStop('STOP_BUDGET_BATCH', { batchId, reason: 'cap_raise_must_be_exactly_2x', from: from.toString(), to: toPico.toString() });
      if (toPico > batchMax) throw new BudgetStop('STOP_BUDGET_BATCH', { batchId, reason: 'cap_raise_above_25pct_of_provider', to: toPico.toString(), max: batchMax.toString() });
      write({ kind: 'cap_raise', operationId: 'CAP_RAISE', provider, batchId, usd: toPico.toString(), tsUtc: clock(), note: JSON.stringify({ from: from.toString(), to: toPico.toString(), signedBy, reason }) });
      return { fromPico: from.toString(), toPico: toPico.toString() };
    },
    reservedOf: (id) => open.get(id)?.usd ?? null,
    pauseThresholdReached: (provider, percent = 80) => provider in caps.providers && committed(provider) * 100n >= caps.providers[provider] * BigInt(percent),
  };
}
