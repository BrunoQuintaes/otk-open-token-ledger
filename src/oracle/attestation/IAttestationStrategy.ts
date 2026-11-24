/**
 * IAttestationStrategy — pluggable attestation mechanism interface.
 *
 * An attestation strategy is responsible for producing an OracleAttestation
 * from raw prompt/completion + provider event data. Different strategies
 * offer different trust guarantees:
 *
 *   operator_recount — current default (U12-oracle-level-ac; was 'provider_signed', D1-G07)
 *                      Provider-declared tokens captured by the operator + operator-side local recount.
 *                      Trust: client hash + provider data. Oracle limitation applies.
 *
 *   tee_tls_notary   — FUTURE WORK (U12.9, beyond dissertation scope)
 *                      TEE (Trusted Execution Environment) or TLSNotary attestation.
 *                      Would eliminate oracle problem at execution layer.
 *                      NOT IMPLEMENTED — throws AttestationNotImplementedError.
 *
 * See: docs/architecture/adr/ADR-0004 (oracle limitation), dissertacao §5.2 (limitations)
 *
 * @module oracle/attestation/IAttestationStrategy
 * @since U12.9.1
 */

import type {
  OracleAttestationInput,
  OracleAttestationResult,
} from '../../metering/OracleAttestationEngine.js';

/** Re-export for convenience so consumers only import from this module. */
export type AttestationInput  = OracleAttestationInput;
export type AttestationResult = OracleAttestationResult;

/** Supported attestation strategy identifiers. */
export type AttestationStrategyId = 'operator_recount' | 'tee_tls_notary';
/** D1-G07: legacy configuration value, read as an alias of 'operator_recount' (never written). */
export type LegacyAttestationStrategyId = 'provider_signed';

/**
 * Pluggable attestation strategy interface.
 *
 * Implementations MUST be stateless — the same input always produces the
 * same output. Async strategies return Promise<AttestationResult>.
 */
export interface IAttestationStrategy {
  /** Stable identifier for this strategy. */
  readonly strategyId: AttestationStrategyId;

  /** Human-readable description (for logs/docs). */
  readonly description: string;

  /**
   * Produce an attestation from provider event data + raw text.
   *
   * @param input  Prompt/completion text + provider token counts.
   * @returns      Full OracleAttestation + supporting diagnostics.
   * @throws       AttestationNotImplementedError for future-proof stubs.
   */
  attest(input: AttestationInput): AttestationResult;
}

/**
 * Thrown by stub strategies that are not yet implemented.
 * Code is stable and intended for programmatic matching.
 */
export class AttestationNotImplementedError extends Error {
  readonly code = 'ATTESTATION_NOT_IMPLEMENTED' as const;
  readonly strategyId: AttestationStrategyId;

  constructor(strategyId: AttestationStrategyId, detail: string) {
    super(`NOT_IMPLEMENTED: ${detail} (strategyId=${strategyId})`);
    this.name = 'AttestationNotImplementedError';
    this.strategyId = strategyId;
  }
}
