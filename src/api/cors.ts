/**
 * H1.2 — CORS Configuration
 *
 * Configurable CORS headers + OPTIONS preflight handling.
 * Config via OTK_CORS_ORIGINS env (comma-separated, default '*').
 *
 * @module api/cors
 * @since Wave 2H (H1.2)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface CorsConfig {
  allowedOrigins: string[];
  allowAll: boolean;
  allowCredentials: boolean;
}

export function parseCorsConfig(env?: string): CorsConfig {
  const raw = env ?? '*';
  if (raw === '*') {
    return { allowedOrigins: [], allowAll: true, allowCredentials: false };
  }
  const origins = raw.split(',').map(o => o.trim()).filter(Boolean);
  return { allowedOrigins: origins, allowAll: false, allowCredentials: true };
}

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

const ALLOWED_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, X-Request-Id, X-Admin-Key, Idempotency-Key';
const MAX_AGE = '86400';

export function handlePreflight(req: IncomingMessage, res: ServerResponse, config: CorsConfig): void {
  applyCors(req, res, config);
  res.setHeader('access-control-allow-methods', ALLOWED_METHODS);
  res.setHeader('access-control-allow-headers', ALLOWED_HEADERS);
  res.setHeader('access-control-max-age', MAX_AGE);
  res.statusCode = 204;
  res.end();
}
