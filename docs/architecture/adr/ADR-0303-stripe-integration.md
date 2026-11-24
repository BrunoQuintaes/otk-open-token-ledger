# ADR-0303 — Stripe Integration Pattern

**Date:** 2026-04-02
**Status:** Accepted
**Scope:** Commercial billing infrastructure (Wave 4C, P4.5)

---

## Decision

Integrate Stripe as the payment processor for OTK subscription billing (FREE → STARTER/PRO upgrades).

**Chosen approach:** Thin wrapper (`StripeClient.ts`) around the official `stripe` Node.js SDK, with a separate webhook handler (`StripeWebhookHandler.ts`) for event processing.

---

## Context

OTK needs commercial billing to support the STARTER and PRO plan tiers. Options considered:

| Option | Pros | Cons |
|--------|------|------|
| **Stripe SDK** | Market standard, excellent Node.js support, test mode, webhook verification | External dependency, PCI scope |
| Paddle | Simpler tax handling | Less common, smaller ecosystem |
| Manual invoicing | Zero dependency | Not scalable, no automation |

Stripe is the industry standard for B2B SaaS and integrates directly with the existing PlanRegistry tiers.

---

## Implementation

### New files
| File | Purpose |
|------|---------|
| `src/billing/stripe/StripeClient.ts` | Thin wrapper — createCheckoutSession, createCustomer |
| `src/billing/stripe/StripeWebhookHandler.ts` | Event dispatcher for checkout/invoice/subscription events |
| `src/api/routes.ts` (edit) | POST /v1/billing/checkout + POST /v1/webhooks/stripe |

### Env vars
| Var | Default | Purpose |
|-----|---------|---------|
| `OTK_STRIPE_SECRET_KEY` | — | Stripe API secret key (test: `sk_test_...`) |
| `OTK_STRIPE_WEBHOOK_SECRET` | — | Webhook endpoint signing secret |
| `OTK_STRIPE_PRICE_IDS` | — | JSON map: `{"STARTER":"price_xxx","PRO":"price_yyy"}` |

### Webhook events handled
- `checkout.session.completed` → activate subscription, upgrade plan
- `invoice.payment_succeeded` → renew plan, send receipt email
- `customer.subscription.deleted` → downgrade to FREE

### Security
- Raw request body required for `stripe.webhooks.constructEvent()` signature verification
- Webhook route bypasses JSON body parser (uses raw body)
- Invalid signatures return 403 (never 200)

---

## Consequences

- **Positive:** Automated billing, subscription management, payment receipts
- **Positive:** Test mode allows full integration testing without real money
- **Negative:** Stripe dependency (mitigated: only imported when `OTK_STRIPE_SECRET_KEY` set)
- **Negative:** PCI compliance scope (mitigated: no card data stored — Stripe handles it)

---

## Test strategy

- Mock Stripe SDK for unit tests (inject mock client via constructor)
- Use Stripe test mode keys for integration testing
- Webhook tests use `stripe.webhooks.constructEvent()` with test payloads
