/**
 * H1-S06 (SEC02-N02): per-SOURCE limiter of authentication failures for the MITM proxy.
 *
 * Before, the proxy answered 401 to any number of wrong tokens, so tenant tokens could be guessed online at network
 * speed. Now each source (client address) may fail authentication at most `max` times per `windowMs`; after that every
 * request from that source gets 429 (with Retry-After) BEFORE any token is resolved, valid ones included, until the
 * window ends (otherwise a throttled source would still learn which token is valid).
 *
 * It cannot be used to lock out a tenant: the key is the source address, never the tenant or the token, so wrong tokens
 * sent from one source do not affect the same tenant used from any other source. Successful authentications do not
 * count. Memory is bounded (`maxEntries`, oldest entry evicted first).
 *
 * Source address: the socket peer. IPv4-mapped IPv6 is normalised; IPv6 is keyed by its /64 prefix (one host usually
 * holds a whole /64). Behind a reverse proxy set OTK_PROXY_TRUSTED_HOPS=<n> to use the n-th address from the right of
 * X-Forwarded-For (only the hops you control; the default 0 ignores the header, which a client can forge).
 *
 * Configuration: OTK_PROXY_AUTH_FAIL_MAX (default 20, 0 disables), OTK_PROXY_AUTH_FAIL_WINDOW_MS (default 60000),
 * OTK_PROXY_AUTH_FAIL_MAX_SOURCES (default 10000).
 *
 * Replicas (H1 lane B, S06 residual): the local count is per process, so a source spreading its guesses over N replicas
 * used to get N x max attempts. With a shared counter (the IDistributedRateLimiter contract: Redis when OTK_REDIS_URL is
 * configured) every failure is also counted in the shared sliding window `authfail:<source>`; when the shared count
 * reaches `max`, the replica that recorded the failure blocks the source locally until the shared window allows it
 * again. Each other replica blocks it on its own next failure from that source, so the cluster-wide number of failures
 * per window is bounded by max + (replicas - 1) (plus failures in flight). The shared update is asynchronous (the 401 is
 * not delayed). The local limiter keeps working on its own when the shared counter is absent or failing (memory
 * fallback; RedisRateLimiter itself answers "allowed" on a Redis error).
 *
 * Replicas (H1 lane B, S06 residual): the local count is per process, so a source spreading its guesses over N replicas
 * used to get N × max attempts. With a shared counter (the IDistributedRateLimiter contract: Redis when OTK_REDIS_URL is
 * configured) every failure is also counted in the shared sliding window `authfail:<source>`; when the shared count
 * reaches `max`, the replica that recorded the failure blocks the source locally until the shared window allows it
 * again. Each other replica blocks it on its own next failure from that source, so the cluster-wide number of failures
 * per window is bounded by max + (replicas - 1) (plus failures in flight). The shared update is asynchronous (the 401 is
 * not delayed). The local limiter keeps working on its own when the shared counter is absent or failing (memory
 * fallback; RedisRateLimiter itself answers "allowed" on a Redis error).
 *
 * @module security/authFailureLimiter
 */
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import {
  getDistributedRateLimiter, MemoryDistributedRateLimiter,
  type IDistributedRateLimiter, type RateLimitConfig,
} from './IDistributedRateLimiter.js';

interface Entry { count: number; windowStart: number }

export interface AuthFailureLimiterOptions { max: number; windowMs: number; maxEntries: number }

function envInt(raw: string | undefined, def: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : def;
}

/** Key of a source in the shared counter. */
export function sharedAuthFailKey(source: string): string {
  return `authfail:${source}`;
}

/**
 * Shared sliding-window configuration equivalent to "blocked after `max` failures": the shared limiter answers
 * "not allowed" from the (maxRequests + 1)-th call of the window on, so maxRequests = max - 1.
 */
export function sharedAuthFailConfig(opts: Pick<AuthFailureLimiterOptions, 'max' | 'windowMs'>): RateLimitConfig {
  return { windowSeconds: Math.max(1, Math.ceil(opts.windowMs / 1000)), maxRequests: Math.max(0, opts.max - 1) };
}

