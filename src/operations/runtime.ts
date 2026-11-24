/**
 * D1–D8 / C — composition of the durable operation runtime used by the proxy's durable profile
 * (opt-in: OTK_PROXY_ENABLED=1 in src/api/server.ts) and by S4's integration.
 *
 * Requires PostgreSQL (the operation must exist durably before the provider is called; there is
 * no in-memory durable profile). Starts: the outbox worker for persist_receipt, the recovery of
 * orphaned operations and the spool replay (both periodic, so recovery does not need a restart).
 *
 * Configuration (non-secret, OTK_* config vars): OTK_PROXY_DEFAULT_MAX_OUTPUT_TOKENS (1024),
 * OTK_PROXY_MAX_OUTPUT_TOKENS (32768), OTK_PROXY_MAX_DURATION_MS (600000),
 * OTK_OPERATION_LEASE_MS (30000), OTK_OPERATION_RECOVERY_MS (5000), OTK_SPOOL_DIR (unset = no
 * spool), OTK_SPOOL_MAX_ENTRIES (10000), OTK_INSTANCE_ID.
 *
 * @module operations/runtime
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { deriveEpoch } from '../types/receipt.js';
import { quotaUnitsFor } from '../billing/meteringQuota.js';
import { ensureD1D8Schema } from './schema.js';
import { PgOperationStore } from './PgOperationStore.js';
import { PgEffectOutbox } from './PgEffectOutbox.js';
import { PgOpeningStore } from './PgOpeningStore.js';
import { PgReceiptV3Store } from './receiptV3Store.js';
import { MeasurementSpool } from './spool.js';
import { AdmissionGate } from './admissionGate.js';
import { OutboxWorker } from './OutboxWorker.js';
import type { MeasurementPorts } from './measurementPorts.js';
import { persistReceiptHandler, recoverOrphans } from './effects.js';
import { replaySpool } from './proxyDurable.js';
import { resolvePendingPrices } from './pricingResolution.js';
import { MONEY_BOUND_POLICY, type MoneyBoundPolicy } from './moneyBound.js';
import { proofHandlers, type ProofPorts } from './proofPipeline.js';
import type { CryptoPorts, InflightOperation, OperationsContext, ProxyPolicy } from './context.js';
import { isDeployedEnv } from '../infra/deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard

export interface OperationsRuntimeOptions {
  dbUrl: string;
  /**
   * Measurement ports (fechamento pós-S5, RV2-06 / AUD-3): REQUIRED. The runtime never falls back to a
   * measurement on its own; the legacy adapter is used only when a caller passes legacyMeasurementPorts()
   * explicitly (tests / legacy profile). The D1–D8 entrypoint passes front B's real ports (bootstrapD1D8).
   */
  measurement: MeasurementPorts;
  crypto?: CryptoPorts | null;
  proof?: ProofPorts | null;
  spoolDir?: string | null;
  spoolMaxEntries?: number;
  instanceId?: string;
  policy?: Partial<ProxyPolicy>;
  recoveryIntervalMs?: number;
  legacyProverEnabled?: () => boolean;
  /** Quota of a tenant in accounting units (default: plan quota, meteringQuota.quotaUnitsFor). */
  quotaFor?: (tenantId: string) => bigint | null;
  /** H1-S07: see PgOperationStoreOptions.requireMoneyBudget (default: OTK_REQUIRE_MONEY_BUDGET, else deployed env). */
  requireMoneyBudget?: boolean;
  /** H1-S07: operator-wide shared budget every tenant must belong to (default: OTK_GLOBAL_MONEY_BUDGET_ID). */
  globalBudgetId?: string | null;
  /** Strict money ceiling policy (ABC-04); default MONEY_BOUND_POLICY (v2, RV2-04). */
  moneyBoundPolicy?: MoneyBoundPolicy;
  /** OVERNIGHT 20261005 (F-P1-04): PostgreSQL pool size of this runtime (default 10, OTK_PG_POOL_MAX). */
  poolMax?: number;
  /** Admissions inside the database at once (default poolMax − 3, at least 1; OTK_ADMISSION_CONCURRENCY). */
  admissionConcurrency?: number;
  /** Longest in-memory wait for an admission slot before 503 admission_busy (default 30 s; OTK_ADMISSION_QUEUE_TIMEOUT_MS). */
  admissionQueueTimeoutMs?: number;
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/** Non-secret configuration from the environment (config vars are allowed outside bootstrap). */
export function operationsOptionsFromEnv(dbUrl: string): Omit<OperationsRuntimeOptions, 'measurement'> {
  const e = process.env;
  return {
    dbUrl,
    spoolDir: e['OTK_SPOOL_DIR'] || null,
    spoolMaxEntries: num(e['OTK_SPOOL_MAX_ENTRIES'], 10_000),
    instanceId: e['OTK_INSTANCE_ID'] || undefined,
    recoveryIntervalMs: num(e['OTK_OPERATION_RECOVERY_MS'], 5_000),
    poolMax: num(e['OTK_PG_POOL_MAX'], 10),
    ...(e['OTK_ADMISSION_CONCURRENCY'] ? { admissionConcurrency: num(e['OTK_ADMISSION_CONCURRENCY'], 7) } : {}),
    admissionQueueTimeoutMs: num(e['OTK_ADMISSION_QUEUE_TIMEOUT_MS'], 30_000),
    legacyProverEnabled: () => (process.env['PROVER_URL'] ?? 'http://localhost:3001') !== 'disabled',
    policy: {
      defaultMaxOutputTokens: BigInt(num(e['OTK_PROXY_DEFAULT_MAX_OUTPUT_TOKENS'], 1024)),
      maxOutputTokensCap: BigInt(num(e['OTK_PROXY_MAX_OUTPUT_TOKENS'], 32_768)),
      maxDurationMs: BigInt(num(e['OTK_PROXY_MAX_DURATION_MS'], 600_000)),
      leaseMs: num(e['OTK_OPERATION_LEASE_MS'], 30_000),
      clientStallMs: num(e['OTK_PROXY_CLIENT_STALL_MS'], 30_000),
      extraForwardHeaders: (e['OTK_PROXY_FORWARD_HEADERS'] ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    },
  };
}

/**
 * H1-S07 / R-10 (adversarial review): whether a USD ceiling is required to spend the operator key. Only an explicit
 * OTK_REQUIRE_MONEY_BUDGET=0 turns it off and '1' turns it on; any other value ('true', 'yes', '', a typo) keeps the
 * default, which is ON in a deployed environment (before, any value other than '1' turned it off).
 */
export function moneyBudgetRequiredFromEnv(): boolean {
  const v = process.env['OTK_REQUIRE_MONEY_BUDGET']?.trim();
  if (v === '0') return false;
  if (v === '1') return true;
  return isDeployedEnv();
}

export class OperationsRuntime implements OperationsContext {
  readonly inflight = new Map<string, InflightOperation>();
  /** F-P1-04: admissions wait here, in memory, instead of holding pool connections behind the quota row lock. */
  admission: AdmissionGate = new AdmissionGate(7, 30_000);
  /** ABC-04: strict money ceiling policy (default: the paid pilot scope). */
  moneyBoundPolicy: MoneyBoundPolicy = MONEY_BOUND_POLICY;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private recovering: Promise<unknown> | null = null;
  readonly worker: OutboxWorker;
  /** v3 proof and on-chain submission (flavor v3 only; legacy proofs stay with the receipt store). */
  readonly proofWorker: OutboxWorker;

  private constructor(
    readonly pool: pg.Pool,
    readonly store: PgOperationStore,
    readonly outbox: PgEffectOutbox,
    readonly openings: PgOpeningStore,
    readonly receiptsV3: PgReceiptV3Store,
    readonly measurement: MeasurementPorts,
    readonly crypto: CryptoPorts | null,
    readonly proof: ProofPorts | null,
    readonly spool: MeasurementSpool | null,
    readonly instanceId: string,
    readonly policy: ProxyPolicy,
    private readonly recoveryIntervalMs: number,
    private readonly proverEnabled: () => boolean,
  ) {
    this.worker = new OutboxWorker(outbox, `${instanceId}:ops`, { persist_receipt: persistReceiptHandler(this) }, {
      intervalMs: Math.max(200, Math.floor(recoveryIntervalMs / 2)),
      onEvent: (e) => { if (e.kind !== 'done') this.log('operation_effect', { ...e }); },
    });
    this.proofWorker = new OutboxWorker(outbox, `${instanceId}:proof`, proofHandlers(this), {
      flavor: 'v3', leaseMs: 120_000, batch: 5,
      intervalMs: Math.max(200, Math.floor(recoveryIntervalMs / 2)),
      onEvent: (e) => { if (e.kind !== 'done') this.log('proof_effect', { ...e }); },
    });
  }

  static async create(o: OperationsRuntimeOptions): Promise<OperationsRuntime> {
    // RV2-06: checked before any connection, also for callers that bypass the type (JS, casts)
    if (!o || !o.measurement) throw new Error('OperationsRuntime: measurement ports are required (front B ports, or legacyMeasurementPorts() explicitly for the legacy/test profile)');
    const poolMax = Math.max(2, Math.floor(o.poolMax ?? 10));
    const pool = new pg.Pool({ connectionString: o.dbUrl, max: poolMax, connectionTimeoutMillis: 5_000, ssl: isDeployedEnv() ? { rejectUnauthorized: true } : false });
    pool.on('error', (err: Error) => process.stderr.write(JSON.stringify({ event: 'pg_pool_idle_error', pool: 'operations', error: err.message, ts: Date.now() }) + '\n'));
    await ensureD1D8Schema(pool);
    const instanceId = o.instanceId ?? `ops-${process.pid}-${randomUUID().slice(0, 8)}`;
    const store = new PgOperationStore(pool, {
      quotaFor: o.quotaFor ?? quotaUnitsFor,
      epochOf: (d) => String(deriveEpoch(Math.floor(d.getTime() / 1000))),
      // H1-S07: deployed default = a USD ceiling is required (OTK_REQUIRE_MONEY_BUDGET=0 opts out explicitly)
      requireMoneyBudget: o.requireMoneyBudget ?? moneyBudgetRequiredFromEnv(),
      globalBudgetId: o.globalBudgetId ?? (process.env['OTK_GLOBAL_MONEY_BUDGET_ID']?.trim() || null),
    });
    const leaseMs = o.policy?.leaseMs ?? 30_000;
    const policy: ProxyPolicy = {
      defaultMaxOutputTokens: o.policy?.defaultMaxOutputTokens ?? 1024n,
      maxOutputTokensCap: o.policy?.maxOutputTokensCap ?? 32_768n,
      maxDurationMs: o.policy?.maxDurationMs ?? 600_000n,
      leaseMs,
      cancelPollMs: o.policy?.cancelPollMs ?? Math.max(100, Math.floor(leaseMs / 3)),
      maxResponseBytes: o.policy?.maxResponseBytes ?? 32 * 1024 * 1024,
      maxStreamBufferBytes: o.policy?.maxStreamBufferBytes ?? 1024 * 1024,
      maxCounterTextBytes: o.policy?.maxCounterTextBytes ?? 1024 * 1024,
      clientStallMs: o.policy?.clientStallMs ?? 30_000,
      extraForwardHeaders: (o.policy?.extraForwardHeaders ?? []).map((h) => h.toLowerCase()),
    };
    // review H4: the spool is per instance file; a random id would orphan it at every restart
    if (o.spoolDir && !o.instanceId) throw new Error('OTK_SPOOL_DIR requires a stable OTK_INSTANCE_ID (the spool file is replayed by the same instance after a restart)');
    const spool = o.spoolDir ? new MeasurementSpool(o.spoolDir, instanceId, { maxEntries: o.spoolMaxEntries ?? 10_000 }) : null;
    const rt = new OperationsRuntime(pool, store, new PgEffectOutbox(pool, { maxAttempts: 1000 }), new PgOpeningStore(pool), new PgReceiptV3Store(pool),
      o.measurement, o.crypto ?? null, o.proof ?? null, spool, instanceId, policy, o.recoveryIntervalMs ?? 5_000,
      o.legacyProverEnabled ?? (() => false));
    if (o.moneyBoundPolicy) rt.moneyBoundPolicy = o.moneyBoundPolicy;
    // F-P1-04: at least 3 connections stay free for leases, recovery and effects while admissions queue
    rt.admission = new AdmissionGate(Math.max(1, Math.floor(o.admissionConcurrency ?? poolMax - 3)), o.admissionQueueTimeoutMs ?? 30_000);
    // OVERNIGHT 20261005 / Phase 1: tokenizers load here, before the server reports ready, never inside a request
    if (o.measurement.warmUp) {
      const t0 = Date.now();
      const loaded = o.measurement.warmUp();
      rt.log('tokenizer_warmup', { loaded, totalMs: Date.now() - t0 });
    }
    return rt;
  }

  legacyProverEnabled(): boolean { return this.proverEnabled(); }

  log(event: string, fields: Record<string, unknown>): void {
    process.stderr.write(JSON.stringify({ event, instance: this.instanceId, ...fields, ts: Date.now() }) + '\n');
  }

  /** One recovery pass: spool replay first (late measurements), then orphaned operations. */
  recoverOnce(): Promise<unknown> {
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      await replaySpool(this).catch((e) => this.log('spool_replay_failed', { error: String(e) }));
      await recoverOrphans(this, { olderThanMs: this.policy.leaseMs }).catch((e) => this.log('operation_recovery_pass_failed', { error: String(e) }));
      // ABC-03: pending prices are retried from the stored usage (never a new inference)
      await resolvePendingPrices(this).catch((e) => this.log('operation_price_reconciliation_failed', { error: String(e) }));
      await this.worker.tick().catch(() => 0);
      await this.proofWorker.tick().catch(() => 0);
    })().finally(() => { this.recovering = null; });
    return this.recovering;
  }

  start(): void {
    this.worker.start();
    this.proofWorker.start();
    if (this.recoveryTimer) return;
    this.recoveryTimer = setInterval(() => { void this.recoverOnce(); }, this.recoveryIntervalMs);
    this.recoveryTimer.unref?.();
    void this.recoverOnce();
  }

  async stop(): Promise<void> {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    await this.worker.stop();
    await this.proofWorker.stop();
    if (this.recovering) await this.recovering.catch(() => undefined);
    await this.pool.end().catch(() => {});
  }
}
