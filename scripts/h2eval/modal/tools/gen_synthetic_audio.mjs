#!/usr/bin/env node
// Deterministic synthetic WAV files (PCM 16-bit mono, 16 kHz, pure tones + silence; NO voice, no third-party content).
// Durations follow R07 §3.4 (10 s, 60 s, 180 s). The files are reproducible byte for byte; only the SPEC (with sha256)
// is committed, the WAVs are regenerated on demand. Uso: node gen_synthetic_audio.mjs --out <dir> [--spec-only]
/**
 * Command-line generator of the synthetic audio test inputs.
 *
 * Usage: `node scripts/h2eval/modal/tools/gen_synthetic_audio.mjs --out <dir> [--spec-only]`. It creates `<dir>`,
 * writes one WAV per duration (unless `--spec-only`) and always writes `AUDIO_SPEC.json` with each file's size and
 * SHA-256; prints a short summary as JSON. Exit code 2 when `--out` is missing. Run by
 * `test/h2eval/modal/synthetic_media.test.ts`. No network, no environment variables.
 *
 * @module scripts/h2eval/modal/tools/gen_synthetic_audio
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const OUT = arg('out'); const specOnly = process.argv.includes('--spec-only');
if (!OUT) { console.error('uso: --out <dir> [--spec-only]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

/** Sample rate in Hz. */
export const RATE = 16000;
/** Durations of the generated files, in seconds. */
export const DURATIONS_S = [10, 60, 180];

/**
 * Builds a 16-bit mono PCM WAV of a repeating 4-second cycle (440 Hz, 660 Hz, silence, 220 Hz).
 *
 * @param seconds - Duration in seconds (integer).
 * @param rate - Sample rate in Hz.
 * @returns The WAV file bytes (44-byte header plus samples).
 */
export function wav(seconds, rate = RATE) {
  const n = seconds * rate; const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate; const seg = Math.floor(t) % 4; // 4-second cycle: 440 Hz, 660 Hz, silence, 220 Hz
    const f = seg === 0 ? 440 : seg === 1 ? 660 : seg === 2 ? 0 : 220;
    const v = f === 0 ? 0 : Math.round(12000 * Math.sin(2 * Math.PI * f * t));
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const spec = { schema: 'otk.h2eval.synthetic_audio_spec.v1', format: 'WAV PCM 16-bit mono', sampleRateHz: RATE, content: 'pure tones 440/660/220 Hz and silence in a 4 s cycle; no voice, no third-party content', generator: 'scripts/h2eval/modal/tools/gen_synthetic_audio.mjs', referenceFigureNotAnEstimator: 'google/audio.html: "32 tokens per second of audio (1 minute = 1,920 tokens)" - reference only; all audio is UNSUPPORTED_FOR_ESTIMATION (C141 B2)', files: [] };
for (const s of DURATIONS_S) {
  const buf = wav(s); const name = `synthetic_tone_${s}s_16k_mono.wav`;
  if (!specOnly) writeFileSync(join(OUT, name), buf);
  spec.files.push({ file: name, seconds: s, bytes: buf.length, sha256: sha(buf), documentedReferenceTokens_NOT_ESTIMATE: 32 * s, mimeType: 'audio/wav' });
}
writeFileSync(join(OUT, 'AUDIO_SPEC.json'), JSON.stringify(spec, null, 1) + '\n');
console.log(JSON.stringify(spec.files.map((f) => [f.file, f.bytes, f.sha256.slice(0, 12)])));
