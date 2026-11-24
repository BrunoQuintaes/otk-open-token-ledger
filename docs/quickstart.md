# OTK zk-Metering -- 5-Minute Quickstart

Get from zero to a working receipt submission in 5 minutes.

---

## 1. Prerequisites

- **Node.js 20+** (check: `node --version`)
- **git** (check: `git --version`)

---

## 2. Clone & Install

```bash
git clone https://github.com/BrunoQuintaes/otk-zk-metering.git
cd otk-zk-metering
npm ci
```

---

## 3. Run Tests

Verify everything works before you start:

```bash
npm test
```

Expect **2329+ tests** passing. If any fail, check Node.js version (must be 20+).

---

## 4. Start the API Server

```bash
PROVER_URL=disabled API_PORT=8787 npx tsx src/api/server.ts
```

- `PROVER_URL=disabled` skips ZK proof generation for quick local testing.
- `API_PORT=8787` sets the port (default is 8787).

You should see:

```
[api] listening on http://127.0.0.1:8787
```

---

## 5. Submit Your First Receipt

Open a new terminal and submit a metering receipt:

```bash
curl -s -X POST http://localhost:8787/receipts \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-quickstart-001",
    "provider": "openai",
    "model": "gpt-4o",
    "inputTokens": 500,
    "outputTokens": 200,
    "costUnits": 700,
    "latencyMs": 320,
    "timestamp": 1710000000,
    "userId": "12345",
    "nonce": "1"
  }'
```

Expected response (HTTP 201):

```json
{
  "ok": true,
  "requestId": "req-quickstart-001",
  "costUnits": 700,
  "duplicate": false
}
```

Submitting the same `requestId` again returns HTTP 200 with `"duplicate": true` (idempotent).

---

## 6. Check Receipt Status

```bash
curl -s http://localhost:8787/receipts/req-quickstart-001
```

Expected response:

```json
{
  "ok": true,
  "receipt": {
    "provider": "openai",
    "model": "gpt-4o",
    "inputTokens": 500,
    "outputTokens": 200,
    "costUnits": 700,
    "latencyMs": 320,
    "timestamp": 1710000000,
    "requestId": "req-quickstart-001",
    "userId": "12345",
    "nonce": "1"
  },
  "proofStatus": "disabled"
}
```

`proofStatus` is `"disabled"` because we set `PROVER_URL=disabled`.

---

## 7. Check Accounting Balance

```bash
curl -s "http://localhost:8787/accounting/balance?tenantId=default&epochId=475000"
```

Expected response:

```json
{
  "ok": true,
  "tenantId": "default",
  "epochId": "475000",
  "totalCU": "700",
  "entryCount": 1
}
```

The `epochId` is derived from `floor(timestamp / 3600)`. For timestamp `1710000000`, the epoch is `475000`.

---

## 8. Check System Health

```bash
curl -s http://localhost:8787/health
```

Expected response:

```json
{
  "ok": true,
  "uptime": "42.3",
  "ts": "2026-03-15T12:00:00.000Z"
}
```

Other useful endpoints:

```bash
# Observability metrics (provider stats, health)
curl -s http://localhost:8787/metrics

# Latest dispatched events
curl -s "http://localhost:8787/events/latest?n=5"

# Rate limit status
curl -s http://localhost:8787/ratelimit/status

# Echo/ping test
curl -s -X POST http://localhost:8787/ping -d "hello"
```

---

## 9. Next Steps

- **API Reference**: visit [http://localhost:8787/api-docs](http://localhost:8787/api-docs) for interactive Redoc documentation
- **OpenAPI Spec**: download at [http://localhost:8787/openapi.json](http://localhost:8787/openapi.json) for use with Postman, Insomnia, or code generators
- **TypeScript SDK**: see `sdk/src/index.ts` for a typed client
- **Python SDK**: see `sdk/python/otk_metering/` for a stdlib-only Python client
- **Dashboard**: visit [http://localhost:8787/app](http://localhost:8787/app) for the built-in dashboard

---

## 10. Multi-Tenant Mode

By default, auth is disabled and all requests use `tenantId=default`.

To enable multi-tenant authentication, set the `OTK_TENANTS` environment variable:

```bash
OTK_TENANTS="acme:secret-token-1,beta/VIEWER:secret-token-2" \
  PROVER_URL=disabled \
  API_PORT=8787 \
  npx tsx src/api/server.ts
```

Then use Bearer tokens in your requests:

```bash
curl -s -X POST http://localhost:8787/receipts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer secret-token-1" \
  -d '{
    "requestId": "req-tenant-001",
    "provider": "anthropic",
    "model": "claude-3-haiku",
    "inputTokens": 1000,
    "outputTokens": 500,
    "costUnits": 1500,
    "latencyMs": 200,
    "timestamp": 1710000000,
    "userId": "99",
    "nonce": "1"
  }'
```

Token format: `tenantId:token` or `tenantId/ROLE:token` (roles: OWNER, ADMIN, OPERATOR, MEMBER, VIEWER).

See [docs/api/AUTH_MODES.md](api/AUTH_MODES.md) for full authentication documentation.
