/**
 * NF-01 (RUN-S 2026-10-09): Gate R0 CHECK 1b must catch secret env reads outside the canonical boundaries in every
 * notation, keep configuration variables out of scope, and print names only. Fixtures are disposable directories
 * with fake values; the real repository must pass with the dated allowlist.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DETECTOR = path.join(ROOT, 'scripts', 'ops', 'secret_env_boundary.mjs');
const tmpDirs: string[] = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function fixture(files: Record<string, string>, allow?: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-nf01-'));
  tmpDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const allowPath = path.join(dir, 'allow.json');
  fs.writeFileSync(allowPath, JSON.stringify(allow ?? { entries: [] }));
  const r = spawnSync(process.execPath, [DETECTOR, dir, allowPath], { encoding: 'utf-8' });
  return { status: r.status, out: r.stdout + r.stderr };
}
const FAKE = 'fixture-value-must-never-be-printed';

describe('NF-01: secret env boundary detector', () => {
  it('dot notation outside the boundary is NO-GO and the value is not printed', () => {
    const r = fixture({ 'src/feature/a.ts': `export const s = process.env.OTK_FOO_SECRET ?? '${FAKE}';\n` });
    assert.equal(r.status, 1);
    assert.match(r.out, /VIOLATION src\/feature\/a\.ts:1 reads OTK_FOO_SECRET/);
    assert.ok(!r.out.includes(FAKE));
  });
  it('bracket notation and destructuring are NO-GO', () => {
    assert.equal(fixture({ 'src/a.ts': `const k = process.env['OTK_NEW_API_KEY'];\n` }).status, 1);
    assert.equal(fixture({ 'src/a.ts': `const { OTK_X_TOKEN, PORT } = process.env;\n` }).status, 1);
    assert.equal(fixture({ 'src/a.ts': `const u = process.env.OTK_DB_URL;\n` }).status, 1, 'credential URL');
  });
  it('reads at secretsBootstrap and under src/providers/ are allowed', () => {
    const r = fixture({
      'src/infra/secretsBootstrap.ts': `const a = process.env['OTK_ADMIN_KEY'];\n`,
      'src/providers/openai.ts': `const k = process.env.OPENAI_API_KEY;\n`,
    });
    assert.equal(r.status, 0, r.out);
  });
  it('a directory named providers elsewhere is not a boundary', () => {
    assert.equal(fixture({ 'src/evil/providers/x.ts': `const k = process.env.OPENAI_API_KEY;\n` }).status, 1);
  });
  it('configuration variables, paths and public certificates are out of scope', () => {
    const r = fixture({ 'src/a.ts': `const p = process.env.OTK_PROXY_PORT; const z = process.env.OTK_ZK_KEY_PATH; const c = process.env['OTK_SAML_CERT']; const f = process.env.OTK_BESU_FUNDER_KEY_FILE;\n` });
    assert.equal(r.status, 0, r.out);
  });
  it('an allowlisted read passes only when the entry has a finding id and a date', () => {
    const files = { 'src/a.ts': `const s = process.env.OTK_FOO_SECRET;\n` };
    assert.equal(fixture(files, { entries: [{ file: 'src/a.ts', var: 'OTK_FOO_SECRET', finding: 'NF-TEST', date: '2026-10-09' }] }).status, 0);
    assert.equal(fixture(files, { entries: [{ file: 'src/a.ts', var: 'OTK_FOO_SECRET' }] }).status, 1);
  });
  it('the allowlist is exact per file: the same variable in another file is NO-GO', () => {
    const r = fixture({ 'src/a.ts': `process.env.OTK_FOO_SECRET;\n`, 'src/b.ts': `process.env.OTK_FOO_SECRET;\n` },
      { entries: [{ file: 'src/a.ts', var: 'OTK_FOO_SECRET', finding: 'NF-TEST', date: '2026-10-09' }] });
    assert.equal(r.status, 1);
    assert.match(r.out, /src\/b\.ts/);
  });
  it('the repository passes with its dated allowlist and has no invalid entry', () => {
    const r = spawnSync(process.execPath, [DETECTOR, ROOT], { encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /RESULT: PASS/);
  });
});

describe('RV-RUNS-04 (adversarial review): reads the regex detector missed', () => {
  const cases: Array<[string, string]> = [
    ['optional chaining', `const s = process.env?.OTK_JWT_SECRET;\n`],
    ['process["env"] notation', `const s = process['env']['OTK_ADMIN_KEY'];\n`],
    ['alias of process.env', `const e = process.env;\nconst s = e['OTK_VAULT_MASTER_KEY'];\n`],
    ['Reflect.get', `const s = Reflect.get(process.env, 'OTK_STRIPE_SECRET_KEY');\n`],
    ['computed name', `const s = process.env['OTK_' + 'ADMIN_KEY'];\n`],
    ['import { env } from node:process', `import { env } from 'node:process';\nconst s = env.OTK_JWT_SECRET;\n`],
    ['dot on the next line', `const s = process.env\n  .OTK_JWT_SECRET;\n`],
    ['spread of the whole environment', `const all = { ...process.env };\n`],
    ['Object.entries of the environment', `for (const [k, v] of Object.entries(process.env)) void k, v;\n`],
    ['PASSPHRASE name', `const s = process.env.OTK_ENC_PASSPHRASE;\n`],
  ];
  for (const [label, body] of cases) {
    it(`${label} outside the boundary is NO-GO`, () => {
      const r = fixture({ 'src/feature/a.ts': body });
      assert.equal(r.status, 1, `${label}: ${r.out}`);
    });
  }
  it('.tsx files are scanned', () => {
    assert.equal(fixture({ 'src/ui/a.tsx': `export const s = process.env.OTK_FOO_SECRET;\n` }).status, 1);
  });
  it('a second read of an allowlisted variable in the same file exceeds the allowed count', () => {
    const allow = { entries: [{ file: 'src/a.ts', var: 'OTK_FOO_SECRET', finding: 'NF-TEST', date: '2026-10-10', count: 1 }] };
    assert.equal(fixture({ 'src/a.ts': `process.env.OTK_FOO_SECRET;\n` }, allow).status, 0);
    assert.equal(fixture({ 'src/a.ts': `process.env.OTK_FOO_SECRET;\nprocess.env.OTK_FOO_SECRET;\n` }, allow).status, 1);
  });
  it('a stale allowlist entry (read no longer present) is NO-GO', () => {
    const allow = { entries: [{ file: 'src/a.ts', var: 'OTK_FOO_SECRET', finding: 'NF-TEST', date: '2026-10-10' }] };
    assert.equal(fixture({ 'src/a.ts': `export const x = 1;\n` }, allow).status, 1);
  });
  it('configuration reads through literal names stay out of scope', () => {
    assert.equal(fixture({ 'src/a.ts': `const p = process.env?.OTK_PROXY_PORT; const q = process.env\n  .NODE_ENV;\n` }).status, 0);
  });
});

describe('RV2-RUNS-01 (second review pass): other paths to the process object', () => {
  const cases: Array<[string, string]> = [
    ['globalThis.process.env', `const s = globalThis.process.env.OTK_ADMIN_KEY;\n`],
    ['alias of process', `const p = process;\nconst s = p.env.OTK_ADMIN_KEY;\n`],
    ['destructuring env from process', `const { env } = process;\nconst s = env.OTK_ADMIN_KEY;\n`],
    ['type assertion', `const s = (process as any).env.OTK_ADMIN_KEY;\n`],
    ['default import of node:process', `import proc from 'node:process';\nconst s = proc.env.OTK_ADMIN_KEY;\n`],
    ['namespace import of node:process', `import * as pp from 'node:process';\nconst s = pp.env.OTK_ADMIN_KEY;\n`],
    ['Reflect.get(process, env)', `const s = (Reflect.get(process, 'env') as Record<string, string>)['OTK_ADMIN_KEY'];\n`],
    ['getOwnPropertyDescriptor', `const s = Object.getOwnPropertyDescriptor(process, 'env')!.value.OTK_ADMIN_KEY;\n`],
    ['dynamic import of node:process', `export async function f() { return (await import('node:process')).env.OTK_ADMIN_KEY; }\n`],
    ['require of process', `const s = require('process').env.OTK_ADMIN_KEY;\n`],
    ['re-export of env', `export { env } from 'node:process';\n`],
  ];
  for (const [label, body] of cases) {
    it(`${label} outside the boundary is NO-GO`, () => {
      assert.equal(fixture({ 'src/feature/a.ts': body }).status, 1, label);
    });
  }
  it('harmless members of process stay out of scope', () => {
    const r = fixture({ 'src/a.ts': `process.on('exit', () => {}); const a = process.argv; const c = process.cwd(); const p = process.platform; process.exitCode = 0; const { argv, pid } = process; process.stdout.write(''); const h = process.hrtime.bigint(); const m = process.memoryUsage(); void a, c, p, argv, pid, h, m;\n` });
    assert.equal(r.status, 0, r.out);
  });
});

describe('M24-O02 (RUN-M1-24H, probe of 18 artificial patterns): remaining false negatives', () => {
  const cases: Array<[string, string]> = [
    ['secret name with an encoding suffix (_KEY_HEX)', `const s = process.env.OTK_SIGNER_KEY_HEX;\n`],
    ['connection string name (_DSN)', `const s = process.env.OTK_DATABASE_DSN;\n`],
    ['API key name without underscore (APIKEY)', `const s = process.env.OPENAI_APIKEY;\n`],
    ['credentials name (_CREDENTIALS)', `const s = process.env.OTK_GCP_CREDENTIALS;\n`],
    ['seed name (_SEED)', `const s = process.env.OTK_WALLET_SEED;\n`],
    ['password abbreviations (PASSWD, _PWD)', `const a = process.env.OTK_SMTP_PASSWD; const b = process.env.OTK_DB_PWD;\n`],
    ['connection string name', `const s = process.env.OTK_ANALYTICS_CONNECTION_STRING;\n`],
    ['named connection URL (*_DB_URL, *_REDIS_URL)', `const a = process.env.OTK_ARCHIVE_DB_URL; const b = process.env.OTK_CACHE_REDIS_URL;\n`],
    ['dynamic import with a computed specifier', `export async function f() { const m = await import('node:' + 'process'); return m.env.OTK_ADMIN_KEY; }\n`],
    ['require with a computed specifier', `const n = 'proc' + 'ess';\nconst s = require(n).env.OTK_ADMIN_KEY;\n`],
    ['reading a .env file directly', `import fs from 'node:fs';\nexport const raw = fs.readFileSync('.env', 'utf8');\n`],
    ['reading a .env.<stage> file by path', `import fs from 'node:fs';\nexport const raw = fs.readFileSync('config/.env.production', 'utf8');\n`],
    // ADV-M24-09 (adversarial review): names and paths the first extension still missed
    ['cookie, bearer and *_PRIVATE names', `const a = process.env.OTK_SESSION_COOKIE; const b = process.env.OTK_BEARER; const c = process.env.OTK_SIGNER_PRIVATE;\n`],
    ['compound encoding suffix (_KEY_HEX_V2, _KEY_BASE64URL)', `const a = process.env.OTK_SIGNER_KEY_HEX_V2; const b = process.env.OTK_HMAC_KEY_BASE64URL;\n`],
    ['named connection URL outside the first list (*_DB_URL)', `const s = process.env.OTK_REPLICA_DB_URL;\n`],
    ['reading a multi-segment dotenv file (.env.production.local)', `import fs from 'node:fs';\nexport const raw = fs.readFileSync('./.env.production.local', 'utf8');\n`],
  ];
  for (const [label, body] of cases) {
    it(`${label} outside the boundary is NO-GO`, () => {
      assert.equal(fixture({ 'src/feature/a.ts': body }).status, 1, label);
    });
  }
  it('stays out of scope: key paths, dynamic imports whose branches are all literals, and ordinary file names', () => {
    const r = fixture({ 'src/a.ts': `const p = process.env.OTK_ZK_KEY_PATH; const q = process.env.OTK_SAML_CERT;\nexport async function f(u: string) { return (await import(u.startsWith('https') ? 'node:https' : 'node:http')).default; }\nconst names = ['environment.ts', 'my.env.json', 'envelope'];\nvoid p, q, names;\n` });
    assert.equal(r.status, 0, r.out);
  });
  it('a conditional dynamic import whose branch is process is still caught', () => {
    assert.equal(fixture({ 'src/feature/a.ts': `export async function f(x: boolean) { return (await import(x ? 'node:process' : 'node:http')) as any; }\n` }).status, 1);
  });
  it('a template specifier with a fixed package prefix is classifiable; one whose prefix could still be process is not', () => {
    const ok = fixture({ 'src/a.ts': `export function f(e: string) { return require(\`js-tiktoken/ranks/\${e}\`); }\n` });
    assert.equal(ok.status, 0, ok.out);
    assert.equal(fixture({ 'src/feature/a.ts': `export async function f(x: string) { return (await import(\`node:\${x}\`)) as any; }\n` }).status, 1);
  });
});
