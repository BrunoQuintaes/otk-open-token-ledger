/**
 * GovernanceTrail — governance-specific audit events with JSONL persistence (E2.4)
 *
 * Extends the AuditLogChain concept with governance-specific event types.
 * Tracks: tenant_created, tenant_updated, tenant_deleted, plan_changed,
 *         key_rotated, config_changed.
 *
 * Persistence: JSONL file at OTK_GOVERNANCE_LOG env path.
 * When OTK_GOVERNANCE_LOG is unset, events are in-memory only.
 *
 * @module security/GovernanceTrail
 * @since Wave 1 Pack 9 (E2.4)
 */

import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { chainHash, sha256Hex, type AuditRecord } from './AuditLogChain.js';

/**
 * Governance event types recorded in the trail.
 */
export type GovernanceAction =
  | 'tenant_created'
  | 'tenant_updated'
  | 'tenant_deleted'
  | 'plan_changed'
  | 'key_rotated'
  | 'config_changed';

/**
 * One governance event, as given by the caller.
 */
export interface GovernanceEvent {
  ts: string;           // ISO-8601
  tenantId: string;
  actor: string;        // userId or service identity
  action: GovernanceAction;
  meta?: Record<string, unknown>;
}

/**
 * A governance event as stored in the trail, with its position and chain hash.
 */
export interface GovernanceEntry extends GovernanceEvent {
  /** Sequential index in the chain. */
  seq: number;
  /** Chain hash (H(prev_hash || canonical(event))). */
  hash: string;
}

const GENESIS_HASH = sha256Hex('governance-genesis');

/**
 * Hash-chained list of governance events, kept in memory and optionally appended to a JSONL file.
 *
 * The file path comes from the constructor option or the `OTK_GOVERNANCE_LOG` environment variable; an
 * existing file is loaded at construction. Disk errors are ignored (the in-memory trail stays usable).
 */
export class GovernanceTrail {
  private entries: GovernanceEntry[] = [];
  private lastHash: string = GENESIS_HASH;
  private readonly logPath: string | undefined;

  constructor(options?: { logPath?: string }) {
    this.logPath = options?.logPath ?? process.env['OTK_GOVERNANCE_LOG'];
    if (this.logPath) {
      this._loadFromDisk();
    }
  }

  /**
   * Append a governance event to the trail.
   * Returns the new entry with seq and chain hash.
   * H2.6: Also delegates to IGovernanceStore when a PG/Redis backend is active.
   *
   * Side effects: appends one line to the log file (when configured) and, asynchronously and without
   * waiting, to the shared governance store.
   *
   * @param event - Event to record (copied into the entry).
   * @returns The new entry; `seq` is 0-based here.
   */
  append(event: GovernanceEvent): GovernanceEntry {
    const auditRecord: AuditRecord = {
      ts: event.ts,
      tenantId: event.tenantId,
      actor: event.actor,
      action: event.action,
      meta: event.meta,
    };

    const prevHash = this.lastHash;
    const hash = chainHash(prevHash, auditRecord);
    const entry: GovernanceEntry = {
      ...event,
      seq: this.entries.length,
      hash,
    };

    this.entries.push(entry);
    this.lastHash = hash;

    if (this.logPath) {
      this._appendToDisk(entry);
    }

    // H2.6: Delegate to IGovernanceStore for cross-instance durability.
    // Fire-and-forget — failures are non-fatal (in-memory trail is authoritative locally).
    // Dynamic import avoids runtime circular reference.
    import('./IGovernanceStore.js').then(({ getGovernanceStore }) => {
      getGovernanceStore().append(event, prevHash).catch(() => { /* non-fatal */ });
    }).catch(() => { /* non-fatal */ });

    return entry;
  }

  /**
   * List all governance events, optionally filtered by tenantId.
   *
   * Note: without a filter the internal array itself is returned frozen, so a later `append()` on the same
   * trail fails (TypeError on a frozen array); pass a filter or copy the result if more events will follow.
   *
   * @param filter - Optional tenant and action filters (both must match).
   * @returns The matching entries, frozen.
   */
  list(filter?: { tenantId?: string; action?: GovernanceAction }): readonly GovernanceEntry[] {
    let result: GovernanceEntry[] = this.entries;
    if (filter?.tenantId) {
      result = result.filter(e => e.tenantId === filter.tenantId);
    }
    if (filter?.action) {
      result = result.filter(e => e.action === filter.action);
    }
    return Object.freeze(result);
  }

  /**
   * Get the total number of events.
   * @returns Number of events in memory.
   */
  count(): number {
    return this.entries.length;
  }

  /**
   * Get the latest chain hash.
   * @returns The hash of the last event, or the genesis hash when empty.
   */
  headHash(): string {
    return this.lastHash;
  }

  /**
   * Verify chain integrity. Returns true if no tampering detected.
   * @returns `true` when every hash matches its recomputed value.
   */
  verifyIntegrity(): boolean {
    let prevHash = GENESIS_HASH;
    for (const entry of this.entries) {
      const auditRecord: AuditRecord = {
        ts: entry.ts,
        tenantId: entry.tenantId,
        actor: entry.actor,
        action: entry.action,
        meta: entry.meta,
      };
      const expected = chainHash(prevHash, auditRecord);
      if (expected !== entry.hash) return false;
      prevHash = entry.hash;
    }
    return true;
  }

  /**
   * Clear all entries (for testing only).
   */
  clearForTest(): void {
    this.entries = [];
    this.lastHash = GENESIS_HASH;
  }

  // ── Persistence ─────────────────────────────────────────────

  private _loadFromDisk(): void {
    if (!this.logPath || !existsSync(this.logPath)) return;

    try {
      const content = readFileSync(this.logPath, 'utf-8').trim();
      if (!content) return;

      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as GovernanceEntry;
        this.entries.push(entry);
        this.lastHash = entry.hash;
      }
    } catch {
      // If file is corrupt, start fresh (append-only — old data preserved)
    }
  }

  private _appendToDisk(entry: GovernanceEntry): void {
    if (!this.logPath) return;
    try {
      const line = JSON.stringify(entry) + '\n';
      if (!existsSync(this.logPath)) {
        writeFileSync(this.logPath, line, 'utf-8');
      } else {
        appendFileSync(this.logPath, line, 'utf-8');
      }
    } catch {
      // Silently fail persistence — in-memory trail is still intact
    }
  }
}

// ── Singleton ───────────────────────────────────────────────

let _singleton: GovernanceTrail | undefined;

/**
 * Get or create the process-level GovernanceTrail singleton.
 * @returns The shared trail (created on the first call; it may read the log file then).
 */
export function getGovernanceTrail(): GovernanceTrail {
  if (!_singleton) {
    _singleton = new GovernanceTrail();
  }
  return _singleton;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetGovernanceTrailForTest(): void {
  _singleton = undefined;
}
