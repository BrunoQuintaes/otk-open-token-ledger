/**
 * Official documentation followed by each usage adapter (D5 §1). Retrieval dates are the dates
 * the pages were read for this implementation; the rule summary and quotes are recorded in
 * docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/B/USAGE_MATRIX.md.
 * A synthetic fixture following these pages does not prove a live integration (D5-G02).
 */
import type { IsoTime, UsageApi } from '../../types/d1d8/index.js';

export interface UsageDocRef {
  url: string;
  retrievedAt: IsoTime;
}

// Pages fetched 2026-09-30 20:58–21:01 local time (UTC−3).
const RETRIEVED: IsoTime = '2026-09-30T23:58:00.000Z';

// platform.openai.com answered HTTP 403 to the fetcher; OpenAI's official OpenAPI spec
// (schemas CompletionUsage, ResponseUsage) and developers.openai.com guides were used instead.
export const USAGE_DOC_REFS: Readonly<Record<UsageApi, UsageDocRef>> = Object.freeze({
  'openai.chat_completions': { url: 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml#/components/schemas/CompletionUsage', retrievedAt: RETRIEVED },
  'openai.responses': { url: 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml#/components/schemas/ResponseUsage', retrievedAt: RETRIEVED },
  'anthropic.messages': { url: 'https://platform.claude.com/docs/en/api/messages.md', retrievedAt: RETRIEVED },
  'gemini.generate_content': { url: 'https://ai.google.dev/api/generate-content#UsageMetadata', retrievedAt: RETRIEVED },
  'deepseek.chat_completions': { url: 'https://api-docs.deepseek.com/api/create-chat-completion', retrievedAt: RETRIEVED },
  'mistral.chat_completions': { url: 'https://raw.githubusercontent.com/mistralai/platform-docs-public/main/openapi.yaml#/components/schemas/UsageInfo', retrievedAt: RETRIEVED },
  'cohere.chat': { url: 'https://raw.githubusercontent.com/cohere-ai/cohere-developer-experience/main/cohere-openapi.yaml#/components/schemas/Usage', retrievedAt: RETRIEVED },
});
