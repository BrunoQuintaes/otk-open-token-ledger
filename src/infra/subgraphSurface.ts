/**
 * G4 — Subgraph Query Surface (stub-first)
 *
 * Provides a minimal, deterministic query surface for chain-indexed data.
 *
 * HONEST SCOPE:
 *   In this phase, all queries return status='stub'. No live subgraph
 *   is hosted or queried. The surface documents the intended query API
 *   so that production wiring requires only implementing _fetchLive().
 *
 * Design:
 *   - buildSubgraphQuery(): pure factory — no I/O
 *   - executeSubgraphQuery(): pure evaluator — stub response, no network
 *   - Extension point: inject a fetchFn for production wiring
 *
 * @module infra/subgraphSurface
 * @since G4
 */

import type {
  ChainId,
  SubgraphQuery,
  SubgraphResult,
  SubgraphRef,
} from './multichainTypes.js';
import type { ChainRegistry } from './chainRegistry.js';

// ---------------------------------------------------------------------------
// Query builder (pure)
// ---------------------------------------------------------------------------

/**
 * Build a typed subgraph query.
 * Pure function — validates queryType, returns structured SubgraphQuery.
 */
export function buildSubgraphQuery(
  chainId: ChainId,
  queryType: SubgraphQuery['queryType'],
  filter: Record<string, unknown> = {},
): SubgraphQuery {
  return { chainId, queryType, filter };
}

// ---------------------------------------------------------------------------
// Query executor (stub-first, pure in dev)
// ---------------------------------------------------------------------------

/**
 * Execute a subgraph query against the registry.
 *
 * Evaluation logic:
 *   1. Unknown chain → status='error'
 *   2. Known chain, no subgraph ref → status='stub' with note
 *   3. Known chain, subgraph status='stub'|'unavailable' → status='stub'
 *   4. Known chain, subgraph status='active' (production) → would call fetchFn
 *
 * In all dev/CI contexts: returns stub with empty data array and a note.
 *
 * @param query   - Query built with buildSubgraphQuery()
 * @param registry - ChainRegistry to resolve chain + subgraph refs
 * @param subgraphName - Subgraph name to look up (default: 'otk-receipts')
 */
export function executeSubgraphQuery(
  query: SubgraphQuery,
  registry: ChainRegistry,
  subgraphName = 'otk-receipts',
): SubgraphResult {
  const chain = registry.getChain(query.chainId);
  if (!chain) {
    return {
      chainId: query.chainId,
      queryType: query.queryType,
      status: 'error',
      data: [],
      note: `Unknown chainId=${query.chainId} — not registered in ChainRegistry`,
    };
  }

  const ref: SubgraphRef | undefined = registry.getSubgraphRef(query.chainId, subgraphName);
  if (!ref || ref.status !== 'active') {
    return {
      chainId: query.chainId,
      queryType: query.queryType,
      status: 'stub',
      data: [],
      note: [
        `Subgraph '${subgraphName}' on chain '${chain.name}' (${query.chainId}) is`,
        ref ? `status='${ref.status}'` : 'not registered',
        '— stub response. Wire a live subgraph endpoint via ChainRegistry.addSubgraphRef() for production.',
      ].join(' '),
    };
  }

  // Production path — not reached in dev/CI
  return {
    chainId: query.chainId,
    queryType: query.queryType,
    status: 'live',
    data: [],
    note: `Live subgraph at ${ref.endpoint} — implement fetchFn for real data`,
  };
}

/**
 * Build a deployment_info query for a given chain.
 * Convenience wrapper — pure function.
 */
export function buildDeploymentInfoQuery(chainId: ChainId): SubgraphQuery {
  return buildSubgraphQuery(chainId, 'deployment_info', {});
}

// ---------------------------------------------------------------------------
// Live fetch — production wiring via OTK_SUBGRAPH_URL (E6.7 — W5-5B03)
// ---------------------------------------------------------------------------

export interface SubgraphFetchResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

/**
 * Execute a raw GraphQL query against the live subgraph endpoint.
 *
 * Reads OTK_SUBGRAPH_URL from the environment. If unset, returns a stub
 * result so that dev/CI environments are unaffected.
 *
 * Production: set OTK_SUBGRAPH_URL to the hosted subgraph query endpoint,
 * e.g. https://api.thegraph.com/subgraphs/name/otk/otk-receipts
 *
 * @param graphqlQuery  GraphQL query string
 * @param variables     Optional query variables
 */
export async function fetchSubgraphQuery(
  graphqlQuery: string,
  variables: Record<string, unknown> = {},
): Promise<SubgraphFetchResult> {
  const url = process.env['OTK_SUBGRAPH_URL'];
  if (!url) {
    return {
      data: null,
      errors: [{ message: 'OTK_SUBGRAPH_URL not configured — stub mode active' }],
    };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: graphqlQuery, variables }),
  });
  if (!res.ok) {
    return {
      data: null,
      errors: [{ message: `Subgraph HTTP ${res.status}: ${res.statusText}` }],
    };
  }
  return res.json() as Promise<SubgraphFetchResult>;
}