type SharedSource = IDistributedRateLimiter | null | undefined | (() => IDistributedRateLimiter | null | undefined);

export class AuthFailureLimiter {
  private readonly _entries = new Map<string, Entry>();
  /** source → epoch ms until which the shared counter says the source is over the limit */
  private readonly _sharedBlocked = new Map<string, number>();
  constructor(private readonly _opts: AuthFailureLimiterOptions, private readonly _shared: SharedSource = null) {}

  private _sharedCounter(): IDistributedRateLimiter | null {
    const s = typeof this._shared === 'function' ? this._shared() : this._shared;
    return s ?? null;
  }

  /** Seconds to wait when `source` is throttled now, else 0. */
  throttledFor(source: string, now: number = Date.now()): number {
    if (this._opts.max <= 0) return 0;
    const until = this._sharedBlocked.get(source);
    if (until !== undefined) {
      if (until > now) return Math.max(1, Math.ceil((until - now) / 1000));
      this._sharedBlocked.delete(source);
    }
    const e = this._entries.get(source);
    if (!e) return 0;
    const elapsed = now - e.windowStart;
    if (elapsed >= this._opts.windowMs) { this._entries.delete(source); return 0; }
    return e.count >= this._opts.max ? Math.max(1, Math.ceil((this._opts.windowMs - elapsed) / 1000)) : 0;
  }

  /**
   * Record one authentication failure of `source`. The local count is updated synchronously; the returned promise
   * settles when the shared counter (if any) has been updated. Callers on the request path do not await it; it never
   * rejects.
   */
  recordFailure(source: string, now: number = Date.now()): Promise<void> {
    if (this._opts.max <= 0) return Promise.resolve();
    this._recordLocal(source, now);
    const shared = this._sharedCounter();
    if (!shared) return Promise.resolve();
    let pending: Promise<void>;
    try {
      pending = shared.check(sharedAuthFailKey(source), sharedAuthFailConfig(this._opts)).then((d) => {
        if (d.allowed) return;
        const wait = typeof d.retryAfterMs === 'number' && Number.isFinite(d.retryAfterMs) && d.retryAfterMs > 0
          ? d.retryAfterMs : this._opts.windowMs;
        this._blockShared(source, Date.now() + wait);
      });
    } catch {
      return Promise.resolve();
    }
    return pending.catch(() => { /* shared counter unavailable: the local limiter still applies */ });
  }

  private _recordLocal(source: string, now: number): void {
    const e = this._entries.get(source);
    if (e && now - e.windowStart < this._opts.windowMs) { e.count++; return; }
    if (e) this._entries.delete(source);
    while (this._entries.size >= this._opts.maxEntries) {
      const oldest = this._entries.keys().next().value;
      if (oldest === undefined) break;
      this._entries.delete(oldest);
    }
    this._entries.set(source, { count: 1, windowStart: now });
  }

  private _blockShared(source: string, until: number): void {
    this._sharedBlocked.delete(source);
    while (this._sharedBlocked.size >= this._opts.maxEntries) {
      const oldest = this._sharedBlocked.keys().next().value;
      if (oldest === undefined) break;
      this._sharedBlocked.delete(oldest);
    }
    this._sharedBlocked.set(source, until);
  }

  size(): number { return this._entries.size; }
  clear(): void { this._entries.clear(); this._sharedBlocked.clear(); }
}

/**
 * STOPGATE-01 P1.3 (R-12): an X-Forwarded-For entry is used only when it is an IP address ("1.2.3.4", "1.2.3.4:80",
 * "2001:db8::1", "[2001:db8::1]:443"); anything else ("unknown", "evil", an empty item) falls back to the socket peer,
 * so a forged header cannot mint arbitrary source keys.
 */
