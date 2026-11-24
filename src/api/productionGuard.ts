/**
 * PF-NEW-03 (POST-FREEZE review; decision D2 of the author, RUN-S 2026-10-09): a deployment labelled production must
 * not run with authentication silently disabled. With OTK_TENANTS empty the registry is empty and every route that
 * checks `isAuthEnabled()` is open; without OTK_ADMIN_KEY the legacy admin routes are open and no platform credential
 * exists. Development and test keep the permissive A0 mode by design.
 *
 * Secrets are read only through the existing boundaries (tenant registry, secretsBootstrap); values are never logged.
 */
import { isAuthEnabled } from './tenantKeyRegistry.js';
import { getAdminKey } from '../infra/secretsBootstrap.js';
import { isDeployedEnv } from '../infra/deployEnv.js';

/**
 * Deployed environments fail closed. Staging counts: the Helm staging values expose it through a public ingress, so
 * it is not a private development setup. RV-RUNS-05 (RUN-S review): the check is not an exact-string match; every
 * value except development / dev / test (case and surrounding spaces ignored) is deployed, so "Production", "prod",
 * "live" or "qa" no longer reopen the auth-disabled mode. An unset NODE_ENV keeps the permissive A0 mode (Node
 * convention for local runs and tests; documented limitation).
 */
export function isProductionEnv(): boolean {
  return isDeployedEnv();
}

/** Minimum length of the platform credential in deployed environments (ADV-M24-18). */
export const ADMIN_KEY_MIN_LENGTH = 32;
/** Values published with the demo dashboard and the seed script; never acceptable outside development. */
export const KNOWN_PUBLIC_ADMIN_KEYS: ReadonlySet<string> = new Set(['demo-otk-2026']);

/** Configuration problems that make a production or staging start unsafe (empty elsewhere). */
export function productionAuthProblems(): string[] {
  if (!isProductionEnv()) return [];
  const problems: string[] = [];
  if (!isAuthEnabled()) problems.push('OTK_TENANTS is empty: authentication would be disabled');
  const adminKey = getAdminKey();
  if (!adminKey) problems.push('OTK_ADMIN_KEY is missing: no platform credential, legacy admin routes would be open');
  // ADV-M24-18 / RV2-RUNS-05 (RUN-M1-24H): the platform credential separates tenant roles from the platform in every
  // platform-only route; the demo value shipped with the dashboard and seed script, or a short key, is refused
  else if (KNOWN_PUBLIC_ADMIN_KEYS.has(adminKey)) problems.push('OTK_ADMIN_KEY is a public demo value: choose a random key of at least 32 characters');
  else if (adminKey.length < ADMIN_KEY_MIN_LENGTH) problems.push(`OTK_ADMIN_KEY is shorter than ${ADMIN_KEY_MIN_LENGTH} characters`);
  return problems;
}

/** Routes that stay reachable in production A0 so orchestrators can still see the process (no data). */
export const PRODUCTION_A0_OPEN_ROUTES: ReadonlySet<string> = new Set(['/health', '/healthz', '/readyz', '/version']);
