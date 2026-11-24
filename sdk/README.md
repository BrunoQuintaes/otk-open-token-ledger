# @otk/metering-sdk

TypeScript SDK for the OTK zk-Metering API.

## Installation

```bash
npm install @otk/metering-sdk
```

## Quick Start

```typescript
import { OTKMeteringClient } from '@otk/metering-sdk';

const client = new OTKMeteringClient({
  baseUrl: 'http://localhost:8787',
  apiKey: 'tok_your_api_key', // optional — only when auth is enabled
});

// Check API health
const health = await client.health();
console.log(health.ok); // true

// Submit a receipt
const result = await client.submitReceipt({
  provider: 'openai',
  model: 'gpt-4',
  inputTokens: 500,
  outputTokens: 200,
  costUnits: 1400,
  latencyMs: 320,
  timestamp: Math.floor(Date.now() / 1000),
  requestId: 'req-abc-123',
  userId: '12345',
  nonce: '1',
  signature: '0x...',
  epochId: '100',
});
console.log(result.stored); // true

// Get a receipt
const receipt = await client.getReceipt('req-abc-123');
console.log(receipt.provider); // 'openai'

// Get balance
const balance = await client.getBalance('acme', '100');
console.log(balance.totalCU); // '1400'

// Get invoice
const invoice = await client.getInvoice('acme', '100');
console.log(invoice.invoice.lineItems.length); // GET /invoices answers { ok, invoice }
```

## Configuration

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `baseUrl` | `string` | yes | — | Base URL of the OTK zk-Metering API |
| `apiKey` | `string` | no | — | Bearer token for authenticated requests |
| `timeout` | `number` | no | `30000` | Request timeout in milliseconds |

## Methods

| Method | Description |
|--------|-------------|
| `health()` | Check API health |
| `submitReceipt(receipt)` | Submit a metering receipt |
| `getReceipt(requestId)` | Retrieve a receipt by request ID |
| `getBalance(tenantId, epochId)` | Get CU balance for a tenant/epoch |
| `getInvoice(tenantId, epochId)` | Generate an invoice for a tenant/epoch |

## Error Handling

All methods throw `OTKApiError` on non-2xx responses:

```typescript
import { OTKApiError } from '@otk/metering-sdk';

try {
  await client.getReceipt('nonexistent');
} catch (err) {
  if (err instanceof OTKApiError) {
    console.error(err.status); // 404
    console.error(err.body);   // { error: 'not_found' }
  }
}
```

## License

MIT
