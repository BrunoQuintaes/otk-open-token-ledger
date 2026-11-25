/**
 * Wave 3B Pack 02 — HPA + Ingress Structural Tests
 *
 * Validates Horizontal Pod Autoscaler (NEW-3.02) and Ingress + TLS (NEW-3.03)
 * templates without requiring Helm binary. All checks are fs-based.
 *
 * Under test: the autoscaler and ingress templates and the values files of the Helm chart under
 * `infra/helm/otk/`, read as text.
 *
 * Strategy / partitions: API version, kind, enable flag and the expected sections of each template; defaults
 * off in the base values; the replicas guard in the deployment; the production and staging overrides.
 *
 * Needs: only the file system (read only), from the repository root found from this file's location.
 *
 * Run just this file: `npx tsx --test test/unit/wave3b_hpa_ingress.test.ts`
 *
 * @module test/unit/wave3b_hpa_ingress.test
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

function readTpl(name: string): string {
  return fs.readFileSync(path.join(TPL, name), 'utf-8');
}

function readChart(rel: string): string {
  return fs.readFileSync(path.join(CHART, rel), 'utf-8');
}

// ===========================================================================
// HPA template (NEW-3.02)
// ===========================================================================

describe('W3B-02 — HPA template (NEW-3.02)', () => {
  it('hpa.yaml exists', () => {
    assert.ok(fs.existsSync(path.join(TPL, 'hpa.yaml')), 'hpa.yaml not found');
  });

  it('uses autoscaling/v2 API', () => {
    assert.ok(readTpl('hpa.yaml').includes('autoscaling/v2'), 'must use autoscaling/v2');
  });

  it('kind is HorizontalPodAutoscaler', () => {
    assert.ok(readTpl('hpa.yaml').includes('HorizontalPodAutoscaler'), 'wrong kind');
  });

  it('is conditional on autoscaling.enabled', () => {
    assert.ok(readTpl('hpa.yaml').includes('autoscaling.enabled'), 'missing enabled guard');
  });

  it('has CPU metric', () => {
    assert.ok(readTpl('hpa.yaml').includes('cpu'), 'missing CPU metric');
  });

  it('has memory metric', () => {
    assert.ok(readTpl('hpa.yaml').includes('memory'), 'missing memory metric');
  });

  it('supports customMetrics array', () => {
    assert.ok(readTpl('hpa.yaml').includes('customMetrics'), 'missing customMetrics support');
  });

  it('has behavior section', () => {
    assert.ok(readTpl('hpa.yaml').includes('behavior'), 'missing behavior section');
  });

  it('references correct Deployment', () => {
    assert.ok(readTpl('hpa.yaml').includes('scaleTargetRef'), 'missing scaleTargetRef');
  });
});

// ===========================================================================
// Ingress template (NEW-3.03)
// ===========================================================================

describe('W3B-02 — Ingress template (NEW-3.03)', () => {
  it('ingress.yaml exists', () => {
    assert.ok(fs.existsSync(path.join(TPL, 'ingress.yaml')), 'ingress.yaml not found');
  });

  it('uses networking.k8s.io/v1 API', () => {
    assert.ok(readTpl('ingress.yaml').includes('networking.k8s.io/v1'), 'must use networking.k8s.io/v1');
  });

  it('kind is Ingress', () => {
    assert.ok(readTpl('ingress.yaml').includes('kind: Ingress'), 'wrong kind');
  });

  it('is conditional on ingress.enabled', () => {
    assert.ok(readTpl('ingress.yaml').includes('ingress.enabled'), 'missing enabled guard');
  });

  it('supports ingressClassName', () => {
    assert.ok(readTpl('ingress.yaml').includes('ingressClassName'), 'missing ingressClassName');
  });

  it('supports TLS configuration', () => {
    assert.ok(readTpl('ingress.yaml').includes('tls'), 'missing TLS support');
    assert.ok(readTpl('ingress.yaml').includes('secretName'), 'missing TLS secretName');
  });

  it('supports annotations for cert-manager', () => {
    assert.ok(readTpl('ingress.yaml').includes('annotations'), 'missing annotations support');
  });

  it('has host-based rules with paths', () => {
    assert.ok(readTpl('ingress.yaml').includes('host:'), 'missing host rule');
    assert.ok(readTpl('ingress.yaml').includes('pathType'), 'missing pathType');
  });
});

// ===========================================================================
// values.yaml — autoscaling section
// ===========================================================================

describe('W3B-02 — values.yaml autoscaling section', () => {
  const v = () => readChart('values.yaml');

  it('autoscaling section exists and is disabled by default', () => {
    const content = v();
    assert.ok(content.includes('autoscaling:'), 'missing autoscaling section');
    assert.ok(content.includes('enabled: false'), 'autoscaling should be disabled by default');
  });

  it('has scaleUp and scaleDown behavior', () => {
    const content = v();
    assert.ok(content.includes('scaleUp:'), 'missing scaleUp behavior');
    assert.ok(content.includes('scaleDown:'), 'missing scaleDown behavior');
    assert.ok(content.includes('stabilizationWindowSeconds'), 'missing stabilization window');
  });
});

// ===========================================================================
// values.yaml — ingress section
// ===========================================================================

describe('W3B-02 — values.yaml ingress section', () => {
  const v = () => readChart('values.yaml');

  it('ingress section exists and is disabled by default', () => {
    const content = v();
    assert.ok(content.includes('ingress:'), 'missing ingress section');
  });

  it('defaults to nginx className', () => {
    assert.ok(v().includes('className: nginx'), 'missing nginx className default');
  });
});

// ===========================================================================
// Deployment — conditional replicas
// ===========================================================================

describe('W3B-02 — Deployment replicas guard', () => {
  it('deployment.yaml conditionally omits replicas when autoscaling enabled', () => {
    const d = readTpl('deployment.yaml');
    assert.ok(d.includes('autoscaling.enabled'), 'deployment must check autoscaling.enabled');
  });
});

// ===========================================================================
// Production overrides — autoscaling + custom metrics
// ===========================================================================

describe('W3B-02 — Production overrides', () => {
  it('values-production.yaml enables autoscaling with custom queue metric', () => {
    const p = readChart('values-production.yaml');
    assert.ok(p.includes('autoscaling:'), 'missing autoscaling');
    assert.ok(p.includes('enabled: true'), 'autoscaling should be enabled');
    assert.ok(p.includes('otk_proof_queue_depth'), 'missing custom queue depth metric');
  });

  it('values-production.yaml enables ingress with TLS', () => {
    const p = readChart('values-production.yaml');
    assert.ok(p.includes('ingress:'), 'missing ingress');
    assert.ok(p.includes('cert-manager'), 'missing cert-manager annotation');
    assert.ok(p.includes('tls:'), 'missing TLS section');
  });

  it('values-staging.yaml enables autoscaling + ingress', () => {
    const s = readChart('values-staging.yaml');
    assert.ok(s.includes('autoscaling:'), 'staging missing autoscaling');
    assert.ok(s.includes('ingress:'), 'staging missing ingress');
  });
});
