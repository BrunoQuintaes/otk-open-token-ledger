/**
 * Fechamento pós-S5 — RV2-06 / AUD-3: the operations runtime never starts with a measurement it chose
 * by itself. Without measurement ports it refuses BEFORE opening any connection (the database URL below
 * is unreachable on purpose: reaching it would fail differently), both for typed callers (compile error,
 * kept by @ts-expect-error) and for callers that bypass the type. The legacy adapter remains available
 * only as an explicit factory.
 *
 * Modules under test: `OperationsRuntime` and `operationsOptionsFromEnv` from
 * `src/operations/runtime.ts`, and `legacyMeasurementPorts` from `src/operations/measurementPorts.ts`.
 *
 * Strategy / partitions: creating the runtime with the measurement ports omitted and explicitly
 * `undefined` (both rejected); options built from the environment carry no measurement; the
 * legacy adapter is labelled as legacy.
 *
 * Needs: no database (the URL points at a closed local port and must never be contacted).
 *
 * Run just this file: `npx tsx --test test/unit/d1d8_fps5_measurement_required.test.ts`
 *
 * @module test/unit/d1d8_fps5_measurement_required.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OperationsRuntime, operationsOptionsFromEnv } from '../../src/operations/runtime.js';
import { legacyMeasurementPorts } from '../../src/operations/measurementPorts.js';

const UNREACHABLE = 'postgres://otk:none@127.0.0.1:1/none';

describe('RV2-06 — measurement ports are a required dependency of the runtime', () => {
  it('missing measurement is refused before any connection (typed and untyped callers)', async () => {
    // @ts-expect-error measurement is required by the type
    await assert.rejects(OperationsRuntime.create({ dbUrl: UNREACHABLE }), /measurement ports are required/);
    await assert.rejects(OperationsRuntime.create({ dbUrl: UNREACHABLE, measurement: undefined } as unknown as Parameters<typeof OperationsRuntime.create>[0]), /measurement ports are required/);
  });

  it('options from the environment carry no measurement: the caller must add real or explicit legacy ports', () => {
    const o = operationsOptionsFromEnv(UNREACHABLE);
    assert.equal('measurement' in o, false);
    const legacy = legacyMeasurementPorts();
    assert.match(legacy.label, /legacy/i, 'the legacy adapter is labelled as such');
  });
});
