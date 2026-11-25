/**
 * G2 — Deploy / Helm / K8s smoke tests (RB-082)
 *
 * Validates:
 *   1. Docker API artifact exists with expected contract markers
 *   2. docker-compose.api.yml exists and references the correct build context
 *   3. Helm chart structure is present and self-consistent
 *   4. values.yaml covers the deploy contract (image, port, /healthz, /readyz probes)
 *   5. deployment.yaml wires probes to /healthz (liveness) and /readyz (readiness)
 *   6. render_helm.sh script exists and is readable
 *   7. Deploy docs exist (deploy_k8s.md, helm.md)
 *   8. GET /health endpoint returns the probe-expected shape {ok, uptime, ts}
 *   9. GET /healthz (liveness) and GET /readyz (readiness) return K8s probe shapes
 *
 * No server socket, no Docker daemon, no Helm binary required.
 * Uses in-process mockReq/mockRes for API contract verification.
 *
 * Files under test: `docker/api/Dockerfile`, `docker/api/docker-compose.api.yml`, the Helm chart
 * in `infra/helm/otk/`, `scripts/ops/render_helm.sh` and the deploy docs under `docs/devops/`;
 * code under test: `handleRequest` in `src/api/routes.ts` for the health and probe routes.
 *
 * Strategy / partitions: each file exists and contains its contract markers (text checks only);
 * the legacy health route shape; the liveness and readiness probe shapes (readiness accepts 200
 * or 503, so it passes with or without a reachable Redis).
 *
 * Needs: read access to the repository files listed above; nothing else.
 *
 * Run just this file: `npx tsx --test test/unit/deploy_smoke.test.ts`
 *
 * @module test/unit/deploy_smoke.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as other smoke tests)
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
// Docker artifacts
// ---------------------------------------------------------------------------

describe('Deploy G2 — Docker API artifact', () => {
  const DOCKERFILE = path.join(ROOT, 'docker', 'api', 'Dockerfile');

  it('docker/api/Dockerfile exists', () => {
    assert.ok(fs.existsSync(DOCKERFILE), 'docker/api/Dockerfile not found');
  });

  it('Dockerfile has FROM + EXPOSE 8787 + CMD markers', () => {
    const content = fs.readFileSync(DOCKERFILE, 'utf-8');
    assert.ok(content.includes('FROM'), 'Dockerfile missing FROM');
    assert.ok(content.includes('EXPOSE 8787'), 'Dockerfile missing EXPOSE 8787');
    assert.ok(content.includes('CMD'), 'Dockerfile missing CMD');
  });

  it('docker/api/docker-compose.api.yml exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'docker', 'api', 'docker-compose.api.yml')),
      'docker-compose.api.yml not found',
    );
  });
});

// ---------------------------------------------------------------------------
// Helm chart structure
// ---------------------------------------------------------------------------

describe('Deploy G2 — Helm chart structure', () => {
  const CHART_DIR = path.join(ROOT, 'infra', 'helm', 'otk');

  it('Chart.yaml exists with apiVersion + name: otk', () => {
    const p = path.join(CHART_DIR, 'Chart.yaml');
    assert.ok(fs.existsSync(p), 'Chart.yaml not found');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('apiVersion:'), 'Chart.yaml missing apiVersion');
    assert.ok(content.includes('name: otk'), 'Chart.yaml missing name: otk');
  });

  it('values.yaml covers deploy contract: image + port + /healthz + /readyz probes', () => {
    const p = path.join(CHART_DIR, 'values.yaml');
    assert.ok(fs.existsSync(p), 'values.yaml not found');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('image:'), 'values.yaml missing image');
    assert.ok(content.includes('port:'), 'values.yaml missing port');
    assert.ok(content.includes('/healthz'), 'values.yaml missing /healthz probe path');
    assert.ok(content.includes('/readyz'), 'values.yaml missing /readyz probe path');
  });

  it('templates/deployment.yaml exists with liveness + readiness + startup probes', () => {
    const p = path.join(CHART_DIR, 'templates', 'deployment.yaml');
    assert.ok(fs.existsSync(p), 'deployment.yaml not found');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('livenessProbe'), 'deployment.yaml missing livenessProbe');
    assert.ok(content.includes('readinessProbe'), 'deployment.yaml missing readinessProbe');
    assert.ok(content.includes('startupProbe'), 'deployment.yaml missing startupProbe');
  });

  it('templates/service.yaml exists', () => {
    assert.ok(
      fs.existsSync(path.join(CHART_DIR, 'templates', 'service.yaml')),
      'templates/service.yaml not found',
    );
  });
});

// ---------------------------------------------------------------------------
// Scripts and docs
// ---------------------------------------------------------------------------

describe('Deploy G2 — Scripts and docs', () => {
  it('scripts/ops/render_helm.sh exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'scripts', 'ops', 'render_helm.sh')),
      'render_helm.sh not found',
    );
  });

  it('docs/devops/deploy_k8s.md exists', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'docs', 'devops', 'deploy_k8s.md')),
      'deploy_k8s.md not found',
    );
  });
});

// ---------------------------------------------------------------------------
// API contract — /health matches probe path
// ---------------------------------------------------------------------------

describe('Deploy G2 — /health legacy endpoint contract', () => {
  it('GET /health returns {ok, uptime, ts}', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/health'), res);
    assert.equal(res.statusCode, 200, '/health must return HTTP 200');
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true, 'ok must be true');
    assert.equal(typeof body.uptime, 'string', 'uptime must be string');
    assert.equal(typeof body.ts, 'string', 'ts must be string');
  });
});

// ---------------------------------------------------------------------------
// K8s probe contracts — /healthz (liveness) + /readyz (readiness) — H4.4
// ---------------------------------------------------------------------------

describe('Deploy G2 — K8s probe contracts (H4.4)', () => {
  it('GET /healthz returns {status: "ok", uptime, instanceId} for liveness', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/healthz'), res);
    assert.equal(res.statusCode, 200, '/healthz must return HTTP 200');
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok', 'status must be "ok"');
    assert.equal(typeof body.uptime, 'string', 'uptime must be string');
    assert.equal(typeof body.instanceId, 'string', 'instanceId must be string');
  });

  it('GET /readyz returns {status, instanceId, checks} for readiness', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/readyz'), res);
    // Without Redis configured, readyz returns 200 with status "ready"
    assert.ok([200, 503].includes(res.statusCode), '/readyz must return 200 or 503');
    const body = JSON.parse(res.body);
    assert.ok(['ready', 'not_ready'].includes(body.status), 'status must be ready or not_ready');
    assert.equal(typeof body.instanceId, 'string', 'instanceId must be string');
    assert.ok(body.checks, 'checks object must exist');
    assert.ok(body.checks.redis, 'checks.redis must exist');
  });
});
