/**
 * H1R2 C1 (S08-F01): scripts/ops/extract_routes.mjs must see every HTTP handler of the routers it scans.
 *
 * Before this change the extractor missed 16 handlers of src/api/routes.ts (regex with `[^/]` inside a character
 * class, `flagsPath.startsWith`, pre-computed `*Match` variables) plus the prover `/status/:jobId`, SCIM
 * `/scim/v2/Users/:id`, the gateway MITM catch-all and the D1-D8 operation/attribution routes served by the gateway.
 * They were covered only by a hand-kept "supplementary inventory" in h1_s08_route_matrix_gaps.test.ts.
 *
 * 1. Every one of those handlers is reported by the extractor (explicit list: a regression in the scanner fails here).
 * 2. Generic coverage: every `if (...)` line of the scanned routers that tests a request path (path variable, `*Match`
 *    variable, path flag, router predicate) is reported by the extractor at that line, except the conditions listed
 *    in NOT_A_ROUTE with the reason (guards and delegations, never a wildcard).
 * Static only: no server, no network.
 *
 * Under test: `scripts/ops/extract_routes.mjs`, run as a child `node` process with `--json`; the routers it scans are
 * read as text (the list of scanned files is taken from the extractor's own source). A third case checks that a
 * negated path condition is an exclusion, not a route.
 *
 * Needs: only the repository files; spawns `node` once per call to the extractor.
 *
 * Run just this file: `npx tsx --test test/security/h1r2_c1_route_extractor.test.ts`
 *
 * @module test/security/h1r2_c1_route_extractor.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ops', 'extract_routes.mjs');
type Route = { key: string; server: string; methods: string[]; kind: string; path: string; file: string; line: number };
const extracted = (): Route[] => JSON.parse(execFileSync(process.execPath, [SCRIPT, ROOT, '--json'], { encoding: 'utf-8' })) as Route[];

/** Handlers the extractor did not report before H1R2 C1 (inventory keys). */
const FORMERLY_BLIND = [
  // src/api/routes.ts — the 16 handlers of the S08 supplementary inventory
  'api DELETE regex:/^\\/v1\\/webhooks\\/([^/]+)$/ @src/api/routes.ts',
  'api GET regex:/^\\/v1\\/webhooks\\/([^/]+)\\/deliveries$/ @src/api/routes.ts',
  'api POST regex:/^\\/v1\\/webhooks\\/([^/]+)\\/deliveries\\/([^/]+)\\/replay$/ @src/api/routes.ts',
  'api POST regex:/^\\/v1\\/tenants\\/[^/]+\\/provider-keys$/ @src/api/routes.ts',
  'api GET regex:/^\\/v1\\/tenants\\/[^/]+\\/provider-keys$/ @src/api/routes.ts',
  'api DELETE regex:/^\\/v1\\/tenants\\/[^/]+\\/provider-keys\\/[^/]+$/ @src/api/routes.ts',
  'api GET prefix:/admin/flags/ @src/api/routes.ts',
  'api PUT regex:/^\\/admin\\/flags\\/([^/]+)\\/override\\/([^/]+)$/ @src/api/routes.ts',
  'api DELETE regex:/^\\/admin\\/flags\\/([^/]+)\\/override\\/([^/]+)$/ @src/api/routes.ts',
  'api DELETE prefix:/admin/flags/ @src/api/routes.ts',
  'api POST regex:/^\\/admin\\/dead-letters\\/[^/]+\\/retry$/ @src/api/routes.ts',
  'api POST regex:/^\\/admin\\/dead-letters\\/[^/]+\\/discard$/ @src/api/routes.ts',
  'api POST regex:/^\\/keys\\/[^/]+\\/rotate$/ @src/api/routes.ts',
  'api POST regex:/^\\/teams\\/[^/]+\\/members$/ @src/api/routes.ts',
  'api DELETE regex:/^\\/teams\\/[^/]+\\/members\\/[^/]+$/ @src/api/routes.ts',
  'api GET regex:/^\\/teams\\/[^/]+\\/members$/ @src/api/routes.ts',
  // other routers
  'api GET|PUT|PATCH|DELETE regex:/^\\/scim\\/v2\\/Users\\/(.+)$/ @src/auth/scim/ScimRouter.ts',
  'prover GET regex:/^\\/status\\/([a-zA-Z0-9\\-_]+)$/ @src/prover/ProverDaemon.ts',
  'proxy ANY except:/proxy,/health @src/proxy/ProxyGateway.ts',
  'proxy GET|POST regex:/^\\/v1\\/operations\\/([A-Za-z0-9._:-]{1,128})(\\/cancel|\\/conference)?$/ @src/operations/routes.ts',
  'proxy GET|POST regex:/^\\/v1\\/attribution\\/(projects|applications|summary|export)$/ @src/operations/attributionRoutes.ts',
];

