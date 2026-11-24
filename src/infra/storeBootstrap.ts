/**
 * Store Bootstrap — centralized store initialization (Wave 3A)
 *
 * Called once from server.ts at startup. Probes OTK_REDIS_URL and OTK_DB_URL,
 * creates Redis/PG backend implementations, and injects them via set*Store().
 * Falls back to Memory stores when external backends are unavailable.
 *
 * @module infra/storeBootstrap
 * @since Wave 3A (PACK 3A-01)
 */

import { initRedis, getRedisClient, closeRedis } from './redis/redisClient.js';
import { setIdempotencyStore } from '../api/idempotency.js';
import { setDistributedRateLimiter } from '../security/IDistributedRateLimiter.js';
import { setDeadLetterStore } from '../api/IDeadLetterStore.js';
import { setTokenStore } from '../api/ITokenStore.js';
import { setPolicyStore } from '../security/IPolicyStore.js';
import { setBudgetTracker } from '../economics/IBudgetTracker.js';
import { setGovernanceStore } from '../security/IGovernanceStore.js';
import { setIndexerStore } from '../dashboard/IIndexerStore.js';
import { setApiKeyMetadataStore } from '../api/IApiKeyMetadataStore.js';
import { setUserStore } from '../users/IUserStore.js';
import { getLogger } from './logging/StructuredLogger.js';
import { isDeployedEnv } from './deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard

export interface BootstrapResult {
  redis: boolean;
  pg: boolean;
  stores: Record<string, 'redis' | 'pg' | 'memory' | 'smtp' | 'console'>;
}

let _pgPool: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } | null = null;

/** Get the shared PG pool (available after bootstrap). */
export function getPgPool() { return _pgPool; }

/** Close the PG pool (called during graceful shutdown). */
export async function closePg(): Promise<void> {
  if (_pgPool && 'end' in _pgPool && typeof (_pgPool as any).end === 'function') {
    try { await (_pgPool as any).end(); } catch { /* ignore */ }
    _pgPool = null;
  }
}

/**
 * H1-S01 (FA-04): stores that hold money-relevant state and must be durable in a deployed environment. Before H1-S01
 * a deployed instance whose PostgreSQL was missing or unreachable at start kept serving with in-memory plan
 * assignments: paid tiers vanished on restart, downgrades did not survive, replicas disagreed. Empty outside
 * deployed environments (development and tests keep the memory fallback by design).
 */
export function deployedStoreProblems(result: BootstrapResult): string[] {
  if (!isDeployedEnv()) return [];
  // Explicit, logged opt-out for a disposable demo labelled production (never silent)
  if (process.env['OTK_ALLOW_NON_DURABLE_STORES'] === '1') return [];
  const problems: string[] = [];
  if (result.stores['planStore'] !== 'pg') {
    problems.push('plan store is not PostgreSQL (OTK_DB_URL missing or unreachable): plan assignments would live only in memory; set OTK_ALLOW_NON_DURABLE_STORES=1 only for a disposable demo');
  }
  // H1 R-03 (adversarial review): a failure AFTER the plan store (e.g. the revocation status load) used to be swallowed
  // with planStore already 'pg', so a deployed instance started without any revocation state (fail open)
  for (const k of ['subjectStatus', 'userStore', 'apiKeyMetadata'] as const) {
    if (result.stores[k] !== 'pg') problems.push(`${k} store is not PostgreSQL: revocation or identity state would not be durable/shared`);
  }
  if (!result.pg) problems.push('PostgreSQL bootstrap did not complete');
  return problems;
}

/**
 * Initialize all stores based on environment configuration.
 *
 * - OTK_REDIS_URL → Redis-backed stores (idempotency, rate limiter)
 * - OTK_DB_URL → PostgreSQL-backed stores (dead letter)
 *
 * Graceful: if Redis/PG is configured but unreachable, falls back to Memory stores.
 * Non-throwing: always returns a result, never aborts server startup.
 */
