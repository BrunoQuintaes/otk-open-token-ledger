/** Adapter registry by matrix model. The runner picks the adapter from the model id alone. */
import type { Api, MatrixModel, Modality, ParsedResponse, Provider } from '../types.js';
import { parseOpenAiChatResponse, OPENAI_CHAT_PATH } from './openai_chat.js';
import { parseAnthropicMessagesResponse, ANTHROPIC_MESSAGES_PATH } from './anthropic_messages.js';
import { parseGoogleGenerateContentResponse, GOOGLE_GENERATE_CONTENT_PATH, googlePathFor } from './google_generate_content.js';

export interface AdapterInfo { provider: Provider; api: Api; path: string; modalitiesAccepted: Modality[]; parse: (httpStatus: number, body: unknown, ctx: { requestModalities: Modality[] }) => ParsedResponse }

export const ADAPTERS: Readonly<Record<MatrixModel, AdapterInfo>> = Object.freeze({
  'gpt-4o-mini-2024-07-18': { provider: 'openai', api: 'openai.chat_completions', path: OPENAI_CHAT_PATH, modalitiesAccepted: ['text', 'image'], parse: parseOpenAiChatResponse },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', api: 'anthropic.messages', path: ANTHROPIC_MESSAGES_PATH, modalitiesAccepted: ['text', 'image'], parse: parseAnthropicMessagesResponse },
  'claude-haiku-5-5': { provider: 'anthropic', api: 'anthropic.messages', path: ANTHROPIC_MESSAGES_PATH, modalitiesAccepted: ['text', 'image'], parse: parseAnthropicMessagesResponse },
  'claude-sonnet-5-5': { provider: 'anthropic', api: 'anthropic.messages', path: ANTHROPIC_MESSAGES_PATH, modalitiesAccepted: ['text', 'image'], parse: parseAnthropicMessagesResponse },
  'claude-opus-5-5': { provider: 'anthropic', api: 'anthropic.messages', path: ANTHROPIC_MESSAGES_PATH, modalitiesAccepted: ['text', 'image'], parse: parseAnthropicMessagesResponse },
  'gemini-3.5-flash-lite': { provider: 'google', api: 'gemini.generate_content', path: GOOGLE_GENERATE_CONTENT_PATH, modalitiesAccepted: ['text', 'image', 'audio'], parse: parseGoogleGenerateContentResponse },
  // E3G (C160 BRACO-GO): calibration arm, text only (the attested prices are text prices)
  'gemini-3.1-flash-lite': { provider: 'google', api: 'gemini.generate_content', path: googlePathFor('gemini-3.1-flash-lite'), modalitiesAccepted: ['text'], parse: parseGoogleGenerateContentResponse },
  'gpt-6-luna': { provider: 'openai', api: 'openai.chat_completions', path: OPENAI_CHAT_PATH, modalitiesAccepted: ['text'], parse: parseOpenAiChatResponse },
});

/** NOT_SUPPORTED (contract §1) when the model does not accept the modality (R08 §5-6). */
export function modalitySupport(model: MatrixModel, modality: Modality): 'SUPPORTED' | 'NOT_SUPPORTED' {
  return ADAPTERS[model].modalitiesAccepted.includes(modality) ? 'SUPPORTED' : 'NOT_SUPPORTED';
}

export { buildOpenAiChatRequest, parseOpenAiChatResponse } from './openai_chat.js';
export { buildAnthropicMessagesRequest, parseAnthropicMessagesResponse } from './anthropic_messages.js';
export { buildGoogleGenerateContentRequest, parseGoogleGenerateContentResponse } from './google_generate_content.js';
