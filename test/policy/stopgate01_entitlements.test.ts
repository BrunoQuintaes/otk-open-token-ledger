/**
 * OTK-H1-STOPGATE-01 / WP-P3: financial-policy contract (entitlements). SYNTHETIC ONLY: in-memory plan store, no
 * network, no real Stripe, no keys, no PostgreSQL. Not part of `npm test` (test/policy is outside its glob).
 *
 * Two things are written down here, side by side, for the ten cases of the P3 brief:
 *   CURRENT   what production does today (src/billing/IPlanStore.ts stripeSkip + MemoryPlanStore, reached through
 *             StripeWebhookHandler and PlanRegistry). These tests PASS: they document today's semantics, including the
 *             defects the R2 review left to human policy (MED-4 → R2-D5, INFO-1 → R2-D6, INFO-2 → R2-D7).
 *   MODEL     an EXPERIMENTAL "entitlement ledger" reference model written inside this file (never imported by src/):
 *             each source of a tier (a Stripe subscription, an administrative courtesy) is a separate record; the
 *             effective tier is the highest tier among ACTIVE sources; a cancellation ends only its own source; an
 *             administrative restriction revokes every source known at that moment (keeps the A2 R-07 rule).
 * Where CURRENT and MODEL disagree, the comparison test carries `todo: 'PENDING_HUMAN_POLICY …'`: it runs, its
 * failure is reported as TODO (suite stays green), and the divergence is visible in the output. Nothing here is an
 * approved policy (see docs/_ops/runs/OTK-H1-STOPGATE-01-20261013/P3/DECISION_MEMO_ENTITLEMENTS.md).
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_PLAN_STORE_TIMEOUT_MS'] = '300';
process.env['OTK_PLAN_ADMIN_ORDER_SKEW_S'] = '60'; // default value, pinned so the test does not depend on the shell

type Tier = 'FREE' | 'STARTER' | 'PRO';
const RANK: Readonly<Record<Tier, number>> = { FREE: 0, STARTER: 1, PRO: 2 };
const SKEW_S = 60;
const NOW = (): number => Math.floor(Date.now() / 1000);

// ─────────────────────────────────────────────────────────────────────────────
// Experimental reference model (pure; NOT production; proposal B of the memo)
// ─────────────────────────────────────────────────────────────────────────────

type SourceStatus = 'active' | 'canceled' | 'revoked_by_admin' | 'held_for_reconciliation' | 'ended';
interface Source { kind: 'stripe_subscription' | 'courtesy'; ref: string; tier: Tier; status: SourceStatus; lastCreated: number }

class EntitlementLedgerModel {
  sources = new Map<string, Source>();
  /** event id → outcome (idempotency and audit). */
  events = new Map<string, string>();
  /** events of types the policy does not cover yet (refund, failed payment, …): recorded, no effect. */
  unsupported: Array<{ eventId: string; type: string; ref: string }> = [];
  adminDecidedAtS: number | null = null;
  private _courtesySeq = 0;

  constructor(readonly skewS: number) {}

  effectiveTier(): Tier {
    let best: Tier = 'FREE';
    for (const s of this.sources.values()) if (s.status === 'active' && RANK[s.tier] > RANK[best]) best = s.tier;
    return best;
  }

  activeSources(): Array<{ kind: string; ref: string; tier: Tier }> {
    return [...this.sources.values()].filter((s) => s.status === 'active').map((s) => ({ kind: s.kind, ref: s.ref, tier: s.tier }));
  }

  /** All-or-nothing: a failure inside `fn` leaves the ledger exactly as it was (stands for one DB transaction). */
  transact<T>(fn: () => T): T {
    const snap = { sources: new Map([...this.sources].map(([k, v]) => [k, { ...v }])), events: new Map(this.events), unsupported: [...this.unsupported], adm: this.adminDecidedAtS, seq: this._courtesySeq };
    try { return fn(); } catch (err) {
      this.sources = snap.sources; this.events = snap.events; this.unsupported = snap.unsupported; this.adminDecidedAtS = snap.adm; this._courtesySeq = snap.seq;
      throw err;
    }
  }

  private _once(eventId: string, fn: () => string): string {
    if (this.events.has(eventId)) return 'duplicate';
    const outcome = fn();
    this.events.set(eventId, outcome);
    return outcome;
  }

  /** Paid grant of a Stripe subscription (checkout.session.completed with payment_status=paid). */
  stripeGrant(eventId: string, created: number, sub: string, tier: Tier): string {
    return this._once(eventId, () => {
      const k = `stripe:${sub}`;
      const s = this.sources.get(k);
      if (s?.status === 'canceled') return 'stale';                         // Stripe does not reactivate a cancelled subscription
      if (s?.status === 'revoked_by_admin') return 'superseded_by_admin';    // R-07 by identity (kept from A2)
      if (s?.status === 'held_for_reconciliation') return 'held_for_reconciliation';
      if (s && created < s.lastCreated) return 'stale';                     // same subscription, older event
      if (!s && this.adminDecidedAtS !== null && created <= this.adminDecidedAtS + this.skewS) {
        // R-07 by time (kept from A2): unknown subscription not provably after the decision → held, visible, no effect
        this.sources.set(k, { kind: 'stripe_subscription', ref: sub, tier, status: 'held_for_reconciliation', lastCreated: created });
        return 'held_for_reconciliation';
      }
      this.sources.set(k, { kind: 'stripe_subscription', ref: sub, tier, status: 'active', lastCreated: Math.max(s?.lastCreated ?? created, created) });
      return 'applied';
    });
  }

  /** customer.subscription.deleted: ends ONLY that subscription's source (courtesy and other subscriptions untouched). */
  stripeCancel(eventId: string, created: number, sub: string): string {
    return this._once(eventId, () => {
      const k = `stripe:${sub}`;
      const s = this.sources.get(k);
      if (!s) {
        // tombstone: a later grant of this subscription is stale; no other source changes
        this.sources.set(k, { kind: 'stripe_subscription', ref: sub, tier: 'FREE', status: 'canceled', lastCreated: created });
        return 'no_effect_unknown_subscription';
      }
      s.status = 'canceled';
      s.lastCreated = Math.max(s.lastCreated, created);
      return 'applied';
    });
  }

  /** Administrative courtesy: an ADDITIONAL source; it does not revoke paid subscriptions. */
  adminCourtesy(tier: Tier): string {
    const ref = `courtesy-${++this._courtesySeq}`;
    this.sources.set(`courtesy:${ref}`, { kind: 'courtesy', ref, tier, status: 'active', lastCreated: 0 });
    return ref;
  }

  /**
   * Administrative restriction (downgrade, fraud, abuse): every source known now is revoked/ended, a floor courtesy at
   * `tier` is created when tier > FREE, and the decision time becomes the R-07 epoch (A2 rule kept).
   */
  adminRestrict(tier: Tier, nowS: number): void {
    for (const s of this.sources.values()) {
      if (s.kind === 'stripe_subscription' && (s.status === 'active' || s.status === 'held_for_reconciliation')) s.status = 'revoked_by_admin';
      if (s.kind === 'courtesy' && s.status === 'active') s.status = 'ended';
    }
    if (tier !== 'FREE') this.adminCourtesy(tier);
    this.adminDecidedAtS = nowS;
  }

  /** Event type without an approved policy (refund, failed payment, past_due …): recorded, never changes the tier. */
  stripeUnsupported(eventId: string, type: string, sub: string): string {
    return this._once(eventId, () => { this.unsupported.push({ eventId, type, ref: sub }); return 'recorded_unsupported_pending_policy'; });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario steps, run against production (CURRENT) and the model (MODEL)
// ─────────────────────────────────────────────────────────────────────────────

type Step =
  | { op: 'grant'; id: string; created: number; sub: string; tier: Tier }
  | { op: 'cancel'; id: string; created: number; sub: string }
  /** production has ONE admin operation (assignPlan); the model needs the intent (courtesy vs restrict). */
  | { op: 'admin'; tier: Tier; intent: 'courtesy' | 'restrict' }
  | { op: 'unsupported'; id: string; type: string; created: number; sub: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
let plans: any; let planStores: any; let stripe: any; let store: any;
const RUN = Date.now().toString(36);
let n = 0;
let T = '';

const checkout = (id: string, created: number, sub: string, tier: Tier, tenant = T): any => ({
  type: 'checkout.session.completed', id: `${id}_${RUN}_${tenant}`, created,
  data: { object: { payment_status: 'paid', subscription: sub, metadata: { tenantId: tenant, tier } } },
});
const deleted = (id: string, created: number, sub: string, tenant = T): any => ({
  type: 'customer.subscription.deleted', id: `${id}_${RUN}_${tenant}`, created,
  data: { object: { id: sub, object: 'subscription', metadata: { tenantId: tenant } } },
});
const other = (id: string, type: string, created: number, sub: string, tenant = T): any => ({
  type, id: `${id}_${RUN}_${tenant}`, created,
  data: { object: { subscription: sub, status: 'past_due', metadata: { tenantId: tenant } } },
});

async function runProduction(steps: Step[]): Promise<{ tier: Tier; actions: string[] }> {
  const h = new stripe.StripeWebhookHandler();
  const actions: string[] = [];
  for (const s of steps) {
    if (s.op === 'grant') actions.push((await h.handle(checkout(s.id, s.created, s.sub, s.tier))).action);
    else if (s.op === 'cancel') actions.push((await h.handle(deleted(s.id, s.created, s.sub))).action);
    else if (s.op === 'unsupported') actions.push((await h.handle(other(s.id, s.type, s.created, s.sub))).action);
    else { await plans.assignPlan(T, s.tier, { actor: 'platform', source: 'admin_api' }); actions.push(`admin_${s.tier}`); }
  }
  return { tier: ((await store.get(T)) ?? 'FREE') as Tier, actions };
}

function runModel(steps: Step[]): { tier: Tier; outcomes: string[]; model: EntitlementLedgerModel } {
  const m = new EntitlementLedgerModel(SKEW_S);
  const outcomes: string[] = [];
  for (const s of steps) {
    if (s.op === 'grant') outcomes.push(m.stripeGrant(s.id, s.created, s.sub, s.tier));
    else if (s.op === 'cancel') outcomes.push(m.stripeCancel(s.id, s.created, s.sub));
    else if (s.op === 'unsupported') outcomes.push(m.stripeUnsupported(s.id, s.type, s.sub));
    else if (s.intent === 'courtesy') outcomes.push(`courtesy_${s.tier}:${m.adminCourtesy(s.tier)}`);
    else { m.adminRestrict(s.tier, NOW()); outcomes.push(`restrict_${s.tier}`); }
  }
  return { tier: m.effectiveTier(), outcomes, model: m };
}

interface ScenarioSpec {
  steps: () => Step[];
  current: { tier: Tier; actions: string[] };
  proposal: { tier: Tier; outcomes: string[] };
  /** set when CURRENT ≠ MODEL: the comparison is a TODO naming the pending human decision. */
  pending?: string;
}

/** Three tests per scenario: CURRENT (passes), MODEL (passes), comparison (passes, or TODO when they diverge). */
function scenario(name: string, spec: ScenarioSpec): void {
  it(`CURRENT  ${name} → ${spec.current.tier}`, async () => {
    const r = await runProduction(spec.steps());
    assert.deepEqual(r.actions, spec.current.actions);
    assert.equal(r.tier, spec.current.tier);
  });
  it(`MODEL    ${name} → ${spec.proposal.tier}`, () => {
    const r = runModel(spec.steps());
    assert.deepEqual(r.outcomes.map((o) => o.replace(/:courtesy-\d+$/, '')), spec.proposal.outcomes);
    assert.equal(r.tier, spec.proposal.tier);
  });
  const cmp = async (): Promise<void> => {
    const prod = await runProduction(spec.steps());
    assert.equal(prod.tier, runModel(spec.steps()).tier, 'production effective tier vs proposed ledger');
  };
  if (spec.pending) it(`PROPOSAL ${name}: production == model`, { todo: spec.pending }, cmp);
  else it(`AGREE    ${name}: production == model`, cmp);
}

before(async () => {
  plans = await import('../../src/billing/PlanRegistry.js');
  planStores = await import('../../src/billing/IPlanStore.js');
  stripe = await import('../../src/billing/stripe/StripeWebhookHandler.js');
});
beforeEach(async () => {
  plans.resetPlanStoreForTest();
  store = new planStores.MemoryPlanStore();
  await plans.setPlanStore(store);
  T = `sg01p3-${RUN}-${++n}`;
});

const PA = 'plan_activated';
const DF = 'downgraded_to_free';

// ─────────────────────────────────────────────────────────────────────────────

describe('P3 case 1: administrative courtesy vs cancellation of an older subscription (R2-D5, review MED-4)', () => {
  scenario('1a sub A STARTER, admin courtesy PRO, cancellation of A', {
    steps: () => [
      { op: 'grant', id: 'c1a_A', created: NOW() - 7200, sub: 'sub_A', tier: 'STARTER' },
      { op: 'admin', tier: 'PRO', intent: 'courtesy' },
      { op: 'cancel', id: 'c1a_xA', created: NOW() - 60, sub: 'sub_A' },
    ],
    current: { tier: 'FREE', actions: [PA, 'admin_PRO', DF] },
    proposal: { tier: 'PRO', outcomes: ['applied', 'courtesy_PRO', 'applied'] },
    pending: 'PENDING_HUMAN_POLICY R2-D5 (MED-4): cancelling the old subscription removes an unrelated courtesy grant (A2 rule "cancellation beats courtesy")',
  });

  scenario('1b admin courtesy PRO, later NEW subscription B STARTER', {
    steps: () => [
      { op: 'admin', tier: 'PRO', intent: 'courtesy' },
      { op: 'grant', id: 'c1b_B', created: NOW() + 3600, sub: 'sub_B', tier: 'STARTER' },
    ],
    current: { tier: 'STARTER', actions: ['admin_PRO', PA] },
    proposal: { tier: 'PRO', outcomes: ['courtesy_PRO', 'applied'] },
    pending: 'PENDING_HUMAN_POLICY R2-D5/R2-D7: a lower-tier paid grant overwrites a higher courtesy (single-tier row, "last grant wins")',
  });

  it('CURRENT  courtesy is distinguishable only while it is the last write; a later Stripe grant erases it (audit trail only)', async () => {
    const h = new stripe.StripeWebhookHandler();
    await plans.assignPlan(T, 'PRO', { actor: 'platform', source: 'admin_api' });
    const v = await store.getVersioned(T);
    let ord = await store.getPlanOrdering(T);
    assert.equal(ord.adminVersion, v.version);            // current tier was set by an admin decision
    assert.equal(ord.activeSubscriptionId, null);
    await h.handle(checkout('c1c_B', NOW() + 3600, 'sub_B', 'STARTER'));
    ord = await store.getPlanOrdering(T);
    assert.equal(ord.activeSubscriptionId, 'sub_B');
    assert.notEqual(ord.adminVersion, (await store.getVersioned(T)).version); // courtesy no longer represented in state
    const audit = await plans.listPlanAudit(T);
    assert.deepEqual(audit.map((a: any) => [a.toTier, a.source]), [['PRO', 'admin_api'], ['STARTER', 'stripe_webhook']]);
  });

  it('MODEL    courtesy and paid subscription coexist as distinct, listable sources', () => {
    const m = new EntitlementLedgerModel(SKEW_S);
    m.adminCourtesy('PRO');
    m.stripeGrant('m1c_B', NOW() + 3600, 'sub_B', 'STARTER');
    assert.deepEqual(m.activeSources(), [{ kind: 'courtesy', ref: 'courtesy-1', tier: 'PRO' }, { kind: 'stripe_subscription', ref: 'sub_B', tier: 'STARTER' }]);
    assert.equal(m.effectiveTier(), 'PRO');
  });
});

describe('P3 case 2: two simultaneous active subscriptions (R2-D7)', () => {
  scenario('2a A STARTER then B PRO (higher last)', {
    steps: () => [
      { op: 'grant', id: 'c2a_A', created: 100, sub: 'sub_A', tier: 'STARTER' },
      { op: 'grant', id: 'c2a_B', created: 200, sub: 'sub_B', tier: 'PRO' },
    ],
    current: { tier: 'PRO', actions: [PA, PA] },
    proposal: { tier: 'PRO', outcomes: ['applied', 'applied'] },
  });

  scenario('2b B PRO then A STARTER (lower last)', {
    steps: () => [
      { op: 'grant', id: 'c2b_B', created: 100, sub: 'sub_B', tier: 'PRO' },
      { op: 'grant', id: 'c2b_A', created: 200, sub: 'sub_A', tier: 'STARTER' },
    ],
    current: { tier: 'STARTER', actions: [PA, PA] },
    proposal: { tier: 'PRO', outcomes: ['applied', 'applied'] },
    pending: 'PENDING_HUMAN_POLICY R2-D7: the last grant becomes the active tier; a second, cheaper subscription lowers a still-paid PRO',
  });
});

describe('P3 case 3: cancel the lower-tier subscription (R2-D7, review INFO-2)', () => {
  scenario('3a A STARTER, B PRO, cancel A', {
    steps: () => [
      { op: 'grant', id: 'c3a_A', created: 100, sub: 'sub_A', tier: 'STARTER' },
      { op: 'grant', id: 'c3a_B', created: 200, sub: 'sub_B', tier: 'PRO' },
      { op: 'cancel', id: 'c3a_xA', created: 300, sub: 'sub_A' },
    ],
    current: { tier: 'PRO', actions: [PA, PA, 'other_subscription_ignored'] },
    proposal: { tier: 'PRO', outcomes: ['applied', 'applied', 'applied'] },
  });

  scenario('3b B PRO, A STARTER (A is the active one), cancel A', {
    steps: () => [
      { op: 'grant', id: 'c3b_B', created: 100, sub: 'sub_B', tier: 'PRO' },
      { op: 'grant', id: 'c3b_A', created: 200, sub: 'sub_A', tier: 'STARTER' },
      { op: 'cancel', id: 'c3b_xA', created: 300, sub: 'sub_A' },
    ],
    current: { tier: 'FREE', actions: [PA, PA, DF] },
    proposal: { tier: 'PRO', outcomes: ['applied', 'applied', 'applied'] },
    pending: 'PENDING_HUMAN_POLICY R2-D7 (INFO-2): cancelling the lower-tier subscription drops the tenant to FREE while sub_B (PRO) is still paid',
  });
});

describe('P3 case 4: cancel the higher-tier subscription (R2-D7)', () => {
  scenario('4a A STARTER, B PRO, cancel B', {
    steps: () => [
      { op: 'grant', id: 'c4a_A', created: 100, sub: 'sub_A', tier: 'STARTER' },
      { op: 'grant', id: 'c4a_B', created: 200, sub: 'sub_B', tier: 'PRO' },
      { op: 'cancel', id: 'c4a_xB', created: 300, sub: 'sub_B' },
    ],
    current: { tier: 'FREE', actions: [PA, PA, DF] },
    proposal: { tier: 'STARTER', outcomes: ['applied', 'applied', 'applied'] },
    pending: 'PENDING_HUMAN_POLICY R2-D7: cancelling PRO drops to FREE although sub_A (STARTER) is still paid',
  });

  scenario('4b B PRO, A STARTER (A active), cancel B', {
    steps: () => [
      { op: 'grant', id: 'c4b_B', created: 100, sub: 'sub_B', tier: 'PRO' },
      { op: 'grant', id: 'c4b_A', created: 200, sub: 'sub_A', tier: 'STARTER' },
      { op: 'cancel', id: 'c4b_xB', created: 300, sub: 'sub_B' },
    ],
    current: { tier: 'STARTER', actions: [PA, PA, 'other_subscription_ignored'] },
    proposal: { tier: 'STARTER', outcomes: ['applied', 'applied', 'applied'] },
  });
});

describe('P3 case 5: late payment event (R-07 kept; R2-D6 skew window, review INFO-1)', () => {
  scenario('5a admin restricts to FREE, late grant of an unknown subscription created BEFORE the decision', {
    steps: () => [
      { op: 'grant', id: 'c5a_A', created: NOW() - 7200, sub: 'sub_A', tier: 'STARTER' },
      { op: 'admin', tier: 'FREE', intent: 'restrict' },
      { op: 'grant', id: 'c5a_X', created: NOW() - 3600, sub: 'sub_X', tier: 'PRO' },
    ],
    current: { tier: 'FREE', actions: [PA, 'admin_FREE', 'admin_superseded_ignored'] },
    proposal: { tier: 'FREE', outcomes: ['applied', 'restrict_FREE', 'held_for_reconciliation'] },
  });

  scenario('5b R2-D6: NEW payment created 30 s AFTER the admin decision (inside the 60 s skew)', {
    steps: () => [
      { op: 'admin', tier: 'FREE', intent: 'restrict' },
      { op: 'grant', id: 'c5b_Y', created: NOW() + 30, sub: 'sub_Y', tier: 'PRO' },
    ],
    current: { tier: 'FREE', actions: ['admin_FREE', 'admin_superseded_ignored'] },
    proposal: { tier: 'FREE', outcomes: ['restrict_FREE', 'held_for_reconciliation'] },
  });

  scenario('5c NEW payment created well after the skew window', {
    steps: () => [
      { op: 'admin', tier: 'FREE', intent: 'restrict' },
      { op: 'grant', id: 'c5c_Z', created: NOW() + 600, sub: 'sub_Z', tier: 'PRO' },
    ],
    current: { tier: 'PRO', actions: ['admin_FREE', PA] },
    proposal: { tier: 'PRO', outcomes: ['restrict_FREE', 'applied'] },
  });

  scenario('5d older event of the SAME subscription delivered late', {
    steps: () => [
      { op: 'grant', id: 'c5d_new', created: 200, sub: 'sub_A', tier: 'STARTER' },
      { op: 'grant', id: 'c5d_old', created: 100, sub: 'sub_A', tier: 'PRO' },
    ],
    current: { tier: 'STARTER', actions: [PA, 'stale_ignored'] },
    proposal: { tier: 'STARTER', outcomes: ['applied', 'stale'] },
  });

  it('CURRENT  the R2-D6 payment is recorded (not lost) with skip_reason superseded_by_admin; no alert/metric beyond the counter', async () => {
    await runProduction([{ op: 'admin', tier: 'FREE', intent: 'restrict' }, { op: 'grant', id: 'c5e_Y', created: NOW() + 30, sub: 'sub_Y', tier: 'PRO' }]);
    const evs = await store.listStripeEvents(T);
    assert.deepEqual(evs.map((e: any) => [e.applied, e.skipReason, e.subscriptionId]), [[false, 'superseded_by_admin', 'sub_Y']]);
  });
});

describe('P3 case 6: duplicate payment event', () => {
  it('CURRENT  same event id delivered twice (and 5x concurrently): applied once, one audit row, version unchanged', async () => {
    const h = new stripe.StripeWebhookHandler();
    const ev = checkout('c6_A', 100, 'sub_A', 'PRO');
    assert.equal((await h.handle(ev)).action, PA);
    const v1 = (await store.getVersioned(T)).version;
    assert.equal((await h.handle(ev)).action, 'duplicate_ignored');
    const burst = await Promise.all(Array.from({ length: 5 }, () => h.handle(ev)));
    assert.deepEqual(burst.map((r: any) => r.action), Array(5).fill('duplicate_ignored'));
    assert.equal((await store.getVersioned(T)).version, v1);
    assert.equal((await plans.listPlanAudit(T)).length, 1);
    // duplicate cancellation is idempotent too
    const x = deleted('c6_xA', 200, 'sub_A');
    assert.equal((await h.handle(x)).action, DF);
    assert.equal((await h.handle(x)).action, 'duplicate_ignored');
    assert.equal((await plans.listPlanAudit(T)).length, 2);
  });

  it('MODEL    same event id is applied once', () => {
    const m = new EntitlementLedgerModel(SKEW_S);
    assert.equal(m.stripeGrant('m6', 100, 'sub_A', 'PRO'), 'applied');
    assert.equal(m.stripeGrant('m6', 100, 'sub_A', 'PRO'), 'duplicate');
    assert.equal(m.stripeCancel('m6x', 200, 'sub_A'), 'applied');
    assert.equal(m.stripeCancel('m6x', 200, 'sub_A'), 'duplicate');
    assert.equal(m.effectiveTier(), 'FREE');
  });
});

describe('P3 case 7: administrative downgrade', () => {
  scenario('7a sub A PRO, admin downgrades to STARTER, renewal-like event of A after the decision', {
    steps: () => [
      { op: 'grant', id: 'c7a_A', created: NOW() - 7200, sub: 'sub_A', tier: 'PRO' },
      { op: 'admin', tier: 'STARTER', intent: 'restrict' },
      { op: 'grant', id: 'c7a_A2', created: NOW() + 3600, sub: 'sub_A', tier: 'PRO' },
    ],
    current: { tier: 'STARTER', actions: [PA, 'admin_STARTER', 'admin_superseded_ignored'] },
    proposal: { tier: 'STARTER', outcomes: ['applied', 'restrict_STARTER', 'superseded_by_admin'] },
  });

  scenario('7b sub A PRO, admin downgrades to STARTER, then A (already revoked) is cancelled', {
    steps: () => [
      { op: 'grant', id: 'c7b_A', created: NOW() - 7200, sub: 'sub_A', tier: 'PRO' },
      { op: 'admin', tier: 'STARTER', intent: 'restrict' },
      { op: 'cancel', id: 'c7b_xA', created: NOW() + 20, sub: 'sub_A' },
    ],
    current: { tier: 'FREE', actions: [PA, 'admin_STARTER', DF] },
    proposal: { tier: 'STARTER', outcomes: ['applied', 'restrict_STARTER', 'applied'] },
    pending: 'PENDING_HUMAN_POLICY R2-D5 (MED-4 variant): cancelling a subscription the admin decision already revoked wipes the tier the admin set',
  });

  scenario('7c admin downgrades to FREE, NEW subscription B after the decision (control)', {
    steps: () => [
      { op: 'grant', id: 'c7c_A', created: NOW() - 7200, sub: 'sub_A', tier: 'PRO' },
      { op: 'admin', tier: 'FREE', intent: 'restrict' },
      { op: 'grant', id: 'c7c_B', created: NOW() + 3600, sub: 'sub_B', tier: 'PRO' },
    ],
    current: { tier: 'PRO', actions: [PA, 'admin_FREE', PA] },
    proposal: { tier: 'PRO', outcomes: ['applied', 'restrict_FREE', 'applied'] },
  });

  it('CURRENT  a tenant-role self-downgrade is the same administrative decision (revokes the paid subscription)', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('c7d_A', NOW() - 7200, 'sub_A', 'PRO'));
    await plans.assignPlan(T, 'STARTER', { actor: T, source: 'admin_api' });       // routes.ts actor = caller tenant
    const r = await h.handle(checkout('c7d_A2', NOW() + 3600, 'sub_A', 'PRO'));
    assert.equal(r.action, 'admin_superseded_ignored');
    assert.equal(await store.get(T), 'STARTER');
  });
});

