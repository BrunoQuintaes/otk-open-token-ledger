/**
 * Data Minimizer — applies ComplianceProfile to a NormalizedUsageEvent (F2.2)
 *
 * Produces a MinimizedEvent safe for audit/export surfaces.
 * Also provides a bridge to AuditLogChain via toComplianceAuditRecord().
 *
 * Minimization modes (see complianceTypes.ts for definitions):
 *   full:      all non-secret fields preserved, including requestId
 *   aggregate: requestId suppressed (no per-request correlation)
 *   redacted:  requestId suppressed + model name replaced with '[redacted]'
 *
 * This function never throws. All inputs are validated inline.
 *
 * @module privacy/dataMinimizer
 * @since F2.2
 */

import type { ComplianceProfile } from './complianceTypes.js';
import type { NormalizedUsageEvent } from '../providers/types.js';
import type { AuditRecord } from '../security/AuditLogChain.js';

/** Minimized usage event — safe for export, logging, and audit surfaces. */
export type MinimizedEvent = {
  provider: string;
  model: string;       // '[redacted]' in redacted mode
  totalTokens: number;
  costUnits: number;
  timestamp: number;
  retentionHint: string;
  requestId?: string;  // absent in aggregate/redacted modes
};

/**
 * Apply compliance minimization to a NormalizedUsageEvent.
 *
 * @param event   Source usage event from an adapter
 * @param profile ComplianceProfile governing minimization mode and retention
 * @returns       MinimizedEvent safe for export/audit surfaces
 */
export function minimizeEvent(
  event: NormalizedUsageEvent,
  profile: ComplianceProfile,
): MinimizedEvent {
  const base: MinimizedEvent = {
    provider: event.provider,
    model: event.model,
    totalTokens: event.totalTokens,
    costUnits: event.costUnits,
    timestamp: event.timestamp,
    retentionHint: profile.retentionHint,
  };

  switch (profile.minimizationMode) {
    case 'redacted':
      // Maximum privacy: suppress requestId, replace model with placeholder
      return { ...base, model: '[redacted]' };

    case 'aggregate':
      // Aggregate mode: suppress per-request identifier (requestId)
      return base;

    case 'full':
    default:
      // Full fidelity: include requestId for correlation
      return { ...base, requestId: event.requestId };
  }
}

/**
 * Convert a MinimizedEvent to an AuditRecord for use with AuditLogChain.chainHash().
 *
 * The resulting record is audit-safe: it contains only the minimized fields,
 * no raw prompts or secrets.
 *
 * @param minimized  Output of minimizeEvent()
 * @param tenantId   Tenant identifier for the audit record
 * @param actor      Actor identifier (userId or service name)
 * @param nowIso     ISO 8601 timestamp (injectable for determinism)
 */
export function toComplianceAuditRecord(
  minimized: MinimizedEvent,
  tenantId: string,
  actor: string,
  nowIso: string,
): AuditRecord {
  const meta: Record<string, unknown> = {
    provider: minimized.provider,
    model: minimized.model,
    totalTokens: minimized.totalTokens,
    costUnits: minimized.costUnits,
    retentionHint: minimized.retentionHint,
  };
  if (minimized.requestId !== undefined) {
    meta['requestId'] = minimized.requestId;
  }
  return { ts: nowIso, tenantId, actor, action: 'usage_metered', meta };
}
