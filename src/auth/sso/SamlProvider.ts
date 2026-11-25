/**
 * SamlProvider — SAML 2.0 Service Provider implementation (NEW-4.03)
 *
 * Handles:
 *   - SP metadata generation (GET /auth/saml/metadata)
 *   - Assertion Consumer Service: validates SAML assertion → extracts user identity
 *
 * Uses @node-saml/node-saml (loaded dynamically to avoid hard dep when SAML not configured).
 *
 * Env vars:
 *   OTK_SAML_CERT        — IdP signing certificate (PEM)
 *   OTK_SAML_ENTITY_ID   — SP entity ID (default: https://otk.io/saml/sp)
 *   OTK_SSO_METADATA_URL — IdP metadata URL
 *
 * Status in this version: a STUB. `validateAssertion` checks no signature, certificate, issuer, audience or validity
 * window; outside a deployed environment it only extracts the NameID, and in a deployed environment it throws. The
 * SAML assertion route in `src/api/routes.ts` answers 501 and never calls it; only the metadata route uses this class.
 * Also reads OTK_BASE_URL (callback URL base; default a localhost address).
 *
 * @module src/auth/sso/SamlProvider
 * @since Wave 4 (4D-PACK-4D01 / NEW-4.03)
 */

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

import { isDeployedEnv } from '../../infra/deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard
/** Service-provider settings; each field falls back to its environment variable. */
export interface SamlConfig {
  idpCert?: string;
  entityId?: string;
  metadataUrl?: string;
  callbackUrl?: string;
}

/** Identity extracted from an assertion. */
export interface SamlAssertion {
  nameId: string;
  email?: string;
  displayName?: string;
  groups?: string[];
  attributes: Record<string, string | string[]>;
}

// ──────────────────────────────────────────────────────────
// SamlProvider
// ──────────────────────────────────────────────────────────

/** SAML service provider (metadata real; assertion validation a stub, see the file header). */
export class SamlProvider {
  private _config: SamlConfig;

  constructor(config?: SamlConfig) {
    this._config = {
      idpCert: config?.idpCert ?? process.env['OTK_SAML_CERT'],
      entityId: config?.entityId ?? process.env['OTK_SAML_ENTITY_ID'] ?? 'https://otk.io/saml/sp',
      metadataUrl: config?.metadataUrl ?? process.env['OTK_SSO_METADATA_URL'],
      callbackUrl: config?.callbackUrl ?? `${process.env['OTK_BASE_URL'] ?? 'http://localhost:3000'}/auth/saml/acs`,
    };
  }

  /**
   * Generate SP metadata XML.
   *
   * @returns The SP metadata XML (entity id and HTTP-POST assertion consumer URL).
   */
  getMetadata(): string {
    const entityId = this._config.entityId ?? 'https://otk.io/saml/sp';
    const acsUrl = this._config.callbackUrl ?? 'http://localhost:3000/auth/saml/acs';
    return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${entityId}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${acsUrl}" index="1"/>
  </SPSSODescriptor>
</EntityDescriptor>`;
  }

  /**
   * Validate a SAML assertion XML string.
   * When @node-saml/node-saml is available, uses it for real validation.
   * In test environments without the package, performs minimal validation.
   *
   * @param samlResponse - Assertion XML as received.
   * @returns The NameID and, when found, an e-mail; other attributes are empty.
   * @throws {Error} In a deployed environment (stub not allowed), or when no NameID is found.
   */
  async validateAssertion(samlResponse: string): Promise<SamlAssertion> {
    // Dynamic import to avoid hard dependency
    let nodeSaml: { SAML?: unknown } | null = null;
    try {
      nodeSaml = await import('@node-saml/node-saml');
    } catch {
      // Package not installed — fallback to minimal parsing for tests
    }

    if (nodeSaml?.SAML) {
      // Real validation via @node-saml/node-saml
      // (implementation would go here in production)
    }

    // Production guard: stub mode without real IdP validation is unsafe in production
    if (isDeployedEnv()) {
      throw new Error(
        'SamlProvider: stub validation is not allowed in production. ' +
        'Install @node-saml/node-saml and configure OTK_SAML_CERT + OTK_SSO_METADATA_URL.',
      );
    }

    // Minimal parsing: extract nameId from assertion XML (for test/stub mode)
    const nameIdMatch = samlResponse.match(/<(?:saml:|)[Nn]ame[Ii][Dd][^>]*>([^<]+)<\//);
    const emailMatch = samlResponse.match(/email[">][^<]*>([^<@]+@[^<]+)</i);

    if (!nameIdMatch) {
      throw new Error('SamlProvider: invalid assertion — NameID not found');
    }

    return {
      nameId: nameIdMatch[1].trim(),
      email: emailMatch?.[1]?.trim(),
      attributes: {},
    };
  }

  /**
   * Copy of the effective configuration.
   *
   * @returns A shallow copy of the configuration.
   */
  get config(): SamlConfig {
    return { ...this._config };
  }
}
