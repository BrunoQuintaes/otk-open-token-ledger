/**
 * PROXY-01 — UsageExtractor
 * Extracts token usage from LLM provider response bodies.
 * Supports: OpenAI, Anthropic, Gemini, Cohere, Mistral
 */

export interface ExtractedUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestId?: string;
  /** Anthropic prompt-cache categories, billed apart from input_tokens (N8). */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

function toInt(v: unknown): number {
  return typeof v === 'number' ? Math.floor(v) : 0;
}

function extractOpenAI(
  provider: string,
  model: string,
  body: Record<string, unknown>,
): ExtractedUsage {
  const usage = (body['usage'] ?? {}) as Record<string, unknown>;
  return {
    provider,
    model: typeof body['model'] === 'string' ? body['model'] : model,
    inputTokens: toInt(usage['prompt_tokens']),
    outputTokens: toInt(usage['completion_tokens']),
    requestId: typeof body['id'] === 'string' ? body['id'] : undefined,
  };
}

function extractAnthropic(
  model: string,
  body: Record<string, unknown>,
): ExtractedUsage {
  const usage = (body['usage'] ?? {}) as Record<string, unknown>;
  const out: ExtractedUsage = {
    provider: 'anthropic',
    model: typeof body['model'] === 'string' ? body['model'] : model,
    inputTokens: toInt(usage['input_tokens']),
    outputTokens: toInt(usage['output_tokens']),
    requestId: typeof body['id'] === 'string' ? body['id'] : undefined,
  };
  // N8: cache categories only when reported (absent is not zero)
  if (typeof usage['cache_creation_input_tokens'] === 'number') out.cacheCreationInputTokens = toInt(usage['cache_creation_input_tokens']);
  if (typeof usage['cache_read_input_tokens'] === 'number') out.cacheReadInputTokens = toInt(usage['cache_read_input_tokens']);
  return out;
}

function extractGemini(
  model: string,
  body: Record<string, unknown>,
): ExtractedUsage {
  const meta = (body['usageMetadata'] ?? {}) as Record<string, unknown>;
  return {
    provider: 'gemini',
    model,
    inputTokens: toInt(meta['promptTokenCount']),
    outputTokens: toInt(meta['candidatesTokenCount']),
  };
}

function extractCohere(
  model: string,
  body: Record<string, unknown>,
): ExtractedUsage {
  const metaTokens = (
    ((body['meta'] ?? {}) as Record<string, unknown>)['tokens'] ?? {}
  ) as Record<string, unknown>;
  return {
    provider: 'cohere',
    model,
    inputTokens: toInt(metaTokens['input_tokens']),
    outputTokens: toInt(metaTokens['output_tokens']),
  };
}

/**
 * Extracts token usage from a parsed LLM provider response body.
 *
 * @param provider - Provider identifier: 'openai' | 'anthropic' | 'gemini' | 'cohere' | 'mistral'
 * @param model    - Model name as sent in the request (fallback if not present in response)
 * @param responseBody - Parsed JSON response body from the upstream provider
 */
export function extractUsage(
  provider: string,
  model: string,
  responseBody: Record<string, unknown>,
): ExtractedUsage {
  switch (provider.toLowerCase()) {
    case 'anthropic':
      return extractAnthropic(model, responseBody);
    case 'gemini':
      return extractGemini(model, responseBody);
    case 'cohere':
      return extractCohere(model, responseBody);
    case 'openai':
    case 'mistral':
    default:
      return extractOpenAI(provider.toLowerCase(), model, responseBody);
  }
}
