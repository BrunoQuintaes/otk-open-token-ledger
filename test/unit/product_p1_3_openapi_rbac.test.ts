/**
 * P1.3 — OpenAPI RBAC Sync Tests
 *
 * Validates that docs/api/openapi.json reflects the RBAC model introduced in E1.3:
 * - bearerAuth security scheme present
 * - Protected endpoints carry security + 401/403 responses
 * - /admin/tenants/reload documents OWNER-only restriction
 * - /accounting/balance documents auth
 * - Admin endpoints document bearerAuth (RBAC mode) + adminKey (legacy mode)
 *
 * Note: Tests read the spec file directly (static analysis).
 * No server process required.
 *
 * @since P1.3 (2026-03-14)
 *
 * Under test: the committed specification `docs/api/openapi.json` (no source module is imported).
 *
 * Strategy / partitions: the two security schemes (token and legacy admin key); for the balance route, three
 * admin routes, the tenant reload route and the receipt routes, the declared security options and the 401
 * and 403 responses; the OWNER-only restriction in the reload description; the access model in the info
 * description.
 *
 * Needs: reads `docs/api/openapi.json` relative to the current directory, so run it from the repository root.
 *
 * Run just this file: `npx tsx --test test/unit/product_p1_3_openapi_rbac.test.ts`
 *
 * @module test/unit/product_p1_3_openapi_rbac.test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Load spec once
// ---------------------------------------------------------------------------

type OpenAPISpec = {
  openapi: string;
  info: { title: string; description: string; version: string };
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
  paths: Record<string, Record<string, {
    security?: Array<Record<string, unknown>>;
    responses?: Record<string, unknown>;
    description?: string;
  }>>;
};

let spec: OpenAPISpec;

before(() => {
  const specPath = resolve('docs/api/openapi.json');
  spec = JSON.parse(readFileSync(specPath, 'utf8')) as OpenAPISpec;
});

// ---------------------------------------------------------------------------
// 1. Security schemes
// ---------------------------------------------------------------------------

describe('P1.3 — security schemes', () => {
  it('bearerAuth security scheme exists', () => {
    assert.ok(spec.components?.securitySchemes?.['bearerAuth'], 'bearerAuth must be defined');
  });

  it('bearerAuth is type=http scheme=bearer', () => {
    const scheme = spec.components.securitySchemes['bearerAuth'] as Record<string, string>;
    assert.equal(scheme['type'], 'http');
    assert.equal(scheme['scheme'], 'bearer');
  });

  it('adminKey security scheme exists', () => {
    assert.ok(spec.components?.securitySchemes?.['adminKey'], 'adminKey must be defined');
  });
});

// ---------------------------------------------------------------------------
// 2. /accounting/balance — RBAC gated (accounting:read)
// ---------------------------------------------------------------------------

describe('P1.3 — /accounting/balance RBAC', () => {
  it('has security field', () => {
    const op = spec.paths['/accounting/balance']?.['get'];
    assert.ok(op?.security, '/accounting/balance GET must have security field');
  });

  it('includes bearerAuth in security options', () => {
    const op = spec.paths['/accounting/balance']?.['get'];
    const hasBearerEntry = op?.security?.some(s => 'bearerAuth' in s);
    assert.ok(hasBearerEntry, '/accounting/balance must include bearerAuth security option');
  });

  it('documents 401 response', () => {
    const op = spec.paths['/accounting/balance']?.['get'];
    assert.ok(op?.responses?.['401'], '/accounting/balance must document 401');
  });

  it('documents 403 response', () => {
    const op = spec.paths['/accounting/balance']?.['get'];
    assert.ok(op?.responses?.['403'], '/accounting/balance must document 403');
  });
});

// ---------------------------------------------------------------------------
// 3. /admin/flush-batch — RBAC gated (admin:flush)
// ---------------------------------------------------------------------------

describe('P1.3 — /admin/flush-batch RBAC', () => {
  it('includes bearerAuth in security options', () => {
    const op = spec.paths['/admin/flush-batch']?.['post'];
    const hasBearerEntry = op?.security?.some(s => 'bearerAuth' in s);
    assert.ok(hasBearerEntry, '/admin/flush-batch must include bearerAuth security option');
  });

  it('includes adminKey in security options (legacy)', () => {
    const op = spec.paths['/admin/flush-batch']?.['post'];
    const hasAdminKeyEntry = op?.security?.some(s => 'adminKey' in s);
    assert.ok(hasAdminKeyEntry, '/admin/flush-batch must include adminKey security option (legacy)');
  });

  it('documents 401 response', () => {
    const op = spec.paths['/admin/flush-batch']?.['post'];
    assert.ok(op?.responses?.['401'], '/admin/flush-batch must document 401');
  });

  it('documents 403 response', () => {
    const op = spec.paths['/admin/flush-batch']?.['post'];
    assert.ok(op?.responses?.['403'], '/admin/flush-batch must document 403');
  });
});

// ---------------------------------------------------------------------------
// 4. /admin/chain-head — RBAC gated (admin:chain-head)
// ---------------------------------------------------------------------------

describe('P1.3 — /admin/chain-head RBAC', () => {
  it('includes bearerAuth in security options', () => {
    const op = spec.paths['/admin/chain-head']?.['get'];
    const hasBearerEntry = op?.security?.some(s => 'bearerAuth' in s);
    assert.ok(hasBearerEntry, '/admin/chain-head must include bearerAuth security option');
  });

  it('documents 401 response', () => {
    const op = spec.paths['/admin/chain-head']?.['get'];
    assert.ok(op?.responses?.['401'], '/admin/chain-head must document 401');
  });

  it('documents 403 response', () => {
    const op = spec.paths['/admin/chain-head']?.['get'];
    assert.ok(op?.responses?.['403'], '/admin/chain-head must document 403');
  });
});

// ---------------------------------------------------------------------------
// 5. /admin/tal-summary — RBAC gated (admin:tal-summary)
// ---------------------------------------------------------------------------

describe('P1.3 — /admin/tal-summary RBAC', () => {
  it('includes bearerAuth in security options', () => {
    const op = spec.paths['/admin/tal-summary']?.['get'];
    const hasBearerEntry = op?.security?.some(s => 'bearerAuth' in s);
    assert.ok(hasBearerEntry, '/admin/tal-summary must include bearerAuth security option');
  });

  it('documents 401 response', () => {
    const op = spec.paths['/admin/tal-summary']?.['get'];
    assert.ok(op?.responses?.['401'], '/admin/tal-summary must document 401');
  });

  it('documents 403 response', () => {
    const op = spec.paths['/admin/tal-summary']?.['get'];
    assert.ok(op?.responses?.['403'], '/admin/tal-summary must document 403');
  });
});

// ---------------------------------------------------------------------------
// 6. /admin/tenants/reload — OWNER only (admin:keys)
// ---------------------------------------------------------------------------

describe('P1.3 — /admin/tenants/reload OWNER-only', () => {
  it('includes bearerAuth in security options', () => {
    const op = spec.paths['/admin/tenants/reload']?.['post'];
    const hasBearerEntry = op?.security?.some(s => 'bearerAuth' in s);
    assert.ok(hasBearerEntry, '/admin/tenants/reload must include bearerAuth security option');
  });

  it('includes adminKey in security options (legacy)', () => {
    const op = spec.paths['/admin/tenants/reload']?.['post'];
    const hasAdminKeyEntry = op?.security?.some(s => 'adminKey' in s);
    assert.ok(hasAdminKeyEntry, '/admin/tenants/reload must include adminKey security option (legacy)');
  });

  it('documents 401 response', () => {
    const op = spec.paths['/admin/tenants/reload']?.['post'];
    assert.ok(op?.responses?.['401'], '/admin/tenants/reload must document 401');
  });

  it('documents 403 response', () => {
    const op = spec.paths['/admin/tenants/reload']?.['post'];
    assert.ok(op?.responses?.['403'], '/admin/tenants/reload must document 403');
  });

  it('description mentions OWNER role restriction', () => {
    const op = spec.paths['/admin/tenants/reload']?.['post'];
    assert.ok(
      op?.description?.toLowerCase().includes('owner'),
      'description must mention OWNER role requirement for admin:keys',
    );
  });
});

// ---------------------------------------------------------------------------
// 7. /receipts and /receipts/{requestId} — existing bearer auth preserved
// ---------------------------------------------------------------------------

describe('P1.3 — receipts endpoints bearer auth preserved', () => {
  it('POST /receipts has bearerAuth security', () => {
    const op = spec.paths['/receipts']?.['post'];
    const hasBearerEntry = op?.security?.some(s => 'bearerAuth' in s);
    assert.ok(hasBearerEntry, 'POST /receipts must have bearerAuth security option');
  });

  it('POST /receipts has 401 response', () => {
    const op = spec.paths['/receipts']?.['post'];
    assert.ok(op?.responses?.['401'], 'POST /receipts must document 401');
  });

  it('POST /receipts has 403 response (VIEWER role lacks receipts:write)', () => {
    const op = spec.paths['/receipts']?.['post'];
    assert.ok(op?.responses?.['403'], 'POST /receipts must document 403 (VIEWER cannot write)');
  });

  it('GET /receipts/{requestId} has bearerAuth security', () => {
    const op = spec.paths['/receipts/{requestId}']?.['get'];
    const hasBearerEntry = op?.security?.some(s => 'bearerAuth' in s);
    assert.ok(hasBearerEntry, 'GET /receipts/{requestId} must have bearerAuth security option');
  });

  it('GET /receipts/{requestId} has 401 and 403 responses', () => {
    const op = spec.paths['/receipts/{requestId}']?.['get'];
    assert.ok(op?.responses?.['401'], 'GET /receipts/{requestId} must document 401');
    assert.ok(op?.responses?.['403'], 'GET /receipts/{requestId} must document 403');
  });
});

// ---------------------------------------------------------------------------
// 8. info.description — RBAC model documented
// ---------------------------------------------------------------------------

describe('P1.3 — info.description RBAC model', () => {
  it('mentions RBAC or ADR-0206', () => {
    const desc = spec.info?.description ?? '';
    assert.ok(
      desc.includes('RBAC') || desc.includes('ADR-0206'),
      'info.description must reference RBAC or ADR-0206',
    );
  });

  it('mentions OWNER role', () => {
    const desc = spec.info?.description ?? '';
    assert.ok(desc.includes('OWNER'), 'info.description must mention OWNER role');
  });
});
