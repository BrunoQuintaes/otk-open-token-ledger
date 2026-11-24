/**
 * Webhook destination policy (H1R2 S21-F01): SSRF guard for outbound webhook deliveries.
 *
 * A webhook URL is chosen by a tenant, so every delivery is a server-side request to an attacker-chosen destination.
 * This module is the single gate between a stored URL and a socket:
 *   - https only (no userinfo, ports 443 or >= 1024, no internal host names such as localhost / *.internal);
 *   - the host name is resolved and EVERY answer must be a public unicast address: loopback, RFC 1918, CGNAT,
 *     link-local (cloud metadata 169.254.169.254 included), multicast, reserved and documentation ranges are refused;
 *     for IPv6 also ::, ::1, ULA fc00::/7 (AWS IMDS fd00:ec2::254), link-local, site-local, IPv4-mapped/compatible,
 *     Teredo, and NAT64/6to4 when the embedded IPv4 is not public;
 *   - DNS rebinding: the connection uses the address that was validated (custom `lookup` that returns the pinned
 *     address), so the host name is never resolved a second time between the check and the connect;
 *   - redirects are never followed (node:http does not follow; a 3xx is a failed delivery), a timeout bounds the
 *     request and the response body is not read (only the status is used).
 * Test-only relaxations (`requireHttps: false`, `isAddressAllowed`) exist only as programmatic options; no environment
 * variable relaxes the policy.
 *
 * @module webhooks/destinationPolicy
 */

import dns from 'node:dns';
import net from 'node:net';
import type { HttpPostFn } from './WebhookDelivery.js';

export type DestinationRefusal =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_not_allowed'
  | 'port_not_allowed'
  | 'host_not_allowed'
  | 'dns_resolution_failed'
  | 'address_not_allowed';

export class WebhookDestinationError extends Error {
  constructor(public readonly reason: DestinationRefusal, detail: string) {
    super(`webhook destination refused (${reason}): ${detail}`);
    this.name = 'WebhookDestinationError';
  }
}

export interface ResolvedAddress { address: string; family: 4 | 6 }
/** Resolver returning every address of a host name (injectable: tests use a fake DNS, never the network). */
export type WebhookResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface DestinationPolicyOptions {
  /** Default true. Only tests talking to a local plain-HTTP server set it to false. */
  requireHttps?: boolean;
  resolver?: WebhookResolver;
  /** Test hook: overrides the address classification (e.g. to allow 127.0.0.1 of a local fake receiver). */
  isAddressAllowed?: (address: string, family: 4 | 6) => boolean;
}

export interface ValidatedDestination {
  url: URL;
  hostname: string;   // without IPv6 brackets
  port: number;
  pinned: ResolvedAddress;
}

export const defaultWebhookResolver: WebhookResolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

// ──────────────────────────────────────────────────────────
// Address classification
// ──────────────────────────────────────────────────────────

const V4_BLOCKED: Array<[number, number, string]> = [
  // [network, prefix length, label]
  [ip4('0.0.0.0'), 8, 'this-network'],
  [ip4('10.0.0.0'), 8, 'private'],
  [ip4('100.64.0.0'), 10, 'cgnat'],
  [ip4('127.0.0.0'), 8, 'loopback'],
  [ip4('169.254.0.0'), 16, 'link-local/metadata'],
  [ip4('172.16.0.0'), 12, 'private'],
  [ip4('192.0.0.0'), 24, 'ietf-protocol'],
  [ip4('192.0.2.0'), 24, 'documentation'],
  [ip4('192.88.99.0'), 24, '6to4-relay'],
  [ip4('192.168.0.0'), 16, 'private'],
  [ip4('198.18.0.0'), 15, 'benchmark'],
  [ip4('198.51.100.0'), 24, 'documentation'],
  [ip4('203.0.113.0'), 24, 'documentation'],
  [ip4('224.0.0.0'), 4, 'multicast'],
  [ip4('240.0.0.0'), 4, 'reserved/broadcast'],
];

