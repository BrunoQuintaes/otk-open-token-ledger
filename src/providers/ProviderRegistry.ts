/**
 * ProviderRegistry — Pluggable adapter registry for multi-provider metering (U11.1)
 *
 * Resolves provider-specific response parsers by provider ID.
 * Each registered adapter converts raw API responses into NormalizedUsageEvent.
 *
 * Design: registry pattern — decouples provider-specific parsing from calling code.
 * Adapters for OpenAI and Anthropic wrap existing U7.5 parse functions.
 * Gemini and DeepSeek adapters are stubs (real API response format: U12).
 *
 * Usage:
 *   const registry = ProviderRegistry.createDefault();
 *   const event = registry.resolve('openai').parseResponse(rawResponse, latencyMs, ts);
 */

import {
  IProviderAdapter,
  NormalizedUsageEvent,
  RegistryError,
  REGISTRY_ERROR,
} from './types.js';
import {
  parseOpenAIResponse,
  type OpenAIChatCompletionResponse,
} from './adapters/OpenAIAdapter.js';
import {
  parseAnthropicResponse,
  type AnthropicMessageResponse,
} from './adapters/AnthropicAdapter.js';
import { GeminiAdapterStub } from './adapters/GeminiAdapterStub.js';
import { DeepseekAdapterStub } from './adapters/DeepseekAdapterStub.js';
import { GeminiAdapter } from './adapters/GeminiAdapter.js';
import { DeepSeekAdapter } from './adapters/DeepSeekAdapter.js';
import { CohereAdapter } from './adapters/CohereAdapter.js';
import { MistralAdapter } from './adapters/MistralAdapter.js';
import { MetaLlamaAdapter } from './adapters/MetaLlamaAdapter.js';

// ---------------------------------------------------------------------------
// Wrapper adapters for existing OpenAI + Anthropic parse functions (U7.5)
// ---------------------------------------------------------------------------

/**
 * OpenAI adapter wrapping the U7.5 parseOpenAIResponse function.
 * Note: OpenAI responses include a 'created' timestamp — the timestamp param is ignored.
 */
class OpenAIProviderAdapter implements IProviderAdapter {
  readonly providerId = 'openai';

  parseResponse(raw: unknown, latencyMs: number, _timestamp: number): NormalizedUsageEvent {
    return parseOpenAIResponse(raw as OpenAIChatCompletionResponse, latencyMs);
  }
}

/**
 * Anthropic adapter wrapping the U7.5 parseAnthropicResponse function.
 * Anthropic responses don't embed a timestamp — the caller must supply it.
 */
class AnthropicProviderAdapter implements IProviderAdapter {
  readonly providerId = 'anthropic';

  parseResponse(raw: unknown, latencyMs: number, timestamp: number): NormalizedUsageEvent {
    return parseAnthropicResponse(raw as AnthropicMessageResponse, latencyMs, timestamp);
  }
}

// ---------------------------------------------------------------------------
// ProviderRegistry — pluggable adapter registry
// ---------------------------------------------------------------------------

export class ProviderRegistry {
  private readonly adapters = new Map<string, IProviderAdapter>();

  /**
   * Register an adapter. Provider IDs are normalized to lowercase.
   * @throws RegistryError (DUPLICATE_PROVIDER) if provider already registered
   */
  register(adapter: IProviderAdapter): void {
    const id = adapter.providerId.toLowerCase();
    if (this.adapters.has(id)) {
      throw new RegistryError(
        REGISTRY_ERROR.DUPLICATE_PROVIDER,
        `Provider already registered: ${id}`
      );
    }
    this.adapters.set(id, adapter);
  }

  /**
   * Resolve an adapter by provider ID (case-insensitive).
   * @throws RegistryError (PROVIDER_NOT_FOUND) if no adapter registered for the given provider
   */
  resolve(providerId: string): IProviderAdapter {
    const adapter = this.adapters.get(providerId.toLowerCase());
    if (!adapter) {
      const registered = this.listProviders().join(', ');
      throw new RegistryError(
        REGISTRY_ERROR.PROVIDER_NOT_FOUND,
        `No adapter registered for provider: '${providerId}'. Registered: [${registered}]`
      );
    }
    return adapter;
  }

  /** Check if a provider ID is registered (case-insensitive) */
  isRegistered(providerId: string): boolean {
    return this.adapters.has(providerId.toLowerCase());
  }

  /** List all registered provider IDs (sorted alphabetically) */
  listProviders(): string[] {
    return Array.from(this.adapters.keys()).sort();
  }

  /**
   * Factory: create a registry pre-loaded with all built-in adapters.
   *
   * Adapter selection:
   *   - openai, anthropic: always use full U7.5 parsers
   *   - gemini:   GeminiAdapter (real) when GEMINI_API_KEY set, else GeminiAdapterStub
   *   - deepseek: DeepSeekAdapter (real) when DEEPSEEK_API_KEY set, else DeepseekAdapterStub
   *   - cohere:   CohereAdapter (always registered — ADAPT-01)
   *   - mistral:  MistralAdapter (always registered — ADAPT-02)
   *   - meta:     MetaLlamaAdapter (always registered — ADAPT-03)
   *
   * Real adapters parse native API response shapes.
   * Stubs accept GenericUsageInput for offline/test use (U11.1 contract unchanged).
   */
  static createDefault(): ProviderRegistry {
    const registry = new ProviderRegistry();
    registry.register(new OpenAIProviderAdapter());
    registry.register(new AnthropicProviderAdapter());

    if (process.env.GEMINI_API_KEY) {
      registry.register(new GeminiAdapter());
    } else {
      registry.register(new GeminiAdapterStub());
    }

    if (process.env.DEEPSEEK_API_KEY) {
      registry.register(new DeepSeekAdapter());
    } else {
      registry.register(new DeepseekAdapterStub());
    }

    // W8-D ADAPT-01/02/03: Cohere, Mistral, Meta Llama adapters
    registry.register(new CohereAdapter());
    registry.register(new MistralAdapter());
    registry.register(new MetaLlamaAdapter());

    return registry;
  }
}

// Re-export types for consumers that import from this module
export type { IProviderAdapter } from './types.js';
export { RegistryError, REGISTRY_ERROR } from './types.js';
