/**
 * Google Gemini generateContent adapter for gemini-3.5-flash-lite (the H1 endpoint; R08 §2 lists generateContent | Interactions,
 * generateContent is the one with the explicit-cache and usageMetadata fields this parser reads).
 * Price-fixing parameters: Standard tier (no tier parameter is sent; the response's usageMetadata.serviceTier must be
 * standard/unspecified; flex/priority/batch => cost UNKNOWN), no streaming, generationConfig.maxOutputTokens,
 * thinkingConfig.thinkingLevel = MINIMAL (there is no "off" for this model: R08 §8), media resolution left at default.
 * Usage semantics (contract §4 + R08 §4): promptTokenCount INCLUDES cached tokens; cachedContentTokenCount is a subset of the
 * prompt; thoughtsTokenCount is a SEPARATE addend billed as output ("Output price (including thinking tokens)");
 * promptTokensDetails[modality] gives the image/audio token units. Implicit caching cannot be disabled.
 * Sources (R08 official_docs): google/generate-content.html, google/pricing.html, google/caching.html, google/thinking.html,
 * google/image-understanding.html, google/audio.html, google/model_gemini-3.5-flash-lite.html.
 *
 * Pure builder and parser; the per-API adapter in `modal/index.ts` calls them and sets the reasoning configuration.
 *
 * @module scripts/h2eval/modal/adapters/google_generate_content
 */
import type { ParsedResponse, RequestEnvelope, Modality } from '../types.js';
import { NA, UNKNOWN, completeness, emptyUsage, intAt, sanitizeNumbers, sub, terms, toCount } from '../canonical.js';
import { stopReasonOf } from './anthropic_messages.js';
import type { Count } from '../types.js';

/** Matrix model id of the Gemini adapter. */
export const GOOGLE_MODEL = 'gemini-3.5-flash-lite';
/** Request path for {@link GOOGLE_MODEL}. */
export const GOOGLE_GENERATE_CONTENT_PATH = `/v1beta/models/${GOOGLE_MODEL}:generateContent`;
/** E3G (C160 BRACO-GO): arm model (DR-187 id, DR-168 prices, DR-194 tier). Same API and parser; only the path carries the model id. */
export const GOOGLE_ARM_MODEL = 'gemini-3.1-flash-lite';
/** Gemini model ids this adapter accepts. */
export type GoogleModel = typeof GOOGLE_MODEL | typeof GOOGLE_ARM_MODEL;
/**
 * Request path of generateContent for a model.
 *
 * @param model - Gemini model id.
 * @returns `/v1beta/models/<model>:generateContent`.
 */
export const googlePathFor = (model: GoogleModel): string => `/v1beta/models/${model}:generateContent`;

/** One message part: text, image or audio (base64 bytes with MIME type). */
export type GoogleUserPart = { kind: 'text'; text: string } | { kind: 'image'; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string } | { kind: 'audio'; mimeType: 'audio/wav' | 'audio/mp3' | 'audio/flac' | 'audio/ogg'; base64: string };

/**
 * Builds the generateContent request body.
 *
 * @param args - Model, optional system text, contents and output ceiling in tokens.
 * @returns The request envelope (path only, no host or credential) with the price-relevant parameters.
 */
