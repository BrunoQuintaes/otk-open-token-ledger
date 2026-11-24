#!/usr/bin/env node
/**
 * Gate R0 CHECK 1b (NF-01, RUN-S 2026-10-09; rewritten for RV-RUNS-04 on 2026-10-10): secret environment variables may be
 * read only at the canonical boundaries (src/infra/secretsBootstrap.ts and the provider gateway under src/providers/).
 * The first version used regular expressions and missed optional chaining, process['env'], aliases of process.env,
 * Reflect.get, computed names, `import { env } from 'node:process'`, a dot on the next line, spreads and .tsx files.
 * This version walks the TypeScript AST of every source file under src/:
 *   - a literal read (process.env.X, process.env['X'], process.env?.X, process['env'].X, destructuring) is classified
 *     by name; a secret name outside the boundaries is a violation;
 *   - any other use of the environment object (alias, spread, argument such as Reflect.get / Object.entries, computed
 *     key, `env` imported from node:process) cannot be classified and is a violation too ("*" in the allowlist);
 *   - pre-existing reads are accepted only through scripts/ops/secret_env_allowlist.json, each entry with a finding id,
 *     a date and a maximum count per file; a stale entry (no longer read) or an entry without finding/date is NO-GO.
 * Prints file:line and names only, never values. Exit 0 = PASS, 1 = FAIL, 2 = usage error.
 * Usage: node scripts/ops/secret_env_boundary.mjs <repo-root> [allowlist.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.argv[2];
if (!root) { console.error('usage: secret_env_boundary.mjs <repo-root> [allowlist.json]'); process.exit(2); }
const allowPath = process.argv[3] ?? path.join(root, 'scripts', 'ops', 'secret_env_allowlist.json');
const allow = fs.existsSync(allowPath) ? JSON.parse(fs.readFileSync(allowPath, 'utf-8')).entries : [];
const require = createRequire(import.meta.url);
const ts = require('typescript');

// M24-O02 (RUN-M1-24H): APIKEY without underscore, CREDENTIALS, DSN and SEED names; an encoding suffix (_HEX, _B64, _PEM...)
// is stripped before classifying, so OTK_SIGNER_KEY_HEX is a key and OTK_SAML_CERT_PEM stays a public certificate
const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|_PWD|PASSPHRASE|_PASS|TOKEN|PRIVKEY|PRIVATE_KEY|MNEMONIC|SALT|API_KEY|APIKEY|_KEY|CREDENTIALS?|_DSN|_SEED|CONNECTION_STRING|CONN_STR|COOKIE|BEARER|_PRIVATE)$/;
const SECRET_EXACT = new Set(['OTK_TENANTS', 'OTK_DB_URL', 'OTK_REDIS_URL', 'OTK_PILOT_PG_URL', 'PRIVKEY']);
// ADV-M24 (adversarial review): connection URLs carry passwords even though other *_URL names are configuration
const CONNECTION_URL = /(_DB_URL|_DATABASE_URL|_PG_URL|_POSTGRES_URL|_REDIS_URL|_MONGO_URL|_AMQP_URL)$/;
const NOT_SECRET = /(_PATH|_FILE|_CERT|_ID|_URL)$/;
// ADV-M24-09: compound suffixes (_HEX_V2, _BASE64URL) are stripped repeatedly
const ENCODING_SUFFIX = /_(HEX|B64|B64URL|BASE64|BASE64URL|PEM|DER|JSON|RAW|V\d+)$/;
export function isSecretName(raw) {
  let name = String(raw).toUpperCase();
  for (let prev = ''; prev !== name;) { prev = name; name = name.replace(ENCODING_SUFFIX, ''); }
  if (SECRET_EXACT.has(name) || CONNECTION_URL.test(name)) return true;
  if (NOT_SECRET.test(name)) return false;
  return SECRET_NAME.test(name);
}
// a literal path to a dotenv file (.env, .env.production, config/.env): reading it bypasses process.env entirely
const ENV_FILE = /(^|[\\/])\.env(\.[A-Za-z0-9_-]+)*$/;
// canonical boundaries (.claude/rules/security.md: secretsBootstrap, SecretsManager, ProviderGateway)
const BOUNDARY = (rel) => rel === 'src/infra/secretsBootstrap.ts' || rel === 'src/security/SecretsManager.ts' || rel.startsWith('src/providers/');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

// RV2-RUNS-01 (RUN-S review): also strip type assertions and non-null, and accept globalThis.process / global.process
const stripParens = (n) => {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))) n = n.expression;
  return n;
};
const isProcess = (n) => {
  n = stripParens(n);
  if (!n) return false;
  if (ts.isIdentifier(n) && n.text === 'process') return true;
  return ts.isPropertyAccessExpression(n) && n.name.text === 'process' && ts.isIdentifier(stripParens(n.expression)) && ['globalThis', 'global', 'self', 'window'].includes(stripParens(n.expression).text);
};
const PROCESS_MODULE = /^(node:)?process$/;
// members of process that carry no environment data; any other use of the process object is unclassified
const SAFE_PROCESS_MEMBERS = new Set(['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners', 'listeners', 'listenerCount', 'emit', 'emitWarning',
  'exit', 'exitCode', 'kill', 'abort', 'argv', 'argv0', 'execArgv', 'execPath', 'cwd', 'chdir', 'platform', 'arch', 'pid', 'ppid', 'title', 'version', 'versions',
  'release', 'features', 'uptime', 'hrtime', 'memoryUsage', 'cpuUsage', 'resourceUsage', 'nextTick', 'stdout', 'stderr', 'stdin', 'umask', 'config', 'report',
  'allowedNodeEnvironmentFlags', 'getuid', 'geteuid', 'getgid', 'getegid', 'setUncaughtExceptionCaptureCallback', 'hasUncaughtExceptionCaptureCallback', 'constrainedMemory', 'availableMemory']);
const literalKey = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
/** every module specifier a dynamic import/require can receive, or null when one of them is not a literal (M24-O02) */
const specifierCandidates = (n) => {
  n = stripParens(n);
  if (!n) return null;
  const k = literalKey(n);
  if (k !== null) return [k];
  if (ts.isConditionalExpression(n)) {
    const a = specifierCandidates(n.whenTrue); const b = specifierCandidates(n.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  // `pkg/dir/${x}`: every value starts with the static head; a head that is not a prefix of (node:)process cannot be it
  if (ts.isTemplateExpression(n)) {
    const head = n.head.text;
    return head && !'process'.startsWith(head) && !'node:process'.startsWith(head) ? [`${head}\${...}`] : null;
  }
  return null;
};
/** node is the environment object: process.env, process?.env, process['env'] or an identifier imported as env from node:process */
function isEnvObject(n, envIdents) {
  n = stripParens(n);
  if (!n) return false;
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'env' && isProcess(n.expression)) return true;
  if (ts.isElementAccessExpression(n) && literalKey(n.argumentExpression) === 'env' && isProcess(n.expression)) return true;
  if (ts.isIdentifier(n) && envIdents.has(n.text)) return true;
  return false;
}

function scanFile(abs, rel) {
  const text = fs.readFileSync(abs, 'utf-8');
  const kind = /\.tsx$/.test(abs) ? ts.ScriptKind.TSX : /\.(js|jsx|mjs|cjs)$/.test(abs) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind);
  const envIdents = new Set();
  // `import { env } from 'node:process'` / `import { env as e } from 'process'`
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /^(node:)?process$/.test(st.moduleSpecifier.text)) {
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if ((el.propertyName ?? el.name).text === 'env') envIdents.add(el.name.text);
    }
  }
  const reads = [];
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  // RV2-RUNS-01: default/namespace imports and re-exports of the process module cannot be classified
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && PROCESS_MODULE.test(st.moduleSpecifier.text)) {
      const ic = st.importClause; const nb = ic?.namedBindings;
      if (ic?.name || (nb && ts.isNamespaceImport(nb))) reads.push({ rel, name: '*', line: line(st), kind: 'process-import' });
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && PROCESS_MODULE.test(st.moduleSpecifier.text)) {
      const ec = st.exportClause;
      if (!ec || !ts.isNamedExports(ec) || ec.elements.some((el) => (el.propertyName ?? el.name).text === 'env')) reads.push({ rel, name: '*', line: line(st), kind: 'process-reexport' });
    }
  }
  const isDeclName = (n) => { const p = n.parent; return p && ((ts.isPropertyAccessExpression(p) && p.name === n) || ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) && p.name === n)); };
  const visit = (node) => {
    // RV2-RUNS-01: import('process') / require('process'); M24-O02: a specifier that is not a literal cannot be classified
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        && node.arguments.length) {
      const cands = specifierCandidates(node.arguments[0]);
      if (cands === null) reads.push({ rel, name: '*', line: line(node), kind: 'dynamic-module' });
      else if (cands.some((c) => PROCESS_MODULE.test(c))) reads.push({ rel, name: '*', line: line(node), kind: 'process-import' });
    }
    // M24-O02: a literal path to a dotenv file
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && ENV_FILE.test(node.text)) {
      reads.push({ rel, name: '*', line: line(node), kind: 'env-file' });
    }
    // RV2-RUNS-01: the process object used other than through a harmless member or an env access
    if (isProcess(node) && !(ts.isIdentifier(node) && isDeclName(node)) && !(ts.isPropertyAccessExpression(node) && node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      let up = node; while (up.parent && (ts.isParenthesizedExpression(up.parent) || ts.isAsExpression(up.parent) || ts.isNonNullExpression(up.parent) || ts.isTypeAssertionExpression(up.parent) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(up.parent)))) up = up.parent;
      const par = up.parent;
      const member = par && ts.isPropertyAccessExpression(par) && par.expression === up ? par.name.text : par && ts.isElementAccessExpression(par) && par.expression === up ? literalKey(par.argumentExpression) : undefined;
      if (member === 'env') { /* handled by the env object logic below */ }
      else if (member !== undefined && member !== null && SAFE_PROCESS_MEMBERS.has(member)) { /* harmless */ }
      else if (par && ts.isTypeOfExpression(par)) { /* typeof process */ }
      else if (par && ts.isVariableDeclaration(par) && par.initializer === up && ts.isObjectBindingPattern(par.name)
        && par.name.elements.every((el) => !el.dotDotDotToken && SAFE_PROCESS_MEMBERS.has((el.propertyName ?? el.name).text ?? ''))) { /* const { argv } = process */ }
      else if (!(ts.isPropertyAccessExpression(node) && isEnvObject(node.parent, envIdents))) {
        reads.push({ rel, name: '*', line: line(node), kind: 'process-object' });
        return;
      }
    }
    if (isEnvObject(node, envIdents) && !(ts.isIdentifier(node) && node.parent && ts.isImportSpecifier(node.parent))) {
      const parent = node.parent;
      const isObjOf = (p) => p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && stripParens(p.expression) === node;
      // skip the inner `process.env` of an outer process['env'] chain: handled on the outer node
      if (isObjOf(parent) && ts.isPropertyAccessExpression(parent)) {
        reads.push({ rel, name: parent.name.text, line: line(parent), kind: 'literal' });
      } else if (isObjOf(parent) && ts.isElementAccessExpression(parent)) {
        const k = literalKey(parent.argumentExpression);
        reads.push(k ? { rel, name: k, line: line(parent), kind: 'literal' } : { rel, name: '*', line: line(parent), kind: 'computed' });
      } else if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
        for (const el of parent.name.elements) {
          const key = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : null) : (ts.isIdentifier(el.name) ? el.name.text : null);
          if (el.dotDotDotToken || !key) reads.push({ rel, name: '*', line: line(el), kind: 'rest' });
          else reads.push({ rel, name: key, line: line(el), kind: 'literal' });
        }
      } else if (parent && ts.isTypeOfExpression(parent)) {
        // typeof process.env: no value read
      } else {
        reads.push({ rel, name: '*', line: line(node), kind: 'whole-env' });
      }
      // a process['env'] node contains `process`; do not descend into it as another env object
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return reads;
}

