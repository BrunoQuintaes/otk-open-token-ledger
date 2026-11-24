/**
 * D1–D8 shared contract — durable operation, reservation/settlement and outbox (D7, D3 §7;
 * producer C, consumers S4/S5).
 *
 * The operation record exists durably BEFORE the upstream call in the durable profile. Execution,
 * measurement, delivery and accounting effects are separate state axes: a closed app changes
 * delivery, not measurement; an explicit cancel is not an upstream failure (D7 §2–3).
 * Prompt/response text is not stored by default (D2 §7, D7 §1).
 */
import type { Hex32, IsoTime, Money, OperationKey, Scaled, FrozenConfigRef, VersionRef } from './common.js';
import type { NormalizedUsage, UsageApi } from './usage.js';

export type ExecutionState =
  | 'admitted'
  | 'upstream_started'
  | 'completed'
  | 'cancel_requested'
  | 'cancelled'
  | 'upstream_failed'
  /** the process that owned the call died; found by recovery; outcome unknown */
  | 'process_lost';

/**
 * none      = nothing measured yet;
 * partial   = intermediate usage only — never settled as final;
 * final     = final usage received and durably captured;
 * uncertain = the call may have consumed tokens but no final usage exists (no auto re-send,
 *             no invented zero; D7 §3).
 */
export type MeasurementState = 'none' | 'partial' | 'final' | 'uncertain';

export type DeliveryState = 'pending' | 'streaming' | 'delivered' | 'client_disconnected';

/**
 * held          = reservation counted against quota/budget, no final usage yet;
 * settled       = final usage debited once; reservation difference returned;
 * held_uncertain= measurement uncertain: exposure kept (never released on timeout/retry, D7 §9);
 * released      = nothing was consumed upstream (e.g. rejected before the call).
 */
export type SettlementState = 'held' | 'settled' | 'held_uncertain' | 'released';

/** Limits frozen at admission; the gateway enforces them even after the client leaves (D7 §2). */
export interface OperationLimits {
  maxOutputTokens: bigint;
  maxDurationMs: bigint;
  /** Money ceiling for real-provider calls; null for simulated providers. */
  maxCost: Money | null;
  /**
   * v1.2 (S4, ABC-04): in strict money mode, every model id the provider may report for this
   * request (lower case). The money reservation is the worst case over this set; a returned model
   * outside it breaks the guarantee and freezes the budgets. Omitted outside strict mode.
   */
  allowedReturnedModels?: string[];
  /** v1.2 (ABC-04): id of the money-bound policy that admitted the request (strict mode only). */
  moneyBoundPolicy?: string;
  /**
   * v1.3 (FECHAMENTO_GEMINI_AD): tariff assumptions the reservation and the frozen table rely on. A usage that
   * contradicts them (another service tier; thinking tokens when thinking was admitted off) breaks the bound:
   * the budgets are frozen and a tier mismatch keeps the price pending. Omitted when there are none.
   */
  pricingTerms?: PricingTerms;
}

/** Tariff assumptions of one admission (v1.3). */
export interface PricingTerms {
  /** Service tier the frozen table prices (OpenAI 'default' = Standard; Gemini 'standard'). */
  serviceTier?: string;
  /** Thinking admitted as off (Gemini thinkingBudget 0): reported thinking tokens contradict the admission. */
  thinking?: 'off';
}

/**
 * Reservation made at admission.
 * Known CU (POST /receipts, CU computed server-side): cu = the computed CU.
 * Unknown CU (proxy, before the provider answers): cu = B's worst-case estimate
 *   CU(estimatedInputTokens + limits.maxOutputTokens) under the frozen weights; settlement
 *   replaces it by the final CU. money = worst-case price under the frozen price table.
 * v1.2 (ABC-03): `state` is the CU/quota settlement only; `money` stays the reserved worst case
 * for the whole life of the operation. Money spent is DurableOperation.money.confirmed.
 */
export interface Reservation {
  cu: Scaled;
  money: Money | null;
  /** How the reservation was derived (e.g. 'known_cu' | 'worst_case_estimate@<version>'). */
  basis: string;
  state: SettlementState;
}

/**
 * v1.2 (S4, audit ABC-03) — monetary axis, separate from the CU settlement of `reservation`.
 * A reservation is not money spent and a partial subtotal is not a final total:
 *   held          = worst case held against every money budget of the operation;
 *   pending_price = measurement/CU final, but the price is missing or partial: the reserved
 *                   worst case STAYS held (exposure kept) until a complete quote of the same
 *                   stored usage settles it (no new inference);
 *   settled       = complete quote: `confirmed` moved to spent once, the hold returned;
 *   held_uncertain= measurement uncertain (no final usage): exposure kept;
 *   released      = nothing consumed upstream: hold returned.
 */
export type MoneyState = 'held' | 'pending_price' | 'settled' | 'held_uncertain' | 'released';

export interface MoneySettlement {
  state: MoneyState;
  /** Worst case held at admission; never changes after admission. */
  reserved: Money;
  /** Confirmed spend; non-null only when state === 'settled' (written once). */
  confirmed: Money | null;
  /** Subtotal of a partial quote — informative, never moved to spent. */
  knownSubtotal: Money | null;
  /** Status of the last quote applied (null = no quote/price table available). */
  priceStatus: 'priced' | 'missing_price' | 'partial' | null;
  /** Table whose quote produced the current state. */
  priceTable: VersionRef | null;
  /**
   * Present only on rows settled before S4 (migration 150 backfill): `confirmed` is what the
   * pre-S4 rule moved to spent at CU settlement, possibly the reservation itself. Not a new claim.
   */
  origin?: 'legacy_pre_s4';
}

