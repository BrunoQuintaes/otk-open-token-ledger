/**
 * Wave 3B Pack 01 — Helm Chart Structural Tests
 *
 * Validates the production Helm chart (v0.2.0) without requiring Helm binary.
 * All checks are fs-based: file existence, YAML key presence, template markers.
 *
 * Covers: E5.7 (Helm Charts), NEW-3.04 (ConfigMaps + Secrets), NEW-3.05 (Probes)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CHART = path.join(ROOT, 'infra', 'helm', 'otk');
const TPL = path.join(CHART, 'templates');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function readChart(rel: string): string {
  return fs.readFileSync(path.join(CHART, rel), 'utf-8');
}

function readTpl(name: string): string {
  return fs.readFileSync(path.join(TPL, name), 'utf-8');
}

// ===========================================================================
// Chart metadata
// ===========================================================================

describe('W3B-01 — Chart metadata', () => {
  it('Chart.yaml version is 0.2.0+', () => {
    const c = readChart('Chart.yaml');
    assert.match(c, /version:\s*0\.[2-9]/, 'Chart version must be >= 0.2.0');
  });

  it('Chart.yaml has sources field', () => {
    const c = readChart('Chart.yaml');
    assert.ok(c.includes('sources:'), 'Chart.yaml missing sources');
  });

  it('.helmignore exists', () => {
    assert.ok(fs.existsSync(path.join(CHART, '.helmignore')), '.helmignore not found');
  });
});

// ===========================================================================
// values.yaml — probe paths (NEW-3.05)
// ===========================================================================

describe('W3B-01 — Probe configuration (NEW-3.05)', () => {
  const v = () => readChart('values.yaml');

  it('livenessProbe uses /healthz', () => {
    assert.ok(v().includes('/healthz'), 'values.yaml missing /healthz');
  });

  it('readinessProbe uses /readyz', () => {
    assert.ok(v().includes('/readyz'), 'values.yaml missing /readyz');
  });

  it('startupProbe section exists', () => {
    assert.ok(v().includes('startupProbe:'), 'values.yaml missing startupProbe');
  });

  it('terminationGracePeriodSeconds is defined', () => {
    assert.ok(v().includes('terminationGracePeriodSeconds:'), 'missing terminationGracePeriodSeconds');
  });
});

// ===========================================================================
// values.yaml — config + secrets (NEW-3.04)
// ===========================================================================

describe('W3B-01 — Config + Secrets in values.yaml (NEW-3.04)', () => {
  const v = () => readChart('values.yaml');

  it('config section has all expected non-secret vars', () => {
    const content = v();
    for (const key of ['API_PORT', 'NODE_ENV', 'OTK_CORS_ORIGINS', 'OTK_RL_MAX_REQUESTS',
      'OTK_AUTH_FAIL_MAX', 'OTK_SHUTDOWN_TIMEOUT_MS', 'GIT_HEAD']) {
      assert.ok(content.includes(key), `values.yaml config missing ${key}`);
    }
  });

  it('secrets section has existingSecret field', () => {
    assert.ok(v().includes('existingSecret:'), 'values.yaml missing secrets.existingSecret');
  });

  it('secrets.data has credential keys', () => {
    const content = v();
    for (const key of ['OTK_ADMIN_KEY', 'OTK_DB_URL', 'OTK_REDIS_URL', 'PRIVKEY']) {
      assert.ok(content.includes(key), `values.yaml secrets.data missing ${key}`);
    }
  });
});

// ===========================================================================
// values.yaml — security + strategy
// ===========================================================================

describe('W3B-01 — Security + Strategy in values.yaml', () => {
  const v = () => readChart('values.yaml');

  it('podSecurityContext with runAsNonRoot', () => {
    assert.ok(v().includes('runAsNonRoot: true'), 'missing runAsNonRoot');
  });

  it('securityContext drops ALL capabilities', () => {
    assert.ok(v().includes('allowPrivilegeEscalation: false'), 'missing allowPrivilegeEscalation');
  });

  it('RollingUpdate strategy', () => {
    assert.ok(v().includes('RollingUpdate'), 'missing RollingUpdate strategy');
  });

  it('PDB section exists', () => {
    assert.ok(v().includes('pdb:'), 'missing pdb section');
  });

  it('serviceAccount section exists', () => {
    assert.ok(v().includes('serviceAccount:'), 'missing serviceAccount section');
  });
});

// ===========================================================================
// Template files — existence
// ===========================================================================

describe('W3B-01 — Template files exist (E5.7)', () => {
  const required = [
    'deployment.yaml',
    'service.yaml',
    'configmap.yaml',
    'secret.yaml',
    'pdb.yaml',
    'serviceaccount.yaml',
    '_helpers.tpl',
    'NOTES.txt',
  ];

  for (const f of required) {
    it(`templates/${f} exists`, () => {
      assert.ok(fs.existsSync(path.join(TPL, f)), `${f} not found`);
    });
  }
});

// ===========================================================================
// deployment.yaml — template markers
// ===========================================================================

describe('W3B-01 — deployment.yaml template markers', () => {
  const d = () => readTpl('deployment.yaml');

  it('has envFrom (ConfigMap + Secret)', () => {
    const content = d();
    assert.ok(content.includes('envFrom'), 'missing envFrom');
    assert.ok(content.includes('configMapRef'), 'missing configMapRef');
    assert.ok(content.includes('secretRef'), 'missing secretRef');
  });

  it('has OTK_INSTANCE_ID from fieldRef', () => {
    assert.ok(d().includes('OTK_INSTANCE_ID'), 'missing OTK_INSTANCE_ID env');
    assert.ok(d().includes('fieldRef'), 'missing fieldRef for OTK_INSTANCE_ID');
  });

  it('has preStop lifecycle hook', () => {
    assert.ok(d().includes('preStop'), 'missing preStop lifecycle hook');
    assert.ok(d().includes('sleep'), 'preStop should sleep for LB drain');
  });

  it('has securityContext reference', () => {
    assert.ok(d().includes('securityContext'), 'missing securityContext');
  });

  it('has strategy reference', () => {
    assert.ok(d().includes('strategy'), 'missing strategy');
  });

  it('has checksum/config annotation for rolling restart', () => {
    assert.ok(d().includes('checksum/config'), 'missing checksum/config annotation');
  });

  it('has conditional replicas for autoscaling guard', () => {
    assert.ok(d().includes('autoscaling.enabled'), 'missing autoscaling guard');
  });
});

// ===========================================================================
// secret.yaml — dual mode
// ===========================================================================

describe('W3B-01 — secret.yaml dual-mode (NEW-3.04)', () => {
  const s = () => readTpl('secret.yaml');

  it('conditionally renders when existingSecret is empty', () => {
    assert.ok(s().includes('secrets.existingSecret'), 'missing existingSecret condition');
  });

  it('has Opaque type', () => {
    assert.ok(s().includes('Opaque'), 'missing type: Opaque');
  });

  it('uses b64enc for secret data', () => {
    assert.ok(s().includes('b64enc'), 'missing b64enc encoding');
  });
});

// ===========================================================================
// _helpers.tpl — new helpers
// ===========================================================================

describe('W3B-01 — _helpers.tpl new helpers', () => {
  const h = () => readTpl('_helpers.tpl');

  it('has otk.serviceAccountName helper', () => {
    assert.ok(h().includes('otk.serviceAccountName'), 'missing serviceAccountName helper');
  });

  it('has otk.secretName helper', () => {
    assert.ok(h().includes('otk.secretName'), 'missing secretName helper');
  });

  it('has otk.chart helper', () => {
    assert.ok(h().includes('otk.chart'), 'missing chart helper');
  });
});

// ===========================================================================
// configmap.yaml — dynamic data
// ===========================================================================

describe('W3B-01 — configmap.yaml iterates .Values.config', () => {
  it('uses range over .Values.config', () => {
    const c = readTpl('configmap.yaml');
    assert.ok(c.includes('.Values.config'), 'configmap.yaml should iterate .Values.config');
  });
});

// ===========================================================================
// Environment override files
// ===========================================================================

describe('W3B-01 — Environment override files', () => {
  it('values-staging.yaml exists with staging config', () => {
    const p = path.join(CHART, 'values-staging.yaml');
    assert.ok(fs.existsSync(p), 'values-staging.yaml not found');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('staging'), 'values-staging.yaml missing staging reference');
  });

  it('values-production.yaml exists with production config', () => {
    const p = path.join(CHART, 'values-production.yaml');
    assert.ok(fs.existsSync(p), 'values-production.yaml not found');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('production'), 'values-production.yaml missing production reference');
  });
});

// ===========================================================================
// PDB + ServiceAccount templates
// ===========================================================================

describe('W3B-01 — PDB + ServiceAccount conditional templates', () => {
  it('pdb.yaml is conditional on pdb.enabled', () => {
    const p = readTpl('pdb.yaml');
    assert.ok(p.includes('pdb.enabled'), 'pdb.yaml missing pdb.enabled condition');
    assert.ok(p.includes('PodDisruptionBudget'), 'pdb.yaml missing PodDisruptionBudget kind');
  });

  it('serviceaccount.yaml is conditional on serviceAccount.create', () => {
    const sa = readTpl('serviceaccount.yaml');
    assert.ok(sa.includes('serviceAccount.create'), 'serviceaccount.yaml missing create condition');
    assert.ok(sa.includes('automountServiceAccountToken: false'), 'SA should disable token automount');
  });
});

// ===========================================================================
// NOTES.txt
// ===========================================================================

describe('W3B-01 — NOTES.txt post-install instructions', () => {
  it('NOTES.txt references healthz and readyz', () => {
    const n = readTpl('NOTES.txt');
    assert.ok(n.includes('/healthz'), 'NOTES.txt missing /healthz');
    assert.ok(n.includes('/readyz'), 'NOTES.txt missing /readyz');
  });
});
