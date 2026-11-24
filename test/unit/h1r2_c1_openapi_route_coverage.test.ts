/**
 * H1R2 C1: the route inventory (scripts/ops/extract_routes.mjs, which since S08-F01 sees every handler) confronted with
 * the OpenAPI contract (docs/api/openapi.json).
 *
 * 1. Every (method, route) of the inventory is documented in the spec OR listed, with a reason, in
 *    test/fixtures/contract/openapi_route_exceptions.json. No wildcard: each exception names one route of the inventory;
 *    a stale exception (route gone or now documented) fails, so the list stays exact. Dispatchers (a prefix test that
 *    only routes to the handlers below it) are listed there too, with the reason.
 * 2. Sensitive routes (admin, SCIM, keys, billing/Stripe, data export / GDPR, webhooks, provider keys, teams, tenants,
 *    proxy gateway) may NOT be exceptions: they must be documented.
 * 3. For every documented operation that maps to a handler:
 *    - each HTTP error status the handler body can write (sendError code, sendJson 4xx/5xx, RBAC / cross-tenant /
 *      foreign-resource / platform / legacy admin-key / verified-user denials) is a documented response;
 *    - a route classified "authenticated" in test/fixtures/security/route_surface_m1.json documents 401 and a
 *      non-empty security requirement;
 *    - the RBAC permission checked by the handler (checkRbac / denyPlatformOperation) is declared in
 *      `x-otk-permission`, and a platform-only handler (denyPlatformOperation) declares `x-otk-platform: true`.
 * 4. Every documented operation maps to a real handler (no phantom path).
 *
 * To update after adding a route: document it in docs/api/openapi.json (preferred) or, for a non-sensitive route,
 * add one exception entry with the reason. A new error status in a handler must be added to the operation responses.
 * Static only (source + spec): no server, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const SPEC: Json = JSON.parse(read('docs/api/openapi.json'));
type Exc = { route: string; reason: string };
const EXC: { undocumented: Exc[]; dispatchers: Exc[]; unreachable: Exc[] } =
  JSON.parse(read('test/fixtures/contract/openapi_route_exceptions.json'));
const SURFACE: Array<{ key: string; access: string }> = JSON.parse(read('test/fixtures/security/route_surface_m1.json')).routes;

type Route = { key: string; server: string; methods: string[]; kind: string; path: string; file: string; line: number; guards: string[] };
const INVENTORY = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ops', 'extract_routes.mjs'), ROOT, '--json'], { encoding: 'utf-8' })) as Route[];
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];

/** Identity of one (method, route) of the inventory: `<METHOD> <kind>:<path> @<file>` (METHOD may be ANY). */
const opId = (m: string, r: Route) => `${m} ${r.kind}:${r.path} @${r.file}`;
const DISPATCH = new Set(EXC.dispatchers.map((d) => d.route));
const handlers = INVENTORY.flatMap((r) => r.methods.map((m) => ({ id: opId(m, r), method: m, route: r }))).filter((h) => !DISPATCH.has(h.id));

/** Server of a spec operation: the gateway (port 8788), the prover (3001) or the API (default). */
function serverOf(op: Json, pathItem: Json): 'api' | 'proxy' | 'prover' {
  const urls = [...(op.servers ?? []), ...(pathItem.servers ?? [])].map((s: Json) => String(s.url));
  if (urls.some((u) => u.includes(':8788'))) return 'proxy';
  if (urls.some((u) => u.includes(':3001'))) return 'prover';
  return 'api';
}
/** Path seen by the handler: the API dispatcher cuts one leading /v1 (routes declared with /v1 live at /v1/v1/...). */
const routePathOf = (p: string, srv: string) => (srv === 'api' && p.startsWith('/v1/') ? p.slice(3) : p);
const concrete = (p: string) => p.replace(/\{[^}]+\}/g, 'sample-id');