const srcDir = path.join(root, 'src');
const files = fs.existsSync(srcDir) ? walk(srcDir, []) : [];
const reads = [];
for (const f of files) reads.push(...scanFile(f, path.relative(root, f).split(path.sep).join('/')));
const relevant = reads.filter((r) => !BOUNDARY(r.rel) && (r.name === '*' || isSecretName(r.name)));
const groups = new Map();
for (const r of relevant) { const k = `${r.rel}|${r.name}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
const violations = []; const used = new Set();
for (const [k, rs] of groups) {
  const [rel, name] = k.split('|');
  const entry = allow.find((a) => a.file === rel && a.var === name);
  const max = entry ? Number(entry.count ?? 1) : 0;
  if (entry) used.add(k);
  if (rs.length > max) for (const r of rs.slice(max)) violations.push(r);
}
const stale = allow.filter((a) => !used.has(`${a.file}|${a.var}`));
const badEntries = allow.filter((a) => !a.finding || !/^\d{4}-\d{2}-\d{2}$/.test(a.date ?? ''));

console.log(`files scanned: ${files.length}; env reads: ${reads.length}; secret or unclassified reads outside boundary: ${relevant.length}; allowlisted: ${relevant.length - violations.length}`);
for (const v of violations) console.log(`VIOLATION ${v.rel}:${v.line} ${v.name === '*' ? `unclassified access to the environment (${v.kind})` : `reads ${v.name}`} outside secretsBootstrap/provider gateway`);
for (const s of stale) console.log(`STALE allowlist entry (no longer read): ${s.file} ${s.var} (${s.finding})`);
for (const b of badEntries) console.log(`INVALID allowlist entry (needs finding id and YYYY-MM-DD date): ${b.file} ${b.var}`);
if (violations.length || stale.length || badEntries.length) { console.log('RESULT: FAIL'); process.exit(1); }
console.log('RESULT: PASS');
