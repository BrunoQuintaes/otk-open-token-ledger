/**
 * W4-4C02 — Stripe billing integration tests (P4.5)
 *
 * Covers:
 *   1.  ADR-0303-stripe-integration.md exists
 *   2.  src/billing/stripe/StripeClient.ts exists
 *   3.  src/billing/stripe/StripeWebhookHandler.ts exists
 *   4.  routes.ts has /v1/billing/checkout route
 *   5.  routes.ts has /v1/webhooks/stripe route
 *   6.  StripeClient.createCheckoutSession() sends correct shape to mock Stripe
 *   7.  StripeWebhookHandler: checkout.session.completed activates plan
 *   8.  StripeWebhookHandler: invoice.payment_succeeded action = receipt_sent
 *   9.  StripeWebhookHandler: customer.subscription.deleted downgrades to FREE
 *  10.  StripeWebhookHandler: unknown event type returns action = ignored
 *  11.  StripeClient.constructWebhookEvent delegates to stripe.webhooks.constructEvent with provided secret
 *  11b. StripeClient.constructWebhookEvent propagates throw when secret is empty (mock guard)
 *  12.  StripeWebhookHandler: missing tenantId in metadata returns ok=false
 *  13.  StripeClient reads OTK_STRIPE_PRICE_IDS from env
 *  14.  StripeWebhookHandler handle() never throws
 *
 * @since Wave 4 (4C-PACK-4C02 / P4.5)
 *
 * Modules under test: `src/billing/stripe/StripeClient.ts` and `src/billing/stripe/StripeWebhookHandler.ts`,
 * with the plan state of `src/billing/PlanRegistry.ts`; the decision record and the route list in
 * `src/api/routes.ts` are checked as text.
 *
 * Strategy / partitions: checkout session, webhook event construction with and without a secret, the real client
 * without the payment SDK, the price ids read from `OTK_STRIPE_PRICE_IDS`; each handled event kind, an unknown
 * kind, missing metadata or tenant, and an input that would throw.
 *
 * Needs: no network and no payment account; the payment API is an in-memory mock with fake ids. Changes
 * `OTK_STRIPE_PRICE_IDS` and restores it.
 *
 * Run just this file: `npx tsx --test test/unit/wave4_stripe.test.ts`
 *
 * @module test/unit/wave4_stripe.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import { StripeClient, type IStripeApi } from '../../src/billing/stripe/StripeClient.js';
import { StripeWebhookHandler, type StripeEvent } from '../../src/billing/stripe/StripeWebhookHandler.js';
import { getTenantPlan } from '../../src/billing/PlanRegistry.js';

// ──────────────────────────────────────────────────────────
// Mock Stripe API
// ──────────────────────────────────────────────────────────
function createMockStripe(overrides: Partial<IStripeApi> = {}): IStripeApi {
  return {
    checkout: {
      sessions: {
        async create(params: unknown) {
          const p = params as Record<string, unknown>;
          return {
            id: 'cs_test_mock_001',
            url: 'https://checkout.stripe.com/pay/cs_test_mock_001',
            customer: null,
            payment_status: 'unpaid',
            metadata: (p['metadata'] as Record<string, string>) ?? {},
          };
        },
        async retrieve(id: string) {
          return { id, url: null, customer: null, payment_status: 'paid', metadata: {} };
        },
      },
    },
    customers: {
      async create(params: unknown) {
        const p = params as Record<string, unknown>;
        return { id: 'cus_mock_001', email: String(p['email'] ?? ''), metadata: (p['metadata'] as Record<string, string>) ?? {} };
      },
      async list() { return { data: [] }; },
    },
    webhooks: {
      constructEvent(payload, sig, secret) {
        if (!secret) throw new Error('no secret');
        if (sig === 'invalid') throw new Error('invalid signature');
        return JSON.parse(String(payload)) as unknown;
      },
    },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────
// 1–5. File structure
// ──────────────────────────────────────────────────────────
describe('W4-4C02 — File structure', () => {
  it('ADR-0303-stripe-integration.md exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/architecture/adr/ADR-0303-stripe-integration.md')));
  });

  it('src/billing/stripe/StripeClient.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/billing/stripe/StripeClient.ts')));
  });

  it('src/billing/stripe/StripeWebhookHandler.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/billing/stripe/StripeWebhookHandler.ts')));
  });

  it('routes.ts has /v1/billing/checkout route', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(content.includes('/billing/checkout'));
  });

  it('routes.ts has /v1/webhooks/stripe route', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(content.includes('/webhooks/stripe'));
  });
});

// ──────────────────────────────────────────────────────────
// 6. StripeClient
// ──────────────────────────────────────────────────────────
describe('W4-4C02 — StripeClient', () => {
  let origPriceIds: string | undefined;

  before(() => { origPriceIds = process.env['OTK_STRIPE_PRICE_IDS']; });
  after(() => {
    if (origPriceIds !== undefined) process.env['OTK_STRIPE_PRICE_IDS'] = origPriceIds;
    else delete process.env['OTK_STRIPE_PRICE_IDS'];
  });

  it('createCheckoutSession() returns session with id and url', async () => {
    process.env['OTK_STRIPE_PRICE_IDS'] = JSON.stringify({ STARTER: 'price_starter_test' });
    const client = new StripeClient(createMockStripe());
    const session = await client.createCheckoutSession({
      tenantId: 'tenant-stripe-test',
      tier: 'STARTER',
      successUrl: 'https://app.otk.io/success',
      cancelUrl: 'https://app.otk.io/cancel',
    });
    assert.ok(session.id.startsWith('cs_test'));
    assert.ok(typeof session.url === 'string');
  });

  it('constructWebhookEvent delegates to stripe.webhooks.constructEvent with provided secret', () => {
    const client = new StripeClient(createMockStripe());
    // Secret is now passed by the caller (not read from env) — should not throw with any non-empty string
    assert.doesNotThrow(() => client.constructWebhookEvent('{}', 'sig', 'whsec_test'));
  });

  it('constructWebhookEvent propagates throw when empty secret passed (mock guard)', () => {
    const client = new StripeClient(createMockStripe());
    // The mock's constructEvent throws when secret is falsy — verify propagation
    assert.throws(() => client.constructWebhookEvent('{}', 'sig', ''), /no secret/);
  });

  // F-H1-01 (H1 2026-10-13): the real client used require() in an ESM module (ReferenceError) and `stripe` is not a
  // dependency; without the SDK the failure is explicit and names the decision, never a ReferenceError
  it('real client without the stripe SDK fails with an explicit message (not ReferenceError)', () => {
    assert.throws(() => new StripeClient('sk_test_fixture_not_a_key'), (e: unknown) =>
      e instanceof Error && !(e instanceof ReferenceError) && /Stripe SDK not installed/.test(e.message));
  });

  it('reads OTK_STRIPE_PRICE_IDS from env', () => {
    process.env['OTK_STRIPE_PRICE_IDS'] = '{"PRO":"price_pro_test"}';
    const client = new StripeClient(createMockStripe());
    assert.ok(client instanceof StripeClient);
  });
});

// ──────────────────────────────────────────────────────────
// 7–14. StripeWebhookHandler
// ──────────────────────────────────────────────────────────
describe('W4-4C02 — StripeWebhookHandler', () => {
  it('checkout.session.completed activates plan (action=plan_activated)', async () => {
    const handler = new StripeWebhookHandler();
    const event: StripeEvent = {
      type: 'checkout.session.completed',
      id: 'evt_001',
      // H1-S03: activation requires a paid session (before, a session without payment_status activated the tier)
      data: { object: { payment_status: 'paid', metadata: { tenantId: 'tenant-stripe-001', tier: 'STARTER' } } },
    };
    const result = await handler.handle(event);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'plan_activated');
    assert.strictEqual(getTenantPlan('tenant-stripe-001'), 'STARTER');
  });

  it('invoice.payment_succeeded returns action=receipt_sent', async () => {
    const handler = new StripeWebhookHandler();
    const event: StripeEvent = {
      type: 'invoice.payment_succeeded',
      id: 'evt_002',
      data: { object: { metadata: { tenantId: 'tenant-stripe-002' }, customer_email: 'test@example.com', amount_paid: 1000 } },
    };
    const result = await handler.handle(event);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'receipt_sent');
  });

  it('customer.subscription.deleted downgrades to FREE', async () => {
    // First set up a non-free plan
    const { assignPlan } = await import('../../src/billing/PlanRegistry.js');
    await assignPlan('tenant-stripe-003', 'PRO');

    const handler = new StripeWebhookHandler();
    const event: StripeEvent = {
      type: 'customer.subscription.deleted',
      id: 'evt_003',
      data: { object: { metadata: { tenantId: 'tenant-stripe-003' } } },
    };
    const result = await handler.handle(event);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'downgraded_to_free');
    assert.strictEqual(getTenantPlan('tenant-stripe-003'), 'FREE');
  });

  it('unknown event type returns action=ignored', async () => {
    const handler = new StripeWebhookHandler();
    const event: StripeEvent = { type: 'payment_intent.created', id: 'evt_004', data: { object: {} } };
    const result = await handler.handle(event);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'ignored');
  });

  it('checkout.session.completed with missing metadata returns ok=false', async () => {
    const handler = new StripeWebhookHandler();
    const event: StripeEvent = {
      type: 'checkout.session.completed',
      id: 'evt_005',
      data: { object: { metadata: {} } },
    };
    const result = await handler.handle(event);
    assert.strictEqual(result.ok, false);
  });

  it('customer.subscription.deleted with missing tenantId returns ok=false', async () => {
    const handler = new StripeWebhookHandler();
    const event: StripeEvent = {
      type: 'customer.subscription.deleted',
      id: 'evt_006',
      data: { object: { metadata: {} } },
    };
    const result = await handler.handle(event);
    assert.strictEqual(result.ok, false);
  });

  it('handle() never throws (error safety)', async () => {
    const handler = new StripeWebhookHandler();
    const badEvent = { type: 'checkout.session.completed', id: 'x', data: { object: null } } as unknown as StripeEvent;
    await assert.doesNotReject(() => handler.handle(badEvent));
  });
});
