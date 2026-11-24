#!/usr/bin/env node
// Deterministic synthetic PNGs (no third-party content, no image library): RGB gradients + a few rectangles,
// 8-bit, no timestamps, so the bytes and the sha256 are stable across runs.
// Uso: node gen_synthetic_images.mjs --out <dir>   (writes <dim>.png, MANIFEST.json, SHA256SUMS)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const OUT = arg('out'); if (!OUT) { console.error('uso: --out <dir>'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

// dimensions: the documented Anthropic table values, OpenAI tile boundaries, the Google example, and R07's "2 dimensions x 2 complexities"
export const SPECS = [
  { w: 200, h: 200, complexity: 'flat' }, { w: 384, h: 384, complexity: 'flat' }, { w: 512, h: 512, complexity: 'pattern' },
  { w: 960, h: 540, complexity: 'pattern' }, { w: 1000, h: 1000, complexity: 'flat' }, { w: 1024, h: 768, complexity: 'pattern' },
  { w: 1092, h: 1092, complexity: 'pattern' }, { w: 1536, h: 1024, complexity: 'flat' }, { w: 1920, h: 1080, complexity: 'pattern' }, { w: 2000, h: 1500, complexity: 'pattern' },
];

const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };

export function png(w, h, complexity) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter none
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      let r = Math.floor((255 * x) / Math.max(1, w - 1)), g = Math.floor((255 * y) / Math.max(1, h - 1)), b = 128;
      if (complexity === 'pattern') { if (((x >> 5) + (y >> 5)) % 2 === 0) { r = 255 - r; b = 30; } if (x % 97 < 3 || y % 89 < 3) { r = 10; g = 10; b = 10; } }
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifest = []; const sums = [];
for (const s of SPECS) {
  const name = `synthetic_${s.w}x${s.h}_${s.complexity}.png`; const buf = png(s.w, s.h, s.complexity);
  writeFileSync(join(OUT, name), buf);
  manifest.push({ file: name, width: s.w, height: s.h, complexity: s.complexity, bytes: buf.length, sha256: sha(buf), generator: 'scripts/h2eval/modal/tools/gen_synthetic_images.mjs', content: 'synthetic gradient/pattern, no third-party content' });
  sums.push(`${sha(buf)}  ${name}`);
}
writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify({ schema: 'otk.h2eval.synthetic_images.v1', images: manifest }, null, 1) + '\n');
writeFileSync(join(OUT, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(JSON.stringify(manifest.map((m) => [m.file, m.bytes, m.sha256.slice(0, 12)])));
