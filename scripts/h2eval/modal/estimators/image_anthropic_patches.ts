/**
 * NEW, EXPERIMENTAL ex ante image estimator for Claude: the official 28-px patch formula, from the archived page
 * anthropic/vision.html (sha256 58d5ce271304d5d319411ac9e7ce4ebecdee77978014f6a29e15b1df57f8c91f, R08 official_docs).
 *
 * Verbatim: "Claude processes images in patches instead of pixels. Each patch is a 28×28-pixel block of the image, referred to as a
 * visual token. An image, therefore, costs ⌈width / 28⌉ × ⌈height / 28⌉ visual tokens."
 * Tiers: "Standard | All other models | 1,568 px | 1,568" ; "High-resolution | Claude 4.7 and later models | 2,576 px | 4,784"
 * (max long edge | max visual tokens). "Images larger than either limit are downscaled before processing; see How Claude resizes
 * and pads images for the exact rule." That page is NOT in the archive, so for an image beyond a limit this estimator returns only
 * the documented cap as an UPPER BOUND (ESTIMATED_UPPER_BOUND), never a guessed resize.
 * Documented table values used as tests: 200x200 -> 64; 1000x1000 -> 1,296; 1092x1092 -> 1,521 (both tiers, "Not resized");
 * 1920x1080 -> 2,691 on High-resolution ("Not resized"), 1,560 on Standard (resized: only the bound 1,568 is asserted here).
 * Haiku 4.5 = Standard tier; Haiku 5.5 = "Claude 4.7 and later" = High-resolution tier (R08 §5).
 */
import type { ExAnteEstimate } from '../types.js';

export const ANTHROPIC_TIERS = Object.freeze({
  standard: { maxLongEdge: 1568, maxTokens: 1568n },
  high_resolution: { maxLongEdge: 2576, maxTokens: 4784n },
});
export const ANTHROPIC_IMAGE_CITATION = 'anthropic/vision.html sha256 58d5ce27...: "An image, therefore, costs ⌈width / 28⌉ × ⌈height / 28⌉ visual tokens."; tiers Standard 1,568 px / 1,568 tokens, High-resolution 2,576 px / 4,784 tokens; oversized images are downscaled by a rule on a page not archived => only the cap is asserted';

export function anthropicTierOf(model: 'claude-haiku-4-5-20251001' | 'claude-haiku-5-5'): keyof typeof ANTHROPIC_TIERS {
  return model === 'claude-haiku-5-5' ? 'high_resolution' : 'standard';
}

export function estimateAnthropicImageTokens(args: { width: number; height: number; model: 'claude-haiku-4-5-20251001' | 'claude-haiku-5-5' }): ExAnteEstimate {
  const id = 'h2eval.image.anthropic_patches28.v0 (EXPERIMENTAL)';
  if (!Number.isInteger(args.width) || !Number.isInteger(args.height) || args.width <= 0 || args.height <= 0) return { status: 'UNSUPPORTED_FOR_ESTIMATION', modality: 'image', tokens: null, estimatorId: id, label: 'NONE', citation: ANTHROPIC_IMAGE_CITATION, reasons: ['invalid_dimensions'] };
  const tierName = anthropicTierOf(args.model); const tier = ANTHROPIC_TIERS[tierName];
  const tokens = BigInt(Math.ceil(args.width / 28) * Math.ceil(args.height / 28));
  const withinEdge = Math.max(args.width, args.height) <= tier.maxLongEdge;
  if (withinEdge && tokens <= tier.maxTokens) return { status: 'ESTIMATED', modality: 'image', tokens, estimatorId: id, label: 'EXPERIMENTAL', citation: ANTHROPIC_IMAGE_CITATION, reasons: [`tier_${tierName}`, 'not_resized'] };
  return { status: 'ESTIMATED_UPPER_BOUND', modality: 'image', tokens: tier.maxTokens, estimatorId: id, label: 'EXPERIMENTAL', citation: ANTHROPIC_IMAGE_CITATION, reasons: [`tier_${tierName}`, withinEdge ? 'exceeds_max_tokens' : 'exceeds_max_long_edge', 'resize_rule_page_not_archived', `unresized_formula_value_${tokens}`] };
}
