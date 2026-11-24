/**
 * OVERNIGHT 20261005 / Phase 5 (R15a) — optional SSO dependencies, NOT installed in this build profile.
 *
 * src/auth/sso/OidcProvider.ts and SamlProvider.ts import these packages dynamically inside try/catch and fall
 * back when they are absent (OIDC token exchange is a stub that refuses to run in production). Raw `tsc` reported
 * TS2307 for the missing modules. These declarations type ONLY what the code touches (nothing for openid-client,
 * `SAML: unknown` for node-saml), so a future real use must replace them with the package's own types.
 * They do not make SSO functional: SSO remains outside the validated scope (claims matrix).
 */
declare module 'openid-client' {
  const unused: unknown;
  export default unused;
}

declare module '@node-saml/node-saml' {
  export const SAML: unknown;
}