export interface DurableOperation {
  schema: 'otk.operation.v1';
  key: OperationKey;
  /** Digest of the admitted request's metering-relevant fields (not the prompt text). */
  requestDigest: Hex32;
  /** v1.4 (OVERNIGHT 20261005): construction of requestDigest; rows from before the column existed read as v1. */
  requestDigestVersion?: 'otk.request_digest.v1' | 'otk.request_digest.v2';
  provider: string;
  api: UsageApi;
  modelRequested: string;
  config: FrozenConfigRef;
  limits: OperationLimits;
  reservation: Reservation;
  providerRequestId: string | null;
  execution: ExecutionState;
  measurement: MeasurementState;
  delivery: DeliveryState;
  usage: NormalizedUsage | null;
  cancellation: { requestedAt: IsoTime; result: 'stopped_upstream' | 'already_finished' | 'failed' | null } | null;
  effects: {
    receiptDigest: Hex32 | null;
    conferenceDigest: Hex32 | null;
    debitApplied: boolean;
    proofJobId: string | null;
  };
  createdAt: IsoTime;
  updatedAt: IsoTime;
  /** Optimistic-concurrency version; every transition increments it. */
  revision: bigint;
  /**
   * v1.2 (ABC-03): monetary settlement. Present iff the operation holds money
   * (reservation.money !== null). `reservation.money` keeps the reserved worst case; the
   * confirmed amount lives only here.
   */
  money?: MoneySettlement;
}

/**
 * Result of admitting an operation. Idempotent on (tenantId, operationId):
 * same requestDigest (or a stored digest listed in AdmitRequest.equivalentDigests, i.e. the same
 * client request digested by an earlier release) → 'existing' with the stored record (no new upstream
 * call); any other digest → 'conflict' (never overwrite; D3 §7, D3-G06).
 */
export type AdmitResult =
  | { outcome: 'admitted'; operation: DurableOperation }
  | { outcome: 'existing'; operation: DurableOperation }
  | { outcome: 'conflict'; existingRequestDigest: Hex32 }
  | { outcome: 'quota_exceeded'; quota: Scaled; current: Scaled }
  | { outcome: 'budget_exceeded'; remaining: Money }
  /**
   * v1.3 (fechamento pós-S5, RV2-01): at the admission's atomic point the tenant is under money
   * budget(s) whose bound policy the request was not reserved under (no strict reservation, or
   * another policy). Nothing was admitted; the caller may re-reserve under `required` and retry.
   */
  | { outcome: 'money_policy_required'; required: string[]; offered: string | null }
  /**
   * H1-S07 (2026-10-13): the operator requires a money budget for spending its provider key and the tenant has none
   * (or is not in the operator-wide budget `globalBudgetId`). Nothing was admitted, nothing reserved.
   */
  | { outcome: 'money_budget_required'; globalBudgetId: string | null }
  /** v1.4 (OVERNIGHT 20261005, Phase 4): this operation id was erased; it is never admitted again. */
  | { outcome: 'erased'; erasedAt: string }
  /** v1.4 (Phase 7): a project/application named by the request is not registered (active) for the tenant. */
  | { outcome: 'attribution_rejected'; reason: 'project_unknown' | 'application_unknown' }
  /** v1.4 (OVERNIGHT 20261005): `detail` = database error code/message head (for logs; never shown as success). */
  | { outcome: 'persistence_unavailable'; detail?: string };

/**
 * Quota admission rule preserved from the current policy (accepted in D7 §8): check before the
 * request, the request that crosses the limit is admitted.
 *   admit ⇔ confirmed + held < quota;   then held += reservation.cu
 * Hand vector (known CU): quota 10 000, twenty concurrent requests of 3 000 →
 *   0→3 000→6 000→9 000 admitted (9 000 < 10 000), 12 000 ≥ 10 000 rejected: 4 admitted,
 *   12 000 CU, with one or two instances (D7-G07).
 * Money ceilings are NOT flexible quotas: a real-money reservation is admitted only if
 *   spentConfirmed + heldWorstCase + request.worstCase ≤ ceiling (no crossing allowed).
 */
export const D1D8_QUOTA_ADMISSION_RULE = 'check_before_crossing_admitted@1' as const;
export const D1D8_MONEY_ADMISSION_RULE = 'strict_ceiling_worst_case@1' as const;

/** One durable side effect, executed at-least-once and deduplicated by effectId. */
export interface OutboxEffect {
  schema: 'otk.outbox_effect.v1';
  effectId: string;
  key: OperationKey;
  kind: 'persist_receipt' | 'persist_conference' | 'apply_debit' | 'project_redis' | 'enqueue_proof' | 'submit_onchain';
  payloadDigest: Hex32;
  /** For 'enqueue_proof'/'submit_onchain': the destination frozen when the job was created (D7 §11). */
  target: { chainId: bigint; registry: string; circuitId: string; schemaVersion: string } | null;
  state: 'pending' | 'leased' | 'done' | 'dead';
  attempts: number;
  lease: { owner: string; until: IsoTime } | null;
  createdAt: IsoTime;
}

/**
 * Retention/replay invariant (fixes RV30-04): a deduplication identity is retained at least as
 * long as any aggregate (balance/quota projection) that still includes its effect; aggregates are
 * rebuildable from the durable source. Replay inside that horizon never adds the effect twice.
 */
export const D1D8_REPLAY_INVARIANT = 'identity_retention_ge_aggregate_retention@1' as const;
