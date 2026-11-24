/**
 * OPS-07 — Sepolia migration support
 *
 * Configuration for migrating from Besu IBFT (local dev) to Ethereum Sepolia
 * testnet.  Activated by setting OTK_CHAIN_TARGET=sepolia in the environment.
 *
 * Usage:
 *   const cfg = getChainConfig();
 *   // cfg.rpc, cfg.chainId, cfg.name
 *
 * The INFURA_PROJECT_ID placeholder in SEPOLIA_RPC is intentional — callers
 * must substitute the actual project ID from their secrets store before use.
 *
 * @module infra/chain/SepoliaConfig
 * @since W9-B (OPS-07)
 */

export const SEPOLIA_RPC = 'https://sepolia.infura.io/v3/${INFURA_PROJECT_ID}';

export const CHAIN_TARGETS = {
  besu: { chainId: 1337, rpc: 'http://localhost:8545', name: 'Besu IBFT (dev)' },
  sepolia: { chainId: 11155111, rpc: SEPOLIA_RPC, name: 'Ethereum Sepolia (testnet)' },
} as const;

export type ChainTarget = keyof typeof CHAIN_TARGETS;

/**
 * Read OTK_CHAIN_TARGET from the environment.
 * Defaults to 'besu' for backward compatibility with existing dev/CI setups.
 */
export function getChainTarget(): ChainTarget {
  const t = process.env['OTK_CHAIN_TARGET'];
  return (t === 'sepolia' ? 'sepolia' : 'besu') as ChainTarget;
}

/**
 * Return the full chain configuration for the active target.
 */
export function getChainConfig(): (typeof CHAIN_TARGETS)[ChainTarget] {
  return CHAIN_TARGETS[getChainTarget()];
}
