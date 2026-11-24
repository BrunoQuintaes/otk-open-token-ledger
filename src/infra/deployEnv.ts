/**
 * Deployed-environment rule (RUN-S 2026-10-10; RV-RUNS-05 and RV2-RUNS-02 of the adversarial review). Every NODE_ENV
 * value except development / dev / test (case and surrounding spaces ignored) is a deployed environment; an unset
 * NODE_ENV keeps the local/test behaviour (Node convention; documented limitation). Used for everything that must not
 * be weaker outside production-like settings: authentication guard, PostgreSQL TLS, CSRF secret, test-only resets and
 * SSO stubs. No dependencies, so any module can import it without import cycles.
 */
const PERMISSIVE_ENVS: ReadonlySet<string> = new Set(['', 'development', 'dev', 'test']);

export function isDeployedEnv(): boolean {
  return !PERMISSIVE_ENVS.has((process.env['NODE_ENV'] ?? '').trim().toLowerCase());
}
