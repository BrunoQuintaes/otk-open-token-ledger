/**
 * Wave 1 Pack 11 — Docs Site + Python SDK Tests (P1.7 + P1.8)
 *
 * Tests:
 *   - Docs site: index.html exists with expected content
 *   - Python SDK: module files exist with expected exports and structure
 *   - Python setup.py: metadata is present
 *
 * @since Wave 1 Pack 11 (2026-03-15)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// ─── P1.7 — Docs Site ───────────────────────────────────────────────

describe('P1.7 — Docs Site (index.html)', () => {

  const docsIndexPath = path.join(ROOT, 'docs/site/index.html');

  it('docs/site/index.html exists', () => {
    assert.ok(fs.existsSync(docsIndexPath), 'docs/site/index.html should exist');
  });

  it('docs site contains expected navigation links', () => {
    const html = fs.readFileSync(docsIndexPath, 'utf8');
    assert.ok(html.includes('/api-docs'), 'should link to /api-docs');
    assert.ok(html.includes('/openapi.json'), 'should link to /openapi.json');
    assert.ok(html.includes('Getting Started'), 'should mention Getting Started');
    assert.ok(html.includes('SDK'), 'should mention SDK');
  });

  it('docs site is valid HTML with doctype', () => {
    const html = fs.readFileSync(docsIndexPath, 'utf8');
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
    assert.ok(html.includes('<html'), 'should have <html> tag');
    assert.ok(html.includes('</html>'), 'should have closing </html> tag');
  });
});

// ─── P1.8 — Python SDK ──────────────────────────────────────────────

describe('P1.8 — Python SDK', () => {

  const pyInitPath = path.join(ROOT, 'sdk/python/otk_metering/__init__.py');
  const pySetupPath = path.join(ROOT, 'sdk/python/setup.py');
  const pyReadmePath = path.join(ROOT, 'sdk/python/README.md');

  it('Python SDK __init__.py exists', () => {
    assert.ok(fs.existsSync(pyInitPath), 'otk_metering/__init__.py should exist');
  });

  it('Python SDK exports OTKMeteringClient class', () => {
    const content = fs.readFileSync(pyInitPath, 'utf8');
    assert.ok(content.includes('class OTKMeteringClient'), 'should define OTKMeteringClient class');
    assert.ok(content.includes('class OTKApiError'), 'should define OTKApiError class');
  });

  it('Python SDK has expected methods', () => {
    const content = fs.readFileSync(pyInitPath, 'utf8');
    assert.ok(content.includes('def submit_receipt'), 'should have submit_receipt method');
    assert.ok(content.includes('def get_receipt'), 'should have get_receipt method');
    assert.ok(content.includes('def get_balance'), 'should have get_balance method');
    assert.ok(content.includes('def get_invoice'), 'should have get_invoice method');
    assert.ok(content.includes('def health'), 'should have health method');
  });

  it('Python SDK uses only stdlib (no external deps)', () => {
    const content = fs.readFileSync(pyInitPath, 'utf8');
    // Should use urllib, not requests
    assert.ok(content.includes('urllib.request'), 'should use urllib.request');
    assert.ok(!content.includes('import requests'), 'should NOT use requests library');
  });

  it('setup.py exists with package metadata', () => {
    assert.ok(fs.existsSync(pySetupPath), 'setup.py should exist');
    const content = fs.readFileSync(pySetupPath, 'utf8');
    assert.ok(content.includes('otk-metering'), 'should have package name');
    assert.ok(content.includes('0.1.0'), 'should have version');
    assert.ok(content.includes('install_requires=[]'), 'should have empty install_requires (stdlib only)');
  });

  it('Python SDK README exists', () => {
    assert.ok(fs.existsSync(pyReadmePath), 'Python SDK README.md should exist');
    const content = fs.readFileSync(pyReadmePath, 'utf8');
    assert.ok(content.includes('otk-metering'), 'README should mention package name');
  });
});