export async function bootstrapStores(): Promise<BootstrapResult> {
  const log = getLogger();
  const result: BootstrapResult = { redis: false, pg: false, stores: {} };

  // ── Redis ──────────────────────────────────────────────────
  const redisUrl = process.env['OTK_REDIS_URL'];
  if (redisUrl) {
    const connected = await initRedis();
    result.redis = connected;

    if (connected) {
      const redis = getRedisClient()!;

      // Idempotency → Redis
      const { RedisIdempotencyStore } = await import('./redis/RedisIdempotencyStore.js');
      setIdempotencyStore(new RedisIdempotencyStore(redis));
      result.stores['idempotency'] = 'redis';

      // Rate Limiter → Redis
      const { RedisRateLimiter } = await import('./redis/RedisRateLimiter.js');
      setDistributedRateLimiter(new RedisRateLimiter(redis));
      result.stores['rateLimiter'] = 'redis';

      // TAL → RedisTAL (Wave 3A Pack 02)
      const { RedisTAL } = await import('../security/RedisTAL.js');
      const { setAccountingLayer } = await import('../security/talRuntime.js');
      setAccountingLayer(new RedisTAL(redis.rawClient));
      result.stores['tal'] = 'redis';

      // TokenStore → Redis (Wave 3A Pack 03)
      const { RedisTokenStore } = await import('./redis/RedisTokenStore.js');
      setTokenStore(new RedisTokenStore(redis));
      result.stores['tokenStore'] = 'redis';

      // PolicyStore → Redis (Wave 3A Pack 03)
      const { RedisPolicyStore } = await import('./redis/RedisPolicyStore.js');
      setPolicyStore(new RedisPolicyStore(redis));
      result.stores['policyStore'] = 'redis';

      // BudgetTracker → Redis (Wave 3A Pack 03)
      const { RedisBudgetTracker } = await import('./redis/RedisBudgetTracker.js');
      setBudgetTracker(new RedisBudgetTracker(redis));
      result.stores['budgetTracker'] = 'redis';

      log.info('redis stores bootstrapped', { stores: ['idempotency', 'rateLimiter', 'tal', 'tokenStore', 'policyStore', 'budgetTracker'] });
    } else {
      log.warn('redis configured but unreachable — using memory stores');
      result.stores['idempotency'] = 'memory';
      result.stores['rateLimiter'] = 'memory';
      result.stores['tal'] = 'memory';
      result.stores['tokenStore'] = 'memory';
      result.stores['policyStore'] = 'memory';
      result.stores['budgetTracker'] = 'memory';
    }
  } else {
    result.stores['idempotency'] = 'memory';
    result.stores['rateLimiter'] = 'memory';
  }

  // ── PostgreSQL ─────────────────────────────────────────────
  const dbUrl = process.env['OTK_DB_URL'];
  if (dbUrl) {
    try {
      const pg = await import('pg');
      const Pool = pg.default?.Pool ?? pg.Pool;
      // SEC-06: enforce SSL in production to prevent unencrypted PG connections
      const pgSsl = isDeployedEnv() ? { rejectUnauthorized: true } : false;
      const pool = new Pool({ connectionString: dbUrl, ssl: pgSsl });
      // N12: idle client errors (PostgreSQL restart) must not terminate the process
      pool.on('error', (err: Error) => log.warn('pg pool idle client error', { pool: 'stores', error: err.message }));
      _pgPool = pool;
      // Verify connectivity
      await _pgPool!.query('SELECT 1');
      result.pg = true;

      // Dead Letter → PG
      const { PgDeadLetterStore } = await import('./pg/PgDeadLetterStore.js');
      const dlStore = new PgDeadLetterStore(_pgPool!);
      await dlStore.init();
      setDeadLetterStore(dlStore);
      result.stores['deadLetter'] = 'pg';

      // PlanStore → PG (Wave 3A Pack 02)
      const { setPlanStore } = await import('../billing/PlanRegistry.js');
      const { PgPlanStore } = await import('../billing/IPlanStore.js');
      const pgPlanStore = new PgPlanStore(_pgPool!);
      await pgPlanStore.init();
      // R07: awaited so the sync plan cache is hydrated before traffic is served
      await setPlanStore(pgPlanStore);
      result.stores['planStore'] = 'pg';

      // H1-S03b: Stripe events live in the plan store (otk_stripe_events, same transaction as the plan change)

      // GovernanceStore → PG (Wave 3A Pack 03)
      const { PgGovernanceStore } = await import('./pg/PgGovernanceStore.js');
      const govStore = new PgGovernanceStore(_pgPool!);
      await govStore.init();
      setGovernanceStore(govStore);
      result.stores['governanceStore'] = 'pg';

      // IndexerStore → PG (Wave 3A Pack 03)
      const { PgIndexerStore } = await import('./pg/PgIndexerStore.js');
      const idxStore = new PgIndexerStore(_pgPool!);
      await idxStore.init();
      setIndexerStore(idxStore);
      result.stores['indexerStore'] = 'pg';

      // ApiKeyMetadataStore → PG (Wave 3C Pack 01)
      const { PgApiKeyMetadataStore } = await import('./pg/PgApiKeyMetadataStore.js');
      const keyStore = new PgApiKeyMetadataStore(_pgPool!);
      await keyStore.init();
      setApiKeyMetadataStore(keyStore);
      // H1R2 R-13: the shared key table is the authority for dynamic keys on every request (no per-process registry)
      const { setKeyAuthority } = await import('../auth/credentialAuthority.js');
      setKeyAuthority(keyStore);
      result.stores['apiKeyMetadata'] = 'pg';

      // STOPGATE-01 R-13b: registry tokens changed through the API (tenant CRUD, reload) are shared by every replica;
      // changes left queued by a failed write are retried in the background (the API answered 503 for them)
      const { PgTenantTokenStore } = await import('./pg/PgTenantTokenStore.js');
      const { setRegistryTokenAuthority, flushRegistryTokenChanges, pendingRegistryTokenChanges } = await import('../auth/registryTokenAuthority.js');
      const tokenStore = new PgTenantTokenStore(_pgPool!);
      await tokenStore.init();
      setRegistryTokenAuthority(tokenStore);
      setInterval(() => { if (pendingRegistryTokenChanges() > 0) void flushRegistryTokenChanges(); }, 5_000).unref();
      result.stores['registryTokens'] = 'pg';

      // UserStore → PG (Wave 3C Pack 03)
      const { PgUserStore } = await import('./pg/PgUserStore.js');
      const userStore = new PgUserStore(_pgPool!);
      await userStore.init();
      setUserStore(userStore);
      result.stores['userStore'] = 'pg';

      // H1 lane B (S04 residual): tenant/user revocation status shared by replicas; awaited so a restart serves no
      // traffic before the cache is hydrated (isolated block, identity lane)
      const { PgSubjectStatusStore } = await import('./pg/PgSubjectStatusStore.js');
      const { setSubjectStatusStore } = await import('../auth/subjectStatus.js');
      const statusStore = new PgSubjectStatusStore(_pgPool!);
      await statusStore.init();
      if (!(await setSubjectStatusStore(statusStore))) {
        await setSubjectStatusStore(null);
        throw new Error('subject status store: initial load failed');
      }
      result.stores['subjectStatus'] = 'pg';

      log.info('pg stores bootstrapped', { stores: ['deadLetter', 'planStore', 'governanceStore', 'indexerStore', 'apiKeyMetadata', 'userStore'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('pg configured but unreachable — using memory stores', { error: msg });
      result.pg = false;
      result.stores['deadLetter'] = 'memory';
    }
  } else {
    result.stores['deadLetter'] = 'memory';
  }

  // ── Notification Service (Wave 3C Pack 02 / W4-SMTP) ───────
  try {
    const { getDispatcher } = await import('../publisher/runtime.js');
    const { NotificationService, setNotificationService } = await import('../notifications/NotificationService.js');
    const { setEmailAdapter } = await import('../email/IEmailAdapter.js');
    const { createSmtpAdapterFromEnv } = await import('../email/SmtpEmailAdapter.js');
    const smtpAdapter = createSmtpAdapterFromEnv();
    if (smtpAdapter) {
      setEmailAdapter(smtpAdapter);
      result.stores['email'] = 'smtp';
      log.info('email adapter: smtp', { host: process.env['OTK_SMTP_HOST'] });
    } else {
      const { ConsoleEmailAdapter } = await import('../email/ConsoleEmailAdapter.js');
      setEmailAdapter(new ConsoleEmailAdapter());
      result.stores['email'] = 'console';
      log.warn('email adapter: console (OTK_SMTP_HOST not set — set for production)');
    }
    setNotificationService(new NotificationService(getDispatcher()));
    result.stores['notifications'] = 'memory';
    log.info('notification service bootstrapped');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('notification service bootstrap failed', { error: msg });
  }

  log.info('store bootstrap complete', {
    redis: result.redis,
    pg: result.pg,
    stores: result.stores,
  });

  return result;
}

/**
 * Shutdown all external store connections.
 * Called during graceful shutdown.
 */
export async function shutdownStores(): Promise<void> {
  await closeRedis();
  await closePg();
}
