/**
 * AttestationStrategyFactory — env-driven factory for IAttestationStrategy.
 *
 * Environment variable:
 *   ATTESTATION_MODE  'operator_recount' | 'tee_tls_notary'
 *   Default:          'operator_recount'
 *   'provider_signed' (pre-D1-G07 name) is read as an alias of 'operator_recount', with a warning once.
 *
 * Usage:
 *   const strategy = AttestationStrategyFactory.resolve();
 *   const result   = strategy.attest(input);
 *
 * In this version only the unit tests import this module; the durable proxy does not use it. The default
 * strategy is resolved once, when the module is first imported.
 *
 * @module src/oracle/attestation/AttestationStrategyFactory
 * @since U12.9.1
 */

import type { IAttestationStrategy, AttestationStrategyId, LegacyAttestationStrategyId } from './IAttestationStrategy.js';
import { operatorRecountStrategy } from './OperatorRecountStrategy.js';
import { futureProofStrategy } from './FutureProofStrategy.js';

/** Registry: strategyId → singleton instance */
const REGISTRY: Record<AttestationStrategyId, IAttestationStrategy> = {
  operator_recount: operatorRecountStrategy,
  tee_tls_notary:  futureProofStrategy,
};

/**
 * Resolve the active ATTESTATION_MODE from environment.
 * Defaults to 'operator_recount' if unset or unrecognised; the legacy value 'provider_signed' is an
 * explicit read alias (D1-G07).
 */
let legacyWarned = false;
/**
 * Reads ATTESTATION_MODE and maps it to a registered strategy id.
 *
 * Side effect: the first time the legacy value is read, one JSON warning line is written to stderr.
 *
 * @returns The strategy id; `operator_recount` for unset, unknown or legacy values.
 */
export function resolveAttestationMode(): AttestationStrategyId {
  const raw = process.env['ATTESTATION_MODE'] ?? '';
  if (raw === 'provider_signed') {
    if (!legacyWarned) { legacyWarned = true; process.stderr.write(JSON.stringify({ event: 'attestation_mode_alias', from: 'provider_signed', to: 'operator_recount', reason: 'D1-G07: no provider signature exists' }) + '\n'); }
    return 'operator_recount';
  }
  return Object.hasOwn(REGISTRY, raw)
    ? (raw as AttestationStrategyId)
    : 'operator_recount';
}

/** Static accessors for the registered attestation strategies. */
export class AttestationStrategyFactory {
  /**
   * Resolve the strategy configured by ATTESTATION_MODE env.
   * Always returns a registered, non-null strategy.
   *
   * @returns The configured strategy (`tee_tls_notary` resolves to a stub whose `attest` throws).
   */
  static resolve(): IAttestationStrategy {
    return REGISTRY[resolveAttestationMode()];
  }

  /**
   * Resolve a strategy by explicit id (ignores env).
   * Throws if the id is unknown.
   *
   * @param id - Strategy id; the legacy `provider_signed` returns the operator-recount strategy.
   * @returns The registered strategy.
   * @throws {Error} When the id is not registered.
   */
  static get(id: AttestationStrategyId | LegacyAttestationStrategyId): IAttestationStrategy {
    const s = id === 'provider_signed' ? REGISTRY.operator_recount : REGISTRY[id];
    if (!s) throw new Error(`Unknown attestation strategy: ${id}`);
    return s;
  }

  /**
   * List all registered strategy ids.
   *
   * @returns The ids (the legacy alias is not included).
   */
  static listStrategies(): AttestationStrategyId[] {
    return Object.keys(REGISTRY) as AttestationStrategyId[];
  }
}

/** Default active strategy singleton — resolved once at import. */
export const defaultAttestationStrategy: IAttestationStrategy =
  AttestationStrategyFactory.resolve();
