/**
 * D1–D8 / C — legal transitions of the four state axes of a DurableOperation (D7 §1–3).
 *
 * Execution, measurement, delivery and reservation move independently, with cross-axis
 * invariants that keep partial or missing usage from being settled as final, and keep an
 * uncertain measurement from releasing its exposure (D7 §9).
 *
 * @module operations/transitions
 */
import type {
  DeliveryState, DurableOperation, ExecutionState, MeasurementState, MoneySettlement, MoneyState, SettlementState,
} from '../types/d1d8/index.js';

/** Structural equality of JSON-like values with bigint (no import from codec: avoids a cycle). */
const sameJson = (a: unknown, b: unknown): boolean => {
  const enc = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  return enc(a) === enc(b);
};

export const EXECUTION_STATES: readonly ExecutionState[] = ['admitted', 'upstream_started', 'completed', 'cancel_requested', 'cancelled', 'upstream_failed', 'process_lost'];
export const MEASUREMENT_STATES: readonly MeasurementState[] = ['none', 'partial', 'final', 'uncertain'];
export const DELIVERY_STATES: readonly DeliveryState[] = ['pending', 'streaming', 'delivered', 'client_disconnected'];
export const SETTLEMENT_STATES: readonly SettlementState[] = ['held', 'settled', 'held_uncertain', 'released'];

const EXECUTION_NEXT: Record<ExecutionState, readonly ExecutionState[]> = {
  admitted: ['upstream_started', 'cancel_requested', 'cancelled', 'upstream_failed', 'process_lost'],
  upstream_started: ['completed', 'cancel_requested', 'upstream_failed', 'process_lost'],
  cancel_requested: ['cancelled', 'completed', 'upstream_failed', 'process_lost'],
  completed: [],
  cancelled: [],
  upstream_failed: [],
  process_lost: [],
};
const MEASUREMENT_NEXT: Record<MeasurementState, readonly MeasurementState[]> = {
  none: ['partial', 'final', 'uncertain'],
  partial: ['partial', 'final', 'uncertain'],
  // a measurement captured later (spool replay) may still turn uncertain into final
  uncertain: ['final'],
  final: [],
};
const DELIVERY_NEXT: Record<DeliveryState, readonly DeliveryState[]> = {
  pending: ['streaming', 'delivered', 'client_disconnected'],
  streaming: ['delivered', 'client_disconnected'],
  delivered: [],
  client_disconnected: [],
};
const SETTLEMENT_NEXT: Record<SettlementState, readonly SettlementState[]> = {
  held: ['settled', 'held_uncertain', 'released'],
  held_uncertain: ['settled'],
  settled: [],
  released: [],
};
/** Monetary axis (S4, ABC-03): a hold ends only by a complete quote (settled) or a certain release. */
export const MONEY_STATES: readonly MoneyState[] = ['held', 'pending_price', 'settled', 'held_uncertain', 'released'];
const MONEY_NEXT: Record<MoneyState, readonly MoneyState[]> = {
  held: ['pending_price', 'settled', 'held_uncertain', 'released'],
  held_uncertain: ['pending_price', 'settled'],
  pending_price: ['settled'],
  settled: [],
  released: [],
};

/**
 * Money follows a CU reservation transition unless the patch states it explicitly: released →
 * released, held_uncertain → held_uncertain, settled (CU) → pending_price (no complete quote
 * given). Never derives 'settled': only a complete quote settles money.
 */
function derivedMoney(cur: DurableOperation, patch: OperationPatch): MoneySettlement | undefined {
  if (!cur.money || patch.money !== undefined || !patch.reservation || patch.reservation.state === cur.reservation.state) return patch.money;
  const to = patch.reservation.state;
  const m = cur.money;
  if (to === 'released' && m.state === 'held') return { ...m, state: 'released' };
  if (to === 'held_uncertain' && m.state === 'held') return { ...m, state: 'held_uncertain' };
  if (to === 'settled' && (m.state === 'held' || m.state === 'held_uncertain')) return { ...m, state: 'pending_price', confirmed: null, knownSubtotal: null, priceStatus: null };
  return undefined;
}

export class IllegalTransitionError extends Error {
  constructor(message: string) { super(message); this.name = 'IllegalTransitionError'; }
}

function check<T extends string>(axis: string, table: Record<T, readonly T[]>, from: T, to: T | undefined): void {
  if (to === undefined || to === from) return;
  if (!(table[from] ?? []).includes(to)) throw new IllegalTransitionError(`${axis}: ${from} → ${to} is not allowed`);
}

export type OperationPatch = Partial<Pick<DurableOperation,
  'execution' | 'measurement' | 'delivery' | 'usage' | 'providerRequestId' | 'cancellation' | 'effects' | 'reservation' | 'money'>>;

