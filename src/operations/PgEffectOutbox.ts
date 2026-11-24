/**
 * D1–D8 / C — PostgreSQL EffectOutbox (contract `EffectOutbox`, src/types/d1d8/modules.ts).
 *
 * At-least-once side effects deduplicated by effectId. An effect row is written in the same
 * transaction as the fact that originates it (enqueueTx), so a commit that lands after the
 * application stopped waiting is still found by any instance (RV30-03). Claims use a lease and
 * `FOR UPDATE SKIP LOCKED`, so two instances never run the same effect at the same time; an
 * expired lease (owner died) becomes claimable again. The `target` of proof/on-chain effects is
 * frozen at creation and never rewritten (D7 §11, N15). Payloads hold references only: no
 * opening secret, prompt or response (D2 §5, D7-G09).
 *
 * @module operations/PgEffectOutbox
 */
import type { EffectOutbox, IsoTime, OperationKey, OutboxEffect } from '../types/d1d8/index.js';
import { encodeJson, big } from './codec.js';
import type { PgQueryable } from './schema.js';

export type EnqueueInput = Omit<OutboxEffect, 'state' | 'attempts' | 'lease' | 'createdAt'> & {
  /** Non-secret references the handler needs (ids, versions). Never content or secrets. */
  payload?: Record<string, unknown> | null;
  /** First attempt not before this instant (default now). */
  notBefore?: IsoTime;
};

export interface ClaimedEffect extends OutboxEffect {
  payload: Record<string, unknown> | null;
  lastError: string | null;
}

export class LeaseLostError extends Error {
  constructor(effectId: string, owner: string) {
    super(`lease on ${effectId} is no longer held by ${owner}`);
    this.name = 'LeaseLostError';
  }
}

interface OutboxRow {
  effect_id: string; tenant_id: string; operation_id: string; kind: string; payload_digest: string;
  payload: Record<string, unknown> | null; target: Record<string, unknown> | null; state: string;
  attempts: number; lease_owner: string | null; lease_until: Date | null; created_at: Date; last_error: string | null;
}

const KINDS: ReadonlySet<string> = new Set(['persist_receipt', 'persist_conference', 'apply_debit', 'project_redis', 'enqueue_proof', 'submit_onchain']);

function decodeRow(r: OutboxRow): ClaimedEffect {
  const t = r.target;
  return {
    schema: 'otk.outbox_effect.v1',
    effectId: r.effect_id,
    key: { tenantId: r.tenant_id, operationId: r.operation_id },
    kind: r.kind as OutboxEffect['kind'],
    payloadDigest: r.payload_digest as OutboxEffect['payloadDigest'],
    target: t == null ? null : {
      chainId: big(t['chainId'], 'target.chainId'),
      registry: String(t['registry']),
      circuitId: String(t['circuitId']),
      schemaVersion: String(t['schemaVersion']),
    },
    state: r.state as OutboxEffect['state'],
    attempts: Number(r.attempts),
    lease: r.lease_owner && r.lease_until ? { owner: r.lease_owner, until: new Date(r.lease_until).toISOString() } : null,
    createdAt: new Date(r.created_at).toISOString(),
    payload: r.payload ?? null,
    lastError: r.last_error,
  };
}

/** Insert one effect inside an open transaction (or on the pool). Duplicate effectId = no-op. */
export async function enqueueTx(q: PgQueryable, e: EnqueueInput): Promise<'enqueued' | 'duplicate'> {
  if (!KINDS.has(e.kind)) throw new RangeError(`unknown effect kind ${e.kind}`);
  const res = await q.query(
    `INSERT INTO otk_outbox (effect_id, tenant_id, operation_id, kind, payload_digest, payload, target, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, COALESCE($8::timestamptz, now()))
     ON CONFLICT (effect_id) DO NOTHING`,
    [e.effectId, e.key.tenantId, e.key.operationId, e.kind, e.payloadDigest,
      e.payload == null ? null : encodeJson(e.payload), e.target == null ? null : encodeJson(e.target), e.notBefore ?? null],
  );
  return (res.rowCount ?? 0) > 0 ? 'enqueued' : 'duplicate';
}

export class PgEffectOutbox implements EffectOutbox {
  /** Attempts after which a failing effect becomes 'dead' (kept, visible, never deleted). */
  constructor(private readonly pool: PgQueryable, private readonly opts: { maxAttempts?: number } = {}) {}