function xffAddress(raw: string): string | null {
  let s = raw.trim();
  const br = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (br) s = br[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  return isIP(s) ? s : null;
}

/**
 * STOPGATE-01 P1.3 (R-12): OTK_PROXY_TRUSTED_ADDRS = comma-separated addresses or CIDRs of the reverse proxies. When
 * set, X-Forwarded-For is read only when the socket peer is one of them: a client reaching the replica directly
 * (bypassing the proxy) cannot choose its source key. Unset keeps the previous behaviour (documented limitation: with
 * OTK_PROXY_TRUSTED_HOPS>0 and a reachable replica, the header is trusted from any peer). Invalid entries are ignored.
 */
let _trustedRaw: string | undefined;
let _trusted: BlockList | null = null;
function trustedProxies(): BlockList | null {
  const raw = (process.env['OTK_PROXY_TRUSTED_ADDRS'] ?? '').trim();
  if (raw === _trustedRaw) return _trusted;
  _trustedRaw = raw;
  if (!raw) { _trusted = null; return null; }
  const bl = new BlockList();
  for (const item of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [ip, bits] = item.split('/');
    const fam = isIP(ip ?? '');
    if (!fam) continue;
    const type = fam === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) bl.addAddress(ip!, type);
    else if (/^\d+$/.test(bits) && Number(bits) <= (fam === 6 ? 128 : 32)) bl.addSubnet(ip!, Number(bits), type);
  }
  _trusted = bl;
  return bl;
}

function peerIsTrustedProxy(peer: string): boolean {
  const bl = trustedProxies();
  if (!bl) return true; // not configured: previous behaviour
  const p = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  const fam = isIP(p);
  return fam !== 0 && bl.check(p, fam === 6 ? 'ipv6' : 'ipv4');
}

/** Normalised source key of a request (see module doc). */
export function sourceKey(req: IncomingMessage): string {
  let addr = req.socket?.remoteAddress ?? '';
  const hops = envInt(process.env['OTK_PROXY_TRUSTED_HOPS'], 0);
  if (hops > 0 && peerIsTrustedProxy(addr)) {
    const xff = req.headers?.['x-forwarded-for'];
    const list = (Array.isArray(xff) ? xff.join(',') : (xff ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
    const pick = list[list.length - hops];
    const ip = pick ? xffAddress(pick) : null;
    if (ip) addr = ip;
  }
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  if (addr.includes(':')) {
    // IPv6: /64 prefix (expand "::" just enough to take the first four groups)
    const [head = '', tail = ''] = addr.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
    return `ip6:${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
  }
  return addr ? `ip4:${addr}` : 'unknown';
}

let _proxyLimiter: AuthFailureLimiter | null = null;
/** undefined = automatic (the distributed rate limiter when it is not the in-memory default); null = none */
let _sharedOverride: IDistributedRateLimiter | null | undefined;

/**
 * Shared counter of the proxy limiter: the explicit override when set, else the process distributed rate limiter when it
 * is a shared backend (Redis, set by storeBootstrap), else none. Resolved on every failure, so a backend configured after
 * the first request is picked up.
 */
function _proxySharedCounter(): IDistributedRateLimiter | null {
  if (_sharedOverride !== undefined) return _sharedOverride;
  const d = getDistributedRateLimiter();
  return d instanceof MemoryDistributedRateLimiter ? null : d;
}

/** Override the shared counter of the proxy limiter (undefined restores the automatic choice). */
export function setProxyAuthFailureSharedCounter(counter: IDistributedRateLimiter | null | undefined): void {
  _sharedOverride = counter;
}

/** Process-wide limiter of the MITM proxy (configured from the environment on first use). */
export function getProxyAuthFailureLimiter(): AuthFailureLimiter {
  if (!_proxyLimiter) {
    _proxyLimiter = new AuthFailureLimiter({
      max: envInt(process.env['OTK_PROXY_AUTH_FAIL_MAX'], 20),
      windowMs: envInt(process.env['OTK_PROXY_AUTH_FAIL_WINDOW_MS'], 60_000) || 60_000,
      maxEntries: envInt(process.env['OTK_PROXY_AUTH_FAIL_MAX_SOURCES'], 10_000) || 10_000,
    }, _proxySharedCounter);
  }
  return _proxyLimiter;
}

/** @internal Test only: forget every source (and re-read the configuration on next use). */
export function resetProxyAuthFailureLimiterForTest(): void {
  _proxyLimiter = null;
}