function matches(r: Route, method: string, templ: string): boolean {
  if (!r.methods.includes('ANY') && !r.methods.includes(method)) return false;
  const c = concrete(templ);
  switch (r.kind) {
    case 'eq': return r.path === templ || (r.path.length > 1 && r.path.endsWith('/') && r.path.slice(0, -1) === templ);
    case 'prefix': return c.startsWith(r.path) && c.length > r.path.length;
    case 'suffix': return c.endsWith(r.path);
    case 'regex': { const m = r.path.match(/^\/(.*)\/([a-z]*)$/)!; return new RegExp(m[1]!, m[2]).test(c); }
    case 'except': return !r.path.split(',').includes(c);
    default: return false;
  }
}
const SPECIFICITY: Record<string, number> = { eq: 0, regex: 1, suffix: 2, prefix: 3, except: 4 };
/** Documented operations with the handler(s) of the inventory that serve them (most specific kind wins). */
const DOCUMENTED = Object.entries<Json>(SPEC.paths).flatMap(([p, item]) => HTTP_METHODS.filter((m) => item[m]).map((m) => {
  const op = item[m]; const srv = serverOf(op, item); const rp = routePathOf(p, srv); const M = m.toUpperCase();
  const cands = handlers.filter((h) => h.route.server === srv && (h.method === M || h.method === 'ANY') && matches(h.route, M, rp));
  const best = cands.length ? Math.min(...cands.map((h) => SPECIFICITY[h.route.kind]!)) : -1;
  return { label: `${M} ${p}`, method: M, op, served: cands.filter((h) => SPECIFICITY[h.route.kind] === best) };
}));

/** Sensitive surface: may not be left out of the contract. */
const SENSITIVE = /\/admin|\/scim|\/keys|\/billing|\/webhooks|stripe|\/data\/export|gdpr|provider-keys|\/teams|\/tenants|except:|\/operations|\/attribution|eq:\/proxy/;

/** Handler body: the `if` line and the lines indented below it (same rule as the extractor, larger window). */
function bodyOf(r: Route): string {
  const lines = read(r.file).split(/\r?\n/);
  // a module regex constant used as the router (D1-D8 operation/attribution routes): the whole module is the handler
  if (!/\bif\s*\(/.test(lines[r.line - 1]!)) return lines.join('\n');
  const i = r.line - 1; const indent = lines[i]!.match(/^\s*/)![0].length; const out = [lines[i]!];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!; if (l.trim() === '') continue;
    if (l.match(/^\s*/)![0].length <= indent) break;
    out.push(l);
  }
  return out.join('\n');
}
/**
 * Guards of an enclosing dispatcher that run before the handler (e.g. the webhook 401, the GDPR RBAC, the flags platform
 * check): the dispatcher lines from its `if` up to its first nested method test.
 */
function prologueOf(r: Route): string {
  const lines = read(r.file).split(/\r?\n/);
  const out: string[] = [];
  for (const d of INVENTORY.filter((x) => x.file === r.file && x.line < r.line && DISPATCH.has(opId(x.methods[0]!, x)))) {
    const indent = lines[d.line - 1]!.match(/^\s*/)![0].length;
    const deeper = (l: string) => !l.trim() || l.match(/^\s*/)![0].length > indent;
    let inside = true;
    for (let k = d.line; k < r.line - 1; k++) if (!deeper(lines[k]!)) { inside = false; break; }
    if (!inside) continue;
    // the dispatcher's own lines until its first nested handler (a method test) or the handler itself
    for (let j = d.line; j < r.line - 1 && deeper(lines[j]!) && !/\bmethod\s*===/.test(lines[j]!); j++) out.push(lines[j]!);
  }
  return out.join('\n');
}
/**
 * Handler text for one method: when the route's body dispatches on the method itself (`if (method === 'GET') {...}`,
 * e.g. SCIM), only the lines before the first nested method test and the nested blocks of that method are kept.
 */
