/**
 * G4 — Multichain Runtime (process-level singleton)
 *
 * Provides a process-level ChainRegistry singleton.
 * Mirrors the pattern of F1 (getCollector), F4 (getLimiter), G3 (getOracleConfig).
 *
 * Default: built-in NETWORKS + DEPLOYMENTS from chainRegistry.ts.
 * Override: setChainRegistry() for operator injection (e.g. production deployments).
 *
 * @module src/infra/multichainRuntime
 * @since G4
 */

import { ChainRegistry } from './chainRegistry.js';

let _registry = new ChainRegistry();

/**
 * Get the process-level ChainRegistry singleton.
 *
 * @returns The registry in use.
 */
export function getChainRegistry(): ChainRegistry {
  return _registry;
}

/**
 * Override the process-level ChainRegistry.
 * Use for operator injection of production deployment addresses.
 *
 * @param registry - Registry to use from now on.
 */
export function setChainRegistry(registry: ChainRegistry): void {
  _registry = registry;
}

/** Reset to the default ChainRegistry (for test isolation). */
export function resetChainRegistry(): void {
  _registry = new ChainRegistry();
}
