/**
 * D1–D8 front B — signed weights v2, multiplicative CU, price and reservation
 * (D4-G01/G02, D5-G01/G05/G07, S0-F01). Expected values: test/fixtures/d1d8/common_vectors.json.
 * Signing keys are random per run (Wallet.createRandom); no key material is stored.
 *
 * Modules under test: `src/economics/cuWeightsV2.ts`, `src/economics/computeCu.ts`,
 * `src/economics/cuWeightsRuntimeV2.ts`, the legacy `src/pricing/CostUnits.ts`,
 * `src/pricing/priceUsage.ts` and `src/pricing/reservation.ts`.
 *
 * Strategy / partitions: CU from the shared vectors (raw totals and normalized usage, latency
 * has no effect, missing usage gives `null`); statuses for an unknown model, a model swap, dated
 * aliases, partial usage, an unsupported formula and invalid totals; weights table validation
 * (valid, missing, tampered weight or alias, garbage or misattributed signature, untrusted
 * signer, expired vs not yet valid, malformed shapes); runtime snapshots (restart with the
 * source down, no snapshot, rejected or replayed older tables, signer rotation, prototype-key
 * ids, frozen references, revocation); prices per category, missing price (`null`, never US$ 0),
 * price history, unpriced or zero-count addends, overlapping windows; worst-case reservation
 * and the input-size upper bound.
 *
 * Needs: must be run from the repository root (reads `test/fixtures/d1d8/common_vectors.json` and
 * `test/fixtures/d1d8/b/price_table_illustrative_v1.json` by relative path); one snapshot test
 * writes to a temporary directory that it removes. No network.
 *
 * Run just this file: `npx tsx --test test/unit/d1d8_b_cu_price.test.ts`
 *
 * @module test/unit/d1d8_b_cu_price.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import {
  loadCuWeights, cuWeightsV2Message, cuWeightsV2ToJson, staticTablesAsV2Body, developmentCuConfig,
  CU_FORMULA_EXACT, CU_FORMULA_LEGACY,
} from '../../src/economics/cuWeightsV2.js';
import { computeCu, computeCuFromTotals, cuFromTotals, scaledToDecimal } from '../../src/economics/computeCu.js';
import { createCuWeightsRuntime, createFileSnapshotStore, createMemorySnapshotStore } from '../../src/economics/cuWeightsRuntimeV2.js';
import { calculateCostUnitsV1, bucketCU, MODEL_WEIGHTS_INT, PROVIDER_WEIGHTS_INT } from '../../src/pricing/CostUnits.js';
import { normalizeUsage } from '../../src/providers/usage/normalizeUsage.js';
import { createPriceTableRegistry, createPriceUsage, parsePriceTableV1, priceTableRef } from '../../src/pricing/priceUsage.js';
import { createEstimateReservation, inputTokensUpperBound, ReservationError } from '../../src/pricing/reservation.js';
import type { CuConfig, CuWeightsTableV2, UsageApi } from '../../src/types/d1d8/index.js';

const vectors = JSON.parse(readFileSync('test/fixtures/d1d8/common_vectors.json', 'utf8')) as { vectors: Array<Record<string, any>> };
const V = (id: string) => vectors.vectors.find((v) => v.id === id)!;
const NOW = '2026-09-30T12:00:00.000Z';

async function signedTable(wallet: { address: string; signMessage(m: string): Promise<string> }, over: Partial<Omit<CuWeightsTableV2, 'signature'>> = {}): Promise<Record<string, unknown>> {
  const body = { ...staticTablesAsV2Body({ version: 'cw-test-1', validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', signedBy: wallet.address }), ...over };
  const signature = await wallet.signMessage(cuWeightsV2Message(body));
  return cuWeightsV2ToJson({ ...body, signature });
}

async function validConfig(formula: string = CU_FORMULA_EXACT): Promise<CuConfig> {
  const w = Wallet.createRandom();
  const r = loadCuWeights(await signedTable(w), { now: NOW, trustedSigners: [w.address], formula });
  assert.equal(r.status, 'valid', r.reason ?? '');
  return r.config!;
}

describe('d1d8_b CU — common vectors (multiplicative, exact scale 10^6, legacy rounding)', async () => {
  const cfg = await validConfig();
  const legacy = await validConfig(CU_FORMULA_LEGACY);
  for (const id of ['CU-01', 'CU-02', 'CU-03', 'CU-04', 'CU-05', 'CU-06', 'CU-08']) {
    it(id, () => {
      const v = V(id);
      const r = computeCuFromTotals({ provider: v.provider, model: v.model, tIn: BigInt(v.tIn), tOut: BigInt(v.tOut) }, cfg);
      assert.equal(r.status, 'computed');
      assert.equal(r.cu!.units, BigInt(v.expected.cu_units));
      assert.equal(r.cu!.scale, BigInt(v.expected.cu_scale));
      if (v.expected.cu_decimal) assert.equal(scaledToDecimal(r.cu!), v.expected.cu_decimal);
      if (v.weights_milli) {
        assert.equal(r.wModelMilli, BigInt(v.weights_milli.model));
        assert.equal(r.wProviderMilli, BigInt(v.weights_milli.provider));
      }
      if (v.expected.legacy_cu !== undefined) {
        const l = computeCuFromTotals({ provider: v.provider, model: v.model, tIn: BigInt(v.tIn), tOut: BigInt(v.tOut) }, legacy);
        assert.equal(l.cu!.units, BigInt(v.expected.legacy_cu));
        assert.equal(l.cu!.scale, 1n);
        // The legacy formula is exactly the pre-existing calculateCostUnitsV1.
        assert.equal(calculateCostUnitsV1({ provider: v.provider, model: v.model, inputTokens: Number(v.tIn), outputTokens: Number(v.tOut) }), BigInt(v.expected.legacy_cu));
      }
      if (v.expected.legacy_bucket100 !== undefined) assert.equal(bucketCU(BigInt(v.expected.legacy_cu)), BigInt(v.expected.legacy_bucket100));
    });
  }

  it('CU-07: latency has no input and no effect', () => {
    const v = V('CU-07');
    const bodies = v.latencies_ms.map((ms: string) => ({ model: 'gpt-4o', latency_ms: Number(ms), usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }));
    const r = bodies.map((b: unknown) => computeCu(normalizeUsage('openai.chat_completions', b, { provider: 'openai', modelRequested: 'gpt-4o', origin: 'provider_response', observedAt: NOW }), cfg));
    assert.equal(r[0].cu!.units, BigInt(v.expected.cu_units));
    assert.deepEqual(r[0].cu, r[1].cu);
  });

  for (const id of ['USAGE-ANTHROPIC-01', 'USAGE-OPENAI-CHAT-01', 'USAGE-OPENAI-RESPONSES-01', 'USAGE-GEMINI-01', 'USAGE-ZERO-01']) {
    it(`${id}: CU from normalized usage`, () => {
      const v = V(id);
      const provider = (v.api as string).split('.')[0]!;
      const u = normalizeUsage(v.api as UsageApi, v.response, { provider, modelRequested: 'requested', origin: 'provider_response', observedAt: NOW });
      const r = computeCu(u, cfg);
      assert.equal(r.status, 'computed');
      assert.equal(r.cu!.units, BigInt(v.expected.cu_units));
      if (v.expected.previous_code_legacy_cu) {
        // Previous behaviour (cache or thoughts out of CU) reproduced by hand-given numbers only.
        assert.notEqual(r.cu!.units / 1_000_000n, BigInt(v.expected.previous_code_legacy_cu));
      }
    });
  }

  it('USAGE-MISSING-01: missing usage → usage_not_computable, cu null (never 0)', () => {
    const v = V('USAGE-MISSING-01');
    const u = normalizeUsage('openai.chat_completions', v.response, { provider: 'openai', modelRequested: 'gpt-4o', origin: 'provider_response', observedAt: NOW });
    const r = computeCu(u, cfg);
    assert.equal(r.status, v.expected.cu_status);
    assert.equal(r.cu, null);
  });
});

describe('d1d8_b CU — statuses and model selection', async () => {
  const cfg = await validConfig();
  const ctx = { provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_response' as const, observedAt: NOW };
  it('unknown model → unsupported_model, no default constant', () => {
    const u = normalizeUsage('openai.chat_completions', { model: 'gpt-99', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, ctx);
    const r = computeCu(u, cfg);
    assert.equal(r.status, 'unsupported_model');
    assert.equal(r.cu, null);
  });
  it('model swap: returned gpt-4o takes gpt-4o weight even if gpt-4o-mini was requested', () => {
    const u = normalizeUsage('openai.chat_completions', { model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, ctx);
    const r = computeCu(u, cfg);
    assert.equal(r.wModelMilli, 1000n); // gpt-4o, not 400 (gpt-4o-mini)
    assert.equal(r.cu!.units, 2n * 1000n * 1000n);
  });
  it('dated alias resolves only when listed in the signed table', () => {
    const ok = normalizeUsage('openai.chat_completions', { model: 'gpt-4o-mini-2024-07-18', usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }, ctx);
    assert.equal(computeCu(ok, cfg).wModelMilli, 400n);
    const unk = normalizeUsage('openai.chat_completions', { model: 'gpt-4o-mini-2099-01-01', usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }, ctx);
    assert.equal(computeCu(unk, cfg).status, 'unsupported_model');
  });
  it('partial usage is not computed unless explicitly accepted', () => {
    const u = { ...normalizeUsage('openai.chat_completions', { model: 'gpt-4o', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }, ctx), completeness: 'partial' as const };
    assert.equal(computeCu(u, cfg).status, 'usage_not_computable');
    assert.equal(computeCu(u, cfg, { acceptCompleteness: ['complete', 'partial'] }).status, 'computed');
  });
  it('unsupported formula id → invalid_config', () => {
    const u = normalizeUsage('openai.chat_completions', { model: 'gpt-4o', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }, ctx);
    assert.equal(computeCu(u, { ...cfg, formula: 'weighted_sum' }).status, 'invalid_config');
  });
  it('computeCuFromTotals refuses negative/fractional totals instead of coercing', () => {
    assert.equal(computeCuFromTotals({ provider: 'openai', model: 'gpt-4o', tIn: -1, tOut: 1 }, cfg).status, 'usage_not_computable');
    assert.equal(computeCuFromTotals({ provider: 'openai', model: 'gpt-4o', tIn: 1.5, tOut: 1 }, cfg).status, 'usage_not_computable');
  });
  it('development profile is explicit and labelled', () => {
    const dev = developmentCuConfig();
    assert.equal(dev.developmentProfile, true);
    assert.match(dev.ref.version, /^dev-/);
    const r = computeCuFromTotals({ provider: 'openai', model: 'gpt-4o', tIn: 1, tOut: 0 }, dev);
    assert.equal(r.developmentProfile, true);
  });
  it('cuFromTotals multiplicative identity: (a+b)·Wm·Wp equals sum of parts (no weighted sum by side)', () => {
    const a = cuFromTotals(CU_FORMULA_EXACT, 7n, 0n, 1500n, 1100n).units + cuFromTotals(CU_FORMULA_EXACT, 0n, 11n, 1500n, 1100n).units;
    assert.equal(cuFromTotals(CU_FORMULA_EXACT, 7n, 11n, 1500n, 1100n).units, a);
  });
});

describe('d1d8_b weights v2 — load and validation (D4-G01)', () => {
  it('valid table signed by a trusted signer is accepted; ref digest is stable', async () => {
    const w = Wallet.createRandom();
    const raw = await signedTable(w);
    const a = loadCuWeights(raw, { now: NOW, trustedSigners: [w.address] });
    const b = loadCuWeights(JSON.parse(JSON.stringify(raw)), { now: NOW, trustedSigners: [w.address.toLowerCase()] });
    assert.equal(a.status, 'valid');
    assert.equal(a.config!.developmentProfile, false);
    assert.equal(a.config!.ref.digest, b.config!.ref.digest);
    assert.equal(a.config!.table.providerWeightsMilli['anthropic'], PROVIDER_WEIGHTS_INT['anthropic']);
    assert.equal(a.config!.table.modelWeightsMilli['gpt-4o-mini'], MODEL_WEIGHTS_INT['gpt-4o-mini']);
  });
  it('missing table → missing', () => {
    assert.equal(loadCuWeights(null, { now: NOW, trustedSigners: [] }).status, 'missing');
    assert.equal(loadCuWeights(undefined, { now: NOW, trustedSigners: [] }).status, 'missing');
  });
  it('tampered weight → bad_signature', async () => {
    const w = Wallet.createRandom();
    const raw = await signedTable(w) as any;
    raw.modelWeightsMilli['gpt-4o'] = '1';
    assert.equal(loadCuWeights(raw, { now: NOW, trustedSigners: [w.address] }).status, 'bad_signature');
  });
  it('tampered alias → bad_signature', async () => {
    const w = Wallet.createRandom();
    const raw = await signedTable(w) as any;
    raw.aliases['gpt-4o-2024-08-06'] = 'gpt-4o-mini';
    assert.equal(loadCuWeights(raw, { now: NOW, trustedSigners: [w.address] }).status, 'bad_signature');
  });
  it('garbage signature → bad_signature', async () => {
    const w = Wallet.createRandom();
    const raw = { ...(await signedTable(w)), signature: '0x1234' };
    assert.equal(loadCuWeights(raw, { now: NOW, trustedSigners: [w.address] }).status, 'bad_signature');
  });
  it('signed by a key that is not trusted → unauthorized_signer; empty trust list authorizes nobody', async () => {
    const w = Wallet.createRandom();
    const raw = await signedTable(w);
    assert.equal(loadCuWeights(raw, { now: NOW, trustedSigners: [Wallet.createRandom().address] }).status, 'unauthorized_signer');
    assert.equal(loadCuWeights(raw, { now: NOW, trustedSigners: [] }).status, 'unauthorized_signer');
  });
  it('signedBy claimed for someone else than the actual signer → bad_signature', async () => {
    const w = Wallet.createRandom();
    const other = Wallet.createRandom();
    const body = staticTablesAsV2Body({ version: 'x', validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z', signedBy: other.address });
    const raw = cuWeightsV2ToJson({ ...body, signature: await w.signMessage(cuWeightsV2Message(body)) });
    assert.equal(loadCuWeights(raw, { now: NOW, trustedSigners: [w.address, other.address] }).status, 'bad_signature');
  });
  it('expired and not-yet-valid are distinct', async () => {
    const w = Wallet.createRandom();
    const raw = await signedTable(w);
    assert.equal(loadCuWeights(raw, { now: '2027-01-01T00:00:00.000Z', trustedSigners: [w.address] }).status, 'expired');
    assert.equal(loadCuWeights(raw, { now: '2025-12-31T23:59:59.000Z', trustedSigners: [w.address] }).status, 'not_yet_valid');
  });
  it('malformed: v1 shape, latency field, zero weight, number weights, dangling alias', async () => {
    const w = Wallet.createRandom();
    const good = await signedTable(w) as any;
    const v1 = { version: '2.0.0', validFrom: '2020-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z', weights: { openai: { 'gpt-4': { inputWeight: 2, outputWeight: 4, latencyWeight: 0.001 } } }, signedBy: w.address, signature: '0x00' };
    for (const raw of [
      v1,
      { ...good, latencyWeight: '1' },
      { ...good, modelWeightsMilli: { ...good.modelWeightsMilli, 'gpt-4o': '0' } },
      { ...good, providerWeightsMilli: { ...good.providerWeightsMilli, openai: 1000 } },
      { ...good, aliases: { 'x-2024': 'not-a-model' } },
      { ...good, validFrom: 'yesterday' },
    ]) {
      assert.equal(loadCuWeights(raw, { now: NOW, trustedSigners: [w.address] }).status, 'malformed', JSON.stringify(raw).slice(0, 80));
    }
  });
});

describe('d1d8_b weights runtime — snapshot and frozen config (D4-G02)', () => {
  it('restart with source down keeps the same version from the persisted snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'otk-b-cw-'));
    try {
      const w = Wallet.createRandom();
      const raw = await signedTable(w);
      const rt1 = createCuWeightsRuntime({ store: createFileSnapshotStore(dir), trustedSigners: [w.address], now: () => NOW });
      const s1 = await rt1.refresh(async () => ({ kind: 'ok', raw }));
      assert.equal(s1.status, 'valid');
      // "restart": new runtime, same directory, source unavailable
      const rt2 = createCuWeightsRuntime({ store: createFileSnapshotStore(dir), trustedSigners: [w.address], now: () => NOW });
      const s2 = await rt2.refresh(async () => ({ kind: 'unavailable', reason: 'ECONNREFUSED' }));
      assert.equal(s2.status, 'source_unavailable_using_snapshot');
      assert.equal(s2.active!.ref.digest, s1.active!.ref.digest);
      assert.equal(s2.activeSource, 'snapshot');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('source down and no snapshot → missing (no constants); expired snapshot → expired', async () => {
    const w = Wallet.createRandom();
    const rt = createCuWeightsRuntime({ store: createMemorySnapshotStore(), trustedSigners: [w.address], now: () => NOW });
    const s = await rt.refresh(async () => { throw new Error('timeout'); });
    assert.equal(s.status, 'missing');
    assert.equal(rt.active(), null);
    const store = createMemorySnapshotStore();
    let now = NOW;
    const rt2 = createCuWeightsRuntime({ store, trustedSigners: [w.address], now: () => now });
    await rt2.refresh(async () => ({ kind: 'ok', raw: await signedTable(w) }));
    now = '2027-02-01T00:00:00.000Z';
    const s2 = await rt2.refresh(async () => ({ kind: 'unavailable', reason: 'down' }));
    assert.equal(s2.status, 'expired');
    assert.equal(s2.active, null);
  });

  it('a rejected new table never activates; the last good one stays and the rejection is reported', async () => {
    const w = Wallet.createRandom();
    const rt = createCuWeightsRuntime({ store: createMemorySnapshotStore(), trustedSigners: [w.address], now: () => NOW });
    const good = await rt.refresh(async () => ({ kind: 'ok', raw: await signedTable(w) }));
    const evil = await signedTable(Wallet.createRandom(), { version: 'cw-evil' });
    const s = await rt.refresh(async () => ({ kind: 'ok', raw: evil }));
    assert.equal(s.status, 'valid'); // status of the ACTIVE config
    assert.equal(s.lastRejection!.status, 'unauthorized_signer');
    assert.equal(s.active!.ref.digest, good.active!.ref.digest);
    assert.equal(s.activeSource, 'previous');
  });

  it('review MEDIUM-6: an older validly signed table (replay) does not downgrade the active one', async () => {
    const w = Wallet.createRandom();
    const rt = createCuWeightsRuntime({ store: createMemorySnapshotStore(), trustedSigners: [w.address], now: () => NOW });
    const newer = await rt.refresh(async () => ({ kind: 'ok', raw: await signedTable(w, { version: 'cw-new', validFrom: '2026-06-01T00:00:00.000Z' }) }));
    const s = await rt.refresh(async () => ({ kind: 'ok', raw: await signedTable(w, { version: 'cw-old', validFrom: '2026-01-01T00:00:00.000Z' }) }));
    assert.equal(s.active!.ref.digest, newer.active!.ref.digest);
    assert.equal(s.lastRejection!.status, 'downgrade');
  });

  it('re-audit MEDIUM: after a restart an older replayed table does not overwrite the newer persisted snapshot', async () => {
    const w = Wallet.createRandom();
    const store = createMemorySnapshotStore();
    const rt1 = createCuWeightsRuntime({ store, trustedSigners: [w.address], now: () => NOW });
    const newer = await rt1.refresh(async () => ({ kind: 'ok', raw: await signedTable(w, { version: 'cw-new', validFrom: '2026-06-01T00:00:00.000Z' }) }));
    const rt2 = createCuWeightsRuntime({ store, trustedSigners: [w.address], now: () => NOW }); // restart: state.active empty
    const s = await rt2.refresh(async () => ({ kind: 'ok', raw: await signedTable(w, { version: 'cw-old', validFrom: '2026-01-01T00:00:00.000Z' }) }));
    assert.equal(s.lastRejection!.status, 'downgrade');
    assert.equal(s.active!.ref.digest, newer.active!.ref.digest);
    assert.equal(s.activeSource, 'snapshot');
    const rt3 = createCuWeightsRuntime({ store, trustedSigners: [w.address], now: () => NOW });
    assert.equal((await rt3.refresh(async () => ({ kind: 'unavailable', reason: 'down' }))).active!.ref.version, 'cw-new');
  });

  it('review MEDIUM-6: after signer rotation, frozen history stays readable through historicalSigners', async () => {
    const oldKey = Wallet.createRandom();
    const newKey = Wallet.createRandom();
    const store = createMemorySnapshotStore();
    const rt1 = createCuWeightsRuntime({ store, trustedSigners: [oldKey.address], now: () => NOW });
    const frozen = (await rt1.refresh(async () => ({ kind: 'ok', raw: await signedTable(oldKey) }))).active!.ref;
    const rotatedNoHistory = createCuWeightsRuntime({ store, trustedSigners: [newKey.address], now: () => NOW });
    assert.equal(rotatedNoHistory.byRef(frozen), null);
    const rotated = createCuWeightsRuntime({ store, trustedSigners: [newKey.address], historicalSigners: [oldKey.address], now: () => NOW });
    assert.equal(rotated.byRef(frozen)!.config.ref.digest, frozen.digest);
    // the historical signer cannot activate NEW tables
    const s = await rotated.refresh(async () => ({ kind: 'ok', raw: await signedTable(oldKey, { version: 'cw-x' }) }));
    assert.equal(s.lastRejection!.status, 'unauthorized_signer');
  });

  it('review HIGH-4: provider-controlled ids like "constructor"/"__proto__" never reach the prototype', async () => {
    const cfg = await validConfig();
    for (const model of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = computeCuFromTotals({ provider: 'openai', model, tIn: 1, tOut: 1 }, cfg);
      assert.equal(r.status, 'unsupported_model', model);
      assert.equal(computeCuFromTotals({ provider: model, model: 'gpt-4o', tIn: 1, tOut: 1 }, cfg).status, 'unsupported_model');
    }
    const w = Wallet.createRandom();
    const raw = await signedTable(w, { aliases: { 'x-1': 'constructor' } });
    assert.equal(loadCuWeights(raw, { now: NOW, trustedSigners: [w.address] }).status, 'malformed');
  });

  it('a frozen ref keeps its weights after a newer table activates, and is found after expiry', async () => {
    const w = Wallet.createRandom();
    let now = NOW;
    const rt = createCuWeightsRuntime({ store: createMemorySnapshotStore(), trustedSigners: [w.address], now: () => now });
    const s1 = await rt.refresh(async () => ({ kind: 'ok', raw: await signedTable(w) }));
    const frozen = s1.active!.ref;
    const changed = await signedTable(w, { version: 'cw-test-2', modelWeightsMilli: { ...MODEL_WEIGHTS_INT, 'gpt-4o': 1234n } });
    const s2 = await rt.refresh(async () => ({ kind: 'ok', raw: changed }));
    assert.notEqual(s2.active!.ref.digest, frozen.digest);
    now = '2028-01-01T00:00:00.000Z';
    const old = rt.byRef(frozen)!;
    assert.equal(old.config.table.modelWeightsMilli['gpt-4o'], 1000n);
    const r = computeCuFromTotals({ provider: 'openai', model: 'gpt-4o', tIn: 1, tOut: 0 }, old.config);
    assert.equal(r.cu!.units, 1_000_000n);
    assert.deepEqual(r.weights, frozen);
  });

  it('revocation removes activation but keeps history flagged', async () => {
    const w = Wallet.createRandom();
    const rt = createCuWeightsRuntime({ store: createMemorySnapshotStore(), trustedSigners: [w.address], now: () => NOW });
    const s = await rt.refresh(async () => ({ kind: 'ok', raw: await signedTable(w) }));
    rt.revoke(s.active!.ref.digest, 'operator rotated key');
    assert.equal(rt.active(), null);
    assert.equal(rt.byRef(s.active!.ref)!.revoked, true);
    const again = await rt.refresh(async () => ({ kind: 'unavailable', reason: 'down' }));
    assert.equal(again.active, null);
  });
});

describe('d1d8_b price — categories, history, missing price (D5-G05/G07)', () => {
  const table = parsePriceTableV1(JSON.parse(readFileSync('test/fixtures/d1d8/b/price_table_illustrative_v1.json', 'utf8')));
  const registry = createPriceTableRegistry([table]);
  const ref = priceTableRef(table);
  const priceUsage = createPriceUsage(registry);
  const norm = (id: string) => {
    const v = V(id);
    const provider = (v.api as string).split('.')[0]!;
    return normalizeUsage(v.api as UsageApi, v.response, { provider, modelRequested: 'requested', origin: 'provider_response', observedAt: NOW });
  };

  for (const id of ['USAGE-ANTHROPIC-01', 'USAGE-OPENAI-CHAT-01']) {
    it(`${id}: per-category lines without double count`, () => {
      const v = V(id);
      const q = priceUsage(norm(id), NOW, ref);
      assert.equal(q.status, v.expected.price.status);
      assert.equal(q.total!.units, BigInt(v.expected.price.total_units));
      assert.equal(q.total!.scale, BigInt(v.expected.price.total_scale));
      const lines = Object.fromEntries(q.lines.map((l) => [l.category, [l.count.toString(), l.amount!.units.toString()]]));
      assert.deepEqual(lines, v.expected.price.lines);
    });
  }

  it('USAGE-MISSING-01 and PRICE-MISSING-01: missing_price with total null, never US$ 0', () => {
    for (const id of ['USAGE-MISSING-01', 'PRICE-MISSING-01']) {
      const q = priceUsage(norm(id), NOW, ref);
      assert.equal(q.status, 'missing_price');
      assert.equal(q.total, null);
    }
  });

  it('unknown table ref → missing_price', () => {
    const q = priceUsage(norm('USAGE-OPENAI-CHAT-01'), NOW, { version: 'nope', digest: `0x${'00'.repeat(32)}` });
    assert.equal(q.status, 'missing_price');
  });

  it('PRICE-HISTORY-01: price in force at pricedAt; a newer table does not change a frozen quote', () => {
    const v = V('PRICE-HISTORY-01');
    const u = norm('PRICE-HISTORY-01');
    const totals = v.pricedAt.map((at: string) => priceUsage(u, at, ref).total!.units.toString());
    assert.deepEqual(totals, v.expected.totals_units);
    const newer = { ...table, version: 'illustrative-2026-10-05', entries: table.entries.map((e) => (e.category === 'input' ? { ...e, pricePerMTokMicroUsd: e.pricePerMTokMicroUsd * 10n } : e)) };
    const newerRef = registry.add(newer);
    assert.notEqual(newerRef.digest, ref.digest);
    assert.equal(priceUsage(u, v.pricedAt[0], ref).total!.units, BigInt(v.expected.totals_units[0]));
  });

  it('separate addend without price → partial with the unpriced line visible', () => {
    const u = normalizeUsage('anthropic.messages', { model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } }, { provider: 'anthropic', modelRequested: 'claude-haiku-4-5', origin: 'provider_response', observedAt: NOW });
    const partialTable = { ...table, version: 'no-cache-price', entries: table.entries.filter((e) => e.category !== 'input_cache_read') };
    const q = createPriceUsage(createPriceTableRegistry([partialTable]))(u, NOW, priceTableRef(partialTable));
    assert.equal(q.status, 'partial');
    const unpriced = q.lines.find((l) => l.category === 'input_cache_read')!;
    assert.equal(unpriced.amount, null);
    assert.equal(unpriced.source, 'otk:missing_price');
  });

  it('review MEDIUM-2: zero-count separate addend without a price does not block the quote', () => {
    const u = normalizeUsage('anthropic.messages', { model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, { provider: 'anthropic', modelRequested: 'claude-haiku-4-5', origin: 'provider_response', observedAt: NOW });
    const noCache = { ...table, version: 'no-cache-prices', entries: table.entries.filter((e) => !e.category.startsWith('input_cache')) };
    const q = createPriceUsage(createPriceTableRegistry([noCache]))(u, NOW, priceTableRef(noCache));
    assert.equal(q.status, 'priced');
    assert.equal(q.total!.units, 10n * 1_000_000n + 2n * 5_000_000n);
  });

  it('review LOW: overlapping windows are refused; aliases lowercased; registry returns a copy', () => {
    const raw = JSON.parse(readFileSync('test/fixtures/d1d8/b/price_table_illustrative_v1.json', 'utf8'));
    const overlap = { ...raw, entries: [...raw.entries, { ...raw.entries[0], effectiveUntil: null }] };
    assert.throws(() => parsePriceTableV1(overlap), /overlapping/);
    const upper = parsePriceTableV1({ ...raw, aliases: { 'GPT-4O-MINI-2024-07-18': 'GPT-4O-MINI' } });
    assert.equal(upper.aliases['gpt-4o-mini-2024-07-18'], 'gpt-4o-mini');
    const got = registry.get(ref)!;
    got.entries[0]!.pricePerMTokMicroUsd = 1n;
    assert.equal(registry.get(ref)!.entries[0]!.pricePerMTokMicroUsd, 150000n);
  });

  it('partial usage never yields a priced status', () => {
    const u = { ...norm('USAGE-OPENAI-CHAT-01'), completeness: 'partial' as const };
    assert.equal(priceUsage(u, NOW, ref).status, 'partial');
  });

  it('RESERVE-01: worst-case CU and money over every window of the frozen table', async () => {
    const v = V('RESERVE-01');
    const cfg = await validConfig();
    const estimate = createEstimateReservation(registry);
    const r = estimate({ provider: v.provider, api: 'openai.chat_completions', modelRequested: v.model, estimatedInputTokens: BigInt(v.estimatedInputTokens), maxOutputTokens: BigInt(v.maxOutputTokens) }, cfg, ref);
    assert.equal(r.cu.units, BigInt(v.expected.cu_units));
    assert.equal(r.cu.scale, BigInt(v.expected.cu_scale));
    assert.equal(r.money!.units, BigInt(v.expected.money_units));
    assert.equal(r.money!.scale, BigInt(v.expected.money_scale));
    assert.equal(estimate({ provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-4o', estimatedInputTokens: 1n, maxOutputTokens: 1n }, cfg, ref).money, null);
    assert.throws(() => estimate({ provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-99', estimatedInputTokens: 1n, maxOutputTokens: 1n }, cfg, ref), ReservationError);
    assert.throws(() => estimate({ provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-4o', estimatedInputTokens: 1n, maxOutputTokens: 0n }, cfg, ref), ReservationError);
  });

  it('input upper bound: text body bounded by bytes; non-text parts not boundable', () => {
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: 'olá, tudo bem?' }] };
    assert.equal(inputTokensUpperBound('openai.chat_completions', body), BigInt(Buffer.byteLength(JSON.stringify(body), 'utf8')));
    assert.equal(inputTokensUpperBound('openai.chat_completions', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }), null);
  });
});