function forMethod(body: string, method: string): string {
  const lines = body.split('\n');
  const first = lines.findIndex((l, i) => i > 0 && /^\s*if\s*\(\s*method\s*===/.test(l));
  if (first < 0) return body;
  const out = lines.slice(0, first);
  for (let i = first; i < lines.length; i++) {
    const l = lines[i]!;
    if (!/^\s*if\s*\(\s*method\s*===/.test(l)) continue;
    if (!new RegExp(`method\\s*===\\s*'${method}'`).test(l)) continue;
    const indent = l.match(/^\s*/)![0].length; out.push(l);
    for (let j = i + 1; j < lines.length && (!lines[j]!.trim() || lines[j]!.match(/^\s*/)![0].length > indent); j++) out.push(lines[j]!);
  }
  return out.join('\n');
}
const handlerText = (r: Route, method?: string) => `${prologueOf(r)}\n${method && method !== 'ANY' ? forMethod(bodyOf(r), method) : bodyOf(r)}`;
/** A module whose regex constant is the router (no `if` line): one handler function serves several documented paths. */
const isModuleRouter = (r: Route) => !/\bif\s*\(/.test(read(r.file).split(/\r?\n/)[r.line - 1]!);
/** HTTP error statuses a handler body can write (static). */
function errorStatuses(body: string): number[] {
  const s = new Set<number>();
  for (const m of body.matchAll(/sendError\(res, 'OTK-(\d{3})\d'/g)) s.add(Number(m[1]));
  for (const m of body.matchAll(/(?:send(?:Json|ScimError)|\bjson)\(res, ([45]\d\d)\b/g)) s.add(Number(m[1]));
  if (/sendDenial\(res, /.test(body)) { s.add(401); s.add(403); s.add(429); } // gateway admission (resolveProxyCaller)
  for (const m of body.matchAll(/\? [1-5]\d\d : ([45]\d\d)/g)) s.add(Number(m[1]));
  if (/sendRbacDenial\(res, _deny|checkRbac\(/.test(body)) { s.add(401); s.add(403); }
  if (/sendRbacDenial\(res, \{ code: 401/.test(body)) s.add(401);
  if (/denyPlatformOperation\(/.test(body)) { s.add(401); s.add(403); }
  if (/denyCrossTenant\(/.test(body)) { s.add(401); s.add(403); }
  if (/denyForeignResource\(|denyForeignApiKey\(/.test(body)) { s.add(401); s.add(404); }
  if (/checkLegacyAdminKey\(/.test(body)) s.add(401);
  if (/denyUnverifiedOrDeprovisionedUser\(/.test(body)) { s.add(401); s.add(403); s.add(503); }
  if (/denySubjectStatusUnsaved\(/.test(body)) s.add(503);
  return [...s].sort();
}
const permissionsOf = (body: string) => [...new Set([...body.matchAll(/(?:checkRbac|denyPlatformOperation)\(\s*req\s*,\s*(?:res\s*,\s*)?'([a-z:-]+)'/g)].map((m) => m[1]!))].sort();
const declaredPermissions = (op: Json): string[] => [op['x-otk-permission'] ?? []].flat().map(String).sort();
const securityOf = (op: Json) => (op.security ?? SPEC.security ?? []) as Json[];

describe('H1R2 C1: OpenAPI coverage of the route inventory', () => {
  it('every exception names a route of the inventory and carries a reason (no wildcard, no stale entry)', () => {
    const all = new Set(INVENTORY.flatMap((r) => r.methods.map((m) => opId(m, r))));
    const bad = [...EXC.undocumented, ...EXC.dispatchers, ...EXC.unreachable].filter((e) => !all.has(e.route) || !e.reason || e.reason.length < 10 || /[*?]/.test(e.route.split(' ')[0]!));
    assert.deepEqual(bad, []);
    const dup = [...EXC.undocumented, ...EXC.dispatchers, ...EXC.unreachable].map((e) => e.route).filter((k, i, a) => a.indexOf(k) !== i);
    assert.deepEqual(dup, []);
  });

  it('every documented operation is served by a real handler (no phantom path)', () => {
    assert.deepEqual(DOCUMENTED.filter((d) => d.served.length === 0).map((d) => d.label), []);
  });

  it('every handler of the inventory is documented or an explicit exception', (t) => {
    const documented = new Set(DOCUMENTED.flatMap((d) => d.served.map((h) => h.id)));
    const exceptions = new Set([...EXC.undocumented, ...EXC.unreachable].map((e) => e.route));
    const missing = handlers.filter((h) => !documented.has(h.id) && !exceptions.has(h.id)).map((h) => h.id);
    assert.deepEqual(missing, [], 'document these routes in docs/api/openapi.json or add an exception with the reason');
    const stale = [...exceptions].filter((k) => documented.has(k));
    assert.deepEqual(stale, [], 'documented now: remove from openapi_route_exceptions.json');
    t.diagnostic(`handlers: ${handlers.length}; documented: ${documented.size}; exceptions: ${exceptions.size}`);
  });

  it('an "unreachable" exception is provably unreachable: its literal path is excluded by the dispatcher around it', () => {
    const wrong: string[] = [];
    for (const e of EXC.unreachable) {
      const h = handlers.find((x) => x.id === e.route);
      if (!h || h.route.kind !== 'eq') { wrong.push(`${e.route}: not an eq handler`); continue; }
      const lines = read(h.route.file).split(/\r?\n/);
      const enclosing = INVENTORY.filter((d) => d.file === h.route.file && d.line < h.route.line && d.kind === 'prefix' && DISPATCH.has(opId(d.methods[0]!, d))).filter((d) => {
        const indent = lines[d.line - 1]!.match(/^\s*/)![0].length;
        for (let k = d.line; k < h.route.line - 1; k++) { const l = lines[k]!; if (l.trim() && l.match(/^\s*/)![0].length <= indent) return false; }
        return true;
      });
      if (!enclosing.some((d) => !h.route.path.startsWith(d.path))) wrong.push(`${e.route}: no enclosing dispatcher excludes it`);
    }
    assert.deepEqual(wrong, []);
  });

  it('no sensitive route (admin, SCIM, keys, billing, export/GDPR, webhooks, tenants, teams, gateway) is an exception', () => {
    assert.deepEqual(EXC.undocumented.filter((e) => SENSITIVE.test(e.route) && !/@src\/prover\//.test(e.route)).map((e) => e.route), []);
  });

  it('documented operations declare every error status their handler can write', () => {
    const gaps: string[] = [];
    for (const d of DOCUMENTED) {
      for (const h of d.served) {
        // a module router serves several paths with one function: its statuses must appear on the operations it serves
        const ops = isModuleRouter(h.route) ? DOCUMENTED.filter((x) => x.served.some((y) => y.route === h.route)).map((x) => x.op) : [d.op];
        const documentedStatuses = new Set(ops.flatMap((o) => Object.keys(o.responses ?? {})));
        const text = isModuleRouter(h.route) ? handlerText(h.route) : handlerText(h.route, d.method);
        for (const s of errorStatuses(text)) if (!documentedStatuses.has(String(s))) gaps.push(`${d.label}: ${s} (handler ${h.route.file}:${h.route.line})`);
      }
    }
    assert.deepEqual(gaps, []);
  });

  it('authenticated routes document 401 and a security requirement; permissions and platform-only are declared', () => {
    const access = new Map(SURFACE.map((r) => [r.key, r.access]));
    const gaps: string[] = [];
    for (const d of DOCUMENTED) {
      for (const h of d.served) {
        const body = handlerText(h.route, d.method);
        if (access.get(h.route.key) === 'authenticated') {
          if (!d.op.responses?.['401']) gaps.push(`${d.label}: 401 not documented`);
          if (!securityOf(d.op).some((s: Json) => Object.keys(s).length > 0)) gaps.push(`${d.label}: no security requirement`);
        }
        const perms = permissionsOf(body); const declared = declaredPermissions(d.op);
        for (const p of perms) if (!declared.includes(p)) gaps.push(`${d.label}: x-otk-permission lacks ${p}`);
        if (/denyPlatformOperation\(/.test(body) && d.op['x-otk-platform'] !== true) gaps.push(`${d.label}: x-otk-platform must be true`);
      }
    }
    assert.deepEqual(gaps, []);
  });
});
