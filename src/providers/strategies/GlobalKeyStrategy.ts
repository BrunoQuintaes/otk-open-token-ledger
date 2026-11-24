/**
 * GlobalKeyStrategy — System-wide API key resolution from environment (U7.7.2)
 *
 * Reads provider keys from environment variables.
 * This is the only place in the codebase that may access process.env for API keys.
 *
 * SECURITY: Never log, print, or expose the resolved key.
 */

import { KeyStrategy } from "./KeyStrategy.js";

const PROVIDER_ENV_MAP: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  // VAULT-08: extended provider map
  gemini: "GEMINI_API_KEY",
  cohere: "COHERE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  meta: "META_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/**
 * Secondary env-var aliases tried when the primary env var is unset.
 * For example, Gemini accepts both GEMINI_API_KEY and GOOGLE_API_KEY.
 */
const PROVIDER_ENV_ALIAS: Record<string, string> = {
  gemini: "GOOGLE_API_KEY",
};

export class GlobalKeyStrategy implements KeyStrategy {
  async resolve(provider: string): Promise<string> {
    const normalizedProvider = provider.toLowerCase();
    const envVar = PROVIDER_ENV_MAP[normalizedProvider];
    if (!envVar) {
      throw new Error(`Unsupported provider for GlobalKeyStrategy: ${provider}`);
    }

    // Primary env var
    const key = process.env[envVar];
    if (key) return key;

    // Try alias if one exists (e.g., GOOGLE_API_KEY as fallback for gemini)
    const aliasVar = PROVIDER_ENV_ALIAS[normalizedProvider];
    if (aliasVar) {
      const aliasKey = process.env[aliasVar];
      if (aliasKey) return aliasKey;
    }

    const tried = aliasVar ? `${envVar} or ${aliasVar}` : envVar;
    throw new Error(
      `API key for provider '${provider}' not found in environment (expected: ${tried})`
    );
  }
}
