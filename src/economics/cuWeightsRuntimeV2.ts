/**
 * Weights runtime with a persisted last-known-good snapshot (D4 §2–3, D4-G01/G02; front B
 * provides it, C wires it into bootstrap/admission).
 *
 * Policy 'otk.cu_weights_runtime@1':
 *  - refresh() with the source reachable and a valid table: the table becomes active and is
 *    persisted as snapshot and in history (by digest).
 *  - source reachable but the table is rejected (bad signature, unauthorized signer, expired,
 *    malformed, revoked, or older than the active one — replay/downgrade): it is never
 *    activated; the last good table stays active (status 'valid', activeSource 'previous') and
 *    lastRejection records why — an attack or mistake is not confused with an outage.
 *  - source unavailable: the persisted snapshot is used if still valid
 *    ('source_unavailable_using_snapshot'); expired snapshot → 'expired', none → 'missing',
 *    and active() is null, so measurement-dependent admission must be refused (D4 §7).
 *  - Operations freeze cfg.ref at admission; byRef() finds that exact table later (restart,
 *    recovery, audit) even after it expired or was replaced. A refresh never mutates a frozen
 *    config. revoke() removes a table from activation but keeps it in history, flagged.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CuWeightsLoadStatus, IsoTime, VersionRef } from '../types/d1d8/index.js';
import type { CuConfig } from '../types/d1d8/index.js';
import { loadCuWeights } from './cuWeightsV2.js';

export interface CuWeightsSnapshotStore {
  readActive(): unknown | null;
  writeActive(raw: unknown): void;
  readHistory(digest: string): unknown | null;
  writeHistory(digest: string, raw: unknown): void;
  readRevoked(): Record<string, string>;
  writeRevoked(revoked: Record<string, string>): void;
}

export type SourceResult = { kind: 'ok'; raw: unknown } | { kind: 'unavailable'; reason: string };

export interface CuWeightsRuntimeState {
  status: CuWeightsLoadStatus;
  active: CuConfig | null;
  activeSource: 'source' | 'snapshot' | 'previous' | null;
  reason: string | null;
  /** Why the table offered by a reachable source was not activated (distinct from an outage). */
  lastRejection: { status: CuWeightsLoadStatus | 'revoked' | 'downgrade'; reason: string } | null;
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** File store: <dir>/active.json, <dir>/history/<digest>.json, <dir>/revoked.json (atomic writes). */
export function createFileSnapshotStore(dir: string): CuWeightsSnapshotStore {
  mkdirSync(join(dir, 'history'), { recursive: true });
  const safe = (d: string) => { if (!/^0x[0-9a-f]{64}$/.test(d)) throw new Error('invalid digest'); return d; };
  return {
    readActive: () => readJson(join(dir, 'active.json')),
    writeActive: (raw) => writeAtomic(join(dir, 'active.json'), JSON.stringify(raw)),
    readHistory: (digest) => readJson(join(dir, 'history', `${safe(digest)}.json`)),
    writeHistory: (digest, raw) => writeAtomic(join(dir, 'history', `${safe(digest)}.json`), JSON.stringify(raw)),
    readRevoked: () => (readJson(join(dir, 'revoked.json')) as Record<string, string> | null) ?? {},
    writeRevoked: (r) => writeAtomic(join(dir, 'revoked.json'), JSON.stringify(r)),
  };
}

export function createMemorySnapshotStore(): CuWeightsSnapshotStore {
  let active: unknown | null = null;
  const history = new Map<string, unknown>();
  let revoked: Record<string, string> = {};
  return {
    readActive: () => (active === null ? null : structuredClone(active)),
    writeActive: (raw) => { active = structuredClone(raw); },
    readHistory: (d) => (history.has(d) ? structuredClone(history.get(d)) : null),
    writeHistory: (d, raw) => { history.set(d, structuredClone(raw)); },
    readRevoked: () => ({ ...revoked }),
    writeRevoked: (r) => { revoked = { ...r }; },
  };
}

