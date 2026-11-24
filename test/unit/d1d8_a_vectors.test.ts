/**
 * D1-G01 / D3-G01 — static v3 vectors (test/fixtures/d1d8/a/v3_vectors.json) are reproduced
 * exactly by the current code. A change in encoding, digest, commitment or signature breaks this
 * test; such a change needs a new schema version, not a silent vector update.
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
