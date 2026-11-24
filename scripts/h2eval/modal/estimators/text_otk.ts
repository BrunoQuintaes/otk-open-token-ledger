/**
 * EX ANTE text estimator = the OTK local counter of the H1 baseline, imported unchanged (label EXISTENTE).
 * It counts the text parts of the request body with the model's tokenizer (exact o200k_base for gpt-4o-mini;
 * cl100k_base APPROXIMATION for Anthropic and Gemini, as the H1 catalog resolves them). Any non-text part (image,
 * audio, tools) makes the counter report 'incomplete' and this estimator returns UNSUPPORTED_FOR_ESTIMATION: no L0 is invented.
 * claude-haiku-5-5 is not in the H1 catalog; the catalog falls back to the provider approximation (cl100k_base) and the
 * official page says this model's tokenizer yields ~30% more tokens than Haiku 4.5: flagged, uncalibrated.
 */
import { createLocalCounter, COUNTER_VERSION } from '../../../../src/tokenization/localCounter.js';
import { resolveModelSupport } from '../../../../src/providers/catalog/modelCatalog.js';
import type { UsageApi } from '../../../../src/types/d1d8/index.js';
import type { Api, ExAnteEstimate, MatrixModel } from '../types.js';

const PROVIDER_OF: Record<MatrixModel, string> = { 'gpt-4o-mini-2024-07-18': 'openai', 'claude-haiku-4-5-20251001': 'anthropic', 'claude-haiku-5-5': 'anthropic', 'claude-sonnet-5-5': 'anthropic', 'claude-opus-5-5': 'anthropic', 'gemini-3.5-flash-lite': 'gemini' };

export function estimateTextTokens(model: MatrixModel, api: Api, requestBody: unknown): ExAnteEstimate {
  const support = resolveModelSupport(PROVIDER_OF[model], api as UsageApi, model);
  const counter = createLocalCounter(support, { maxTextBytes: 1 << 22 });
  counter.observeInput({ api: api as UsageApi, body: requestBody });
  const r = counter.finish();
  const reasons = [...counter.reasons];
  const exact = support.support === 'exact' || support.support === 'alias_known';
  const info = { version: r.counterVersion || COUNTER_VERSION, encoding: support.tokenizer?.encoding ?? null, support: support.support, exact };
  if (model === 'claude-haiku-5-5') reasons.push('haiku_5_5_new_tokenizer_approx_cl100k_uncalibrated');
  if (model === 'claude-sonnet-5-5' || model === 'claude-opus-5-5') reasons.push('claude_5_5_tokenizer_approx_cl100k_uncalibrated');
  // r.status reflects both sides (no output was observed here); the input side alone decides the ex ante estimate
  if (r.status === 'failed' || r.status === 'unsupported' || !r.covered.includes('input')) {
    return { status: 'UNSUPPORTED_FOR_ESTIMATION', modality: 'text', tokens: null, estimatorId: `${info.version}:${info.encoding ?? 'none'}`, label: 'NONE', citation: null, reasons: [`counter_status_${r.status}`, ...reasons], counter: info };
  }
  const c = r.counts.find((x) => x.category === 'input');
  return { status: 'ESTIMATED', modality: 'text', tokens: c ? c.count : null, estimatorId: `${info.version}:${info.encoding}`, label: 'EXISTENTE', citation: `OTK local counter ${info.version}, assembly otk.assembly.text_parts@1, tokenizer ${info.encoding} (${exact ? 'exact for this model' : 'provider approximation; the gap is what a calibration estimates'})`, reasons, counter: info };
}
