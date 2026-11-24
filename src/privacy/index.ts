/**
 * Privacy & Compliance public API (F2)
 *
 * Lateral compliance layer — does not alter core CU/ZK/Registry/Economic semantics.
 *
 * Usage:
 *   import { minimizeEvent, COMPLIANCE_PROFILES } from '../privacy/index.js';
 *   const safe = minimizeEvent(event, COMPLIANCE_PROFILES.STRICT);
 *   const auditRec = toComplianceAuditRecord(safe, tenantId, actor, nowIso);
 *
 * @since F2
 */

export type { DataClass, RetentionHint, MinimizationMode, ComplianceProfile } from './complianceTypes.js';
export { COMPLIANCE_PROFILES } from './complianceTypes.js';

export type { RetentionPolicy } from './retentionPolicy.js';
export { getRetentionPolicy, isPurgeable } from './retentionPolicy.js';

export type { MinimizedEvent } from './dataMinimizer.js';
export { minimizeEvent, toComplianceAuditRecord } from './dataMinimizer.js';
