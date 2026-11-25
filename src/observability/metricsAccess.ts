/**
 * Metrics access rule (STOPGATE-01 P1.2, finding R2-D8 / review LOW-4 of the H1 final closure run).
 *
 * Before: GET /metrics, /metrics?format=json and /metrics/prover answered anyone. The counters carry no key, tenant or
 * user identifier (H1R2 C5 / LOW-4), but they still describe the deployment to an outsider: request and error rates,
 * credential-store outages (fail-closed counters), revocation activity, proof pipeline and queue state.
 *
 * Rule:
 *   - local / test environments (infra/deployEnv: NODE_ENV unset, development, dev, test): open, as before;
 *   - deployed environments: the scraper presents `Authorization: Bearer <OTK_METRICS_TOKEN>` (Prometheus
 *     `authorization` / `bearer_token` scrape option), or the platform operator presents OTK_ADMIN_KEY in x-admin-key.
 *     Without OTK_METRICS_TOKEN configured only the platform operator can read them (fail closed). Comparisons are
 *     constant time. The metrics token is not a tenant credential: it opens the metrics routes and nothing else.
 *
 * Called by the metrics routes in `src/api/routes.ts` and by the prover daemon's metrics endpoint
 * (`src/prover/ProverDaemon.ts`). Secrets are read through `src/infra/secretsBootstrap.ts`, never directly
 * from the environment here. It does not log, count or rate-limit refused attempts.
 *
 * @module src/observability/metricsAccess
 */

import crypto from 'node:crypto';
import { isDeployedEnv } from '../infra/deployEnv.js';
import { getMetricsToken, getAdminKey } from '../infra/secretsBootstrap.js';

type Headers = Record<string, string | string[] | undefined> | undefined;

function sameSecret(presented: string, expected: string): boolean {
  // hash both sides first: timingSafeEqual needs equal lengths, and the length of the secret must not leak either
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * True when the request may read the metrics routes.
 *
 * Header names must be lower case (as Node delivers them); array-valued headers are refused.
 *
 * @param headers - Incoming request headers, or `undefined` (treated as no credentials).
 * @returns `true` in local/test environments, or when a configured operator key or metrics token matches;
 *   `false` otherwise, including when neither secret is configured in a deployed environment.
 */
export function metricsAccessAllowed(headers: Headers): boolean {
  if (!isDeployedEnv()) return true;
  const adminKey = getAdminKey();
  const presentedAdmin = headers?.['x-admin-key'];
  if (adminKey && typeof presentedAdmin === 'string' && sameSecret(presentedAdmin, adminKey)) return true;
  const metricsToken = getMetricsToken();
  const auth = headers?.['authorization'];
  if (metricsToken && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return sameSecret(auth.slice(7).trim(), metricsToken);
  }
  return false;
}
