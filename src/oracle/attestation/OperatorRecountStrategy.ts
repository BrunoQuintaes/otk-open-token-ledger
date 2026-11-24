/**
 * OperatorRecountStrategy — default attestation strategy (Level A+C), renamed from
 * ProviderSignedStrategy (D1-G07, specification A/ESPEC_NOMES_D1G07.md, applied by S4).
 *
 * Delegates to OracleAttestationEngine:
 *   - Level A: local hash of prompt + completion text, computed by the operator
 *   - Level C: operator-side local token recount via TokenizerRegistry
 *              + discrepancy detection vs provider-declared counts
 *
 * Trust model: the provider-declared token counts are captured by the operator; the local recount
 * is auxiliary. No component verifies a signature issued by an AI provider, and this report does
 * not prove the provider measured correctly (oracle problem §5.2). For stronger guarantees see
 * FutureProofStrategy (TEE/TLSNotary).
 *
 * @module oracle/attestation/OperatorRecountStrategy
 * @since U12.9.1 (as ProviderSignedStrategy); renamed in run 20260930-1625 (D1-G07)
 */

import {
  OracleAttestationEngine,
  defaultOracleEngine,
} from '../../metering/OracleAttestationEngine.js';
import type {
  IAttestationStrategy,
  AttestationInput,
  AttestationResult,
} from './IAttestationStrategy.js';

export class OperatorRecountStrategy implements IAttestationStrategy {
  readonly strategyId = 'operator_recount' as const;
  readonly description =
    'Operator-side recount: local hash of prompt/completion and local token recount compared with the provider-declared counts. ' +
    "Integrity of this report rests on the operator's key; it is not a provider signature and does not prove the provider measured correctly.";

  private readonly engine: OracleAttestationEngine;

  constructor(engine: OracleAttestationEngine = defaultOracleEngine) {
    this.engine = engine;
  }

  attest(input: AttestationInput): AttestationResult {
    return this.engine.attest(input);
  }
}

/** Default singleton — uses default OracleAttestationEngine. */
export const operatorRecountStrategy = new OperatorRecountStrategy();
