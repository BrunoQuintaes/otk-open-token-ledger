/**
 * FutureProofStrategy — stub for future TEE/TLSNotary attestation (U12.9).
 *
 * ## What this represents
 *
 * TEE (Trusted Execution Environment) attestation — e.g., Intel SGX, AMD SEV —
 * would run the AI inference inside a hardware-isolated enclave that produces
 * a cryptographic quote verifiable by any party, eliminating the oracle problem.
 *
 * TLSNotary attestation — e.g., tlsnotary.org — would prove the TLS session
 * content (provider response) via a cryptographic protocol between the prover
 * and a notary, without the provider's cooperation.
 *
 * ## Current status
 *
 * NOT IMPLEMENTED. This stub:
 *   1. Satisfies the IAttestationStrategy interface at the type level.
 *   2. Throws AttestationNotImplementedError on any call to attest().
 *   3. Is registered in AttestationStrategyFactory under 'tee_tls_notary'.
 *   4. Is documented as future work in dissertacao §5.3 (trabalhos futuros).
 *
 * ## References
 *
 * - KANG et al., 2022 — zkML: verifiable ML inference via ZK proofs
 * - TLSNotary project (tlsnotary.org) — TLS attestation without MitM
 * - Intel SGX SDK — TEE attestation framework
 * - Dissertação FGV §5.3: "Mitigações Level D — WebProofs/TEE"
 *
 * @module src/oracle/attestation/FutureProofStrategy
 * @since U12.9.1
 */

import type {
  IAttestationStrategy,
  AttestationInput,
  AttestationResult,
} from './IAttestationStrategy.js';
import { AttestationNotImplementedError } from './IAttestationStrategy.js';

/** Placeholder strategy for TEE/TLSNotary attestation; every call to `attest` throws. */
export class FutureProofStrategy implements IAttestationStrategy {
  readonly strategyId = 'tee_tls_notary' as const;
  readonly description =
    'Future attestation strategy: TEE (Intel SGX/AMD SEV) or TLSNotary. ' +
    'NOT IMPLEMENTED — reserved for U12.9 (post-dissertation scope). ' +
    'See dissertacao §5.3 (trabalhos futuros) and ADR-0004 §Mitigation Level D.';

  /**
   * Always throws — this strategy is not implemented.
   *
   * @param _input - Ignored.
   * @returns Never returns.
   * @throws {AttestationNotImplementedError} always.
   */
  attest(_input: AttestationInput): AttestationResult {
    throw new AttestationNotImplementedError(
      'tee_tls_notary',
      'TEE/TLSNotary attestation is future work (U12.9, post-dissertation scope). ' +
      'Use ATTESTATION_MODE=operator_recount for current functionality.'
    );
  }
}

/** Singleton stub — will throw on any attest() call. */
export const futureProofStrategy = new FutureProofStrategy();