export function createCuWeightsRuntime(opts: {
  store: CuWeightsSnapshotStore;
  trustedSigners: readonly string[];
  /** Signers no longer trusted for NEW tables but still accepted to read frozen history (byRef). */
  historicalSigners?: readonly string[];
  now: () => IsoTime;
  formula?: string;
}) {
  let state: CuWeightsRuntimeState = { status: 'missing', active: null, activeSource: null, reason: 'not refreshed yet', lastRejection: null };
  const load = (raw: unknown, now: IsoTime) => loadCuWeights(raw, { now, trustedSigners: opts.trustedSigners, formula: opts.formula });
  const isRevoked = (cfg: CuConfig | null) => !!cfg && Object.hasOwn(opts.store.readRevoked(), cfg.ref.digest);

  function fromSnapshot(status: CuWeightsLoadStatus, reason: string, lastRejection: CuWeightsRuntimeState['lastRejection']): CuWeightsRuntimeState {
    const snap = opts.store.readActive();
    if (snap === null) {
      // No config at all: status says why (the rejection, when it is a load status).
      const why = lastRejection && lastRejection.status !== 'revoked' && lastRejection.status !== 'downgrade' ? lastRejection.status : 'missing';
      return { status: why, active: null, activeSource: null, reason: `${reason}; no snapshot`, lastRejection };
    }
    const r = load(snap, opts.now());
    if (r.status !== 'valid' || !r.config || isRevoked(r.config)) {
      return { status: r.status === 'valid' ? 'missing' : r.status, active: null, activeSource: null, reason: `${reason}; snapshot ${r.reason ?? 'revoked'}`, lastRejection };
    }
    return { status, active: r.config, activeSource: 'snapshot', reason, lastRejection };
  }

  /** Keep the current active config (if still valid now) or fall back to the snapshot. */
  function keepPrevious(lastRejection: NonNullable<CuWeightsRuntimeState['lastRejection']>): CuWeightsRuntimeState {
    const prev = state.active && load(opts.store.readHistory(state.active.ref.digest), opts.now()).status === 'valid' ? state.active : null;
    if (prev && !isRevoked(prev)) return { status: 'valid', active: prev, activeSource: 'previous', reason: lastRejection.reason, lastRejection };
    return fromSnapshot('valid', lastRejection.reason, lastRejection);
  }

  return {
    async refresh(fetchSource: () => Promise<SourceResult>): Promise<CuWeightsRuntimeState> {
      let src: SourceResult;
      try { src = await fetchSource(); } catch (e) { src = { kind: 'unavailable', reason: (e as Error).message }; }
      if (src.kind === 'unavailable') {
        state = fromSnapshot('source_unavailable_using_snapshot', `source unavailable: ${src.reason}`, null);
        return state;
      }
      const r = load(src.raw, opts.now());
      if (r.status !== 'valid' || !r.config) {
        // Rejected table (bad signature, unauthorized, expired, malformed): never activated.
        state = keepPrevious({ status: r.status, reason: r.reason ?? r.status });
        return state;
      }
      if (isRevoked(r.config)) {
        state = keepPrevious({ status: 'revoked', reason: `offered table ${r.config.ref.version} is revoked` });
        return state;
      }
      // Downgrade protection: a validly signed but OLDER table (replay) does not replace a newer one.
      // After a restart state.active is empty, so the persisted snapshot is the reference too.
      const snapRaw = opts.store.readActive();
      const snapCfg = snapRaw === null ? null : load(snapRaw, opts.now()).config;
      const newest = [state.active, snapCfg].filter((c): c is CuConfig => !!c && !isRevoked(c))
        .sort((a, b) => Date.parse(b.table.validFrom) - Date.parse(a.table.validFrom))[0] ?? null;
      if (newest && Date.parse(r.config.table.validFrom) < Date.parse(newest.table.validFrom)) {
        state = keepPrevious({ status: 'downgrade', reason: `older table ${r.config.ref.version} ignored (newer ${newest.ref.version})` });
        return state;
      }
      opts.store.writeHistory(r.config.ref.digest, src.raw);
      opts.store.writeActive(src.raw);
      state = { status: 'valid', active: r.config, activeSource: 'source', reason: null, lastRejection: null };
      return state;
    },
    state: (): CuWeightsRuntimeState => state,
    active: (): CuConfig | null => state.active,
    /**
     * Exact table frozen by an operation, verified as of its own validFrom against current and
     * historical signers (key rotation must not make frozen history unreadable).
     */
    byRef(ref: VersionRef): { config: CuConfig; revoked: boolean } | null {
      const raw = opts.store.readHistory(ref.digest) as Record<string, unknown> | null;
      if (!raw || typeof raw['validFrom'] !== 'string') return null;
      const r = loadCuWeights(raw, { now: raw['validFrom'] as string, trustedSigners: [...opts.trustedSigners, ...(opts.historicalSigners ?? [])], formula: opts.formula });
      if (r.status !== 'valid' || !r.config || r.config.ref.digest !== ref.digest || r.config.ref.version !== ref.version) return null;
      return { config: r.config, revoked: Object.hasOwn(opts.store.readRevoked(), ref.digest) };
    },
    revoke(digest: string, reason: string): void {
      opts.store.writeRevoked({ ...opts.store.readRevoked(), [digest]: reason });
      if (state.active?.ref.digest === digest) state = { status: 'missing', active: null, activeSource: null, reason: `revoked: ${reason}`, lastRejection: null };
    },
  };
}
