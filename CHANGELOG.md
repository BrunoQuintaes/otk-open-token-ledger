# Changelog

All notable changes to OTK zk-Metering are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased] - H1R2 C3 (2026-10-13)

### Security
- Production dependency advisories (F-H1-04) closed with semver-compatible `overrides` (no direct dependency bumped):
  `ws` 8.17.1/8.18.0 → 8.22.0, `uuid` 11.1.0 → 11.1.1, `nanoid` 5.1.9 → 5.1.16; dev tree shipped in the Docker images
  (`npm ci --include=dev`): `minimatch` 5.1.9, `brace-expansion` 2.1.7, `underscore` 1.13.8, `jsonpath` 1.3.0.
- Idempotency-Key body fingerprint (S24-F09): cached entries now also store `bodyHashV2` (`v2:` + SHA-256 of the body),
  which decides replay vs 409 when present. The legacy 32-bit fingerprint is still written and still honored for entries
  written by older replicas until they expire, so rolling deploys are safe. HTTP contract unchanged.

## [0.6.0] - 2026-04-03

### Added
- Feature flag service with per-tenant overrides (NEW-6.01)
- Changelog parser and HTTP dashboard endpoint (NEW-6.02)
- Evidence directory indexer for automated EVD discovery (P5.1)

## [0.5.0] - 2026-04-03

### Added
- On-chain v2 verifier deployment script and SDK v2 receipt builder (S6.1)
- MPC ceremony public attestation document (S6.2)
- Reconciliation scheduler with PostgreSQL storage (E6.3)
- TheGraph subgraph schema, manifest, and AssemblyScript mapping (E6.7)
- Analytics dashboard with CU trend chart (P4.3)
- Demo sandbox tenant (P4.2)
- SLA tier mapping per plan (P4.4)
- Legal pages: Terms of Service, Privacy Policy, Data Processing Agreement (NEW-5.02)
- Opt-in SDK telemetry: p50/p95 latency, error rate (NEW-5.03)
- Tenant isolation audit suite — 6 boundary test suites (NEW-5.04)

### Changed
- Policy engine wired to plan templates; rate limiter with provider-scoped keys (E6.4/E6.5)

## [0.4.0] - 2026-04-02

### Added
- Wave 4: ZK v2 MPC proving key integration
- SSO: SAML 2.0 and OIDC providers
- SCIM 2.0 user provisioning
- Stripe billing integration with webhook handler
- Webhook registry, delivery queue, and management dashboard
- SSE real-time stream endpoint
- GDPR export and erasure with tombstone hashing
- Data retention worker
- SMTP email adapter
- Pricing engine v2 with margin rates per plan
- Data export async jobs

## [0.3.0] - 2026-03-28

### Added
- Wave 3: Scale infrastructure and self-service
- K8s Helm chart with HPA and ingress
- API key management CRUD
- User model with PostgreSQL backing
- Email and notification infrastructure
- Dashboard views: users, billing, webhooks

## [0.2.0] - 2026-03-15

### Added
- Wave 2H production hardening (34 items)
- JWT authentication and RBAC middleware
- CORS, security headers, body limits, idempotency
- Circuit breaker and W3C tracing
- Auto-loop batch trigger and crash recovery

## [0.1.0] - 2026-02-28

### Added
- Wave 1: MVP operational base
- ZK metering circuit v1 (Groth16) and v2 (range proof)
- MPC ceremony (5 contributors, beacon applied)
- IBFT 4-node Besu network
- Receipt registry smart contract
- SDK: buildReceipt, proveAndSubmit
- BullMQ proof queue
- PostgreSQL receipt store
