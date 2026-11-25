/**
 * Secrets Bootstrap — one-time secret resolution at startup (AUD-005)
 *
 * Reads credential env vars (OTK_ADMIN_KEY, OTK_JWT_SECRET) once at startup,
 * registers them in SecretsManager, and exposes sync cached getters.
 *
 * Rule: API/route modules MUST NOT read process.env for secrets directly.
 * They use the sync getters exported here instead.
 *
 * Call bootstrapSecrets() once from server.ts before starting the HTTP server.
 *
 * Full list of variables read (names only): `OTK_ADMIN_KEY`, `OTK_JWT_SECRET`, `OTK_STRIPE_SECRET_KEY`,
 * `OTK_STRIPE_WEBHOOK_SECRET`, `OTK_VAULT_MASTER_KEY`, `OTK_V3_OPERATOR_KEY`, `OTK_V3_SUBMITTER_KEY`,
 * `OTK_STRIPE_PRICE_IDS`, `OTK_METRICS_TOKEN` and `OTK_GDPR_NOTIFY_EMAIL`. Only the names of loaded secrets are
 * logged, never their values. Every getter falls back to the environment variable when bootstrap has not run.
 *
 * @module src/infra/secretsBootstrap
 * @since Wave 3 audit fix (AUD-005)
 */

import { getSecretsProvider } from '../security/SecretsManager.js';
import { getLogger } from './logging/StructuredLogger.js';

let _adminKey: string | undefined;
let _jwtSecret: string | undefined;
let _stripeSecretKey: string | undefined;
let _stripeWebhookSecret: string | undefined;
let _vaultMasterKey: string | undefined;
let _stripePriceIds: string | undefined;
let _v3OperatorKey: string | undefined;
let _v3SubmitterKey: string | undefined;
let _metricsToken: string | undefined;
let _bootstrapped = false;

/**
 * Read credential env vars, register in SecretsManager, cache for sync access.
 * Safe to call multiple times — only runs once.
 *
 * @throws {Error} When the secrets provider rejects a `setSecret` call (bootstrap then stays incomplete).
 */
export async function bootstrapSecrets(): Promise<void> {
  if (_bootstrapped) return;
  const log = getLogger();
  const provider = getSecretsProvider();

  // OTK_ADMIN_KEY — legacy admin authentication
  const adminKey = process.env['OTK_ADMIN_KEY'];
  if (adminKey) {
    await provider.setSecret('ADMIN_KEY', adminKey);
    _adminKey = adminKey;
    log.info('secret loaded', { key: 'ADMIN_KEY', source: 'env' });
  }

  // OTK_JWT_SECRET — JWT signing key
  const jwtSecret = process.env['OTK_JWT_SECRET'];
  if (jwtSecret) {
    await provider.setSecret('JWT_SECRET', jwtSecret);
    _jwtSecret = jwtSecret;
    log.info('secret loaded', { key: 'JWT_SECRET', source: 'env' });
  }

  // OTK_STRIPE_SECRET_KEY — Stripe API secret
  const stripeKey = process.env['OTK_STRIPE_SECRET_KEY'];
  if (stripeKey) {
    await provider.setSecret('STRIPE_SECRET_KEY', stripeKey);
    _stripeSecretKey = stripeKey;
    log.info('secret loaded', { key: 'STRIPE_SECRET_KEY', source: 'env' });
  }

  // OTK_STRIPE_WEBHOOK_SECRET — Stripe webhook signing secret
  const stripeWebhook = process.env['OTK_STRIPE_WEBHOOK_SECRET'];
  if (stripeWebhook) {
    await provider.setSecret('STRIPE_WEBHOOK_SECRET', stripeWebhook);
    _stripeWebhookSecret = stripeWebhook;
    log.info('secret loaded', { key: 'STRIPE_WEBHOOK_SECRET', source: 'env' });
  }

  // OTK_VAULT_MASTER_KEY — AES-256-GCM master key for ProviderKeyVault
  const vaultKey = process.env['OTK_VAULT_MASTER_KEY'];
  if (vaultKey) {
    await provider.setSecret('VAULT_MASTER_KEY', vaultKey);
    _vaultMasterKey = vaultKey;
    log.info('secret loaded', { key: 'VAULT_MASTER_KEY', source: 'env' });
  }

  // D1–D8 / S4: OTK_V3_OPERATOR_KEY signs v3 receipts/conferences/authorizations; OTK_V3_SUBMITTER_KEY
  // pays the on-chain submission. Separate keys; values never logged (only that they were loaded).
  const v3op = process.env['OTK_V3_OPERATOR_KEY'];
  if (v3op) { await provider.setSecret('V3_OPERATOR_KEY', v3op); _v3OperatorKey = v3op; log.info('secret loaded', { key: 'V3_OPERATOR_KEY', source: 'env' }); }
  const v3sub = process.env['OTK_V3_SUBMITTER_KEY'];
  if (v3sub) { await provider.setSecret('V3_SUBMITTER_KEY', v3sub); _v3SubmitterKey = v3sub; log.info('secret loaded', { key: 'V3_SUBMITTER_KEY', source: 'env' }); }

  // OTK_STRIPE_PRICE_IDS — JSON map of PlanTier → Stripe price ID (config, not secret)
  _stripePriceIds = process.env['OTK_STRIPE_PRICE_IDS'];

  // STOPGATE-01 P1.2: OTK_METRICS_TOKEN — bearer of the metrics scraper in deployed environments (opens /metrics only)
  _metricsToken = process.env['OTK_METRICS_TOKEN'] || undefined;

  _bootstrapped = true;
}

