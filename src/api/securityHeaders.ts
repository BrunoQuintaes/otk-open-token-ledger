/**
 * H1.9 — Security Headers
 *
 * Standard security headers applied to every response.
 *
 * Called by `src/api/routes.ts` and `src/proxy/ProxyGateway.ts`. Environment variable read: OTK_TLS_ENABLED
 * (`true` adds Strict-Transport-Security for one year).
 *
 * @module src/api/securityHeaders
 * @since Wave 2H (H1.9)
 */

import type { ServerResponse } from 'node:http';

// H6.2: CSP configuration.
// TODO(Wave4): Replace 'unsafe-inline' with nonce-based CSP once the dashboard
// migrates inline scripts/styles to external files or templated nonces.
// The dashboard (src/dashboard/app.ts) currently uses inline <style> and <script>
// blocks which require 'unsafe-inline' for cross-browser compatibility.
// Track: https://github.com/org/otk-zk-metering/issues/csp-nonce
const _CSP_API = "default-src 'none'; script-src 'none'; style-src 'none'; frame-ancestors 'none'";
const _CSP_DASHBOARD = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";
const _CSP_DEFAULT = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

/**
 * Sets the standard security headers, a route-specific Content-Security-Policy and `cache-control: no-store`.
 *
 * @param res - Response whose headers are set; nothing is sent.
 * @param opts - `route` selects the CSP: `api` (strictest), `dashboard` (inline scripts and styles allowed) or
 *   `default` (the default).
 */
export function applySecurityHeaders(res: ServerResponse, opts?: { route?: 'api' | 'dashboard' | 'default' }): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-xss-protection', '0');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  // Route-specific CSP: API endpoints get strictest policy, dashboard keeps unsafe-inline
  const route = opts?.route ?? 'default';
  const csp = route === 'api' ? _CSP_API : route === 'dashboard' ? _CSP_DASHBOARD : _CSP_DEFAULT;
  res.setHeader('content-security-policy', csp);
  res.setHeader('cache-control', 'no-store');
  if (process.env['OTK_TLS_ENABLED'] === 'true') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}
