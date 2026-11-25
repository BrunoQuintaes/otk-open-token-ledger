/**
 * D1-G01 / D3-G01 — static v3 vectors (test/fixtures/d1d8/a/v3_vectors.json) are reproduced
 * exactly by the current code. A change in encoding, digest, commitment or signature breaks this
 * test; such a change needs a new schema version, not a silent vector update.
 *
 * Module under test: everything `computeVectors` in `test/fixtures/d1d8/a/v3Vectors.ts` calls
 * (v3 encoding, digests, commitment and signatures).
 *
 * Strategy: one comparison of the freshly computed vectors with the committed JSON file, plus a
 * check of the hand-computed epoch and bucket window in the public signals.
 *
 * Needs: read access to the committed vectors file; no network.
 *
 * Run just this file: `npx tsx --test test/unit/d1d8_a_vectors.test.ts`
 *
 * @module test/unit/d1d8_a_vectors.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeVectors, VECTORS_PATH } from '../fixtures/d1d8/a/v3Vectors.js';

test('v3 static vectors are reproduced byte for byte', async () => {
  const saved = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
  const now = JSON.parse(JSON.stringify(await computeVectors()));
  assert.deepEqual(now, saved);
  // The epoch/window in the vector are the hand values of the fixture: 2026-09-30T19:00Z → 497443; 640 CU → [0, 999 999 999].
  assert.deepEqual(saved.publicSignals.slice(1), ['497443', '0', '999999999']);
});
