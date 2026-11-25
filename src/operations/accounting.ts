/**
 * D1–D8 / C — accounting scales and the two admission rules frozen by the contract
 * (src/types/d1d8/operation.ts). Pure functions; the stores apply them under a row lock.
 *
 * All amounts are non-negative bigint integers at a fixed power-of-ten scale; conversions never round
 * (they throw instead). Used by `PgOperationStore.ts` and by `src/billing/meteringQuota.ts`.
 *
 * @module src/operations/accounting
 */
import type { Money, Scaled } from '../types/d1d8/index.js';
import { D1D8_MONEY_ADMISSION_RULE, D1D8_QUOTA_ADMISSION_RULE } from '../types/d1d8/index.js';

/** Rule ids stamped in admission logs/evidence (frozen by the contract). */
export const QUOTA_RULE = D1D8_QUOTA_ADMISSION_RULE;
/** Rule id of the money-ceiling admission rule (see {@link admitByMoney}). */
export const MONEY_RULE = D1D8_MONEY_ADMISSION_RULE;

/** CU accounting scale: micro-CU. B's CU_MULT_v2_micro is already here; legacy CU_MODEL_v1 is ×10^6. */
export const ACCOUNTING_SCALE = 1_000_000n;
/** Money scale: pico-USD (B's Money scale). */
export const MONEY_SCALE = 1_000_000_000_000n;

/** Thrown when a scaled amount cannot be converted exactly (non power-of-ten scale or lost digits). */
export class ScaleLossError extends Error {
  /**
   * Builds the error with the offending value and target scale.
   *
   * @param value - The amount that could not be converted.
   * @param target - The requested scale.
   */
  constructor(readonly value: Scaled, readonly target: bigint) {
    super(`converting ${value.units}/${value.scale} to scale ${target} would lose digits`);
    this.name = 'ScaleLossError';
  }
}

function isPowerOfTen(n: bigint): boolean {
  if (n <= 0n) return false;
  while (n % 10n === 0n) n /= 10n;
  return n === 1n;
}

/**
 * Exact conversion to `target` scale; refuses (throws) instead of rounding.
 *
 * @param value - Amount as `units / scale`.
 * @param target - Target scale (a power of ten).
 * @returns The amount expressed in units of `1 / target`.
 * @throws {@link ScaleLossError} When either scale is not a power of ten, or digits would be lost.
 * @throws {RangeError} When the amount is negative.
 * @example
 * toScale({ units: 15n, scale: 10n }, 1_000_000n); // 1_500_000n
 */
export function toScale(value: Scaled, target: bigint): bigint {
  if (!isPowerOfTen(value.scale) || !isPowerOfTen(target)) throw new ScaleLossError(value, target);
  if (value.units < 0n) throw new RangeError(`negative amount ${value.units}`);
  if (target >= value.scale) return value.units * (target / value.scale);
  const div = value.scale / target;
  if (value.units % div !== 0n) throw new ScaleLossError(value, target);
  return value.units / div;
}

/**
 * Converts a CU amount to accounting units (micro-CU).
 *
 * @param cu - Scaled CU amount.
 * @returns Micro-CU.
 * @throws {@link ScaleLossError} When the conversion would lose digits.
 * @throws {RangeError} When the amount is negative.
 */
export const toAccountingUnits = (cu: Scaled): bigint => toScale(cu, ACCOUNTING_SCALE);
/**
 * Converts a USD money amount to pico-USD.
 *
 * @param m - Money amount; only `USD` is accepted.
 * @returns Pico-USD.
 * @throws {RangeError} When the currency is not USD or the amount is negative.
 * @throws {@link ScaleLossError} When the conversion would lose digits.
 */
export const toMoneyUnits = (m: Money): bigint => {
  if (m.currency !== 'USD') throw new RangeError(`unsupported currency ${String(m.currency)}`);
  return toScale(m, MONEY_SCALE);
};

/**
 * Integer CU of a plan quota (PlanRegistry) in accounting units. 0 = no hard limit → null.
 *
 * @param planQuotaCu - Plan quota in whole CU.
 * @returns Micro-CU, or `null` meaning unlimited.
 */
export function quotaUnits(planQuotaCu: bigint): bigint | null {
  return planQuotaCu === 0n ? null : planQuotaCu * ACCOUNTING_SCALE;
}

/**
 * check_before_crossing_admitted@1: admit ⇔ confirmed + held < quota (the request that crosses
 * the limit is admitted). quota null = unlimited.
 *
 * @param confirmed - Settled usage in the epoch, micro-CU.
 * @param held - Reserved but unsettled usage, micro-CU.
 * @param quota - Epoch quota, micro-CU, or `null` for unlimited.
 * @returns Whether a new operation may be admitted.
 */
export function admitByQuota(confirmed: bigint, held: bigint, quota: bigint | null): boolean {
  return quota === null || confirmed + held < quota;
}

/**
 * strict_ceiling_worst_case@1: admit ⇔ spent + held + worstCase ≤ ceiling. An unknown worst case
 * under a configured ceiling is refused (never treated as zero).
 *
 * @param spent - Money already spent against the budget, pico-USD.
 * @param held - Money reserved by unsettled operations, pico-USD.
 * @param worstCase - Worst-case cost of the new operation, pico-USD; `null` when unknown.
 * @param ceiling - Budget ceiling, pico-USD.
 * @returns Whether the new operation fits under the ceiling.
 */
export function admitByMoney(spent: bigint, held: bigint, worstCase: bigint | null, ceiling: bigint): boolean {
  if (worstCase === null) return false;
  return spent + held + worstCase <= ceiling;
}

/** money_excess_over_reservation (S4, ABC-04): observed money above the reserved worst case; budgets frozen. */
export type SettlementNote = 'within_reservation' | 'excess_over_reservation' | 'cu_not_computable' | 'money_excess_over_reservation' | 'unexpected_returned_model'
  // FECHAMENTO_GEMINI_AD: tariff assumptions of the admission contradicted by the usage
  | 'unexpected_service_tier' | 'unexpected_thinking';

/**
 * Single point for the reservation × returned-model decision (MEDIUM-3, option (c) until the
 * author decides): the final CU is always settled as measured, never truncated; an excess over
 * the worst-case reservation is flagged so it is visible in status, logs and evidence.
 *
 * @param reservedUnits - CU reserved at admission, micro-CU.
 * @param finalUnits - CU measured at settlement, micro-CU.
 * @returns `'excess_over_reservation'` when the final exceeds the reservation, else `'within_reservation'`.
 */
export function settlementPolicy(reservedUnits: bigint, finalUnits: bigint): SettlementNote {
  return finalUnits > reservedUnits ? 'excess_over_reservation' : 'within_reservation';
}
