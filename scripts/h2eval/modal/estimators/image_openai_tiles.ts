/**
 * NEW, EXPERIMENTAL ex ante image estimator for gpt-4o-mini: the official tile formula, implemented from the archived page
 * openai/images-vision.html (sha256 25aa452da3aebba35724b7cfcc71ac26e1f20efc8d1559ee069d66c5218dcd6f, R08 official_docs).
 *
 * Verbatim ("Tile-based image tokenization"):
 *   "gpt-4o-mini | 2833 | 5667" (Base tokens | Tile tokens)
 *   "With "detail": "low", an image costs only the model's base tokens, regardless of dimensions. With "detail": "high" or "detail": "auto":
 *    Scale down to fit in a 2048px x 2048px square, maintaining aspect ratio. Smaller images are not enlarged.
 *    If the shortest side exceeds 768px, scale it down to 768px and round down the other dimension.
 *    Count the 512px squares needed to cover the image. Each square uses the model's tile tokens.
 *    Add the model's base tokens to the tile tokens."
 *   "Floating-point rounding in billing can make the final count differ from the estimate by one token."
 * The page gives no worked example for gpt-4o-mini itself; the tests use the formula's own arithmetic plus the rule text.
 * Scope: one image, detail low/high/auto; "original" detail is not covered by the tile table => UNSUPPORTED.
 */
import type { ExAnteEstimate } from '../types.js';

export const OPENAI_TILE_TABLE = Object.freeze({ 'gpt-4o-mini': { base: 2833n, tile: 5667n } });
export const OPENAI_IMAGE_CITATION = 'openai/images-vision.html sha256 25aa452d...: "gpt-4o-mini | 2833 | 5667"; low = base only; high/auto: fit 2048x2048 (no enlarging), shortest side > 768 -> 768 (other side rounded down), count 512px squares x tile tokens + base tokens; billing may differ by one token';

export function openAiResizedDims(width: number, height: number): { w: number; h: number } {
  let w = width; let h = height;
  if (w > 2048 || h > 2048) { const s = 2048 / Math.max(w, h); w = Math.floor(w * s); h = Math.floor(h * s); } // fit in the square, aspect kept, no enlarging
  if (Math.min(w, h) > 768) { if (w <= h) { h = Math.floor(h * (768 / w)); w = 768; } else { w = Math.floor(w * (768 / h)); h = 768; } } // shortest side -> 768, other rounded down
  return { w, h };
}

export function estimateOpenAiImageTokens(args: { width: number; height: number; detail: 'low' | 'high' | 'auto' | 'original'; model: 'gpt-4o-mini-2024-07-18' }): ExAnteEstimate {
  const t = OPENAI_TILE_TABLE['gpt-4o-mini'];
  const id = 'h2eval.image.openai_tiles.v0 (EXPERIMENTAL)';
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height) || args.width <= 0 || args.height <= 0) return { status: 'UNSUPPORTED_FOR_ESTIMATION', modality: 'image', tokens: null, estimatorId: id, label: 'NONE', citation: OPENAI_IMAGE_CITATION, reasons: ['invalid_dimensions'] };
  if (args.detail === 'original') return { status: 'UNSUPPORTED_FOR_ESTIMATION', modality: 'image', tokens: null, estimatorId: id, label: 'NONE', citation: OPENAI_IMAGE_CITATION, reasons: ['detail_original_not_in_tile_table'] };
  if (args.detail === 'low') return { status: 'ESTIMATED', modality: 'image', tokens: t.base, estimatorId: id, label: 'EXPERIMENTAL', citation: OPENAI_IMAGE_CITATION, reasons: ['detail_low_base_only', 'billing_may_differ_by_one_token'] };
  const { w, h } = openAiResizedDims(args.width, args.height);
  const tiles = BigInt(Math.ceil(w / 512) * Math.ceil(h / 512));
  return { status: 'ESTIMATED', modality: 'image', tokens: t.base + tiles * t.tile, estimatorId: id, label: 'EXPERIMENTAL', citation: OPENAI_IMAGE_CITATION, reasons: [`resized_${w}x${h}`, `tiles_${tiles}`, 'billing_may_differ_by_one_token'] };
}
