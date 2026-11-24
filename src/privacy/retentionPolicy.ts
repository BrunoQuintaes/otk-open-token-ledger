/**
 * Retention Policy — maps RetentionHint to concrete policy parameters (F2.2)
 *
 * Informational: maxAgeSecs and purgeable are hints for infra/ops tooling.
 * No automated purge is performed by this module.
 *
 * @module privacy/retentionPolicy
 * @since F2.2
 */

import type { RetentionHint } from './complianceTypes.js';

export type RetentionPolicy = {
  retentionHint: RetentionHint;
  /** Maximum age in seconds (Number.MAX_SAFE_INTEGER = indefinite). */
  maxAgeSecs: number;
  /** Whether records with this hint may be purged by infra tooling. */
  purgeable: boolean;
};

const POLICIES: Record<RetentionHint, RetentionPolicy> = {
  ephemeral:  { retentionHint: 'ephemeral',  maxAgeSecs: 3_600,              purgeable: true  },
  short_term: { retentionHint: 'short_term', maxAgeSecs: 86_400 * 30,        purgeable: true  },
  long_term:  { retentionHint: 'long_term',  maxAgeSecs: 86_400 * 365,       purgeable: false },
  permanent:  { retentionHint: 'permanent',  maxAgeSecs: Number.MAX_SAFE_INTEGER, purgeable: false },
};

/** Returns the canonical RetentionPolicy for the given hint. */
export function getRetentionPolicy(hint: RetentionHint): RetentionPolicy {
  return POLICIES[hint];
}

/** Returns true if records with this hint may be purged by infra tooling. */
export function isPurgeable(hint: RetentionHint): boolean {
  return POLICIES[hint].purgeable;
}
