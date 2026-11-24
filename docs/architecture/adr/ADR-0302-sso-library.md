# ADR-0302 — SSO Library Selection (SAML + OIDC)

**Date:** 2026-04-02
**Status:** Accepted
**Scope:** Enterprise authentication (Wave 4D, NEW-4.03)

---

## Decision

Use **`@node-saml/node-saml`** for SAML 2.0 SP support and **`openid-client`** for OIDC exchange.

---

## Context

Enterprise customers require Single Sign-On via their corporate IdP. OTK must support:
1. **SAML 2.0** — most common in enterprise (Okta, Azure AD, ADFS)
2. **OIDC** — modern federation standard (Google Workspace, Auth0, Azure AD v2)

### Libraries evaluated

| Library | SAML | OIDC | Maintenance | Notes |
|---------|------|------|------------|-------|
| `@node-saml/node-saml` | ✓ | ✗ | Active | Fork of passport-saml, no Passport dep |
| `samlify` | ✓ | ✗ | Less active | More complex API |
| `openid-client` | ✗ | ✓ | Active (Panva) | RFC-compliant, TypeScript-native |
| `passport-openidconnect` | ✗ | ✓ | Passive | Requires Passport |

Chosen: `@node-saml/node-saml` + `openid-client` — independent libraries, no Passport dependency, TypeScript-native.

---

## Routes

| Route | Purpose |
|-------|---------|
| `GET /auth/saml/metadata` | SP metadata XML (no auth required) |
| `POST /auth/saml/acs` | Assertion Consumer Service — validates assertion → issues JWT |
| `GET /auth/oidc/callback` | Exchange OIDC code for tokens → issues JWT |

---

## Env vars

| Var | Purpose |
|-----|---------|
| `OTK_SSO_METADATA_URL` | IdP metadata URL for SAML |
| `OTK_SAML_CERT` | IdP signing certificate (PEM) |
| `OTK_SAML_ENTITY_ID` | SP entity ID |
| `OTK_OIDC_ISSUER` | OIDC issuer URL |
| `OTK_OIDC_CLIENT_ID` | OIDC client ID |
| `OTK_OIDC_CLIENT_SECRET` | OIDC client secret |

---

## Consequences

- **Positive:** Standard protocols — works with all major IdPs
- **Positive:** No Passport dependency — cleaner integration
- **Negative:** Two dependencies added (mitigated: only loaded when env vars set)
- **Negative:** Certificate management complexity (documented in deployment guide)
