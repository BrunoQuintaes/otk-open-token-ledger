/**
 * D1–D8 / C — accounting scales and the two admission rules frozen by the contract
 * (src/types/d1d8/operation.ts). Pure functions; the stores apply them under a row lock.
 *
 * @module operations/accounting
 */
import type { Money, Scaled } from '../types/d1d8/index.js';
import { D1D8_MONEY_ADMISSION_RULE, D1D8_QUOTA_ADMISSION_RULE } from '../types/d1d8/index.js';

/** Rule ids stamped in admission logs/evidence (frozen by the contract). */
export const QUOTA_RULE = D1D8_QUOTA_ADMISSION_RULE;
export const MONEY_RULE = D1D8_MONEY_ADMISSION_RULE;

/** CU accounting scale: micro-CU. B's CU_MULT_v2_micro is already here; legacy CU_MODEL_v1 is ×10^6. */
export const ACCOUNTING_SCALE = 1_000_000n;
/** Money scale: pico-USD (B's Money scale). */
export const MONEY_SCALE = 1_000_000_000_000n;

export class ScaleLossError extends Error {
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

/** Exact conversion to `target` scale; refuses (throws) instead of rounding. */
export function toScale(value: Scaled, target: bigint): bigint {
  if (!isPowerOfTen(value.scale) || !isPowerOfTen(target)) throw new ScaleLossError(value, target);
  if (value.units < 0n) throw new RangeError(`negative amount ${value.units}`);
  if (target >= value.scale) return value.units * (target / value.scale);
  const div = value.scale / target;
  if (value.units % div !== 0n) throw new ScaleLossError(value, target);
  return value.units / div;
}

export const toAccountingUnits = (cu: Scaled): bigint => toScale(cu, ACCOUNTING_SCALE);
export const toMoneyUnits = (m: Money): bigint => {
  if (m.currency !== 'USD') throw new RangeError(`unsupported currency ${String(m.currency)}`);
  return toScale(m, MONEY_SCALE);
};

/** Integer CU of a plan quota (PlanRegistry) in accounting units. 0 = no hard limit → null. */
export function quotaUnits(planQuotaCu: bigint): bigint | null {
  return planQuotaCu === 0n ? null : planQuotaCu * ACCOUNTING_SCALE;
}

/**
 * check_before_crossing_admitted@1: admit ⇔ confirmed + held < quota (the request that crosses
 * the limit is admitted). quota null = unlimited.
 */
export function admitByQuota(confirmed: bigint, held: bigint, quota: bigint | null): boolean {
  return quota === null || confirmed + held < quota;
}

/**
 * strict_ceiling_worst_case@1: admit ⇔ spent + held + worstCase ≤ ceiling. An unknown worst case
 * under a configured ceiling is refused (never treated as zero).
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
 */
export function settlementPolicy(reservedUnits: bigint, finalUnits: bigint): SettlementNote {
  return finalUnits > reservedUnits ? 'excess_over_reservation' : 'within_reservation';
}
