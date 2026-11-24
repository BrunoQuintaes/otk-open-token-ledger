# GA Readiness Checklist — OTK zk-Metering

> **Version:** 1.0.0 | **Date:** 2026-04-07
> **Status:** Infrastructure READY — Business sign-offs PENDING
> **Branch:** `feature/u8-4-1-arch-reconciliation`

GA (General Availability) requires 6 sign-offs. The technical infrastructure for each is in place.
Business decisions (pentest execution, DR drill execution, SLO window, first customer) are human gates.

---

## Readiness Matrix

| # | Requirement | Owner | Status | Notes |
|---|-------------|-------|--------|-------|
| 1 | External pentest | Security team | `PENDING` | Scope defined below — awaiting engagement |
| 2 | Disaster recovery drill | Infra/Ops | `DONE` | Full staging drill 2026-04-15: RTO=7m54s, RPO=0s, pg_restore, smoke test HTTP 201 — EVD: `docs/_ops/ga/DR_DRILL_FULL_20260415T191415Z/` |
| 3 | Load test (p99 < 200 ms) | Engineering | `DONE` | EC2 loopback c=100: p99=193ms ✓, 734 req/s, 0 errors — EVD: `docs/_ops/ga/LOAD_TEST_E1_FINAL_20260415T184033Z/01_result.md` |
| 4 | SLO sign-off (99.9% / 30 days) | SRE | `PENDING` | Status page live at `/status` — 30-day window not yet elapsed |
| 5 | Legal (ToS + Privacy + DPA) | Legal/Product | `INFRA READY` | Routes `/terms`, `/privacy`, `/dpa` wired — content needs legal review |
| 6 | First paying customer | Sales/CEO | `PENDING` | Signed contract + live on production required |

---

## Requirement Details

### GA-1 — External Pentest

**Scope:**
- OWASP Top 10 against all `/v1/` API endpoints
- Auth flows: JWT issuance/blacklist, API key rotation, CSRF tokens, password hash (scrypt)
- Provider Key Vault (BYOK): `src/security/ProviderKeyVault.ts` — key isolation per tenant
- RBAC enforcement: all 12 permissions across 5 roles (`OWNER/ADMIN/OPERATOR/MEMBER/VIEWER`)
- ZK proof submission endpoint: replay attack prevention
- Rate limiting: per-tenant distributed rate limiter (`src/infra/redis/`)
- Input validation: Zod schemas (`src/api/schemas.ts`)
- Security headers: 7 headers (`src/api/securityHeaders.ts`)
- CORS policy: `src/api/cors.ts`

**How to initiate:** Engage an approved external security firm. Provide them with:
- API base URL + test tenant credentials
- `docs/api/openapi.json` (spec)
- `docs/architecture/adr/` (ADRs 0001–0303)

**Definition of Done:** Pentest report issued; all Critical/High findings resolved; report archived in `docs/_ops/ga/`.

---

### GA-2 — Disaster Recovery Drill

**Scope:**
- PostgreSQL: `pg_dump` backup → restore to clean instance → verify row count
- Redis: PING health check → simulate failover → verify reconnect
- API server: restart with `OTK_DB_URL` + `OTK_REDIS_URL` pointing to restored instances

**Infrastructure:**
- Backup script: `scripts/ops/backup.sh`
- DR drill script: `scripts/ops/dr_drill.sh` (checklist + dry-run commands)
- K8s: Helm chart with PVC-backed PG + Redis at `infra/helm/otk/`

**Definition of Done:** Full drill executed in staging environment; RTO < 30 minutes documented; results in `docs/_ops/ga/`.

---

### GA-3 — Load Test

**Target:** 100 concurrent users × 50 AI calls/hour = 5,000 req/hour sustained
**SLO:** p99 proxy latency < 200 ms at this concurrency level

**Script:** `scripts/ops/load_test.js`

```bash
# Run against local dev server
node scripts/ops/load_test.js http://localhost:8080 10 100

# Run against staging (adjust concurrency/iterations for full load)
node scripts/ops/load_test.js https://staging.otk-metering.io 100 500
```

