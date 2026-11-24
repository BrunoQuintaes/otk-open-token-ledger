/**
 * F-FC-02 (FINAL CLOSURE, 2026-10-07): the calibration profile is selected for the model the provider RETURNED when its
 * local tokenizer is identical to the one used for the local count. Uses the approved real profile of the OVERNIGHT 2
 * campaign (gpt-4o-mini-2024-07-18, calibrated=true) and the two NOT_CALIBRATED ones. No alias is added.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { calibrationSupportFor } from '../../src/operations/effects.js';
import { createCalibrationRegistry } from '../../src/tokenization/calibrationProfile.js';
import { resolveModelSupport } from '../../src/providers/catalog/modelCatalog.js';
import { COUNTER_VERSION } from '../../src/tokenization/localCounter.js';

const ROOT = path.join(import.meta.dirname, '..', '..');
const src = (rel: string) => ({ source: rel, text: readFileSync(path.join(ROOT, rel), 'utf8') });
const reg = createCalibrationRegistry([
  src('config/calibration/otk.calib.ovn2-20261007.openai.gpt-4o-mini-2024-07-18.json'),
  src('docs/_ops/OVERNIGHT2_20261006/calibration/calibration_profile_anthropic_claude-haiku-4-5-20251001.json'),
  src('docs/_ops/OVERNIGHT2_20261006/calibration/calibration_profile_gemini_gemini-3.5-flash-lite.json'),
]);
const sup = (p: string, api: string, m: string) => resolveModelSupport(p, api as never, m);
const state = (requested: ReturnType<typeof sup>, returned: ReturnType<typeof sup> | null) => reg.select(calibrationSupportFor(requested, returned), COUNTER_VERSION).state;

describe('calibration profile selection by the returned model (F-FC-02)', () => {
  const reqAlias = sup('openai', 'openai.chat_completions', 'gpt-4o-mini');
  it('requested alias + returned calibrated snapshot → COMPATIBLE (the profile is found and applied)', () => {
    assert.equal(state(reqAlias, sup('openai', 'openai.chat_completions', 'gpt-4o-mini-2024-07-18')), 'COMPATIBLE');
  });
  it('requested alias without a returned model → ABSENT (no alias invented)', () => {
    assert.equal(state(reqAlias, null), 'ABSENT');
  });
  it('returned snapshot that no profile names → ABSENT (a future snapshot is not covered)', () => {
    assert.equal(state(reqAlias, sup('openai', 'openai.chat_completions', 'gpt-4o-mini-2099-01-01')), 'ABSENT');
  });
  it('Haiku 4.5 and Gemini 3.5 stay NOT_CALIBRATED', () => {
    const h = sup('anthropic', 'anthropic.messages', 'claude-haiku-4-5-20251001');
    assert.equal(state(h, h), 'NOT_CALIBRATED');
    const g = sup('gemini', 'gemini.generate_content', 'gemini-3.5-flash-lite');
    assert.equal(state(g, g), 'NOT_CALIBRATED');
  });
  it('a returned model with a different local tokenizer never borrows a profile: the requested support is kept', () => {
    const req = sup('openai', 'openai.chat_completions', 'gpt-4o-mini');
    const other = sup('openai', 'openai.chat_completions', 'gpt-4');
    // precondition asserted, not guarded (AUD-FC-03): the two models really have different local tokenizers
    assert.ok(req.tokenizer && other.tokenizer, 'both models have a local tokenizer in the catalog');
    assert.notEqual(req.tokenizer!.encoding, other.tokenizer!.encoding);
    assert.equal(calibrationSupportFor(req, other), req);
    assert.equal(state(req, other), 'ABSENT', 'the alias requested keeps its own (absent) state; nothing is borrowed');
    assert.equal(calibrationSupportFor(req, null), req);
  });
});