/** `if` lines that test the request path but are not handlers, with the reason (exact trimmed text, no wildcard). */
const NOT_A_ROUTE: Record<string, string> = {
  'if (isProductionEnv() && !isAuthEnabled() && !PRODUCTION_A0_OPEN_ROUTES.has(routePath)) {': 'production A0 fail-closed guard (503), not a handler',
  'if (!INFRA_ROUTES.has(routePath)) {': 'H1R2 R-13/A3 credential freshness pre-check before every non-infra route (503 credential_status_unavailable), not a handler',
  'if (epIdMatch && epIdMatch[1] !== undefined) {': 'AUD-FC-10 webhook ownership pre-check shared by the by-id handlers (404 for a foreign endpoint)',
  'if (handleLoginRequest(req, res, routePath)) return;': 'delegation to src/dashboard/login.ts (scanned itself)',
  'if (await handleDashboardRequest(req, res, routePath, resolveCallerContext)) return;': 'delegation to src/dashboard/app.ts (scanned itself)',
  'if (opts.operations && isOperationRoute(url.pathname)) {': 'delegation to src/operations/routes.ts (scanned itself: ROUTE constant)',
  'if (opts.operations && isAttributionRoute(url.pathname)) {': 'delegation to src/operations/attributionRoutes.ts (scanned itself: ROUTE constant)',
};

function scannedFiles(): string[] {
  return [...fs.readFileSync(SCRIPT, 'utf-8').matchAll(/\['(?:api|proxy|prover)', '([^']+)'\]/g)].map((m) => m[1]!);
}

describe('H1R2 C1: route extractor sees every handler (S08-F01)', () => {
  it('reports each formerly blind handler (16 of routes.ts + SCIM, prover, gateway)', () => {
    const keys = new Set(extracted().map((r) => r.key));
    const missing = FORMERLY_BLIND.filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `extractor does not report ${missing.length} handler(s)`);
  });

  it('every path-testing `if` of the scanned routers is a reported route or an explicit non-route', () => {
    const ext = extracted();
    const unreported: string[] = [];
    const usedExceptions = new Set<string>();
    for (const rel of scannedFiles()) {
      const lines = fs.readFileSync(path.join(ROOT, rel), 'utf-8').split(/\r?\n/);
      const at = new Set(ext.filter((r) => r.file === rel).map((r) => r.line));
      lines.forEach((l, i) => {
        if (!/\bif\s*\(/.test(l)) return;
        if (!/(routePath|pathname|[a-z]Path\b|\w+Match\b|Route\()/.test(l)) return;
        if (at.has(i + 1)) return;
        const t = l.trim();
        if (NOT_A_ROUTE[t]) { usedExceptions.add(t); return; }
        unreported.push(`${rel}:${i + 1}: ${t}`);
      });
    }
    assert.deepEqual(unreported, [], 'handler conditions the extractor does not report');
    // a stale exception (the line changed or disappeared) must be removed, so the list stays exact
    assert.deepEqual(Object.keys(NOT_A_ROUTE).filter((t) => !usedExceptions.has(t)), []);
  });

  it('negated conditions are exclusions, not routes (no suffix route from `!routePath.endsWith`)', () => {
    const ext = extracted();
    assert.deepEqual(ext.filter((r) => r.kind === 'suffix').map((r) => r.key), []);
    // the ownership pre-check is not reported as an ANY route
    assert.ok(!ext.some((r) => r.path.includes('(?:\\/.*)?')), 'webhook ownership guard reported as a route');
  });
});