describe('P3 case 8: refund / failed payment / unsupported state', () => {
  scenario('8a PRO via sub A, then charge.refunded, invoice.payment_failed, customer.subscription.updated(past_due), async_payment_failed', {
    steps: () => [
      { op: 'grant', id: 'c8_A', created: 100, sub: 'sub_A', tier: 'PRO' },
      { op: 'unsupported', id: 'c8_r', type: 'charge.refunded', created: 200, sub: 'sub_A' },
      { op: 'unsupported', id: 'c8_f', type: 'invoice.payment_failed', created: 210, sub: 'sub_A' },
      { op: 'unsupported', id: 'c8_u', type: 'customer.subscription.updated', created: 220, sub: 'sub_A' },
      { op: 'unsupported', id: 'c8_a', type: 'checkout.session.async_payment_failed', created: 230, sub: 'sub_A' },
    ],
    current: { tier: 'PRO', actions: [PA, 'ignored', 'ignored', 'ignored', 'ignored'] },
    proposal: { tier: 'PRO', outcomes: ['applied', ...Array(4).fill('recorded_unsupported_pending_policy')] },
  });

  it('PROPOSAL 8b unsupported events are recorded per tenant for reconciliation', {
    todo: 'PENDING_HUMAN_POLICY D1/D2 (refund and dunning policy): production acknowledges these events as "ignored" without any per-tenant record (only the stripe_webhook_events_total{type="other"} counter)',
  }, async () => {
    await runProduction([{ op: 'grant', id: 'c8b_A', created: 100, sub: 'sub_A', tier: 'PRO' }, { op: 'unsupported', id: 'c8b_r', type: 'charge.refunded', created: 200, sub: 'sub_A' }]);
    const evs = await store.listStripeEvents(T);
    assert.ok(evs.some((e: any) => e.type === 'charge.refunded'), 'refund recorded in the tenant ledger');
  });

  it('CURRENT  checkout with payment_status=unpaid never grants (awaiting_payment, nothing recorded)', async () => {
    const ev = checkout('c8c', 100, 'sub_A', 'PRO');
    ev.data.object.payment_status = 'unpaid';
    assert.equal((await new stripe.StripeWebhookHandler().handle(ev)).action, 'awaiting_payment');
    assert.equal(await store.get(T), null);
    assert.deepEqual(await store.listStripeEvents(T), []);
  });
});