/**
 * Sync getter — returns cached admin key.
 * Falls back to process.env for backward compat in tests where bootstrap wasn't called.
 * At runtime, bootstrapSecrets() is always called first so the cache is populated.
 *
 * @returns The admin key, or undefined when not configured.
 */
export function getAdminKey(): string | undefined {
  return _adminKey ?? process.env['OTK_ADMIN_KEY'];
}

/**
 * Sync getter — returns cached JWT secret.
 * Falls back to process.env for backward compat in tests where bootstrap wasn't called.
 *
 * @returns The JWT signing secret, or undefined when not configured.
 */
export function getCachedJwtSecret(): string | undefined {
  return _jwtSecret ?? process.env['OTK_JWT_SECRET'];
}

/**
 * Sync getter — returns cached Stripe secret key.
 * Falls back to process.env for backward compat in tests where bootstrap wasn't called.
 *
 * @returns The Stripe secret key, or undefined when not configured.
 */
export function getStripeSecretKey(): string | undefined {
  return _stripeSecretKey ?? process.env['OTK_STRIPE_SECRET_KEY'];
}

/**
 * Sync getter — returns cached Stripe webhook signing secret.
 * Falls back to process.env for backward compat in tests where bootstrap wasn't called.
 *
 * @returns The Stripe webhook signing secret, or undefined when not configured.
 */
export function getStripeWebhookSecret(): string | undefined {
  return _stripeWebhookSecret ?? process.env['OTK_STRIPE_WEBHOOK_SECRET'];
}

/**
 * Sync getter — returns cached vault master key.
 * Falls back to process.env for backward compat in tests where bootstrap wasn't called.
 *
 * @returns The vault master key, or undefined when not configured.
 */
export function getVaultMasterKey(): string | undefined {
  return _vaultMasterKey ?? process.env['OTK_VAULT_MASTER_KEY'];
}

/**
 * Sync getter — returns cached Stripe price IDs JSON string.
 * Falls back to process.env for backward compat in tests where bootstrap wasn't called.
 *
 * @returns The JSON text of the tier-to-price map, or undefined.
 */
export function getStripePriceIds(): string | undefined {
  return _stripePriceIds ?? process.env['OTK_STRIPE_PRICE_IDS'];
}

/**
 * D1–D8 v3 operator signing key (receipts, conferences, public authorizations).
 *
 * @returns The key, or undefined when not configured.
 */
export function getV3OperatorKey(): string | undefined {
  return _v3OperatorKey ?? process.env['OTK_V3_OPERATOR_KEY'];
}

/**
 * D1–D8 v3 on-chain submitter key (pays gas; distinct from the operator key).
 *
 * @returns The key, or undefined when not configured.
 */
export function getV3SubmitterKey(): string | undefined {
  return _v3SubmitterKey ?? process.env['OTK_V3_SUBMITTER_KEY'];
}

/**
 * STOPGATE-01 P1.2: metrics scraper bearer (deployed environments). Empty value = not configured.
 *
 * @returns The token, or undefined.
 */
export function getMetricsToken(): string | undefined {
  return _metricsToken ?? (process.env['OTK_METRICS_TOKEN'] || undefined);
}

/**
 * STOPGATE-01 P1.4 (S23-F04): recipient of the GDPR export notification (config, not a secret). Unset = no
 * notification (it used to go to a fixed external address).
 *
 * @returns The trimmed address, or undefined when unset or blank.
 */
export function getGdprNotifyEmail(): string | undefined {
  const v = (process.env['OTK_GDPR_NOTIFY_EMAIL'] ?? '').trim();
  return v || undefined;
}

/** Reset for testing. */
export function resetSecretsForTest(): void {
  _metricsToken = undefined;
  _adminKey = undefined;
  _jwtSecret = undefined;
  _stripeSecretKey = undefined;
  _stripeWebhookSecret = undefined;
  _vaultMasterKey = undefined;
  _stripePriceIds = undefined;
  _v3OperatorKey = undefined;
  _v3SubmitterKey = undefined;
  _bootstrapped = false;
}
