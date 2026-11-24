# ADR-0301 — Real Email Adapter Selection

**Status:** Accepted
**Date:** 2026-04-02
**Wave:** Wave 4 (W4-SMTP)
**Deciders:** Bruno (OTK)

---

## Context

Wave 3C introduced the `ConsoleEmailAdapter` — a development-only adapter that logs emails instead of sending them. Wave 4 requires a real email delivery adapter for:

- **E5.5 (GDPR notifications):** Send compliance export notifications to tenants.
- **P4.5 (Stripe receipts):** Send payment receipt emails after successful checkout.

A real adapter is required before these sub-waves can be fully tested or deployed.

## Decision

**Use SMTP via nodemailer** (`nodemailer ^6.x`).

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **SMTP / nodemailer** | Zero external SaaS dependency, self-hostable, works with any MTA (Postfix, AWS SES via SMTP, Gmail SMTP) | Requires an SMTP server in the environment |
| SendGrid API | Managed deliverability, webhooks, analytics | Vendor lock-in, external API dependency, additional env secret |
| Amazon SES API | Lowest cost at scale, AWS ecosystem | AWS-only, SDK overhead, forces AWS dependency |

## Rationale

1. **Simplest for dev/staging:** Any SMTP server works (Mailhog, Mailtrap, Gmail).
2. **Production-portable:** Production can use AWS SES, SendGrid, or any MTA via SMTP without code changes — only env vars change.
3. **No vendor lock-in:** SMTP is a universal protocol. Switching MTAs requires zero code changes.
4. **Pattern matches existing infra:** The project already uses provider-agnostic patterns (IEmailAdapter interface). SMTP is just another concrete implementation.

## Implementation

**File:** `src/email/SmtpEmailAdapter.ts`

**Interface:** Implements `IEmailAdapter.send(msg: EmailMessage): Promise<EmailResult>`

**Env vars:**
| Variable | Default | Description |
|----------|---------|-------------|
| `OTK_SMTP_HOST` | — | SMTP server hostname. **If not set, ConsoleEmailAdapter is used.** |
| `OTK_SMTP_PORT` | `587` | SMTP port (465 = TLS, 587 = STARTTLS) |
| `OTK_SMTP_USER` | — | Auth username (optional for relay-only setups) |
| `OTK_SMTP_PASS` | — | Auth password |
| `OTK_EMAIL_FROM` | `noreply@otk.io` | Default From address |

**Bootstrap wiring** (`src/infra/storeBootstrap.ts`):
```
if OTK_SMTP_HOST set  → SmtpEmailAdapter   (result.stores['email'] = 'smtp')
else                  → ConsoleEmailAdapter (result.stores['email'] = 'console')
```

**Nodemailer transport is lazily loaded** (dynamic import on first `send()` call). This means:
- The module can be imported without nodemailer being present (factory returns adapter object).
- If nodemailer is not installed, `send()` returns `{ ok: false, error: 'nodemailer not available: ...' }`.

## Consequences

**Positive:**
- Real emails can be sent in staging/production by setting `OTK_SMTP_HOST`.
- ConsoleEmailAdapter remains the default for dev/test (no env vars needed).
- E5.5 and P4.5 can now be fully implemented and tested.

**Negative:**
- Production deployments need an SMTP server or relay configured.
- `OTK_SMTP_PASS` is a sensitive credential — must be stored in SecretsManager or Kubernetes Secret, never in `.env` committed to git.

## Future

If transactional email volume grows, evaluate migrating to SendGrid or AWS SES API (not SMTP relay) via a new `SendGridEmailAdapter` or `SesEmailAdapter` implementing the same `IEmailAdapter` interface. No code changes required outside the adapter and bootstrap wiring.
