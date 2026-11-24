/**
 * G1 — DevEx smoke tests (RB-064 / RB-077)
 *
 * Validates:
 *   1. Python client artifact exists with expected API surface
 *   2. Quickstart doc exists and covers all documented endpoints
 *   3. API endpoint responses match quickstart-documented shapes
 *   4. Example files exist for both Python and TypeScript
 *
 * Uses the same in-process mockReq/mockRes pattern as other smoke tests.
 * No server socket, no network I/O.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';
import { getCollector } from '../../src/observability/runtime.js';
import { getDispatcher } from '../../src/publisher/runtime.js';
import { getLimiter } from '../../src/security/rateLimitRuntime.js';
import { resetDistributedRateLimiterForTest } from '../../src/security/IDistributedRateLimiter.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as api_routes_smoke + observability_smoke)
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url }) as unknown as IncomingMessage;
  process.nextTick(() => em.emit('end'));
  return req;
}

type MockRes = ServerResponse & { body: string };

function mockRes(): MockRes {
  let body = '';
  return {
    statusCode: 200,
    setHeader: () => {},
    end: (data: string) => { body = data; },
    get body() { return body; },
  } as unknown as MockRes;
}

// ---------------------------------------------------------------------------
// Artifact: Python client
// ---------------------------------------------------------------------------

describe('DevEx G1 — Python client artifact', () => {
  const CLIENT_PATH = path.join(ROOT, 'python', 'otk_client.py');

  it('python/otk_client.py exists', () => {
    assert.ok(fs.existsSync(CLIENT_PATH), 'python/otk_client.py not found');
  });

  it('OTKClient class present', () => {
    const content = fs.readFileSync(CLIENT_PATH, 'utf-8');
    assert.ok(content.includes('class OTKClient'), 'OTKClient class missing');
  });

  it('all public methods present: health, metrics, events_latest, ratelimit_status, ping', () => {
    const content = fs.readFileSync(CLIENT_PATH, 'utf-8');
    for (const method of ['def health', 'def metrics', 'def events_latest', 'def ratelimit_status', 'def ping']) {
      assert.ok(content.includes(method), `${method}() missing from Python client`);
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact: Quickstart doc
// ---------------------------------------------------------------------------

describe('DevEx G1 — Quickstart documentation', () => {
  // INF01-F01 (OTK-MOR-01): docs/quickstart.md and docs/QUICKSTART.md are byte-identical twins; the academic package
  // keeps only one (case collision on Windows/macOS, tools/academic_release/build_package.py). Resolve the name the
  // way a case-insensitive filesystem does, so the package passes on Linux too; the content check below is unchanged.
  const QS_PATH = path.join(ROOT, 'docs',
    fs.readdirSync(path.join(ROOT, 'docs')).sort().reverse().find((n) => n.toLowerCase() === 'quickstart.md') ?? 'quickstart.md');

  it('docs/quickstart.md exists', () => {
    assert.ok(fs.existsSync(QS_PATH), 'docs/quickstart.md not found');
  });

  it('quickstart documents all API endpoints', () => {
    const content = fs.readFileSync(QS_PATH, 'utf-8');
    for (const endpoint of ['/health', '/metrics', '/events/latest', '/ratelimit/status', '/ping']) {
      assert.ok(content.includes(endpoint), `endpoint ${endpoint} missing from quickstart.md`);
    }
  });
});

// ---------------------------------------------------------------------------
// API contract consistency (quickstart ↔ implementation)
// ---------------------------------------------------------------------------

describe('DevEx G1 — API contract consistency', () => {
  beforeEach(() => {
    getCollector().reset();
    getDispatcher().reset();
    getLimiter().reset();
    resetDistributedRateLimiterForTest();
  });

  it('GET /metrics?format=json returns capturedAt + providers (as documented)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics?format=json'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok('capturedAt' in body, 'capturedAt missing');
    assert.ok(Array.isArray(body.providers), 'providers must be array');
  });

  it('GET /events/latest returns ok + events array (as documented)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/events/latest'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, 'ok must be true');
    assert.ok(Array.isArray(body.events), 'events must be array');
  });

  it('GET /ratelimit/status returns ok + status (as documented)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/ratelimit/status'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, 'ok must be true');
    assert.equal(body.status, 'distributed', 'status should be distributed');
  });
});

// ---------------------------------------------------------------------------
// Artifact: Examples
// ---------------------------------------------------------------------------

describe('DevEx G1 — Example files', () => {
  it('examples/python/basic_metering.py exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'examples', 'python', 'basic_metering.py')),
      'examples/python/basic_metering.py not found',
    );
  });

  it('examples/typescript/basic_metering.ts exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'examples', 'typescript', 'basic_metering.ts')),
      'examples/typescript/basic_metering.ts not found',
    );
  });
});