/** Apply a patch, or throw IllegalTransitionError. Returns the merged next state (without revision/time). */
export function applyPatch(cur: DurableOperation, patchIn: OperationPatch): DurableOperation {
  const money = derivedMoney(cur, patchIn);
  const patch: OperationPatch = money === undefined ? patchIn : { ...patchIn, money };
  if (patch.money !== undefined) {
    if (!cur.money) throw new IllegalTransitionError('money: the operation holds no money (it exists only from admission)');
    check('money', MONEY_NEXT, cur.money.state, patch.money.state);
    if (!sameJson(patch.money.reserved, cur.money.reserved)) throw new IllegalTransitionError('money: reserved amount is immutable');
    if (patch.money.state === cur.money.state && !sameJson(patch.money, cur.money)) {
      throw new IllegalTransitionError(`money cannot change while it stays ${cur.money.state}`);
    }
  }
  check('execution', EXECUTION_NEXT, cur.execution, patch.execution);
  check('measurement', MEASUREMENT_NEXT, cur.measurement, patch.measurement);
  check('delivery', DELIVERY_NEXT, cur.delivery, patch.delivery);
  check('reservation', SETTLEMENT_NEXT, cur.reservation.state, patch.reservation?.state);
  if (patch.reservation !== undefined && !sameJson(patch.reservation.money, cur.reservation.money)) {
    // ABC-03: reservation.money is the reserved worst case for the whole operation; spend lives in money.confirmed
    throw new IllegalTransitionError('reservation.money is the reserved worst case and never changes (money spent goes to money.confirmed)');
  }
  if (patch.reservation !== undefined && patch.reservation.state === cur.reservation.state
      && !sameJson(patch.reservation, cur.reservation)) {
    // the reserved/settled amounts change only together with a reservation state transition
    throw new IllegalTransitionError(`reservation cannot change while it stays ${cur.reservation.state}`);
  }
  if (patch.providerRequestId !== undefined && cur.providerRequestId !== null && patch.providerRequestId !== cur.providerRequestId) {
    throw new IllegalTransitionError('providerRequestId is write-once');
  }
  if (patch.usage !== undefined && cur.measurement === 'final') {
    throw new IllegalTransitionError('final usage is immutable');
  }
  if (patch.cancellation !== undefined && cur.cancellation?.result != null) {
    throw new IllegalTransitionError('cancellation result is write-once');
  }
  if (patch.effects !== undefined) {
    if (cur.effects.debitApplied && !patch.effects.debitApplied) throw new IllegalTransitionError('debitApplied cannot be undone');
    for (const k of ['receiptDigest', 'conferenceDigest', 'proofJobId'] as const) {
      const was = cur.effects[k];
      if (was !== null && patch.effects[k] !== was) throw new IllegalTransitionError(`effects.${k} is write-once`);
    }
  }
  const next: DurableOperation = { ...cur, ...patch, effects: patch.effects ?? cur.effects, reservation: patch.reservation ?? cur.reservation };
  if (cur.money && patch.money === undefined) next.money = cur.money;
  assertInvariants(next);
  return next;
}

/** Cross-axis invariants (checked after every transition and on admission). */
export function assertInvariants(op: DurableOperation): void {
  if (op.measurement === 'final' && op.usage === null) throw new IllegalTransitionError('final measurement requires usage');
  if (op.measurement === 'final' && op.usage && op.usage.completeness !== 'complete') {
    throw new IllegalTransitionError(`final measurement requires complete usage (got ${op.usage.completeness})`);
  }
  const s = op.reservation.state;
  if (s === 'settled' && op.measurement !== 'final') throw new IllegalTransitionError('settled reservation requires final measurement');
  if (s === 'held_uncertain' && op.measurement === 'none') {
    // final + held_uncertain = usage known but its CU not computable (exposure kept, visible)
    throw new IllegalTransitionError('held_uncertain requires a measurement (uncertain, partial or final without CU)');
  }
  if (s === 'released' && op.measurement !== 'none') throw new IllegalTransitionError('released requires that nothing was measured');
  if ((op.execution === 'completed' || op.execution === 'cancelled' || op.execution === 'upstream_failed' || op.execution === 'process_lost') && s === 'held') {
    // a terminal execution must not keep a plain hold (no path would ever end it): settled,
    // released (certainly nothing consumed) or held_uncertain (exposure kept, visible) — review H2
    throw new IllegalTransitionError(`terminal execution ${op.execution} cannot keep a plain hold`);
  }
  const m = op.money;
  if (m) {
    // ABC-03: a reservation or a partial subtotal is never money spent
    if (m.state === 'settled' && (m.confirmed === null || (m.priceStatus !== 'priced' && m.origin !== 'legacy_pre_s4'))) throw new IllegalTransitionError('money settled requires a complete quote (priced) and its confirmed total');
    if (m.state !== 'settled' && m.confirmed !== null) throw new IllegalTransitionError(`money ${m.state} cannot carry a confirmed amount`);
    if ((m.state === 'settled' || m.state === 'pending_price') && op.measurement !== 'final') throw new IllegalTransitionError(`money ${m.state} requires a final measurement`);
    if (m.state === 'released' && s !== 'released') throw new IllegalTransitionError('money released requires a released reservation');
    if (m.state === 'held' && s !== 'held') throw new IllegalTransitionError(`money held cannot outlive a ${s} reservation`);
    if (m.state === 'held_uncertain' && op.measurement === 'none') throw new IllegalTransitionError('money held_uncertain requires a measurement');
  }
}

export function isIncomplete(execution: ExecutionState): boolean {
  return execution === 'admitted' || execution === 'upstream_started' || execution === 'cancel_requested';
}

export function assertStateValues(op: { execution: string; measurement: string; delivery: string; reservation: { state: string } }): void {
  if (!(EXECUTION_STATES as readonly string[]).includes(op.execution)) throw new IllegalTransitionError(`unknown execution ${op.execution}`);
  if (!(MEASUREMENT_STATES as readonly string[]).includes(op.measurement)) throw new IllegalTransitionError(`unknown measurement ${op.measurement}`);
  if (!(DELIVERY_STATES as readonly string[]).includes(op.delivery)) throw new IllegalTransitionError(`unknown delivery ${op.delivery}`);
  if (!(SETTLEMENT_STATES as readonly string[]).includes(op.reservation.state)) throw new IllegalTransitionError(`unknown reservation state ${op.reservation.state}`);
}
