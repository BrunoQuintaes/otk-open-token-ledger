/**
 * OidcProvider — OIDC authorization code exchange (NEW-4.03)
 *
 * Handles:
 *   - Authorization URL generation
 *   - Code → token exchange (GET /auth/oidc/callback)
 *
 * Uses openid-client (loaded dynamically to avoid hard dep when OIDC not configured).
 *
 * Env vars:
 *   OTK_OIDC_ISSUER        — OIDC issuer URL
 *   OTK_OIDC_CLIENT_ID     — OIDC client ID
 *   OTK_OIDC_CLIENT_SECRET — OIDC client secret
 *
 * Status in this version: a STUB. `exchangeCode` performs no real code exchange and validates no ID token; outside a
 * deployed environment it returns a fake identity derived from the code, and in a deployed environment it throws.
 * The OIDC callback route in `src/api/routes.ts` answers 501 and never calls it. Also reads OTK_BASE_URL (redirect
 * URI base; default a localhost address).
 *
 * @module src/auth/sso/OidcProvider
 * @since Wave 4 (4D-PACK-4D01 / NEW-4.03)
 */

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

import { isDeployedEnv } from '../../infra/deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard
/** OIDC client settings; each field falls back to its environment variable. */
export interface OidcConfig {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

/** Identity returned by a code exchange. */
export interface OidcTokenResult {
  /** Subject identifier at the identity provider. */
  sub: string;
  email?: string;
  name?: string;
  claims: Record<string, unknown>;
  accessToken: string;
  idToken?: string;
}

// ──────────────────────────────────────────────────────────
// OidcProvider
// ──────────────────────────────────────────────────────────

/** OIDC relying party (stub; see the file header). */
export class OidcProvider {
  private _config: OidcConfig;

  constructor(config?: OidcConfig) {
    this._config = {
      issuer: config?.issuer ?? process.env['OTK_OIDC_ISSUER'],
      clientId: config?.clientId ?? process.env['OTK_OIDC_CLIENT_ID'],
      clientSecret: config?.clientSecret ?? process.env['OTK_OIDC_CLIENT_SECRET'],
      redirectUri: config?.redirectUri
        ?? `${process.env['OTK_BASE_URL'] ?? 'http://localhost:3000'}/auth/oidc/callback`,
    };
  }

  /**
   * Get the issuer configuration.
   * Returns true if OIDC is configured (issuer + clientId set).
   *
   * @returns Whether issuer and client id are set.
   */
  isConfigured(): boolean {
    return !!(this._config.issuer && this._config.clientId);
  }

  /**
   * Exchange an authorization code for tokens.
   * Uses openid-client when available; returns stub result in test mode.
   *
   * @param code - One-time code returned to the callback by the identity provider.
   * @param _state - Unused (state is not checked here).
   * @returns A stub identity (fake values derived from the code).
   * @throws {Error} When OIDC is not configured, or in a deployed environment (stub not allowed there).
   */
  async exchangeCode(code: string, _state?: string): Promise<OidcTokenResult> {
    if (!this.isConfigured()) {
      throw new Error('OidcProvider: OIDC not configured (OTK_OIDC_ISSUER + OTK_OIDC_CLIENT_ID required)');
    }

    // Try to use openid-client dynamically
    try {
      await import('openid-client');
      // In production, would call issuer.discover(), create client, exchange code
      // For now, stub implementation for test coverage
    } catch {
      // openid-client not installed
    }

    // Production guard: stub token exchange is not safe in production
    if (isDeployedEnv()) {
      throw new Error(
        'OidcProvider: stub token exchange is not allowed in production. ' +
        'Install openid-client and configure OTK_OIDC_ISSUER + OTK_OIDC_CLIENT_ID + OTK_OIDC_CLIENT_SECRET.',
      );
    }

    // Stub result for test/integration harness
    return {
      sub: `oidc-${code.slice(0, 8)}`,
      email: `user-${code.slice(0, 4)}@example.com`,
      name: 'OIDC User',
      claims: { iss: this._config.issuer, aud: this._config.clientId },
      accessToken: `at-${code}`,
      idToken: `idt-${code}`,
    };
  }

  /**
   * Build authorization URL for redirecting user to IdP.
   *
   * @param state - Optional opaque state to round-trip.
   * @returns The URL of the issuer's login endpoint with the query parameters.
   * @throws {Error} When issuer or client id is missing.
   */
  getAuthorizationUrl(state?: string): string {
    if (!this._config.issuer || !this._config.clientId) {
      throw new Error('OidcProvider: not configured');
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this._config.clientId,
      redirect_uri: this._config.redirectUri ?? '',
      scope: 'openid email profile',
      ...(state ? { state } : {}),
    });
    return `${this._config.issuer}/authorize?${params.toString()}`;
  }

  /**
   * Copy of the effective configuration (includes the client secret: do not log it).
   *
   * @returns A shallow copy of the configuration.
   */
  get config(): OidcConfig {
    return { ...this._config };
  }
}