  enqueue(effect: EnqueueInput): Promise<'enqueued' | 'duplicate'> {
    return enqueueTx(this.pool, effect);
  }

  /**
   * `flavor`: 'v3' claims only effects whose payload says flavor = v3; 'legacy' only those without
   * it; undefined claims both. Lets the legacy receipt worker and the v3 operation worker share
   * the kind `enqueue_proof` without running each other's effects.
   */
  async claim(owner: string, kinds: OutboxEffect['kind'][], leaseMs: number, limit: number, flavor?: 'v3' | 'legacy'): Promise<ClaimedEffect[]> {
    const res = await this.pool.query<OutboxRow & Record<string, unknown>>(
      `WITH c AS (
         SELECT effect_id FROM otk_outbox
          WHERE kind = ANY($2::text[])
            AND ($5::text IS NULL OR ($5 = 'v3' AND payload->>'flavor' = 'v3') OR ($5 = 'legacy' AND (payload->>'flavor') IS DISTINCT FROM 'v3'))
            AND ((state = 'pending' AND next_attempt_at <= now()) OR (state = 'leased' AND lease_until < now()))
          ORDER BY created_at, effect_id
          LIMIT $4
          FOR UPDATE SKIP LOCKED)
       UPDATE otk_outbox o
          SET state = 'leased', lease_owner = $1, lease_until = now() + ($3::int * interval '1 millisecond'),
              attempts = o.attempts + 1, updated_at = now()
         FROM c WHERE o.effect_id = c.effect_id
       RETURNING o.*`,
      [owner, kinds, Math.max(1, Math.floor(leaseMs)), Math.max(1, Math.floor(limit)), flavor ?? null],
    );
    return res.rows.map(decodeRow).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.effectId.localeCompare(b.effectId));
  }

  /** `result`: public, non-secret outcome merged into the payload (e.g. a transaction hash). */
  /** Extend a lease still held by `owner`; false when it was lost (another instance took it). */
  async renew(effectId: string, owner: string, leaseMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE otk_outbox SET lease_until = now() + ($3::int * interval '1 millisecond'), updated_at = now()
        WHERE effect_id = $1 AND state = 'leased' AND lease_owner = $2 AND lease_until > now()`,
      [effectId, owner, Math.max(1, Math.floor(leaseMs))],
    );
    return (res.rowCount ?? 0) === 1;
  }

  async complete(effectId: string, owner: string, result?: Record<string, unknown>): Promise<void> {
    const res = await this.pool.query(
      `UPDATE otk_outbox SET state = 'done', done_at = now(), updated_at = now(), lease_until = NULL, last_error = NULL,
              payload = CASE WHEN $3::jsonb IS NULL THEN payload ELSE COALESCE(payload, '{}'::jsonb) || $3::jsonb END
        WHERE effect_id = $1 AND state = 'leased' AND lease_owner = $2`,
      [effectId, owner, result ? encodeJson({ result }) : null],
    );
    if ((res.rowCount ?? 0) === 0) throw new LeaseLostError(effectId, owner);
  }

  async fail(effectId: string, owner: string, reason: string, retryAt: IsoTime | null): Promise<void> {
    const max = this.opts.maxAttempts ?? 20;
    const res = await this.pool.query(
      `UPDATE otk_outbox
          SET state = CASE WHEN $4::timestamptz IS NULL OR attempts >= $5 THEN 'dead' ELSE 'pending' END,
              next_attempt_at = COALESCE($4::timestamptz, next_attempt_at),
              lease_until = NULL, last_error = left($3, 2000), updated_at = now()
        WHERE effect_id = $1 AND state = 'leased' AND lease_owner = $2`,
      [effectId, owner, reason, retryAt, max],
    );
    if ((res.rowCount ?? 0) === 0) throw new LeaseLostError(effectId, owner);
  }

  /** Effects of one operation (status endpoint, tests). Tenant-scoped by the key. */
  async listFor(key: OperationKey): Promise<ClaimedEffect[]> {
    const res = await this.pool.query<OutboxRow & Record<string, unknown>>(
      'SELECT * FROM otk_outbox WHERE tenant_id = $1 AND operation_id = $2 ORDER BY created_at, effect_id',
      [key.tenantId, key.operationId],
    );
    return res.rows.map(decodeRow);
  }

  async get(effectId: string): Promise<ClaimedEffect | null> {
    const res = await this.pool.query<OutboxRow & Record<string, unknown>>('SELECT * FROM otk_outbox WHERE effect_id = $1', [effectId]);
    return res.rows[0] ? decodeRow(res.rows[0]) : null;
  }

  /**
   * D7-G08: make completed effects of one kind run again (e.g. Redis lost and rebuilt: every
   * `project_redis` effect is re-applied; projections are idempotent, so live data is not
   * doubled). Optional filters by tenant and by `payload.epochId`. Returns the number re-armed.
   */
  async replayKind(kind: OutboxEffect['kind'], filter: { tenantId?: string | null; epochId?: string | null } = {}): Promise<number> {
    const res = await this.pool.query(
      `UPDATE otk_outbox SET state = 'pending', next_attempt_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now()
        WHERE kind = $1 AND state IN ('done', 'dead')
          AND ($2::text IS NULL OR tenant_id = $2) AND ($3::text IS NULL OR payload->>'epochId' = $3)`,
      [kind, filter.tenantId ?? null, filter.epochId ?? null],
    );
    return res.rowCount ?? 0;
  }

  /** Counts by state, for monitoring and the backpressure policy. */
  async stats(): Promise<Record<string, number>> {
    const res = await this.pool.query<{ state: string; n: string }>('SELECT state, count(*)::text AS n FROM otk_outbox GROUP BY state');
    return Object.fromEntries(res.rows.map((r) => [r.state, Number(r.n)]));
  }
  /**
   * OVERNIGHT 20261005 (Phase 2): queue observability in one read: depth per state and kind, age of the oldest
   * pending/due effect, live vs expired leases, retried effects (attempts > 1), dead effects, and completions in the
   * last minute (drain rate). Read-only; meant for metrics/health endpoints and load probes.
   */
  async metrics(): Promise<OutboxMetrics> {
    const r = await this.pool.query<{ kind: string; state: string; n: string }>('SELECT kind, state, count(*)::text AS n FROM otk_outbox GROUP BY kind, state');
    const a = await this.pool.query<{ oldest_pending_ms: string | null; oldest_due_ms: string | null; leases_live: string; leases_expired: string; retried: string; done_last_minute: string }>(
      `SELECT round(extract(epoch FROM (now() - min(created_at) FILTER (WHERE state IN ('pending', 'leased')))) * 1000)::text AS oldest_pending_ms,
              round(extract(epoch FROM (now() - min(next_attempt_at) FILTER (WHERE state = 'pending' AND next_attempt_at <= now()))) * 1000)::text AS oldest_due_ms,
              count(*) FILTER (WHERE state = 'leased' AND lease_until > now())::text AS leases_live,
              count(*) FILTER (WHERE state = 'leased' AND lease_until <= now())::text AS leases_expired,
              count(*) FILTER (WHERE attempts > 1)::text AS retried,
              count(*) FILTER (WHERE state = 'done' AND done_at > now() - interval '1 minute')::text AS done_last_minute
         FROM otk_outbox`);
    const byState: Record<string, number> = {};
    const byKind: Record<string, Record<string, number>> = {};
    for (const x of r.rows) {
      byState[x.state] = (byState[x.state] ?? 0) + Number(x.n);
      (byKind[x.kind] ??= {})[x.state] = Number(x.n);
    }
    const row = a.rows[0]!;
    return {
      byState, byKind,
      oldestPendingAgeMs: row.oldest_pending_ms === null ? null : Number(row.oldest_pending_ms),
      oldestDueAgeMs: row.oldest_due_ms === null ? null : Number(row.oldest_due_ms),
      leasesLive: Number(row.leases_live), leasesExpired: Number(row.leases_expired),
      retried: Number(row.retried), dead: byState['dead'] ?? 0, doneLastMinute: Number(row.done_last_minute),
    };
  }
}

export interface OutboxMetrics {
  byState: Record<string, number>;
  byKind: Record<string, Record<string, number>>;
  /** Age of the oldest effect not yet done (pending or leased), null when none. */
  oldestPendingAgeMs: number | null;
  /** How long the oldest DUE pending effect has been waiting for a worker, null when none is due. */
  oldestDueAgeMs: number | null;
  leasesLive: number;
  leasesExpired: number;
  retried: number;
  dead: number;
  doneLastMinute: number;
}
