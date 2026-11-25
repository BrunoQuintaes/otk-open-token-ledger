#!/usr/bin/env node
/**
 * RUN-S-T001 / T026 (RUN-S 2026-10-09, Gate S-05): static inventory of the HTTP routes registered in the source, with
 * the guards found in each handler. Not a proof of authorization (a guard can exist and still be wrong); it makes the
 * surface explicit so that a new route without an inventory entry fails the surface test.
 * Usage: node scripts/ops/extract_routes.mjs <repo-root> [--json]
 *
 * H1R2 C1 (S08-F01): the extractor also resolves the handler forms it used to miss (16 handlers of src/api/routes.ts
 * plus the prover, SCIM and gateway routes listed below), so they enter the committed inventory:
 *   - `x.match(/re/)` / `/re/.test(x)` whose regex contains `/` inside a character class (`[^/]`): the regex literal is
 *     now read with a balanced scanner instead of `[^/]+`;
 *   - path variables derived from the request path (`flagsPath`, …), declared in PATH_VARS;
 *   - positive `x.endsWith('…')` (kind `suffix`; negated `!x.endsWith` is an exclusion, not a route);
 *   - `if (fooMatch)` where `const fooMatch = x.match(/re/)` (kind `regex`, the regex of the assignment); with no method
 *     on the line the methods come from `method === '…'` tests nested in the body, and a `*Match` test with no method
 *     at all is a guard (e.g. the webhook ownership pre-check), not a route;
 *   - a module regex constant used as the router (`const ROUTE = /re/` + `ROUTE.exec(pathname)`), methods taken from
 *     the `method !== '…'` tests of the file (D1-D8 operation and attribution routes served by the gateway);
 *   - a catch-all flag (`const isMitmPath = url.pathname !== '/a' && …; if (isMitmPath)`), kind `except`.
 *
 * In short: it reads the router files listed in FILES as plain text, line by line (it does not parse TypeScript),
 * and prints one entry per route with server, methods, match kind, path or regex, file:line and the guard calls
 * found on the line and in the indented body below it (up to 60 lines). Duplicate entries are merged.
 * It is run by the route-surface and API-contract tests under test/security and test/unit, which compare its JSON
 * output with committed inventories; changing what it reports changes those tests. It only reads files.
 *
 * @module scripts/ops/extract_routes
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? '.';
const FILES = [
  ['api', 'src/api/routes.ts'],
  ['proxy', 'src/proxy/ProxyGateway.ts'],
  ['proxy', 'src/operations/routes.ts'],
  ['proxy', 'src/operations/attributionRoutes.ts'],
  ['prover', 'src/prover/ProverDaemon.ts'],
  ['api', 'src/auth/scim/ScimRouter.ts'],
  ['api', 'src/dashboard/app.ts'],
  ['api', 'src/dashboard/login.ts'],
];
// H1R2 C1: variables that hold the request path (or a normalised copy of it)
const PATH_VARS = '(?:routePath|pathname|url\\.pathname|path|p|sub|subPath|flagsPath)';
const PATH_EQ = new RegExp(`(?<![\\w.])${PATH_VARS}\\s*===\\s*'(\\/[^']*)'`, 'g');
const PATH_SW = new RegExp(`(?<![\\w.])${PATH_VARS}\\.startsWith\\('(\\/[^']*)'\\)`, 'g');
const PATH_EW = new RegExp(`(?<![!\\w.])${PATH_VARS}\\.endsWith\\('(\\/[^']*)'\\)`, 'g');
const PATH_MATCH_CALL = new RegExp(`(?<![!\\w.])${PATH_VARS}\\.match\\(\\/`, 'g');
const PATH_VAR_AT = new RegExp(`^${PATH_VARS}\\)`);
const METHOD = /method\s*===\s*'([A-Z]+)'/g;
const GUARDS = [
  ['rbac', /checkRbac\(\s*req\s*,\s*'([a-z:-]+)'/g],
  ['platform', /denyPlatformOperation\(\s*req\s*,\s*res\s*,\s*'([a-z:-]+)'/g],
  ['legacyAdminKey', /checkLegacyAdminKey\(/g],
  ['crossTenant', /denyCrossTenant\(|denyForeignApiKey\(|assertTenantBoundary\(/g],
  ['tenantScope', /callerTenantScope\(|tenantScopeUnlessPlatform\(|resolveCallerContext\(/g],
  ['proxyAuth', /authorizeOperationAccess\(|authorizeMeteringWrite\(|authorize[A-Z][A-Za-z]*\(/g],
  ['authenticate', /authenticateRequest\(|requireAuth\(|verifyToken\(|scimAuth|bearerOk|checkScimToken|isScimAuthorized/g],
  ['platformCaller', /isPlatformCaller\(/g],
];

/**
 * H1R2 C1: reads the regex literal that starts at src[i] === '/' (escapes and character classes balanced).
 *
 * @param src - Text to read from (one source line in practice).
 * @param i - Index of the opening slash.
 * @returns The literal with its flags and the index just after it, or `null` when no closing slash is found
 *   before the end of the line.
 */
function readRegexLiteral(src, i) {
  let j = i + 1; let inClass = false;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\n') return null;
    if (c === '\\') { j++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') break;
  }
  if (j >= src.length) return null;
  let k = j + 1; while (k < src.length && /[a-z]/.test(src[k])) k++;
  return { text: src.slice(i, k), end: k };
}
/**
 * Regex literals tested against a path variable on a line: `x.match(/re/)` and `/re/.test(x)` / `.exec(x)`.
 *
 * @param l - One source line.
 * @returns The regex literals found, as source text with flags, in line order.
 */
