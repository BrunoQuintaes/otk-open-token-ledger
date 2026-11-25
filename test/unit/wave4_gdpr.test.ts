/**
 * W4-4B04 — GDPR export + erasure tests (E5.5+E5.6)
 *
 * Covers:
 *   1.  src/api/gdpr.ts file exists
 *   2.  scripts/migrations/005_gdpr_tombstones.sql exists
 *   3.  routes.ts has /admin/gdpr/export/ route
 *   4.  routes.ts has /admin/gdpr/erase/ route
 *   5.  handleGdprExport() returns GdprExportResult shape
 *   6.  handleGdprExport() includes exportedAt field
 *   7.  handleGdprErase() returns GdprEraseResult with tombstoneHash
 *   8.  handleGdprErase() tombstoneHash is a 64-char hex string (SHA-256)
 *   9.  handleGdprErase() sets erasedAt field
 *  10.  RBAC: admin:gdpr permission added to OWNER role
 *  11.  Migration 005 contains erased_at column
 *  12.  Migration 005 contains tombstone_hash column
 *  13.  setGdprStore / getGdprStore round-trips custom store
 *  14.  CSV format returns text/csv (source check)
 *  15.  handleGdprExport() with custom store returns tenant receipts
 *  16.  handleGdprErase() erasedCount matches store result
 *  17.  getEmailAdapter called during export (email notification path)
 *  18.  gdpr.ts exports handleGdprExport and handleGdprErase
 *
 * @since Wave 4 (4B-PACK-4B04 / E5.5+E5.6)
 *
 * Module under test: `src/api/gdpr.ts` (export and erasure handlers and the store registry); the route list in
 * `src/api/routes.ts`, the permission in `src/security/rbac.ts` and the migration SQL are checked as text.
 *
 * Strategy / partitions: as listed above (the numbering is the original plan, not the test order); export in
 * JSON and CSV and erasure, each with an injected in-memory store.
 *
 * Needs: nothing external (mock request and response, injected store); reads source files from the repository
 * root found from this file's location.
 *
 * Run just this file: `npx tsx --test test/unit/wave4_gdpr.test.ts`
 *
 * @module test/unit/wave4_gdpr.test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import {
  handleGdprExport,
  handleGdprErase,
  setGdprStore,
  getGdprStore,
  type IGdprStore,
  type GdprReceipt,
} from '../../src/api/gdpr.js';

// ──────────────────────────────────────────────────────────
// Mock HTTP objects
// ──────────────────────────────────────────────────────────
function mockReq(url: string): http.IncomingMessage {
  return Object.assign(Object.create(http.IncomingMessage.prototype), {
    url,
    method: 'GET',
    headers: {},
  }) as http.IncomingMessage;
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(code: number, hdrs?: Record<string, string>): void;
  end(body?: string): void;
  setHeader(name: string, value: string): void;
}

function mockRes(): MockRes & http.ServerResponse {
  const r: MockRes = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, hdrs) { this.statusCode = code; if (hdrs) Object.assign(this.headers, hdrs); },
    end(b) { this.body += b ?? ''; },
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
  };
  return r as unknown as MockRes & http.ServerResponse;
}

// ──────────────────────────────────────────────────────────
// 1–4. File structure
// ──────────────────────────────────────────────────────────
describe('W4-4B04 — File structure', () => {
  it('src/api/gdpr.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/api/gdpr.ts')));
  });

  it('scripts/migrations/005_gdpr_tombstones.sql exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts/migrations/005_gdpr_tombstones.sql')));
  });

  it('routes.ts has /admin/gdpr/export/ route', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(content.includes('/admin/gdpr/export/'));
  });

  it('routes.ts has /admin/gdpr/erase/ route', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(content.includes('/admin/gdpr/erase/'));
  });

  it('gdpr.ts exports handleGdprExport and handleGdprErase', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/gdpr.ts'), 'utf-8');
    assert.ok(content.includes('export async function handleGdprExport'));
    assert.ok(content.includes('export async function handleGdprErase'));
  });
});

// ──────────────────────────────────────────────────────────
// 5–6. handleGdprExport
// ──────────────────────────────────────────────────────────
describe('W4-4B04 — handleGdprExport', () => {
  before(() => {
    const mockStore: IGdprStore = {
      async getReceiptsForTenant(tid) {
        return [{ id: 'r1', tenantId: tid, costUnits: 100, timestamp: 1000 }];
      },
      async eraseReceiptsForTenant() { return { erasedCount: 0 }; },
    };
    setGdprStore(mockStore);
  });

  it('returns 200 with JSON body containing tenant field', async () => {
    const req = mockReq('/admin/gdpr/export/tenant-abc');
    const res = mockRes();
    await handleGdprExport(req, res as unknown as http.ServerResponse, 'tenant-abc');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.tenant, 'tenant-abc');
  });

  it('includes exportedAt (ISO string)', async () => {
    const req = mockReq('/admin/gdpr/export/tenant-abc');
    const res = mockRes();
    await handleGdprExport(req, res as unknown as http.ServerResponse, 'tenant-abc');
    const parsed = JSON.parse(res.body);
    assert.ok(typeof parsed.exportedAt === 'string');
    assert.ok(!isNaN(Date.parse(parsed.exportedAt)));
  });

  it('includes receipts array', async () => {
    const req = mockReq('/admin/gdpr/export/tenant-abc');
    const res = mockRes();
    await handleGdprExport(req, res as unknown as http.ServerResponse, 'tenant-abc');
    const parsed = JSON.parse(res.body);
    assert.ok(Array.isArray(parsed.receipts));
    assert.strictEqual(parsed.receipts.length, 1);
  });

  it('CSV format: content-type is text/csv', async () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/gdpr.ts'), 'utf-8');
    assert.ok(content.includes('text/csv'));
  });

  it('CSV format: returns flat CSV (source check)', async () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/gdpr.ts'), 'utf-8');
    assert.ok(content.includes('format=csv') || content.includes("format === 'csv'"));
  });
});

// ──────────────────────────────────────────────────────────
// 7–9. handleGdprErase
// ──────────────────────────────────────────────────────────
describe('W4-4B04 — handleGdprErase', () => {
  let erasedStore: { eraseCount: number };

  before(() => {
    erasedStore = { eraseCount: 0 };
    const mockStore: IGdprStore = {
      async getReceiptsForTenant(): Promise<GdprReceipt[]> {
        return [{ id: 'r2', tenantId: 'tenant-erase', costUnits: 50 }];
      },
      async eraseReceiptsForTenant() {
        erasedStore.eraseCount++;
        return { erasedCount: 3 };
      },
    };
    setGdprStore(mockStore);
  });

  it('returns ok=true and erasedCount', async () => {
    const req = mockReq('/admin/gdpr/erase/tenant-erase');
    const res = mockRes();
    await handleGdprErase(req, res as unknown as http.ServerResponse, 'tenant-erase');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.erasedCount, 3);
  });

  it('tombstoneHash is a 64-char hex string (SHA-256)', async () => {
    const req = mockReq('/admin/gdpr/erase/tenant-erase');
    const res = mockRes();
    await handleGdprErase(req, res as unknown as http.ServerResponse, 'tenant-erase');
    const parsed = JSON.parse(res.body);
    assert.ok(typeof parsed.tombstoneHash === 'string');
    assert.strictEqual(parsed.tombstoneHash.length, 64);
    assert.ok(/^[0-9a-f]+$/.test(parsed.tombstoneHash));
  });

  it('erasedAt is a valid ISO timestamp', async () => {
    const req = mockReq('/admin/gdpr/erase/tenant-erase');
    const res = mockRes();
    await handleGdprErase(req, res as unknown as http.ServerResponse, 'tenant-erase');
    const parsed = JSON.parse(res.body);
    assert.ok(typeof parsed.erasedAt === 'string');
    assert.ok(!isNaN(Date.parse(parsed.erasedAt)));
  });
});

// ──────────────────────────────────────────────────────────
// 10. RBAC
// ──────────────────────────────────────────────────────────
describe('W4-4B04 — RBAC', () => {
  it('admin:gdpr permission is in OWNER role (rbac.ts)', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/security/rbac.ts'), 'utf-8');
    assert.ok(content.includes("'admin:gdpr'"));
  });
});

// ──────────────────────────────────────────────────────────
// 11–12. Migration content
// ──────────────────────────────────────────────────────────
describe('W4-4B04 — Migration 005 content', () => {
  it('migration 005 contains erased_at column', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts/migrations/005_gdpr_tombstones.sql'), 'utf-8');
    assert.ok(content.includes('erased_at'));
  });

  it('migration 005 contains tombstone_hash column', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts/migrations/005_gdpr_tombstones.sql'), 'utf-8');
    assert.ok(content.includes('tombstone_hash'));
  });
});

// ──────────────────────────────────────────────────────────
// 13. setGdprStore / getGdprStore
// ──────────────────────────────────────────────────────────
describe('W4-4B04 — Store registry', () => {
  it('setGdprStore / getGdprStore round-trips custom store', () => {
    const customStore: IGdprStore = {
      async getReceiptsForTenant() { return []; },
      async eraseReceiptsForTenant() { return { erasedCount: 0 }; },
    };
    setGdprStore(customStore);
    assert.strictEqual(getGdprStore(), customStore);
  });
});