**Metrics tracked:** p50, p95, p99 latency; pass/fail against 200 ms target; error rate.

**Definition of Done:** Load test executed against production-equivalent environment; p99 < 200 ms; results archived in `docs/_ops/ga/`.

---

### GA-4 — SLO Sign-Off

**Target:** 99.9% uptime over a rolling 30-day window

**Infrastructure in place:**
- Status page: `GET /status` — public, no auth required (`src/dashboard/status.ts`)
- Prometheus metrics: `GET /metrics` — uptime counters + request latency histograms
- SLO definitions per plan: FREE (best-effort), STARTER (99.0%), PRO (99.9%)
- Structured logging: `src/infra/logging/StructuredLogger.ts`

**How to verify:**
1. Deploy to production
2. Monitor `GET /status` and `/metrics` for 30 days
3. Calculate uptime = (total_minutes - downtime_minutes) / total_minutes × 100
4. Target: ≥ 99.9% (allows ≤ 43.8 minutes downtime/month)

**Definition of Done:** 30-day window completed; uptime report generated; signed off by SRE lead.

---

### GA-5 — Legal Pages

**Status: INFRA READY** — routes exist and serve content.

| Route | Handler | Status |
|-------|---------|--------|
| `GET /terms` | `renderTermsPage()` in `src/dashboard/legal.ts` | Route wired ✓ |
| `GET /privacy` | `renderPrivacyPage()` in `src/dashboard/legal.ts` | Route wired ✓ |
| `GET /dpa` | `renderDpaPage()` in `src/dashboard/legal.ts` | Route wired ✓ |

**Remaining action:** Replace placeholder content in `src/dashboard/legal.ts` with finalized text reviewed by legal counsel before production go-live.

---

### GA-6 — First Paying Customer

**Definition:**
- Signed contract or accepted ToS + payment method on file
- Live API key issued (via `src/api/apiKeyManager.ts`)
- At least one receipt submitted and persisted in production PostgreSQL
- Billing cycle running (Stripe webhooks active at `src/billing/stripe/`)

**How to verify:** Check `GET /v1/admin/ga-readiness` — `first_paying_customer` will remain `pending` until manually updated post-contract signature.

---

## GA Readiness API

**Endpoint:** `GET /v1/admin/ga-readiness`
**Auth:** `admin:chain-head` permission required
**Module:** `src/api/gaReadinessCheck.ts`

Returns structured JSON with status per requirement. Example response:

```json
{
  "ok": true,
  "gaReady": false,
  "requirements": [
    { "id": "pentest", "name": "External Pentest", "status": "pending", "notes": "..." },
    { "id": "dr_drill", "name": "Disaster Recovery Drill", "status": "done", "notes": "EVD: docs/_ops/ga/DR_DRILL_20260415T171310Z.md" },
    { "id": "load_test", "name": "Load Test (p99 < 200ms)", "status": "done", "notes": "p99=193ms @c100 — EVD: docs/_ops/ga/LOAD_TEST_E1_FINAL_20260415T184033Z/01_result.md" },
    { "id": "slo_signoff", "name": "SLO Sign-Off (99.9% / 30 days)", "status": "pending", "notes": "..." },
    { "id": "legal_pages", "name": "Legal Pages Active", "status": "pass", "notes": "..." },
    { "id": "first_paying_customer", "name": "First Paying Customer", "status": "pending", "notes": "..." }
  ]
}
```

`gaReady: true` only when ALL requirements reach `pass` status.

---

## Change Log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-07 | Engineering | Initial GA readiness infrastructure — all technical foundations complete |
| 2026-04-12 | Engineering | GA-2 DR drill + GA-3 load test executed on local Docker stack (PASS) and AWS EC2 t3.large sa-east-1 (PASS) |

---

> GA_READINESS.md v1.0.0 — 2026-04-07
> Technical infrastructure complete. Business sign-offs pending human decision.
