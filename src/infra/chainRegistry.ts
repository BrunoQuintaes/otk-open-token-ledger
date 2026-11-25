/**
 * G4 — Chain Registry
 *
 * Canonical registry of known networks and OTK contract deployments.
 *
 * Networks:
 *   1337  — ibft-local  (OTK development IBFT cluster, evmVersion=berlin)
 *   1     — ethereum    (mainnet stub — no deployed contracts yet)
 *   137   — polygon     (stub — no deployed contracts yet)
 *   11155111 — sepolia  (testnet stub — deployment pending)
 *
 * Deployments on chainId=1337 (ibft-local):
 *   ReceiptRegistry     — core on-chain receipt store (ADR-0002)
 *   MeteringVerifierV2  — Groth16 verifier (MPC ceremony key)
 *
 * All other chains: status='pending' until explicitly deployed.
 *
 * HONEST SCOPE NOTE:
 *   This registry is a deterministic in-memory source of truth.
 *   It does NOT query live chains. Addresses for chainId=1337 are
 *   dev-only placeholders — actual deployed addresses vary per local run.
 *   Production deployments require operator injection via addDeployment().
 *
 * The process-wide instance is held by `multichainRuntime.ts`.
 *
 * @module src/infra/chainRegistry
 * @since G4
 */

import type {
  ChainId,
  NetworkProfile,
  DeploymentRecord,
  SubgraphRef,
} from './multichainTypes.js';

// ---------------------------------------------------------------------------
// Known networks
// ---------------------------------------------------------------------------

const NETWORKS: readonly NetworkProfile[] = [
  {
    chainId: 1337,
    name: 'ibft-local',
    rpcRef: 'http://127.0.0.1:9545',
    nativeCurrency: 'ETH',
    evmVersion: 'berlin',
  },
  {
    chainId: 1,
    name: 'ethereum',
    rpcRef: 'https://mainnet.rpc.example',
    nativeCurrency: 'ETH',
    evmVersion: 'cancun',
    explorerUrl: 'https://etherscan.io',
  },
  {
    chainId: 137,
    name: 'polygon',
    rpcRef: 'https://polygon.rpc.example',
    nativeCurrency: 'MATIC',
    evmVersion: 'paris',
    explorerUrl: 'https://polygonscan.com',
  },
  {
    chainId: 11155111,
    name: 'sepolia',
    rpcRef: 'https://sepolia.rpc.example',
    nativeCurrency: 'ETH',
    evmVersion: 'cancun',
    explorerUrl: 'https://sepolia.etherscan.io',
  },
] as const;

// ---------------------------------------------------------------------------
// Known deployments
// ---------------------------------------------------------------------------

/**
 * Dev-only placeholder addresses for ibft-local.
 * Format: 0xDeaD0000…<contract-index> — visually distinguishable, never real.
 * Actual addresses depend on deployment order in local cluster.
 */
const DEPLOYMENTS: readonly DeploymentRecord[] = [
  {
    chainId: 1337,
    contractName: 'ReceiptRegistry',
    address: '0xDeaD000000000000000000000000000000001001',
    deployedAt: 'dev-only',
    version: 'U8.5.3',
    status: 'dev-only',
  },
  {
    chainId: 1337,
    contractName: 'MeteringVerifierV2',
    address: '0xDeaD000000000000000000000000000000001002',
    deployedAt: 'dev-only',
    version: 'metering_v2-mpc-final',
    status: 'dev-only',
  },
  {
    chainId: 1,
    contractName: 'ReceiptRegistry',
    address: '0x0000000000000000000000000000000000000000',
    deployedAt: 'pending',
    version: 'U8.5.3',
    status: 'pending',
  },
  {
    chainId: 137,
    contractName: 'ReceiptRegistry',
    address: '0x0000000000000000000000000000000000000000',
    deployedAt: 'pending',
    version: 'U8.5.3',
    status: 'pending',
  },
] as const;

// ---------------------------------------------------------------------------
// Default subgraph refs
// ---------------------------------------------------------------------------

const SUBGRAPH_REFS: readonly SubgraphRef[] = [
  {
    chainId: 1337,
    name: 'otk-receipts',
    endpoint: 'http://localhost:8000/subgraphs/name/otk-receipts',
    status: 'stub',
  },
  {
    chainId: 1,
    name: 'otk-receipts',
    endpoint: 'https://api.thegraph.com/subgraphs/name/otk/receipts',
    status: 'unavailable',
  },
] as const;

// ---------------------------------------------------------------------------
// ChainRegistry class
// ---------------------------------------------------------------------------

/** In-memory lookup of networks, contract deployments and subgraphs by chain id. */
export class ChainRegistry {
  private readonly _networks = new Map<ChainId, NetworkProfile>();
  private readonly _deployments = new Map<string, DeploymentRecord>();
  private readonly _subgraphs = new Map<string, SubgraphRef>();

  /**
   * Builds the registry; later entries with the same key replace earlier ones.
   *
   * @param networks - Network profiles (default: the built-in list).
   * @param deployments - Deployment records (default: the built-in list).
   * @param subgraphs - Subgraph references (default: the built-in list).
   */
  constructor(
    networks: readonly NetworkProfile[] = NETWORKS,
    deployments: readonly DeploymentRecord[] = DEPLOYMENTS,
    subgraphs: readonly SubgraphRef[] = SUBGRAPH_REFS,
  ) {
    for (const n of networks) this._networks.set(n.chainId, n);
    for (const d of deployments) this._deployments.set(_dkey(d.chainId, d.contractName), d);
    for (const s of subgraphs) this._subgraphs.set(_skey(s.chainId, s.name), s);
  }

  /**
   * Get the network profile for a chain ID. Returns undefined if unknown.
   *
   * @param chainId - Chain id.
   * @returns The profile, or undefined.
   */
  getChain(chainId: ChainId): NetworkProfile | undefined {
    return this._networks.get(chainId);
  }

  /**
   * List all known network profiles.
   *
   * @returns Profiles in insertion order.
   */
  listChains(): NetworkProfile[] {
    return Array.from(this._networks.values());
  }

  /**
   * Get a deployment record. Returns undefined if not found.
   *
   * @param chainId - Chain id.
   * @param contractName - Contract name, e.g. `ReceiptRegistry`.
   * @returns The record, or undefined.
   */
  getDeployment(chainId: ChainId, contractName: string): DeploymentRecord | undefined {
    return this._deployments.get(_dkey(chainId, contractName));
  }

  /**
   * Get all deployments for a given chain.
   *
   * @param chainId - Chain id.
   * @returns The chain's records (empty when none).
   */
  getDeploymentsByChain(chainId: ChainId): DeploymentRecord[] {
    return Array.from(this._deployments.values()).filter(d => d.chainId === chainId);
  }

  /**
   * Get the subgraph reference for a chain + name. Returns undefined if not registered.
   *
   * @param chainId - Chain id.
   * @param name - Subgraph name.
   * @returns The reference, or undefined.
   */
  getSubgraphRef(chainId: ChainId, name: string): SubgraphRef | undefined {
    return this._subgraphs.get(_skey(chainId, name));
  }

  /**
   * Add or overwrite a deployment record (operator injection).
   * Used for production deployments not known at build time.
   *
   * @param record - Deployment to store (kept by reference).
   */
  addDeployment(record: DeploymentRecord): void {
    this._deployments.set(_dkey(record.chainId, record.contractName), record);
  }
}

function _dkey(chainId: ChainId, name: string): string {
  return `${chainId}::${name}`;
}

function _skey(chainId: ChainId, name: string): string {
  return `${chainId}::${name}`;
}
