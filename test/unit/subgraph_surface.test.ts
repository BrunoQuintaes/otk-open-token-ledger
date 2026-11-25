/**
 * G4 — Subgraph Surface behavioral tests
 *
 * Validates the query surface contract:
 *   - buildSubgraphQuery() is a pure factory
 *   - executeSubgraphQuery() returns stub for dev chains
 *   - Unknown chains return status='error'
 *   - result.data is always an array
 *   - All query types produce correct shapes
 *
 * Modules under test: `src/infra/subgraphSurface.ts` (query builders, the stub executor and the live fetch
 * wiring) with `src/infra/chainRegistry.ts`; also the committed `subgraph/schema.graphql`.
 *
 * Strategy / partitions: the three query builders; a known development chain, an unknown chain and chain 1;
 * the result fields always present; the schema entities and their fields; the live fetch without
 * `OTK_SUBGRAPH_URL` (stub error, no request).
 *
 * Needs: no network (the URL variable is removed for the fetch case and restored). Reads
 * `subgraph/schema.graphql` relative to the current directory, so run it from the repository root.
 *
 * Run just this file: `npx tsx --test test/unit/subgraph_surface.test.ts`
 *
 * @module test/unit/subgraph_surface.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChainRegistry } from '../../src/infra/chainRegistry.js';
import {
  buildSubgraphQuery,
  buildDeploymentInfoQuery,
  executeSubgraphQuery,
  fetchSubgraphQuery,
} from '../../src/infra/subgraphSurface.js';

const IBFT = 1337;
const UNKNOWN_CHAIN = 99999;

describe('Subgraph Surface — buildSubgraphQuery (pure)', () => {
  it('returns correct shape for receipts_by_tenant', () => {
    const q = buildSubgraphQuery(IBFT, 'receipts_by_tenant', { tenantId: 't1' });
    assert.equal(q.chainId, IBFT);
    assert.equal(q.queryType, 'receipts_by_tenant');
    assert.deepEqual(q.filter, { tenantId: 't1' });
  });

  it('returns correct shape for receipts_by_epoch', () => {
    const q = buildSubgraphQuery(IBFT, 'receipts_by_epoch', { epoch: 100 });
    assert.equal(q.queryType, 'receipts_by_epoch');
  });

  it('buildDeploymentInfoQuery returns deployment_info query', () => {
    const q = buildDeploymentInfoQuery(IBFT);
    assert.equal(q.queryType, 'deployment_info');
    assert.equal(q.chainId, IBFT);
  });
});

describe('Subgraph Surface — executeSubgraphQuery (stub-first)', () => {
  const reg = new ChainRegistry();

  it('known chain returns status=stub in dev', () => {
    const q = buildSubgraphQuery(IBFT, 'receipts_by_tenant', {});
    const result = executeSubgraphQuery(q, reg);
    assert.equal(result.status, 'stub');
  });

  it('result.chainId matches query.chainId', () => {
    const q = buildSubgraphQuery(IBFT, 'verifier_stats', {});
    const result = executeSubgraphQuery(q, reg);
    assert.equal(result.chainId, IBFT);
  });

  it('result.data is always an array', () => {
    const q = buildSubgraphQuery(IBFT, 'receipts_by_epoch', {});
    const result = executeSubgraphQuery(q, reg);
    assert.ok(Array.isArray(result.data), 'data must be an array');
  });

  it('stub result includes a note explaining the status', () => {
    const q = buildSubgraphQuery(IBFT, 'receipts_by_tenant', {});
    const result = executeSubgraphQuery(q, reg);
    assert.ok(typeof result.note === 'string' && result.note.length > 0, 'note must be a non-empty string');
  });

  it('unknown chain returns status=error', () => {
    const q = buildSubgraphQuery(UNKNOWN_CHAIN, 'receipts_by_tenant', {});
    const result = executeSubgraphQuery(q, reg);
    assert.equal(result.status, 'error');
    assert.ok(result.note?.includes(String(UNKNOWN_CHAIN)));
  });

  it('ethereum chain (chainId=1) returns stub (subgraph unavailable)', () => {
    const q = buildSubgraphQuery(1, 'receipts_by_tenant', {});
    const result = executeSubgraphQuery(q, reg);
    assert.equal(result.status, 'stub');
  });

  it('result.queryType matches query.queryType', () => {
    const q = buildSubgraphQuery(IBFT, 'deployment_info', {});
    const result = executeSubgraphQuery(q, reg);
    assert.equal(result.queryType, 'deployment_info');
  });
});

describe('Subgraph Surface — schema.graphql validation (E6.7)', () => {
  const schemaPath = join(process.cwd(), 'subgraph', 'schema.graphql');

  it('schema.graphql exists', () => {
    let content: string;
    try {
      content = readFileSync(schemaPath, 'utf8');
    } catch {
      assert.fail('subgraph/schema.graphql does not exist');
    }
    assert.ok(content.length > 0, 'schema.graphql must not be empty');
  });

  it('schema defines Receipt entity', () => {
    const content = readFileSync(schemaPath, 'utf8');
    assert.ok(content.includes('type Receipt @entity'), 'schema must define Receipt entity');
  });

  it('schema defines ReceiptV2 entity', () => {
    const content = readFileSync(schemaPath, 'utf8');
    assert.ok(content.includes('type ReceiptV2 @entity'), 'schema must define ReceiptV2 entity');
  });

  it('schema defines Tenant entity', () => {
    const content = readFileSync(schemaPath, 'utf8');
    assert.ok(content.includes('type Tenant @entity'), 'schema must define Tenant entity');
  });

  it('Receipt entity has required fields', () => {
    const content = readFileSync(schemaPath, 'utf8');
    assert.ok(content.includes('userId:'), 'Receipt must have userId field');
    assert.ok(content.includes('costUnits:'), 'Receipt must have costUnits field');
    assert.ok(content.includes('epoch:'), 'Receipt must have epoch field');
  });

  it('ReceiptV2 entity has bucket fields', () => {
    const content = readFileSync(schemaPath, 'utf8');
    assert.ok(content.includes('minUsageBucket:'), 'ReceiptV2 must have minUsageBucket field');
    assert.ok(content.includes('maxUsageBucket:'), 'ReceiptV2 must have maxUsageBucket field');
  });
});

describe('Subgraph Surface — fetchSubgraphQuery (live wiring E6.7)', () => {
  it('returns stub error when OTK_SUBGRAPH_URL is not set', async () => {
    const saved = process.env['OTK_SUBGRAPH_URL'];
    delete process.env['OTK_SUBGRAPH_URL'];
    try {
      const result = await fetchSubgraphQuery('{ receipts(first: 1) { id } }');
      assert.equal(result.data, null, 'data must be null in stub mode');
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0, 'must return errors array');
      assert.ok(result.errors![0].message.includes('OTK_SUBGRAPH_URL'), 'error must mention OTK_SUBGRAPH_URL');
    } finally {
      if (saved !== undefined) process.env['OTK_SUBGRAPH_URL'] = saved;
    }
  });
});
