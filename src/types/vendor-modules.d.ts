/**
 * Ambient declarations for runtime dependencies that ship no TypeScript types.
 * They are typed as `any`; callers keep their own narrow types at the boundary.
 * (Deliberately NOT declared: openid-client, @node-saml/node-saml — those packages are
 * not installed, and declaring them would hide that SSO cannot run; see R15a.)
 */
declare module 'snarkjs';
declare module 'circomlibjs';
