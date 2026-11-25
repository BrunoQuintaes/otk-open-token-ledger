/**
 * CUWeightsLoader — Unit Tests (ADR-0203 Phase 1)
 *
 * Checks validation, lookup and signature verification of the signed CU weights table (CW JSON).
 *
 * Module under test: `src/economics/CUWeightsLoader.ts`.
 *
 * Strategy / partitions: `validateCWJson` with a valid table, `null`, missing version, an expired
 * or not-yet-valid window, negative and non-finite weights; `loadCWJson` in non-strict mode
 * (returns `null`) and strict mode (throws); `getModelWeights` for known and unknown
 * provider/model; `buildSignedMessage` determinism, coverage of every value and key-order
 * independence; `verifyCWSignature` with a real EIP-191 signature from an ephemeral wallet:
 * untouched table accepted, each kind of tampering rejected, key reordering accepted, a
 * signature over the legacy V1 message rejected.
 *
 * Needs: nothing external (the signing key is generated in memory and never stored; no network).
 *
 * Run just this file: `npx tsx --test test/unit/CUWeightsLoader.test.ts`
 *
 * @module test/unit/CUWeightsLoader.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCWJson,
  loadCWJson,
  getModelWeights,
  buildSignedMessage,
  verifyCWSignature,
  type CWJson,
} from '../../src/economics/CUWeightsLoader.js';
import { Wallet } from 'ethers';

const VALID_CW: CWJson = {
  version: '2.0.0',
  validFrom: '2000-01-01T00:00:00Z',
  validUntil: '2099-12-31T23:59:59Z',
  weights: {
    openai: {
      'gpt-4o': { inputWeight: 1.2, outputWeight: 2.4, latencyWeight: 0.001 },
    },
    anthropic: {
      'claude-sonnet-4-6': { inputWeight: 0.9, outputWeight: 1.8, latencyWeight: 0.001 },
    },
  },
  signedBy: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  signature: '0xaabbcc',
};

describe('CUWeightsLoader', () => {
  describe('validateCWJson', () => {
    it('accepts a valid CW JSON', () => {
      const result = validateCWJson(VALID_CW);
      assert.equal(result.ok, true);
    });

    it('rejects null', () => {
      const result = validateCWJson(null);
      assert.equal(result.ok, false);
    });

    it('rejects missing version', () => {
      const { version: _, ...noVer } = VALID_CW;
      const result = validateCWJson(noVer);
      assert.equal(result.ok, false);
      assert.ok((result as { error: string }).error.includes('version'));
    });

    it('rejects expired CW', () => {
      const expired = { ...VALID_CW, validUntil: '2000-01-02T00:00:00Z' };
      const result = validateCWJson(expired);
      assert.equal(result.ok, false);
      assert.ok((result as { error: string }).error.includes('expired'));
    });

    it('rejects future CW (not yet valid)', () => {
      const future = { ...VALID_CW, validFrom: '2099-01-01T00:00:00Z', validUntil: '2099-12-31T00:00:00Z' };
      const result = validateCWJson(future);
      assert.equal(result.ok, false);
      assert.ok((result as { error: string }).error.includes('not yet valid'));
    });

    it('rejects negative weight', () => {
      const bad = {
        ...VALID_CW,
        weights: { openai: { 'gpt-4o': { inputWeight: -1, outputWeight: 2.4, latencyWeight: 0.001 } } },
      };
      const result = validateCWJson(bad);
      assert.equal(result.ok, false);
      assert.ok((result as { error: string }).error.includes('non-negative'));
    });
  });

  describe('loadCWJson', () => {
    it('returns CWJson for valid input', () => {
      const cw = loadCWJson(VALID_CW);
      assert.ok(cw !== null);
      assert.equal(cw!.version, '2.0.0');
    });

    it('returns null for invalid input (non-strict)', () => {
      const cw = loadCWJson({ version: 'bad' });
      assert.equal(cw, null);
    });

    it('throws in strict mode for invalid input', () => {
      assert.throws(() => loadCWJson({ version: 'bad' }, { strict: true }), /CW JSON invalid/);
    });
  });

  describe('getModelWeights', () => {
    it('returns weights for known provider+model', () => {
      const cw = loadCWJson(VALID_CW)!;
      const mw = getModelWeights(cw, 'openai', 'gpt-4o');
      assert.ok(mw !== null);
      assert.equal(mw!.inputWeight, 1.2);
    });

    it('returns null for unknown provider', () => {
      const cw = loadCWJson(VALID_CW)!;
      assert.equal(getModelWeights(cw, 'unknown', 'gpt-4o'), null);
    });

    it('returns null for unknown model', () => {
      const cw = loadCWJson(VALID_CW)!;
      assert.equal(getModelWeights(cw, 'openai', 'nonexistent'), null);
    });
  });

  describe('buildSignedMessage', () => {
    it('returns a deterministic string starting with CW-WEIGHTS-V2', () => {
      const cw = loadCWJson(VALID_CW)!;
      const msg = buildSignedMessage(cw);
      assert.ok(msg.startsWith('CW-WEIGHTS-V2:'));
      assert.ok(msg.includes(cw.version));
      assert.ok(msg.includes(cw.validFrom));
    });

    it('includes every weight value, model and provider name (R01)', () => {
      const msg = buildSignedMessage(VALID_CW);
      for (const s of ['"openai"', '"gpt-4o"', '"outputWeight":2.4', '"claude-sonnet-4-6"', '"inputWeight":0.9']) {
        assert.ok(msg.includes(s), `signed message must contain ${s}`);
      }
    });

    it('is independent of object key order at every depth', () => {
      const reordered: CWJson = {
        signature: VALID_CW.signature,
        signedBy: VALID_CW.signedBy,
        weights: {
          anthropic: { 'claude-sonnet-4-6': { latencyWeight: 0.001, outputWeight: 1.8, inputWeight: 0.9 } },
          openai: { 'gpt-4o': { outputWeight: 2.4, latencyWeight: 0.001, inputWeight: 1.2 } },
        },
        validUntil: VALID_CW.validUntil,
        validFrom: VALID_CW.validFrom,
        version: VALID_CW.version,
      };
      assert.equal(buildSignedMessage(reordered), buildSignedMessage(VALID_CW));
    });

    it('throws on non-finite weights instead of serializing them as null', () => {
      const bad = structuredClone(VALID_CW);
      bad.weights.openai['gpt-4o'].outputWeight = Number.NaN;
      assert.throws(() => buildSignedMessage(bad));
    });
  });

  describe('validateCWJson — non-finite weights', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      it(`rejects outputWeight=${v}`, () => {
        const bad = structuredClone(VALID_CW);
        bad.weights.openai['gpt-4o'].outputWeight = v;
        assert.equal(validateCWJson(bad).ok, false);
      });
    }
  });

  describe('verifyCWSignature — real EIP-191 signature (R01)', () => {
    const signer = Wallet.createRandom(); // ephemeral test key, never persisted

    async function signed(): Promise<CWJson> {
      const cw: CWJson = { ...structuredClone(VALID_CW), signedBy: signer.address, signature: '' };
      cw.signature = await signer.signMessage(buildSignedMessage(cw));
      return cw;
    }

    it('accepts the untouched signed table', async () => {
      assert.equal(await verifyCWSignature(await signed(), signer.address), true);
    });

    const tamperings: Array<[string, (cw: CWJson) => void]> = [
      ['weight value 2.4 → 900', (cw) => { cw.weights.openai['gpt-4o'].outputWeight = 900; }],
      ['latency weight', (cw) => { cw.weights.openai['gpt-4o'].latencyWeight = 5; }],
      ['model renamed', (cw) => {
        cw.weights.openai['gpt-4o-mini'] = cw.weights.openai['gpt-4o'];
        delete cw.weights.openai['gpt-4o'];
      }],
      ['provider renamed', (cw) => {
        cw.weights.azure = cw.weights.openai;
        delete cw.weights.openai;
      }],
      ['model added', (cw) => { cw.weights.openai['gpt-5'] = { inputWeight: 0, outputWeight: 0, latencyWeight: 0 }; }],
      ['validUntil extended', (cw) => { cw.validUntil = '2199-12-31T23:59:59Z'; }],
      ['validFrom changed', (cw) => { cw.validFrom = '1999-01-01T00:00:00Z'; }],
      ['version changed', (cw) => { cw.version = '2.0.1'; }],
    ];
    for (const [label, mutate] of tamperings) {
      it(`rejects tampering: ${label}`, async () => {
        const cw = await signed();
        mutate(cw);
        assert.equal(await verifyCWSignature(cw, signer.address), false);
      });
    }

    it('still accepts the table after reordering keys (same content)', async () => {
      const cw = await signed();
      const reordered = JSON.parse(JSON.stringify({
        weights: { anthropic: cw.weights.anthropic, openai: cw.weights.openai },
        signature: cw.signature, version: cw.version, signedBy: cw.signedBy,
        validUntil: cw.validUntil, validFrom: cw.validFrom,
      })) as CWJson;
      assert.equal(await verifyCWSignature(reordered, signer.address), true);
    });

    it('rejects a table signed over the legacy V1 message', async () => {
      const cw: CWJson = { ...structuredClone(VALID_CW), signedBy: signer.address, signature: '' };
      const v1 = `CW-WEIGHTS-V1:${cw.version}:${cw.validFrom}:${cw.validUntil}:${JSON.stringify(cw.weights, Object.keys(cw.weights).sort())}`;
      cw.signature = await signer.signMessage(v1);
      assert.equal(await verifyCWSignature(cw, signer.address), false);
    });
  });
});
