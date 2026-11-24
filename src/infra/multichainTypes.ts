/**
 * G4 — Multichain Contract Foundation
 *
 * Canonical type contracts for chain identity, network profiles,
 * deployment records, and subgraph references in the OTK ecosystem.
 *
 * Design principles:
 *   - Lateral to core: no dependency on CU/ZK/Registry/Economic modules
 *   - All data injected — no hidden process.env reads
 *   - Deterministic: same input → same output for all pure functions
 *   - Honest about scope: stubs marked explicitly, no production endpoints hardcoded
 *
 * In scope: types, registry, query surface stub
 * Out of scope: live bridge, real subgraph host, cross-chain sync, relayers
 *
 * @module infra/multichainTypes
 * @since G4
 */

/** EIP-155 chain identifier. */
export type ChainId = number;

/** Deployment status for a contract on a given chain. */
export type DeploymentStatus = 'active' | 'pending' | 'deprecated' | 'dev-only';

/**
 * Network profile — identifies a chain by ID, name, RPC reference, and EVM version.
 *
 * rpcRef is a reference string only — it is NOT fetched automatically.
 * Operators must inject live RPC URLs at runtime.
 */
export type NetworkProfile = {
  /** EIP-155 chain ID */
  chainId: ChainId;
  /** Human-readable name (e.g. 'ibft-local', 'ethereum', 'polygon') */
  name: string;
  /** RPC endpoint reference — injected by operator, not fetched */
  rpcRef: string;
  /** Native currency symbol */
  nativeCurrency: string;
  /** EVM version for compatibility (e.g. 'berlin', 'paris') */
  evmVersion: 'berlin' | 'london' | 'paris' | 'cancun';
  /** Block explorer URL (optional, for documentation) */
  explorerUrl?: string;
};

/**
 * A deployment record linking a contract to a chain, address, and version.
 *
 * address is a placeholder for chains where deployment hasn't happened.
 * Use status='pending' to signal undeployed, status='dev-only' for local dev.
 */
export type DeploymentRecord = {
  chainId: ChainId;
  /** Contract name matching tools/hardhat/contracts/ */
  contractName: string;
  /** Checksummed Ethereum address */
  address: string;
  /** ISO timestamp or 'dev-only' / 'pending' */
  deployedAt: string;
  /** Transaction hash (if known) */
  txHash?: string;
  /** Contract version tag */
  version: string;
  /** Deployment status */
  status: DeploymentStatus;
};

/**
 * Reference to a subgraph endpoint for a given chain.
 *
 * In development: always status='stub' — no live indexing.
 * In production: status='active' with injected endpoint URL.
 */
export type SubgraphRef = {
  chainId: ChainId;
  /** Subgraph name (e.g. 'otk-receipts', 'otk-metering') */
  name: string;
  /**
   * Endpoint URL reference — injected by operator.
   * In dev: placeholder string, never fetched.
   */
  endpoint: string;
  status: 'active' | 'stub' | 'unavailable';
};

/** A query against a subgraph or chain-read surface. */
export type SubgraphQuery = {
  chainId: ChainId;
  queryType:
    | 'receipts_by_tenant'
    | 'receipts_by_epoch'
    | 'verifier_stats'
    | 'deployment_info';
  filter: Record<string, unknown>;
};

/** Result from a subgraph/query surface evaluation. */
export type SubgraphResult = {
  chainId: ChainId;
  queryType: SubgraphQuery['queryType'];
  /** 'stub' in dev; 'live' in production; 'error' on failure */
  status: 'stub' | 'live' | 'error';
  data: unknown[];
  /** Human-readable note (especially for stub/error cases) */
  note?: string;
};
