/**
 * RB-053 — Billing Token v2 (Stub)
 *
 * A BillingToken represents a pre-paid unit of metering credit.
 * It is denomination-independent (not USD) — value is expressed in CU.
 *
 * Design target (Fase F):
 *   - On-chain ERC-20 variant for enterprise pre-payment
 *   - Off-chain voucher for SaaS tier gating
 *
 * Current state: pure in-memory stub (no on-chain).
 *
 * Invariant: canDebit / debitToken are pure (no I/O).
 * createBillingToken accepts optional { nowIso, idSeed } for determinism.
 * Without opts, defaults use wall-clock (acceptable at creation boundary only).
 *
 * @module economics/BillingToken
 * @since RB-053
 */

export type BillingTokenId = string;

export type BillingToken = {
  /** Unique token identifier */
  id: BillingTokenId;
  /** Owner (userId or tenantId) */
  owner: string;
  /** Balance in CU units (bigint for determinism) */
  balanceCU: bigint;
  /** Expiry epoch (unix seconds); 0 = no expiry */
  expiryEpoch: number;
  /** Creation timestamp (ISO) */
  createdAt: string;
};

export type DebitResult =
  | { ok: true; remaining: bigint }
  | { ok: false; reason: 'insufficient_balance' | 'expired' };

/**
 * Compute whether token has balance for a given CU amount.
 * Pure function — no I/O, no side effects.
 */
export function canDebit(token: BillingToken, amountCU: bigint, nowEpoch: number): DebitResult {
  if (token.expiryEpoch > 0 && nowEpoch > token.expiryEpoch) {
    return { ok: false, reason: 'expired' };
  }
  if (token.balanceCU < amountCU) {
    return { ok: false, reason: 'insufficient_balance' };
  }
  return { ok: true, remaining: token.balanceCU - amountCU };
}

/**
 * Debit CU from a token. Returns new token state (immutable).
 * Pure function — no I/O, no side effects.
 */
export function debitToken(token: BillingToken, amountCU: bigint, nowEpoch: number): BillingToken {
  const result = canDebit(token, amountCU, nowEpoch);
  if (!result.ok) throw new Error(`BillingToken debit failed: ${result.reason}`);
  return { ...token, balanceCU: result.remaining };
}

/**
 * Create a new BillingToken.
 *
 * @param opts.nowIso - ISO timestamp for createdAt (injectable for determinism/tests)
 * @param opts.idSeed - Seed string for id generation (injectable for determinism/tests)
 *
 * When opts not provided, defaults use wall-clock (acceptable at creation boundary only).
 */
export function createBillingToken(
  owner: string,
  balanceCU: bigint,
  expiryEpoch = 0,
  opts: { nowIso?: string; idSeed?: string } = {},
): BillingToken {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const seed = opts.idSeed ?? String(Date.now());
  return {
    id: `tok_${owner}_${seed}`,
    owner,
    balanceCU,
    expiryEpoch,
    createdAt: nowIso,
  };
}
