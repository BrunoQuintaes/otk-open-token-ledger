/**
 * H1.8 — Request Timeout + Body Limits
 *
 * readBodyWithLimits() replaces the original readBody() with:
 * - Max body size enforcement (default 1MB, OTK_MAX_BODY_BYTES)
 * - Per-request timeout (default 30s, OTK_REQUEST_TIMEOUT_MS)
 *
 * @module api/limits
 * @since Wave 2H (H1.8)
 */

import type { IncomingMessage } from 'node:http';

const DEFAULT_MAX_BYTES = 1_048_576; // 1MB
const DEFAULT_TIMEOUT_MS = 30_000;   // 30s

export function getMaxBodyBytes(): number {
  return Number(process.env['OTK_MAX_BODY_BYTES'] ?? DEFAULT_MAX_BYTES);
}

export function getRequestTimeoutMs(): number {
  return Number(process.env['OTK_REQUEST_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS);
}

export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds maximum size of ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request body read timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

export async function readBodyWithLimits(
  req: IncomingMessage,
  maxBytes?: number,
  timeoutMs?: number,
): Promise<string> {
  const limit = maxBytes ?? getMaxBodyBytes();
  const timeout = timeoutMs ?? getRequestTimeoutMs();

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;

    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      req.destroy();
      reject(new RequestTimeoutError(timeout));
    }, timeout) : null;

    req.on('data', (c: Buffer | string) => {
      if (timedOut) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      totalBytes += buf.length;
      if (totalBytes > limit) {
        if (timer) clearTimeout(timer);
        req.destroy();
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (timedOut) return;
      if (timer) clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (!timedOut) reject(err);
    });
  });
}