export function buildGoogleGenerateContentRequest(args: { model: GoogleModel; system?: string; contents: Array<{ role: 'user' | 'model'; parts: GoogleUserPart[] }>; maxOutputTokens: number }): RequestEnvelope {
  const modalities = new Set<Modality>(['text']);
  const contents = args.contents.map((c) => ({
    role: c.role,
    parts: c.parts.map((p) => {
      if (p.kind === 'text') return { text: p.text };
      modalities.add(p.kind);
      return { inlineData: { mimeType: p.mimeType, data: p.base64 } };
    }),
  }));
  const body: Record<string, unknown> = {
    contents,
    // candidateCount is NOT sent (R14-FIX): "Optional. Number of generated responses to return. If unset, this will default to 1."
    // (google/generate-content.html); BRG-01 reports it unsupported on Gemini 3+ and no archived page documents it for gemini-3.5-flash-lite.
    // thinkingLevel uses the exact API enum: "MINIMAL: Little to no thinking." (google/generate-content.html).
    generationConfig: { maxOutputTokens: args.maxOutputTokens, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
  };
  if (args.system !== undefined) body['systemInstruction'] = { parts: [{ text: args.system }] };
  return {
    provider: 'google', api: 'gemini.generate_content', model: args.model, method: 'POST', path: googlePathFor(args.model),
    body,
    params: { maxOutputTokens: args.maxOutputTokens, temperature: 'DEFAULT', reasoning: 'thinkingConfig.thinkingLevel=MINIMAL (default "On (minimal)"; no OFF for this model: R08 §8); thoughtsTokenCount billed as output', serviceTier: 'standard (no tier parameter; response serviceTier checked)', stream: false, cacheDirectives: 'none (implicit caching cannot be disabled; control = unique prefix per operation; explicit cachedContents not used)' },
    requestModalities: [...modalities],
  };
}

function modalityTokens(details: unknown, modality: 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO'): Count {
  if (!Array.isArray(details)) return UNKNOWN;
  const hit = (details as Array<Record<string, unknown>>).filter((d) => d['modality'] === modality);
  if (hit.length === 0) return UNKNOWN;
  let s = 0n;
  for (const h of hit) { const c = toCount(h['tokenCount']); if (typeof c !== 'bigint') return UNKNOWN; s += c; }
  return s;
}

/**
 * Parses a generateContent response into disjoint usage categories, outcome and stop reason.
 *
 * @param httpStatus - HTTP status of the response.
 * @param body - Parsed response body.
 * @param ctx - Modalities the request carried (decides whether image/audio fields are not applicable).
 * @returns The parsed response; missing counts stay `'UNKNOWN'`, never 0.
 */
export function parseGoogleGenerateContentResponse(httpStatus: number, body: unknown, ctx: { requestModalities: Modality[] }): ParsedResponse {
  const flags: string[] = [];
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const err = b['error'] as Record<string, unknown> | undefined;
  const errorCode = err ? String(err['status'] ?? err['code'] ?? 'error') : null;
  const um = b['usageMetadata'];
  const modelServed = typeof b['modelVersion'] === 'string' ? (b['modelVersion'] as string) : 'UNKNOWN';
  const umo = (um && typeof um === 'object' ? um : {}) as Record<string, unknown>;
  const tier = typeof umo['serviceTier'] === 'string' ? (umo['serviceTier'] as string) : null;
  const pricingTerms = terms(tier, null, null, ['standard', 'unspecified', '']);

  if (!um || typeof um !== 'object') {
    return { api: 'gemini.generate_content', outcome: 'ERROR_NO_USAGE', httpStatus, modelServed, usage: emptyUsage([`no usageMetadata (http ${httpStatus})`]), pricingTerms, flags: ['no_usage'], errorCode, stopReason: 'UNKNOWN', truncated: 'UNKNOWN' };
  }
  const u = emptyUsage();
  u.usageSource = 'provider_response';
  u.rawUsageSanitized = sanitizeNumbers(um);
  const prompt = intAt(um, 'promptTokenCount');
  const cand = intAt(um, 'candidatesTokenCount');
  const cached = intAt(um, 'cachedContentTokenCount');
  const thoughts = intAt(um, 'thoughtsTokenCount');
  const tool = intAt(um, 'toolUsePromptTokenCount');
  const total = intAt(um, 'totalTokenCount');
  // thoughtsTokenCount is omitted by the API when there were no thoughts (proto3 JSON). Absence is NOT read as 0; but the
  // documented identity "totalTokenCount = prompt + tool-use prompt + thoughts + response candidates" lets the remainder be
  // DERIVED from explicit fields: remainder 0 => thoughts (and tool-use prompt) are exactly 0.
  let thoughtsEff: Count = thoughts;
  let toolEff: Count = tool;
  if (thoughts === UNKNOWN && typeof total === 'bigint' && typeof prompt === 'bigint' && typeof cand === 'bigint') {
    const rem = total - prompt - cand - (typeof tool === 'bigint' ? tool : 0n);
    if (rem === 0n) { thoughtsEff = 0n; if (tool === UNKNOWN) toolEff = 0n; u.notes.push('thoughtsTokenCount absent: derived 0 from totalTokenCount = prompt + candidates (documented identity)'); }
    else u.notes.push(`thoughtsTokenCount absent and totalTokenCount leaves a remainder of ${rem}: reasoning UNKNOWN`);
  }
  u.providerTotals = { inputTotal: prompt, outputTotal: typeof cand === 'bigint' && typeof thoughtsEff === 'bigint' ? cand + thoughtsEff : UNKNOWN };
  u.cacheRead = cached; // subset of promptTokenCount; the API omits the field when there is no cached content (proto3 JSON), which is NOT read as 0 here
  u.inputUncached = sub(prompt, cached);
  if (cached === UNKNOWN) u.notes.push('cachedContentTokenCount absent: cache split UNKNOWN (field omission not read as 0); cost can only be bounded');
  u.cacheWrite5m = NA; u.cacheWrite1h = NA; u.cacheWrite = NA; // implicit cache has no write charge; explicit cache storage is per hour (not per call) and is not used
  u.reasoning = thoughtsEff; // separate addend billed as output
  u.outputVisible = cand;
  u.toolTokens = toolEff === UNKNOWN ? NA : toolEff;
  if (Array.isArray(umo['promptTokensDetails'])) { // contract rev. 2 item 8: by-modality detail as reported
    const d: Record<string, number> = {};
    for (const x of umo['promptTokensDetails'] as Array<Record<string, unknown>>) { const c = toCount(x['tokenCount']); if (typeof x['modality'] === 'string' && typeof c === 'bigint') d[x['modality']] = (d[x['modality']] ?? 0) + Number(c); }
    u.promptTokensDetailsByModality = d;
  }
  const img = modalityTokens(umo['promptTokensDetails'], 'IMAGE');
  const aud = modalityTokens(umo['promptTokensDetails'], 'AUDIO');
  u.imageUnits = ctx.requestModalities.includes('image') ? img : NA;
  u.audioUnits = ctx.requestModalities.includes('audio') ? aud : NA;
  if (!ctx.requestModalities.includes('image') && typeof img === 'bigint' && img > 0n) { u.imageUnits = img; flags.push('unexpected_image_input_tokens'); }
  if (!ctx.requestModalities.includes('audio') && typeof aud === 'bigint' && aud > 0n) { u.audioUnits = aud; flags.push('unexpected_audio_input_tokens'); }
  if (Array.isArray(umo['candidatesTokensDetails']) && (umo['candidatesTokensDetails'] as Array<Record<string, unknown>>).some((d) => d['modality'] !== 'TEXT')) flags.push('non_text_output_modality');

  let outcome: ParsedResponse['outcome'] = 'OK';
  const pf = b['promptFeedback'] as Record<string, unknown> | undefined;
  const cands = Array.isArray(b['candidates']) ? (b['candidates'] as Array<Record<string, unknown>>) : [];
  const c0 = cands[0] ?? {};
  if (httpStatus !== 200 || err) { outcome = 'ERROR_WITH_USAGE'; flags.push('http_error_with_usage'); }
  else {
    if (pf && pf['blockReason']) { flags.push(`block_reason_${String(pf['blockReason'])}`); outcome = 'REFUSED_WITH_USAGE'; }
    const fr = c0['finishReason'];
    if (fr === 'SAFETY' || fr === 'RECITATION' || fr === 'BLOCKLIST' || fr === 'PROHIBITED_CONTENT' || fr === 'SPII') { flags.push(`finish_reason_${String(fr)}`); outcome = 'REFUSED_WITH_USAGE'; }
    if (fr === 'MAX_TOKENS') flags.push('finish_reason_max_tokens');
    const parts = Array.isArray((c0['content'] as Record<string, unknown> | undefined)?.['parts']) ? ((c0['content'] as Record<string, unknown>)['parts'] as Array<Record<string, unknown>>) : [];
    if (parts.some((p) => p['functionCall'] || p['executableCode'] || p['codeExecutionResult'])) { flags.push('tool_or_code_part'); outcome = 'INCOMPLETE_UNEXPECTED_CONTENT'; }
    if (parts.some((p) => p['inlineData'] || p['fileData'])) { flags.push('media_output_part'); outcome = 'INCOMPLETE_UNEXPECTED_CONTENT'; }
    if (parts.some((p) => p['thought'] === true)) flags.push('thought_part');
    if (cands.length === 0 && !(pf && pf['blockReason'])) { flags.push('no_candidates'); outcome = 'INCOMPLETE_UNEXPECTED_CONTENT'; }
  }
  u.usageCompleteness = completeness(u);
  const stopReason = stopReasonOf(c0['finishReason']);
  return { api: 'gemini.generate_content', outcome, httpStatus, modelServed, usage: u, pricingTerms, flags, errorCode, stopReason, truncated: stopReason === 'UNKNOWN' ? 'UNKNOWN' : stopReason === 'MAX_TOKENS' };
}
