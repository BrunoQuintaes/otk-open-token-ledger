/**
 * H1.8 — Request Timeout + Body Limits
 *
 * readBodyWithLimits() replaces the original readBody() with:
 * - Max body size enforcement (default 1MB, OTK_MAX_BODY_BYTES)
 * - Per-request timeout (default 30s, OTK_REQUEST_TIMEOUT_MS)
 *
 * Used by `src/api/routes.ts` and `src/proxy/ProxyGateway.ts` to read request bodies. The environment variables
 * are read on every call and not validated (a non-numeric value gives `NaN`, which disables the size check).
 *
 * @module src/api/limits
 * @since Wave 2H (H1.8)
 */

import type { IncomingMessage } from 'node:http';

const DEFAULT_MAX_BYTES = 1_048_576; // 1MB
const DEFAULT_TIMEOUT_MS = 30_000;   // 30s

/**
 * Maximum request body size.
 *
 * @returns Bytes, from `OTK_MAX_BODY_BYTES` (default 1 048 576).
 */
export function getMaxBodyBytes(): number {
  return Number(process.env['OTK_MAX_BODY_BYTES'] ?? DEFAULT_MAX_BYTES);
}

/**
 * Time allowed to read a request body.
 *
 * @returns Milliseconds, from `OTK_REQUEST_TIMEOUT_MS` (default 30 000); 0 or less disables the timeout.
 */
export function getRequestTimeoutMs(): number {
  return Number(process.env['OTK_REQUEST_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS);
}

/** Thrown (as a rejection) when the body exceeds the size limit; the request stream is destroyed. */
export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds maximum size of ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** Thrown (as a rejection) when the body is not fully read in time; the request stream is destroyed. */
export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request body read timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * Reads the whole request body as UTF-8 text, enforcing a size limit and a timeout.
 *
 * @param req - The incoming request; its stream is consumed (and destroyed on a limit breach).
 * @param maxBytes - Size limit in bytes; defaults to `getMaxBodyBytes()`.
 * @param timeoutMs - Read timeout in ms; defaults to `getRequestTimeoutMs()`; 0 or less means no timeout.
 * @returns The body text.
 * @throws {@link BodyTooLargeError} When more than `maxBytes` bytes arrive.
 * @throws {@link RequestTimeoutError} When the body is not complete within `timeoutMs`.
 * @throws {Error} The stream's own error, when the request errors before the timeout.
 */
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