function regexesOn(l) {
  const out = [];
  for (const m of l.matchAll(PATH_MATCH_CALL)) {
    const r = readRegexLiteral(l, m.index + m[0].length - 1);
    if (r) out.push(r.text);
  }
  for (let i = 0; i < l.length; i++) {
    if (l[i] !== '/' || (i > 0 && !/[\s(!&|=,]/.test(l[i - 1]))) continue;
    const r = readRegexLiteral(l, i);
    if (!r || r.text.length < 4) continue;
    const rest = l.slice(r.end).match(/^\.(?:test|exec)\(/);
    if (rest && PATH_VAR_AT.test(l.slice(r.end + rest[0].length))) out.push(r.text);
    i = r.end - 1;
  }
  return out;
}
const methodsIn = (t) => [...t.matchAll(METHOD)].map((m) => m[1]);

function routesOf(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  const src = fs.readFileSync(abs, 'utf-8');
  const lines = src.split(/\r?\n/);
  const out = [];
  // H1R2 C1: `const fooMatch = <pathVar>.match(/re/)` (last assignment before use wins), path-flag booleans and module
  // regex constants used as routers
  const matchVars = new Map();
  const exceptVars = new Map();
  const routerConsts = new Map();
  const bodyOf = (i) => {
    const indent = lines[i].match(/^\s*/)[0].length;
    const body = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
      const lj = lines[j];
      if (lj.trim() === '') continue;
      const ind = lj.match(/^\s*/)[0].length;
      if (ind <= indent) break; // the indentation returned to the if's level (closing brace or next statement)
      body.push(lj);
    }
    return body;
  };
  for (const l of lines) {
    const rc = l.match(/^const ([A-Z][A-Z0-9_]*)\s*=\s*\//);
    if (rc) { const r = readRegexLiteral(l, l.indexOf('/', rc[0].length - 1)); if (r) routerConsts.set(rc[1], r.text); }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const mv = l.match(/\bconst (\w+Match)\s*=\s*/);
    if (mv) { const rs = regexesOn(l); if (rs.length) matchVars.set(mv[1], rs[0]); }
    const ev = l.match(new RegExp(`\\bconst (\\w+)\\s*=\\s*((?:${PATH_VARS}\\s*!==\\s*'\\/[^']*'(?:\\s*&&\\s*)?)+);`));
    if (ev) exceptVars.set(ev[1], [...ev[2].matchAll(/'(\/[^']*)'/g)].map((m) => m[1]).join(','));
    for (const [name, re] of routerConsts) {
      if (new RegExp(`\\b${name}\\.(?:exec|test)\\(${PATH_VARS}\\)`).test(l)) {
        const methods = [...new Set([...src.matchAll(/method\s*[!=]==\s*'([A-Z]+)'/g)].map((m) => m[1]))];
        out.push({ file: rel, line: i + 1, methods: methods.length ? methods.sort() : ['ANY'], kind: 'regex', path: re, guards: [] });
        routerConsts.delete(name); // one entry per router constant
      }
    }
    if (!/\bif\s*\(/.test(l) && !/^\s*(else\s+)?if/.test(l) && !/case\s/.test(l)) continue;
    const paths = [];
    for (const m of l.matchAll(PATH_EQ)) paths.push({ kind: 'eq', path: m[1] });
    for (const m of l.matchAll(PATH_SW)) paths.push({ kind: 'prefix', path: m[1] });
    for (const m of l.matchAll(PATH_EW)) paths.push({ kind: 'suffix', path: m[1] });
    for (const re of regexesOn(l)) paths.push({ kind: 'regex', path: re });
    const ifCond = l.slice(l.search(/\bif\s*\(/));
    let methods = methodsIn(l);
    const body = bodyOf(i);
    for (const [name, re] of matchVars) {
      if (!new RegExp(`(?<![!\\w])${name}\\b`).test(ifCond)) continue;
      // a *Match test with no method on the line and none nested in the body is a guard, not a route
      if (!methods.length) { methods = methodsIn(body.join('\n')); if (!methods.length) continue; }
      paths.push({ kind: 'regex', path: re });
    }
    for (const [name, list] of exceptVars) {
      if (new RegExp(`\\bif\\s*\\(\\s*${name}\\s*\\)`).test(l)) paths.push({ kind: 'except', path: list });
    }
    if (!paths.length) continue;
    const text = [l, ...body].join('\n');
    const guards = [];
    for (const [name, re] of GUARDS) for (const m of text.matchAll(re)) guards.push(m[1] ? `${name}:${m[1]}` : name);
    for (const p of paths) out.push({ file: rel, line: i + 1, methods: methods.length ? [...new Set(methods)] : ['ANY'], kind: p.kind, path: p.path, guards: [...new Set(guards)].sort() });
  }
  return out;
}

const all = [];
for (const [server, rel] of FILES) for (const r of routesOf(rel)) all.push({ server, ...r });
const key = (r) => `${r.server} ${r.methods.join('|')} ${r.kind}:${r.path} @${r.file}`;
const seen = new Map();
for (const r of all) { const k = key(r); if (!seen.has(k)) seen.set(k, { ...r, key: k }); }
const routes = [...seen.values()];
if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify(routes, null, 1)); }
else {
  console.log(`routes: ${routes.length}`);
  for (const r of routes) console.log(`${r.key}  [${r.guards.join(', ') || 'NO GUARD FOUND'}]  :${r.line}`);
}
