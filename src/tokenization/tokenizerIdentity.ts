/**
 * Tokenizer identity and encoders for the auxiliary counter (D4 §5, D4-G05; front B).
 *
 * The encoder is built from the exact rank file shipped by the installed js-tiktoken package,
 * and the identity carries that package version plus a digest of the rank content, so a count
 * can be reproduced in a clean clone. The legacy id 'tiktoken@<encoding>@v1' of
 * TokenizerRegistry is not enough for that and is kept only for historical receipts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Tiktoken } from 'js-tiktoken';
import type { Hex32 } from '../types/d1d8/index.js';
import type { TokenizerIdentity } from '../types/d1d8/index.js';

export type LocalEncoding = 'o200k_base' | 'cl100k_base';

/** Every encoding a local counter may load (keep equal to LocalEncoding). */
export const LOCAL_ENCODINGS: readonly LocalEncoding[] = Object.freeze(['o200k_base', 'cl100k_base']);

/** How message parts are turned into text before counting (see localCounter.ts). */
export const MESSAGE_ASSEMBLY = Object.freeze({ id: 'otk.assembly.text_parts', version: '1' });

interface RankFile {
  pat_str: string;
  special_tokens: Record<string, number>;
  bpe_ranks: string;
}

const require = createRequire(import.meta.url);

let packageVersionCache: string | null = null;

/** Version of the js-tiktoken package actually installed (not the semver range). */
export function tiktokenPackageVersion(): string {
  if (packageVersionCache) return packageVersionCache;
  // The package does not export ./package.json; walk up from the resolved entry point.
  let dir = dirname(require.resolve('js-tiktoken'));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'js-tiktoken' && typeof pkg.version === 'string') {
        packageVersionCache = pkg.version;
        return pkg.version;
      }
    } catch {
      // keep walking up
    }
    dir = dirname(dir);
  }
  throw new Error('js-tiktoken package.json not found');
}

function sha256Hex(data: string): Hex32 {
  return `0x${createHash('sha256').update(data, 'utf8').digest('hex')}`;
}

interface LoadedEncoding {
  encoder: Tiktoken;
  identity: TokenizerIdentity;
}

const loaded = new Map<LocalEncoding, LoadedEncoding>();

/**
 * Encoder and identity for one encoding. The digest covers pat_str, special tokens and the BPE
 * ranks, in that order, joined by '\n' — the exact data the encoder is constructed from.
 */
export function loadEncoding(encoding: LocalEncoding): LoadedEncoding {
  const cached = loaded.get(encoding);
  if (cached) return cached;
  const ranks = require(`js-tiktoken/ranks/${encoding}`) as { default?: RankFile } & Partial<RankFile>;
  const file: RankFile = (ranks.default ?? ranks) as RankFile;
  if (typeof file.pat_str !== 'string' || typeof file.bpe_ranks !== 'string') {
    throw new Error(`rank file for ${encoding} has an unexpected shape`);
  }
  const specials = Object.keys(file.special_tokens).sort().map((k) => `${k}=${file.special_tokens[k]}`).join(',');
  const digest = sha256Hex(`${file.pat_str}\n${specials}\n${file.bpe_ranks}`);
  const entry: LoadedEncoding = {
    encoder: new Tiktoken(file),
    identity: {
      package: 'js-tiktoken',
      packageVersion: tiktokenPackageVersion(),
      encoding,
      vocabularyDigest: digest,
      messageAssembly: { ...MESSAGE_ASSEMBLY },
    },
  };
  loaded.set(encoding, entry);
  return entry;
}

/** Load (and cache) each encoding now; returns the time each first load took (0 when already cached). */
export function warmEncodings(encodings: readonly LocalEncoding[] = LOCAL_ENCODINGS): Array<{ encoding: LocalEncoding; ms: number }> {
  return encodings.map((encoding) => {
    const t0 = performance.now();
    loadEncoding(encoding);
    return { encoding, ms: Math.round(performance.now() - t0) };
  });
}

/**
 * Count tokens of one text piece. Special-token strings inside user text are counted as
 * ordinary text (disallowedSpecial = []), instead of throwing as js-tiktoken does by default.
 */
export function countWith(encoder: Tiktoken, text: string): number {
  if (text.length === 0) return 0;
  return encoder.encode(text, [], []).length;
}

/**
 * js-tiktoken merges a regex piece in time quadratic in its length (measured on this machine:
 * 1000 letters ≈ 0.18 s, 4000 ≈ 2.7 s). A piece longer than this is not counted: callers mark
 * the category uncovered ('max_piece_chars') instead of spending unbounded CPU.
 */
export const MAX_PIECE_CHARS = 1000;
const N = MAX_PIECE_CHARS + 1;
const OVERSIZED_PIECE = new RegExp(String.raw`[\p{L}\p{M}]{${N},}|[^\s\p{L}\p{N}]{${N},}|\s{${N},}`, 'u');

export function hasOversizedPiece(text: string): boolean {
  return text.length > MAX_PIECE_CHARS && OVERSIZED_PIECE.test(text);
}
