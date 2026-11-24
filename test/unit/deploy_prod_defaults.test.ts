/**
 * PF-NEW-04 and the Helm half of PF-NEW-03 (POST-FREEZE review; decision D2 = fix, RUN-S prompt of the author
 * 2026-10-08). docker-compose.prod.yml shipped a fixed OWNER token (public in the repository), Redis password
 * "changeme" and a CSRF placeholder as defaults; the Helm chart rendered empty OTK_TENANTS / OTK_ADMIN_KEY /
 * OTK_JWT_SECRET / OTK_CSRF_SECRET with NODE_ENV=production. Production deployment files must not carry a default
 * credential and must stop when one is missing. Compose interpolation is checked with `docker compose config` when
 * the Docker CLI is available (skipped otherwise, and the skip is reported); no value printed here is a real secret.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const COMPOSE = path.join(ROOT, 'docker-compose.prod.yml');
const text = fs.readFileSync(COMPOSE, 'utf-8');
const hasDocker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf-8' }).status === 0;

const COMPOSE_VARS = ['OTK_ADMIN_KEY', 'POSTGRES_PASSWORD', 'OTK_TENANTS', 'OTK_CSRF_SECRET', 'REDIS_PASSWORD', 'OTK_JWT_SECRET', 'OTK_DB_URL'];
function composeConfig(env: Record<string, string>) {
  // inherit the real environment (the compose plugin needs it) without any compose variable of the caller
  const base = { ...process.env } as Record<string, string>;
  for (const v of COMPOSE_VARS) delete base[v];
  return spawnSync('docker', ['compose', '-f', COMPOSE, 'config'], { encoding: 'utf-8', env: { ...base, ...env } });
}
// H1-S01: OTK_DB_URL is required too (production refuses in-memory plan assignments)
const ALL = { OTK_ADMIN_KEY: 'fx-admin', POSTGRES_PASSWORD: 'fx-pg', OTK_TENANTS: 'acme/OWNER:fx-token', OTK_CSRF_SECRET: 'fx-csrf', REDIS_PASSWORD: 'fx-redis', OTK_DB_URL: 'postgres://fx-host/fx' };

describe('PF-NEW-04: docker-compose.prod.yml has no default credential', () => {
  it('no fixed token, changeme or CSRF placeholder in the file', () => {
    for (const bad of ['ga-admin-token', 'ga-loadtest-token', 'changeme', 'otk-csrf-local']) {
      assert.ok(!text.includes(bad), `docker-compose.prod.yml still contains ${bad}`);
    }
  });
  it('OTK_TENANTS, OTK_CSRF_SECRET and REDIS_PASSWORD are mandatory (:?) and never defaulted (:-)', () => {
    for (const v of ['OTK_TENANTS', 'OTK_CSRF_SECRET', 'REDIS_PASSWORD', 'OTK_ADMIN_KEY', 'POSTGRES_PASSWORD']) {
      assert.ok(text.includes(`\${${v}:?`), `${v} must be required`);
      assert.ok(!text.includes(`\${${v}:-`), `${v} must not have a default`);
    }
  });
  it('the docker compose harness works (a valid file renders)', { skip: !hasDocker && 'docker CLI not available' }, () => {
    const r = spawnSync('docker', ['compose', 'version'], { encoding: 'utf-8', env: process.env });
    assert.equal(r.status, 0, r.stderr);
  });
  it('docker compose config refuses each missing credential', { skip: !hasDocker && 'docker CLI not available' }, () => {
    for (const missing of ['OTK_TENANTS', 'OTK_CSRF_SECRET', 'REDIS_PASSWORD']) {
      const env = { ...ALL } as Record<string, string>;
      delete env[missing];
      const r = composeConfig(env);
      assert.notEqual(r.status, 0, `config must fail without ${missing}`);
      assert.match(r.stderr, new RegExp(missing));
    }
  });
  it('docker compose config refuses an empty OTK_TENANTS', { skip: !hasDocker && 'docker CLI not available' }, () => {
    const r = composeConfig({ ...ALL, OTK_TENANTS: '' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OTK_TENANTS/, 'must fail because of OTK_TENANTS, not for another reason');
  });
  it('H1-S01: docker compose config fails without OTK_DB_URL', { skip: !hasDocker && 'docker CLI not available' }, () => {
    const { OTK_DB_URL: _omit, ...rest } = ALL;
    const r = composeConfig(rest);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OTK_DB_URL/);
  });
  it('docker compose config renders the operator values when all are set', { skip: !hasDocker && 'docker CLI not available' }, () => {
    const r = composeConfig(ALL);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('acme/OWNER:fx-token'));
    assert.ok(!r.stdout.includes('changeme') && !r.stdout.includes('ga-admin-token'));
  });
});

describe('PF-NEW-03 (Helm): production values cannot render empty credentials', () => {
  const secretTpl = fs.readFileSync(path.join(ROOT, 'infra', 'helm', 'otk', 'templates', 'secret.yaml'), 'utf-8');
  it('secret.yaml fails the render when a credential is empty and NODE_ENV is production or staging', () => {
    assert.match(secretTpl, /fail/);
    for (const k of ['OTK_TENANTS', 'OTK_ADMIN_KEY', 'OTK_JWT_SECRET', 'OTK_CSRF_SECRET']) assert.ok(secretTpl.includes(k), k);
    assert.ok(secretTpl.includes('production') && secretTpl.includes('staging'));
  });
});

describe('PF-NEW-03 (Helm): real render with a pinned helm image', () => {
  const IMAGE = 'alpine/helm:3.16.4';
  const hasImage = hasDocker && spawnSync('docker', ['image', 'inspect', IMAGE], { encoding: 'utf-8' }).status === 0;
  const charts = path.join(ROOT, 'infra', 'helm');
  const helm = (...args: string[]) => spawnSync('docker', ['run', '--rm', '-v', `${charts}:/charts`, IMAGE, ...args], { encoding: 'utf-8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  const creds = ['--set', 'secrets.data.OTK_TENANTS=acme/OWNER:fx', '--set', 'secrets.data.OTK_ADMIN_KEY=fx', '--set', 'secrets.data.OTK_JWT_SECRET=fx', '--set', 'secrets.data.OTK_CSRF_SECRET=fx', '--set', 'secrets.data.OTK_DB_URL=postgres://fx-host/fx'];
  it('default values (NODE_ENV=production, empty credentials) fail to render', { skip: !hasImage && `${IMAGE} not present locally` }, () => {
    const r = helm('template', 'otk', '/charts/otk');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OTK_TENANTS is required/);
  });
  it('H1-S01: production with every credential but OTK_DB_URL fails to render', { skip: !hasImage && `${IMAGE} not present locally` }, () => {
    const r = helm('template', 'otk', '/charts/otk', ...creds.slice(0, -2));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OTK_DB_URL is required/);
  });
  it('production with credentials, staging with existingSecret and development render', { skip: !hasImage && `${IMAGE} not present locally` }, () => {
    assert.equal(helm('template', 'otk', '/charts/otk', ...creds).status, 0);
    assert.equal(helm('template', 'otk', '/charts/otk', '-f', '/charts/otk/values-staging.yaml').status, 0);
    assert.equal(helm('template', 'otk', '/charts/otk', '--set', 'config.NODE_ENV=development').status, 0);
  });
});

describe('RV-RUNS-11 (adversarial review): other deployment files', () => {
  const apiCompose = path.join(ROOT, 'docker', 'api', 'docker-compose.api.yml');
  it('the API smoke compose (NODE_ENV=production) requires the credentials instead of failing at start', () => {
    const t = fs.readFileSync(apiCompose, 'utf-8');
    for (const v of ['OTK_TENANTS', 'OTK_ADMIN_KEY', 'OTK_CSRF_SECRET']) assert.ok(t.includes(`\${${v}:?`), v);
  });
  it('docker compose config of the API smoke compose fails without credentials and renders with them', { skip: !hasDocker && 'docker CLI not available' }, () => {
    const base = { ...process.env } as Record<string, string>;
    for (const v of COMPOSE_VARS) delete base[v];
    const without = spawnSync('docker', ['compose', '-f', apiCompose, 'config'], { encoding: 'utf-8', env: base });
    assert.notEqual(without.status, 0); assert.match(without.stderr, /OTK_TENANTS|OTK_ADMIN_KEY|OTK_CSRF_SECRET/);
    const withC = spawnSync('docker', ['compose', '-f', apiCompose, 'config'], { encoding: 'utf-8', env: { ...base, OTK_TENANTS: 'acme/OWNER:fx', OTK_ADMIN_KEY: 'fx', OTK_CSRF_SECRET: 'fx' } });
    assert.equal(withC.status, 0, withC.stderr);
  });
  it('no deployment file suggests a fixed example credential', () => {
    for (const f of [path.join(ROOT, 'docker', 'api', 'Dockerfile'), apiCompose, COMPOSE]) assert.ok(!fs.readFileSync(f, 'utf-8').includes('changeme'), f);
  });
  it('Helm refuses a credential made only of spaces', { skip: !(hasDocker && spawnSync('docker', ['image', 'inspect', 'alpine/helm:3.16.4']).status === 0) && 'alpine/helm:3.16.4 not present locally' }, () => {
    const charts = path.join(ROOT, 'infra', 'helm');
    const r = spawnSync('docker', ['run', '--rm', '-v', `${charts}:/charts`, 'alpine/helm:3.16.4', 'template', 'otk', '/charts/otk',
      '--set', 'secrets.data.OTK_TENANTS=   ', '--set', 'secrets.data.OTK_ADMIN_KEY=fx', '--set', 'secrets.data.OTK_JWT_SECRET=fx', '--set', 'secrets.data.OTK_CSRF_SECRET=fx'], { encoding: 'utf-8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OTK_TENANTS is required/);
  });
});

describe('RV2-RUNS-07 (second review pass): Helm credential set to null', () => {
  it('a credential set to null fails the render (was "<nil>" after toString)', { skip: !(hasDocker && spawnSync('docker', ['image', 'inspect', 'alpine/helm:3.16.4']).status === 0) && 'alpine/helm:3.16.4 not present locally' }, () => {
    const charts = path.join(ROOT, 'infra', 'helm');
    const r = spawnSync('docker', ['run', '--rm', '-v', `${charts}:/charts`, 'alpine/helm:3.16.4', 'template', 'otk', '/charts/otk',
      '--set', 'secrets.data.OTK_TENANTS=null', '--set', 'secrets.data.OTK_ADMIN_KEY=fx', '--set', 'secrets.data.OTK_JWT_SECRET=fx', '--set', 'secrets.data.OTK_CSRF_SECRET=fx'], { encoding: 'utf-8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /OTK_TENANTS is required/);
  });
  it('the usage comment of the API smoke compose keeps its line continuation', () => {
    const lines = fs.readFileSync(path.join(ROOT, 'docker', 'api', 'docker-compose.api.yml'), 'utf-8').split(/\r?\n/);
    const i = lines.findIndex((l) => l.includes('OTK_CSRF_SECRET=<secret>'));
    assert.ok(i >= 0 && lines[i].trimEnd().endsWith('\\'), 'continuation backslash at the end of the variables line');
    assert.match(lines[i + 1] ?? '', /^#\s+docker compose -f docker\/api\/docker-compose\.api\.yml up --build/);
  });
});
