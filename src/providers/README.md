# Provider Adapter Layer (U7)

## Purpose
Provide a **provider-agnostic interface** for AI provider integration, enabling:
- Multi-provider support (OpenAI, Claude, Gemini, DeepSeek, etc.)
- Automatic fallback on provider failures
- Unified metering and cost tracking
- Policy-based routing (rate limits, caching, etc.)

## Status
⚠️ **Skeleton implementation** (U7.7 gateway layer added)
- Interfaces defined (`IProviderClient`)
- Router architecture in place (`ProviderRouter`)
- Metering hooks ready for integration
- **ProviderGateway + KeyStrategy** in place (U7.7)
- Parser adapters operational: `OpenAIAdapter`, `AnthropicAdapter`
- **No real live-calling provider clients yet**

## Architecture

### Components
1. **IProviderClient** — Common interface for all providers
2. **ProviderRouter** — Orchestrates requests across providers
3. **ProviderGateway** — Single entry point for API key resolution (U7.7)
4. **KeyStrategy** — Pluggable key acquisition (GlobalKeyStrategy, UserVaultStrategy)
5. **MeteringEvent** — Captures usage data (tokens, cost, model)
6. **RouterPolicy** — Configures fallback, rate limits, caching

### Data Flow
```
User Request
    ↓
ProviderRouter.route(providerName, prompt, options)
    ↓
IProviderClient.request(prompt, options)
    ↓
ProviderResponse (includes MeteringEvent)
    ↓
Metering Hook (captures usage for zk proof generation)
```

## Metering Hooks

Metering hooks allow capturing usage events that will feed into ZK proof generation:

```typescript
const router = new ProviderRouter({ fallbackEnabled: true });

// Register hook
router.onMetering((event: MeteringEvent) => {
  console.log("Usage event:", event);
  // TODO: Queue event for batching + zk proof generation
  // TODO: Emit to receipt registry (U8.5)
});

// Make request
const response = await router.route("openai", "Hello, world!");
```

## Receipt Emission (Future U8.5/U9)

Each metering event should generate a **receipt** with fields:
- `timestamp`: Unix timestamp
- `provider`: Provider identifier
- `model`: Model used (e.g., "gpt-4", "claude-3-opus")
- `inputTokens`: Number of input tokens
- `outputTokens`: Number of output tokens
- `costUnits`: Normalized cost metric
- `requestId`: Unique request identifier
- `signature`: ZK proof or cryptographic signature

Receipts will be:
1. Batched locally
2. Fed into ZK circuit to generate proof
3. Submitted to on-chain Receipt Registry (U8.5)
4. Verified and logged for billing/audit

## Next Steps (U8.5+)

### U8.5 — Receipt Registry Integration
- Define receipt schema (compatible with ZK circuit)
- Implement on-chain receipt submission
- Add anti-replay protection (nonce/timestamp)

### U9 — Real Provider Implementations
- `OpenAIClient implements IProviderClient`
- `ClaudeClient implements IProviderClient`
- `GeminiClient implements IProviderClient`
- Test fallback scenarios

### U11 — Production Hardening
- Rate limiting enforcement
- Caching layer (Redis or in-memory)
- API key rotation and secret management
- Circuit breaker pattern for provider outages

## Example Usage (Future — U7.7 ProviderGateway pattern)

```typescript
import { ProviderRouter } from "./ProviderRouter.js";
import { ProviderGateway } from "./gateway/ProviderGateway.js";
import { GlobalKeyStrategy } from "./strategies/GlobalKeyStrategy.js";
import { OpenAIClient } from "./clients/OpenAIClient.js";
import { ClaudeClient } from "./clients/ClaudeClient.js";

// ProviderGateway is the ONLY place keys are resolved — never use process.env directly
const gateway = new ProviderGateway(new GlobalKeyStrategy());

const router = new ProviderRouter({
  fallbackEnabled: true,
  fallbackOrder: ["openai", "claude"],
  rateLimitPerProvider: { openai: 60, claude: 60 },
});

const openai = new OpenAIClient();
await openai.initialize({ apiKey: await gateway.resolveKey("openai") });
router.registerProvider(openai);

const claude = new ClaudeClient();
await claude.initialize({ apiKey: await gateway.resolveKey("anthropic") });
router.registerProvider(claude);

// Capture metering events
router.onMetering((event) => {
  // Submit to receipt queue for zk proof batching
});

// Make request (with automatic fallback if openai fails)
const response = await router.route("openai", "Explain quantum computing");
```

## Files

- `types.ts` — Type definitions
- `IProviderClient.ts` — Provider interface
- `ProviderRouter.ts` — Multi-provider orchestration
- `clients/` — (Future) Real provider implementations
- `README.md` — This file
