/**
 * H-PACK-08 Tests — H6.1-H6.4 Dashboard & Security Hardening
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../../src/dashboard/sanitize.js';
import { generateCsrfToken, validateCsrfToken } from '../../src/auth/csrf.js';

// ═══════════════════════════════════════════
// H6.1 — XSS Prevention
// ═══════════════════════════════════════════
describe('H6.1 — XSS Prevention', () => {
  it('escapes < and >', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;');
  });

  it('escapes & in content', () => {
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
  });

  it('escapes double quotes', () => {
    assert.equal(escapeHtml('value="x"'), 'value=&quot;x&quot;');
  });

  it('escapes single quotes', () => {
    assert.equal(escapeHtml("it's"), 'it&#x27;s');
  });

  it('handles empty string', () => {
    assert.equal(escapeHtml(''), '');
  });

  it('preserves safe text', () => {
    assert.equal(escapeHtml('Hello World 123'), 'Hello World 123');
  });

  it('escapes event handler injection', () => {
    const input = '" onmouseover="alert(1)"';
    const escaped = escapeHtml(input);
    assert.ok(!escaped.includes('"'));
  });

  it('escapes unicode attack vectors', () => {
    assert.equal(escapeHtml('<img src=x>'), '&lt;img src=x&gt;');
  });
});

// ═══════════════════════════════════════════
// H6.3 — CSRF Protection
// ═══════════════════════════════════════════
describe('H6.3 — CSRF Protection', () => {
  it('generateCsrfToken produces 64-char hex', () => {
    const token = generateCsrfToken('session-123');
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  it('same session produces same token (deterministic)', () => {
    const t1 = generateCsrfToken('session-abc');
    const t2 = generateCsrfToken('session-abc');
    assert.equal(t1, t2);
  });

  it('different sessions produce different tokens', () => {
    const t1 = generateCsrfToken('session-1');
    const t2 = generateCsrfToken('session-2');
    assert.notEqual(t1, t2);
  });

  it('validateCsrfToken returns true for valid token', () => {
    const token = generateCsrfToken('session-valid');
    assert.equal(validateCsrfToken(token, 'session-valid'), true);
  });

  it('validateCsrfToken returns false for wrong token', () => {
    assert.equal(validateCsrfToken('deadbeef'.repeat(8), 'session-valid'), false);
  });

  it('validateCsrfToken returns false for wrong session', () => {
    const token = generateCsrfToken('session-a');
    assert.equal(validateCsrfToken(token, 'session-b'), false);
  });

  it('validateCsrfToken returns false for different-length token', () => {
    assert.equal(validateCsrfToken('short', 'session-1'), false);
  });
});