describe('P3 case 9: store failure (PostgreSQL stand-in: in-memory store with failure injection)', () => {
  /** MemoryPlanStore whose next writes fail before, or AFTER committing (ambiguous outcome), or hang (timeout). */
  const failing = (): any => {
    const s: any = new planStores.MemoryPlanStore();
    s.mode = null as null | 'before' | 'after' | 'hang';
    const base = s.assign.bind(s);
    s.assign = async (tenant: string, tier: Tier, meta: unknown) => {
      const mode = s.mode; s.mode = null;
      if (mode === 'before') throw new Error('injected: connection terminated before COMMIT');
      if (mode === 'hang') return new Promise(() => { /* never settles: lock wait / network partition */ });
      const r = await base(tenant, tier, meta);
      if (mode === 'after') throw new Error('injected: connection lost after COMMIT');
      return r;
    };
    return s;
  };

  it('CURRENT  failure before commit: webhook answers retryable (503), nothing recorded; redelivery applies', async () => {
    const s = failing(); await plans.setPlanStore(s); store = s;
    const h = new stripe.StripeWebhookHandler();
    const ev = checkout('c9a', 100, 'sub_A', 'PRO');
    s.mode = 'before';
    const r = await h.handle(ev);
    assert.deepEqual([r.ok, r.action, r.retryable], [false, 'plan_store_unavailable', true]);
    assert.equal(await s.get(T), null);
    assert.deepEqual(await s.listStripeEvents(T), []);
    assert.equal((await h.handle(ev)).action, PA);
    assert.equal(await s.get(T), 'PRO');
  });

  it('CURRENT  failure AFTER commit (ambiguous): 503, Stripe redelivers, the redelivery is a duplicate; tier stays applied once', async () => {
    const s = failing(); await plans.setPlanStore(s); store = s;
    const h = new stripe.StripeWebhookHandler();
    const ev = checkout('c9b', 100, 'sub_A', 'PRO');
    s.mode = 'after';
    assert.equal((await h.handle(ev)).action, 'plan_store_unavailable');
    assert.equal(plans.getTenantPlan(T), 'FREE');           // local view keeps the LOWER tier until a fresh read
    assert.equal((await h.handle(ev)).action, 'duplicate_ignored');
    assert.equal(await plans.getTenantPlanAsync(T), 'PRO');  // the store is the truth
    assert.equal((await plans.listPlanAudit(T)).length, 1);
  });

  it('CURRENT  admin write that hangs: rejects with PlanStoreUnavailableError after OTK_PLAN_STORE_TIMEOUT_MS; local view = lower tier', async () => {
    const s = failing(); await plans.setPlanStore(s); store = s;
    await plans.assignPlan(T, 'PRO', { actor: 'platform', source: 'admin_api' });
    s.mode = 'hang';
    await assert.rejects(plans.assignPlan(T, 'STARTER', { actor: 'platform', source: 'admin_api' }), (e: any) => e.code === 'plan_store_unavailable');
    assert.equal(plans.getTenantPlan(T), 'STARTER');
    assert.equal(await s.get(T), 'PRO');                     // nothing committed: the next fresh read restores the truth
    assert.equal(await plans.getTenantPlanAsync(T), 'PRO');
  });

  it('MODEL    a failed transaction leaves the ledger unchanged (all-or-nothing)', () => {
    const m = new EntitlementLedgerModel(SKEW_S);
    m.stripeGrant('m9_A', 100, 'sub_A', 'STARTER');
    assert.throws(() => m.transact(() => { m.stripeGrant('m9_B', 200, 'sub_B', 'PRO'); throw new Error('injected'); }));
    assert.equal(m.effectiveTier(), 'STARTER');
    assert.equal(m.events.has('m9_B'), false);
    assert.equal(m.stripeGrant('m9_B', 200, 'sub_B', 'PRO'), 'applied');  // redelivery after recovery
    assert.equal(m.effectiveTier(), 'PRO');
  });
});

