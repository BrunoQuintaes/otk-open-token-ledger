/** R14: the synthetic image and audio fixtures are reproducible byte for byte from their generators (sha256 in MANIFEST.json / AUDIO_SPEC.json). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));

describe('synthetic images', () => {
  it('regenerating into a temp dir yields the committed bytes (sha256) and SHA256SUMS matches the files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'h2img-'));
    execFileSync(process.execPath, [join(ROOT, 'scripts/h2eval/modal/tools/gen_synthetic_images.mjs'), '--out', tmp], { stdio: 'pipe' });
    const man = JSON.parse(readFileSync(join(FIX, 'images/MANIFEST.json'), 'utf8')) as { images: Array<{ file: string; sha256: string; bytes: number }> };
    for (const im of man.images) {
      const committed = readFileSync(join(FIX, 'images', im.file)); const regen = readFileSync(join(tmp, im.file));
      assert.equal(sha(committed), im.sha256, im.file); assert.equal(sha(regen), im.sha256, `${im.file} regenerated`); assert.equal(committed.length, im.bytes);
    }
    for (const line of readFileSync(join(FIX, 'images/SHA256SUMS'), 'utf8').trim().split('\n')) { const [h, f] = line.split(/\s+/); assert.equal(sha(readFileSync(join(FIX, 'images', f!))), h); }
  });
});

describe('synthetic audio (spec only committed; WAVs regenerated)', () => {
  it('AUDIO_SPEC.json: 10/60/180 s, 16 kHz mono PCM16, sha256 reproduced by the generator; reference figure is not an estimate', () => {
    const spec = JSON.parse(readFileSync(join(FIX, 'audio/AUDIO_SPEC.json'), 'utf8')) as { sampleRateHz: number; files: Array<{ file: string; seconds: number; bytes: number; sha256: string; documentedReferenceTokens_NOT_ESTIMATE: number }>; referenceFigureNotAnEstimator: string };
    assert.equal(spec.sampleRateHz, 16000); assert.deepEqual(spec.files.map((f) => f.seconds), [10, 60, 180]);
    for (const f of spec.files) { assert.equal(f.bytes, 44 + f.seconds * 16000 * 2); assert.equal(f.documentedReferenceTokens_NOT_ESTIMATE, 32 * f.seconds); }
    assert.match(spec.referenceFigureNotAnEstimator, /UNSUPPORTED_FOR_ESTIMATION/);
    const tmp = mkdtempSync(join(tmpdir(), 'h2aud-'));
    execFileSync(process.execPath, [join(ROOT, 'scripts/h2eval/modal/tools/gen_synthetic_audio.mjs'), '--out', tmp], { stdio: 'pipe' });
    for (const f of spec.files) { const buf = readFileSync(join(tmp, f.file)); assert.equal(sha(buf), f.sha256, f.file); assert.equal(buf.toString('ascii', 0, 4), 'RIFF'); assert.equal(buf.readUInt32LE(24), 16000); }
  });
});
