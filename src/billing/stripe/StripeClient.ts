/**
 * StripeClient — Thin wrapper around Stripe SDK for OTK billing (P4.5)
 *
 * Provides:
 *   - createCheckoutSession(): creates a Stripe Checkout session for plan upgrade
 *   - createCustomer(): creates/finds Stripe customer by tenantId
 *   - getCheckoutSession(): retrieve session for verification
 *
 * Uses the official `stripe` Node.js SDK.
 * Only instantiate when OTK_STRIPE_SECRET_KEY is set.
 *
 * Testing: pass a mock Stripe client via constructor for unit tests.
 *
 * @module billing/stripe/StripeClient
 * @since Wave 4 (4C-PACK-4C02 / P4.5)
 */

import { createRequire } from 'node:module';
import type { PlanTier } from '../PlanRegistry.js';
import { getStripePriceIds } from '../../infra/secretsBootstrap.js';

// ──────────────────────────────────────────────────────────
// Minimal Stripe API surface (subset we use)
// ──────────────────────────────────────────────────────────

export interface IStripeCheckoutSession {
  id: string;
  url: string | null;
  customer: string | null;
  payment_status: string;
  metadata: Record<string, string>;
}

export interface IStripeCustomer {
  id: string;
  email: string | null;
  metadata: Record<string, string>;
}

/** Minimal Stripe client interface (injectable for testing) */
export interface IStripeApi {
  checkout: {
    sessions: {
      create(params: unknown): Promise<IStripeCheckoutSession>;
      retrieve(id: string): Promise<IStripeCheckoutSession>;
    };
  };
  customers: {
    create(params: unknown): Promise<IStripeCustomer>;
    list(params: unknown): Promise<{ data: IStripeCustomer[] }>;
  };
  webhooks: {
    constructEvent(payload: string | Buffer, sig: string, secret: string): unknown;
  };
}

// ──────────────────────────────────────────────────────────
// StripeClient
// ──────────────────────────────────────────────────────────

export interface CheckoutSessionParams {
  tenantId: string;
  tier: PlanTier;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}

export class StripeClient {
  private _stripe: IStripeApi;
  private readonly _priceIds: Record<string, string>;

  /**
   * @param stripeOrKey - Either a mock IStripeApi (for tests) or the Stripe secret key string.
   *   Pass the key from getStripeSecretKey() in secretsBootstrap, not from process.env directly.
   * @param priceIds - Optional map of PlanTier → Stripe price ID. When omitted, falls back to
   *   OTK_STRIPE_PRICE_IDS env var (backward compat). Callers should prefer explicit injection.
   */
  constructor(stripeOrKey?: IStripeApi | string, priceIds?: Record<string, string>) {
    if (stripeOrKey && typeof stripeOrKey === 'object') {
      // Test injection: IStripeApi mock passed directly
      this._stripe = stripeOrKey;
    } else {
      // Real Stripe SDK: key must be provided by caller (not read from env here)
      const key = typeof stripeOrKey === 'string' ? stripeOrKey : undefined;
      if (!key) throw new Error('StripeClient requires a secret key — use getStripeSecretKey() from secretsBootstrap');
      // F-H1-01 (H1 2026-10-13): this module is ESM, where a bare require() is a ReferenceError, and `stripe` is not a
      // dependency of the project; the real client therefore never worked. createRequire loads it when installed and
      // fails with an explicit message otherwise (activating real billing is decision D2: install `stripe` then).
      let Stripe: new (k: string, o: { apiVersion: string }) => IStripeApi;
      try {
        Stripe = createRequire(import.meta.url)('stripe');
      } catch {
        throw new Error('Stripe SDK not installed: add the `stripe` package to enable real billing (decision D2)');
      }
      this._stripe = new Stripe(key, { apiVersion: '2024-06-20' });
    }

    if (priceIds) {
      this._priceIds = priceIds;
    } else {
      const priceEnv = getStripePriceIds() ?? '{}';
      try {
        this._priceIds = JSON.parse(priceEnv) as Record<string, string>;
      } catch {
        this._priceIds = {};
      }
    }
  }

  /**
   * Create a Stripe Checkout session for plan upgrade.
   * Returns the session URL to redirect the user to.
   */
  async createCheckoutSession(params: CheckoutSessionParams): Promise<IStripeCheckoutSession> {
    const priceId = this._priceIds[params.tier];
    if (!priceId) throw new Error(`No Stripe price ID configured for tier ${params.tier}`);

    return this._stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      customer_email: params.customerEmail,
      metadata: { tenantId: params.tenantId, tier: params.tier },
      // H1 R-02 (adversarial review): customer.subscription.deleted carries the SUBSCRIPTION object, whose metadata is
      // set here; without it a cancellation had no tenantId (200 missing_tenant_id) and the paid tier stayed forever
      subscription_data: { metadata: { tenantId: params.tenantId, tier: params.tier } },
    });
  }

  /** Create or find an existing Stripe customer for a tenantId. */
  async createCustomer(tenantId: string, email?: string): Promise<IStripeCustomer> {
    // Check if customer already exists
    const existing = await this._stripe.customers.list({ metadata: { tenantId }, limit: 1 });
    if (existing.data.length > 0) return existing.data[0];

    return this._stripe.customers.create({
      email,
      metadata: { tenantId },
    });
  }

  /**
   * Verify and parse a webhook event. Throws on invalid signature.
   * @param webhookSecret - Pass from getStripeWebhookSecret() in secretsBootstrap.
   */
  constructWebhookEvent(payload: string | Buffer, sig: string, webhookSecret: string): unknown {
    return this._stripe.webhooks.constructEvent(payload, sig, webhookSecret);
  }

  /** Retrieve a checkout session by ID. */
  async getCheckoutSession(sessionId: string): Promise<IStripeCheckoutSession> {
    return this._stripe.checkout.sessions.retrieve(sessionId);
  }
}