describe('P3 case 10: concurrent modification', () => {
  it('CURRENT  two admin writes with the same expectedVersion: exactly one wins, the other gets PlanVersionConflictError', async () => {
    await plans.assignPlan(T, 'STARTER', { actor: 'platform', source: 'admin_api' });
    const v = (await plans.getTenantPlanVersioned(T)).version;
    const rs = await Promise.allSettled([
      plans.assignPlan(T, 'PRO', { expectedVersion: v, actor: 'platform', source: 'admin_api' }),
      plans.assignPlan(T, 'FREE', { expectedVersion: v, actor: 'platform', source: 'admin_api' }),
    ]);
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
    const rej = rs.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rej.reason.code, 'plan_version_conflict');
    assert.equal((await plans.listPlanAudit(T)).length, 2);
  });

  it('CURRENT  cancellation of A and payment of B racing (both start orders, 10 rounds each): always PRO', async () => {
    for (let i = 0; i < 10; i++) {
      for (const order of ['cancelFirst', 'payFirst'] as const) {
        const t = `${T}-${order}-${i}`;
        const h = new stripe.StripeWebhookHandler();
        await h.handle(checkout(`c10a_${order}_${i}`, 100, 'sub_A', 'STARTER', t));
        const c = (): Promise<any> => h.handle(deleted(`c10x_${order}_${i}`, 500, 'sub_A', t));
        const p = (): Promise<any> => h.handle(checkout(`c10b_${order}_${i}`, 500, 'sub_B', 'PRO', t));
        await Promise.all(order === 'cancelFirst' ? [c(), p()] : [p(), c()]);
        assert.equal(await store.get(t), 'PRO', `${order} round ${i}`);
      }
    }
  });

  it('PROPOSAL concurrent courtesy and cancellation of the old subscription keep the courtesy in both orders', {
    todo: 'PENDING_HUMAN_POLICY R2-D5: production result depends on which write lands last (courtesy-first → FREE)',
  }, async () => {
    for (const order of ['courtesyFirst', 'cancelFirst'] as const) {
      const t = `${T}-${order}`;
      const h = new stripe.StripeWebhookHandler();
      await h.handle(checkout(`c10c_A_${order}`, NOW() - 7200, 'sub_A', 'STARTER', t));
      const adm = (): Promise<any> => plans.assignPlan(t, 'PRO', { actor: 'platform', source: 'admin_api' });
      const can = (): Promise<any> => h.handle(deleted(`c10c_x_${order}`, NOW() - 60, 'sub_A', t));
      await Promise.all(order === 'courtesyFirst' ? [adm(), can()] : [can(), adm()]);
      assert.equal(await store.get(t), 'PRO', `${order}: courtesy must survive the cancellation of sub_A`);
    }
  });

  it('MODEL    courtesy and cancellation commute (effective tier independent of order)', () => {
    for (const courtesyFirst of [true, false]) {
      const m = new EntitlementLedgerModel(SKEW_S);
      m.stripeGrant('m10_A', 100, 'sub_A', 'STARTER');
      if (courtesyFirst) { m.adminCourtesy('PRO'); m.stripeCancel('m10_x', 200, 'sub_A'); } else { m.stripeCancel('m10_x', 200, 'sub_A'); m.adminCourtesy('PRO'); }
      assert.equal(m.effectiveTier(), 'PRO');
    }
  });
});