function ip4(s: string): number {
  const p = s.split('.').map(Number);
  return (((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!) >>> 0;
}

function v4Category(address: string): string | null {
  const n = ip4(address);
  for (const [net4, len, label] of V4_BLOCKED) {
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    if (((n & mask) >>> 0) === net4) return label;
  }
  return null;
}

/** Expands an IPv6 literal (optionally with an embedded dotted IPv4) to 8 hextets; null when malformed. */
function expandV6(address: string): number[] | null {
  let s = address;
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (net.isIPv4(dotted[1]!) === false) return null;
    const n = ip4(dotted[1]!);
    s = s.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const out = parts.map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function embeddedV4(h: number[], from: number): string {
  return `${h[from]! >> 8}.${h[from]! & 0xff}.${h[from + 1]! >> 8}.${h[from + 1]! & 0xff}`;
}

function v6Category(address: string): string | null {
  if (address.includes('%')) return 'zone-id';
  const h = expandV6(address);
  if (!h) return 'malformed';
  const zeroUpTo = (n: number) => h.slice(0, n).every((x) => x === 0);
  if (h.every((x) => x === 0)) return 'unspecified';
  if (zeroUpTo(7) && h[7] === 1) return 'loopback';
  if (zeroUpTo(5) && h[5] === 0xffff) return 'ipv4-mapped';
  if (zeroUpTo(6)) return 'ipv4-compatible';
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return v4Category(embeddedV4(h, 6)) ? 'nat64-internal' : null;
  }
  // H1R2 review H2: the rest of 64:ff9b::/32 (local-use NAT64 64:ff9b:1::/48, RFC 8215) embeds the IPv4 at a position
  // that depends on the operator's prefix length: refused as a whole (fail closed)
  if (h[0] === 0x64 && h[1] === 0xff9b) return 'nat64-local-use';
  if (h[0] === 0x2002) return v4Category(embeddedV4(h, 1)) ? '6to4-internal' : null;
  if (h[0] === 0x2001 && h[1] === 0) return 'teredo';
  if (h[0] === 0x2001 && h[1] === 0x0db8) return 'documentation';
  if ((h[0]! & 0xfe00) === 0xfc00) return 'unique-local';
  if ((h[0]! & 0xffc0) === 0xfe80) return 'link-local';
  if ((h[0]! & 0xffc0) === 0xfec0) return 'site-local';
  if ((h[0]! & 0xff00) === 0xff00) return 'multicast';
  return null;
}

/** Returns why an address may not receive a webhook, or null when it is a public unicast address. */
export function blockedAddressCategory(address: string): string | null {
  const family = net.isIP(address);
  if (family === 4) return v4Category(address);
  if (family === 6) return v6Category(address);
  return address.includes('%') ? 'zone-id' : 'not-an-ip';
}

// ──────────────────────────────────────────────────────────
// URL + resolution
// ──────────────────────────────────────────────────────────

const INTERNAL_HOST = /(^|\.)(localhost|local|internal|localdomain|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;

/** Syntactic checks only (no DNS). Throws WebhookDestinationError. */
export function parseWebhookUrl(raw: string, opts: DestinationPolicyOptions = {}): { url: URL; hostname: string; port: number } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new WebhookDestinationError('invalid_url', 'not an absolute URL'); }
  const requireHttps = opts.requireHttps ?? true;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !requireHttps)) {
    throw new WebhookDestinationError('scheme_not_allowed', `${url.protocol} (https only)`);
  }
  if (url.username || url.password) throw new WebhookDestinationError('credentials_not_allowed', 'userinfo in URL');
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (requireHttps && port !== 443 && port < 1024) throw new WebhookDestinationError('port_not_allowed', String(port));
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname) throw new WebhookDestinationError('host_not_allowed', 'empty host');
  if (net.isIP(hostname) === 0 && INTERNAL_HOST.test(hostname)) throw new WebhookDestinationError('host_not_allowed', hostname);
  return { url, hostname, port };
}

