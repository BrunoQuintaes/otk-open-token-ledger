/**
 * Compliance Types — canonical contract for data handling in OTK zk-Metering (F2.1)
 *
 * Defines the minimal compliance vocabulary:
 *   DataClass:         sensitivity level of a data item
 *   RetentionHint:     how long data should be kept (informational; enforcement is out-of-scope)
 *   MinimizationMode:  how aggressively to strip identifiers before export/audit
 *   ComplianceProfile: combination used as a single policy object
 *
 * Preset profiles are provided for common scenarios.
 *
 * Scope (in-scope for F2):
 *   - type definitions and preset profiles
 *   - data classification at the usage-event level
 *   - minimization and retention hints for audit/export surfaces
 *
 * Scope (out-of-scope for F2):
 *   - GDPR/LGPD legal compliance certification
 *   - automated purge / scheduled deletion infra
 *   - encryption-at-rest or in-transit enforcement
 *   - dynamic regulatory policy fetching from external sources
 *
 * @module src/privacy/complianceTypes
 * @since F2.1
 */

/** Sensitivity level of a data item or event. */
export type DataClass = 'public' | 'internal' | 'sensitive' | 'restricted';

/**
 * How long data should be retained.
 * Informational hint — actual enforcement is performed by infra outside this module.
 */
export type RetentionHint =
  | 'ephemeral'   // discard after session / single request
  | 'short_term'  // up to 30 days
  | 'long_term'   // up to 1 year
  | 'permanent';  // indefinite (e.g., audit evidence)

/**
 * How aggressively to strip PII/identifiers before export or audit emission.
 *
 *   full:      preserve all non-secret fields (requestId, granular tokens, model)
 *   aggregate: suppress per-request identifiers (requestId removed)
 *   redacted:  maximum privacy — requestId removed, model name replaced with '[redacted]'
 */
export type MinimizationMode = 'full' | 'aggregate' | 'redacted';

/** Composite compliance policy applied to a data item or export surface. */
export type ComplianceProfile = {
  /** Sensitivity of the data. */
  dataClass: DataClass;
  retentionHint: RetentionHint;
  minimizationMode: MinimizationMode;
};

/**
 * Preset compliance profiles for common scenarios.
 * Callers may derive custom profiles from these or compose their own.
 */
export const COMPLIANCE_PROFILES = {
  /** Default: internal data, 30-day retention, full field fidelity. */
  DEFAULT: {
    dataClass: 'internal',
    retentionHint: 'short_term',
    minimizationMode: 'full',
  } as ComplianceProfile,

  /** Strict: sensitive data, ephemeral retention, maximum minimization. */
  STRICT: {
    dataClass: 'sensitive',
    retentionHint: 'ephemeral',
    minimizationMode: 'redacted',
  } as ComplianceProfile,

  /** Audit: internal data, long-term retention, aggregate (no request IDs). */
  AUDIT: {
    dataClass: 'internal',
    retentionHint: 'long_term',
    minimizationMode: 'aggregate',
  } as ComplianceProfile,
} as const;
