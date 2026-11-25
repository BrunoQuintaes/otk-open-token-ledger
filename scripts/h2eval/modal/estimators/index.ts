/**
 * Ex ante estimator dispatch by model x modality (R08 §10 classification, narrowed by the C141 B2 order):
 *  text  -> OTK local counter (EXISTENTE) for the four models;
 *  image -> OpenAI tiles and Anthropic patches (EXPERIMENTAL, official formulas); Google image = UNSUPPORTED (formula "rough");
 *  audio -> UNSUPPORTED for every model (gpt-4o-mini and Claude: NOT_SUPPORTED by the API; Gemini: declared usage only,
 *           exploratory; the documented "32 tokens per second" is kept as a reference figure, NOT an estimator, so no error is computed).
 * Never compute an error against a missing estimator: the caller must check `status` before any comparison.
 *
 * Re-exported by `modal/index.ts`.
 *
 * @module scripts/h2eval/modal/estimators/index
 */
import type { Api, ExAnteEstimate, MatrixModel, Modality } from '../types.js';
import { estimateTextTokens } from './text_otk.js';
import { estimateOpenAiImageTokens } from './image_openai_tiles.js';
import { estimateAnthropicImageTokens } from './image_anthropic_patches.js';
import { readPngSize } from './png_dims.js';

/** Citation of Google's audio token figure, kept as reference only (never used as an estimator). */
export const GOOGLE_AUDIO_REFERENCE_FIGURE = 'google/audio.html sha256 12128e76...: "Tokens: 32 tokens per second of audio (1 minute = 1,920 tokens)" - reference only, not used as an estimator (C141 B2: all audio UNSUPPORTED_FOR_ESTIMATION)';
/** Citation of Google's image token rule, kept as reference only (declared rough by Google). */
export const GOOGLE_IMAGE_REFERENCE_FIGURE = 'google/image-understanding.html sha256 f196f033...: "258 tokens if both dimensions <= 384 pixels. Larger images are tiled into 768x768 pixel tiles, each costing 258 tokens. A rough formula ..." - declared "rough", media_resolution changes it => UNSUPPORTED_FOR_ESTIMATION';

/**
 * Builds an `UNSUPPORTED_FOR_ESTIMATION` result (no token number).
 *
 * @param modality - Modality that could not be estimated.
 * @param reasons - Machine-readable reasons.
 * @param citation - Optional reference citation.
 * @returns The estimate with `tokens: null` and label `NONE`.
 */
export function unsupported(modality: Modality, reasons: string[], citation: string | null = null): ExAnteEstimate {
  return { status: 'UNSUPPORTED_FOR_ESTIMATION', modality, tokens: null, estimatorId: 'none', label: 'NONE', citation, reasons };
}

/** Image input for the estimators: PNG bytes (dimensions read from the header) or width and height in pixels, plus the OpenAI detail level. */
export interface ImageInput { png?: Buffer; width?: number; height?: number; detail?: 'low' | 'high' | 'auto' | 'original' }

/**
 * Estimates input tokens before the call for one model and modality.
 *
 * @param model - Matrix model.
 * @param api - Provider API.
 * @param modality - `text`, `image` or `audio`.
 * @param input - `requestBody` for text; `image` for image; `audioSeconds` is accepted but not used (audio is never estimated).
 * @returns The estimate, or `UNSUPPORTED_FOR_ESTIMATION` with reasons.
 */
export function estimateExAnte(model: MatrixModel, api: Api, modality: Modality, input: { requestBody?: unknown; image?: ImageInput; audioSeconds?: number }): ExAnteEstimate {
  if (modality === 'text') return estimateTextTokens(model, api, input.requestBody);
  if (modality === 'audio') {
    if (model === 'gemini-3.5-flash-lite') return unsupported('audio', ['audio_declared_usage_only_exploratory', 'no_validated_estimator'], GOOGLE_AUDIO_REFERENCE_FIGURE);
    return unsupported('audio', ['model_does_not_accept_audio_NOT_SUPPORTED'], null);
  }
  // image
  const dims = input.image?.png ? readPngSize(input.image.png) : (input.image?.width && input.image?.height ? { width: input.image.width, height: input.image.height } : null);
  if (!dims) return unsupported('image', ['no_dimensions']);
  if (model === 'gpt-4o-mini-2024-07-18') return estimateOpenAiImageTokens({ width: dims.width, height: dims.height, detail: input.image?.detail ?? 'auto', model });
  if (model === 'claude-sonnet-5-5' || model === 'claude-opus-5-5') return unsupported('image', ['no_archived_image_token_rule_for_this_model']);
  if (model === 'claude-haiku-4-5-20251001' || model === 'claude-haiku-5-5') return estimateAnthropicImageTokens({ width: dims.width, height: dims.height, model });
  return unsupported('image', ['google_formula_declared_rough', 'media_resolution_dependent'], GOOGLE_IMAGE_REFERENCE_FIGURE);
}

export { estimateTextTokens, estimateOpenAiImageTokens, estimateAnthropicImageTokens, readPngSize };
