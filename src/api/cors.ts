/**
 * H1.2 — CORS Configuration
 *
 * Configurable CORS headers + OPTIONS preflight handling.
 * Config via OTK_CORS_ORIGINS env (comma-separated, default '*').
 *
 * `src/api/routes.ts` builds the config once at startup from `OTK_CORS_ORIGINS` and calls `applyCors` on every
 * request and `handlePreflight` for OPTIONS. With the default `'*'` any origin is allowed but credentials are not;
 * with an explicit list only listed origins are echoed back, with credentials allowed.
 *
 * @module src/api/cors
 * @since Wave 2H (H1.2)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Parsed CORS policy. */
export interface CorsConfig {
  /** Exact origins allowed (empty when `allowAll`). */
  allowedOrigins: string[];
  /** `true` when the setting is `'*'`: every origin is allowed. */
  allowAll: boolean;
  /** Whether `access-control-allow-credentials: true` is sent (only with an explicit origin list). */
  allowCredentials: boolean;
}

/**
 * Parses the CORS origin setting.
 *
 * @param env - Comma-separated origins, or `'*'`; `undefined` means `'*'`.
 * @returns The policy; an explicit list enables credentials.
 */
export function parseCorsConfig(env?: string): CorsConfig {
  const raw = env ?? '*';
  if (raw === '*') {
    return { allowedOrigins: [], allowAll: true, allowCredentials: false };
  }
  const origins = raw.split(',').map(o => o.trim()).filter(Boolean);
  return { allowedOrigins: origins, allowAll: false, allowCredentials: true };
}

/**
 * Sets the CORS response headers for one request according to the policy.
 *
 * @param req - Incoming request (its `origin` header is read).
 * @param res - Response whose headers are set; nothing is sent.
 * @param config - Policy from `parseCorsConfig`.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse, config: CorsConfig): void {
  if (config.allowAll) {
    res.setHeader('access-control-allow-origin', '*');
    return;
  }
  const origin = (req.headers as Record<string, string | undefined>)?.['origin'];
  if (!origin) return;
  if (config.allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    if (config.allowCredentials) {
      res.setHeader('access-control-allow-credentials', 'true');
    }
  }
}

// Values sent on preflight responses; MAX_AGE is in seconds (24 h).
const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Request-Id, X-Admin-Key, Idempotency-Key';
const MAX_AGE = '86400';

/**
 * Answers a CORS preflight (OPTIONS) request with 204 and the allowed methods, headers and max age.
 *
 * @param req - The OPTIONS request.
 * @param res - Response; it is ended here.
 * @param config - Policy from `parseCorsConfig`.
 */
export function handlePreflight(req: IncomingMessage, res: ServerResponse, config: CorsConfig): void {
  applyCors(req, res, config);
  res.setHeader('access-control-allow-methods', ALLOWED_METHODS);
  res.setHeader('access-control-allow-headers', ALLOWED_HEADERS);
  res.setHeader('access-control-max-age', MAX_AGE);
  res.statusCode = 204;
  res.end();
}
