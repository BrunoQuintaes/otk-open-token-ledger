/**
 * H1R2 C5 (H1 final closure run): revocation, denied attempts, recovery and ZK signals in /metrics, without identifiers.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { getMetricsText } from '../../src/observability/prometheusMetrics.js';
import { sendRbacDenial } from '../../src/api/errors.js';
import { setKeyAuthority, refreshCredential } from '../../src/auth/credentialAuthority.js';
import { registerToken, clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import { hashKey } from '../../src/api/apiKeyManager.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRes(): any {
  const headers: Record<string, unknown> = {};
  const r = { statusCode: 0, headers, setHeader(k: string, v: unknown) { headers[k] = v; }, writeHead(c: number) { r.statusCode = c; return r; }, end() {} };
  return r;
}

describe('H1R2 C5: observability of revocation, denials and the proof pipeline', () => {
  after(() => { setKeyAuthority(null); clearRegistry(); clearHashRegistryForTest(); });

  it('exposes the new families', async () => {
    const t = await getMetricsText();
    for (const name of ['otk_auth_denials_total', 'otk_credential_authority_events', 'otk_subject_status_store_up',
      'otk_subject_status_sync_age_seconds', 'otk_proof_recovery', 'otk_plan_store_ops_total', 'otk_admission_refusals_total']) {
      assert.match(t, new RegExp(`# TYPE ${name} `), name);
    }
    assert.match(t, /otk_subject_status_store_up -1/, 'no store configured in unit tests: -1');
    assert.match(t, /otk_proof_recovery\{state="pending"\} \d+/);
  });

  it('counts denials and authority refusals; no tenant, key or hash appears in the exposition', async () => {
    const tenant = 'tenant-secret-name-c5';
    const raw = 'otk_k_' + 'c5'.repeat(32);
    registerToken('static-c5-token-0123456789abcdef', tenant, 'OWNER');
    setKeyAuthority({ async getByHash() { return { keyId: 'key_c5', tenantId: tenant, label: 'l', prefix: raw.slice(0, 14), tokenHash: hashKey(raw), role: 'OWNER', createdAt: new Date().toISOString(), expiresAt: null, revokedAt: new Date().toISOString(), lastUsedAt: null }; } });
    await refreshCredential(raw, { strict: true });
    sendRbacDenial(fakeRes(), { code: 401, error: 'unauthorized' });
    sendRbacDenial(fakeRes(), { code: 429, error: 'too_many_auth_failures' });
    const t = await getMetricsText();
    assert.match(t, /otk_auth_denials_total\{status="401",error="unauthorized"\} [1-9]/);
    assert.match(t, /otk_auth_denials_total\{status="429",error="too_many_auth_failures"\} [1-9]/);
    assert.match(t, /otk_credential_authority_events\{event="keysRefused"\} [1-9]/);
    for (const secret of [tenant, raw, hashKey(raw), 'key_c5', 'static-c5-token']) assert.equal(t.includes(secret), false, `leak: ${secret}`);
  });
});