/**
 * Full check: syntax + resolution; every resolved address must be allowed. Returns the address to pin the
 * connection to. Called at registration AND before every delivery (DNS may change in between).
 */
export async function validateWebhookDestination(raw: string, opts: DestinationPolicyOptions = {}): Promise<ValidatedDestination> {
  const { url, hostname, port } = parseWebhookUrl(raw, opts);
  const allowed = opts.isAddressAllowed ?? ((a: string) => blockedAddressCategory(a) === null);
  let answers: ResolvedAddress[];
  const literal = net.isIP(hostname);
  if (literal) {
    answers = [{ address: hostname, family: literal === 6 ? 6 : 4 }];
  } else {
    try { answers = await (opts.resolver ?? defaultWebhookResolver)(hostname); } catch (e) {
      throw new WebhookDestinationError('dns_resolution_failed', e instanceof Error ? e.message : String(e));
    }
    if (!answers.length) throw new WebhookDestinationError('dns_resolution_failed', `${hostname}: no address`);
  }
  for (const a of answers) {
    if (net.isIP(a.address) === 0 || !allowed(a.address, a.family)) {
      throw new WebhookDestinationError('address_not_allowed', `${hostname} -> ${a.address} (${blockedAddressCategory(a.address) ?? 'policy'})`);
    }
  }
  return { url, hostname, port, pinned: answers[0]! };
}

// ──────────────────────────────────────────────────────────
// Pinned, bounded HTTP POST
// ──────────────────────────────────────────────────────────

export interface SafePostOptions extends DestinationPolicyOptions {
  timeoutMs?: number;        // default 10 s, whole request
  maxRequestBytes?: number;  // default 256 KiB
}

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_REQUEST_BYTES = 256 * 1024;

/**
 * HttpPostFn that validates the destination on every call and connects to the validated address only.
 * The response body is never read (status only); 3xx is returned as-is and never followed.
 */
export function createSafeWebhookHttpPost(opts: SafePostOptions = {}): HttpPostFn {
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const maxRequestBytes = opts.maxRequestBytes ?? WEBHOOK_MAX_REQUEST_BYTES;
  return async (rawUrl, headers, body) => {
    const len = Buffer.byteLength(body);
    if (len > maxRequestBytes) throw new Error(`webhook payload too large (${len} > ${maxRequestBytes})`);
    const dest = await validateWebhookDestination(rawUrl, opts);
    const mod = dest.url.protocol === 'https:' ? await import('node:https') : await import('node:http');
    const { address, family } = dest.pinned;
    // DNS-rebinding guard: the socket connects to the address validated above, never to a fresh resolution.
    const pinnedLookup = ((_host: string, o: { all?: boolean }, cb: (...args: unknown[]) => void) => {
      if (o && o.all) cb(null, [{ address, family }]); else cb(null, address, family);
    }) as unknown as net.LookupFunction;
    return new Promise<{ status: number }>((resolve, reject) => {
      const req = mod.request({
        protocol: dest.url.protocol,
        hostname: dest.hostname,      // Host header and TLS SNI/certificate check stay on the registered name
        port: dest.port,
        path: dest.url.pathname + dest.url.search,
        method: 'POST',
        headers: { ...headers, 'Content-Length': len },
        lookup: pinnedLookup,
        agent: false,                 // no pooled socket that could point elsewhere
        timeout: timeoutMs,
      }, (res) => {
        resolve({ status: res.statusCode ?? 0 });
        res.destroy();                // response size limit: the body is not consumed
      });
      const timer = setTimeout(() => req.destroy(new Error(`webhook delivery timed out after ${timeoutMs} ms`)), timeoutMs);
      timer.unref?.();
      req.on('timeout', () => req.destroy(new Error(`webhook delivery timed out after ${timeoutMs} ms`)));
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.on('close', () => clearTimeout(timer));
      req.end(body);
    });
  };
}
