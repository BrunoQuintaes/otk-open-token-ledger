/**
 * CYCLE2-B (proposal C147, NOT adopted; incident R17-001): `preflight-connectivity` — a probe WITHOUT credential, run in the SAME
 * environment (same node binary, same env var NAMES, same CA policy) that will launch the executor, mandatory before any REAL run.
 *   1. TLS: `tls.connect` to the provider host with full verification (rejectUnauthorized is ALWAYS true; never configurable here); records
 *      issuer, subject, leaf fingerprint (sha256), validity and protocol. A verification failure ⇒ FAIL with the non-secret code.
 *   2. HTTP: one unauthenticated GET to a documented endpoint; the expected answer is a 401 (403 accepted for Google). Anything else ⇒ FAIL.
 *      No credential header is ever built: this module never reads a credential variable nor the env file.
 *   3. The result is appended to the CAMPAIGN journal (<campaignDir>/campaign_journal.jsonl, same hash-chained format as a batch journal,
 *      kind PREFLIGHT_CONNECTIVITY, operationId NONE) with an `envFingerprint` = sha256 of (node version, sorted env var NAMES — never values —,
 *      NODE_EXTRA_CA_CERTS path presence + sha256 of that file, NODE_USE_SYSTEM_CA value). `run --mode real` / `run-authorized --mode real`
 *      refuse (exit 6) unless the latest preflight of EVERY provider in scope is PASS, younger than PREFLIGHT_MAX_AGE_MS and carries the
 *      SAME envFingerprint as the executor process (PREFLIGHT_CONNECTIVITY_MISSING / _FAILED / _STALE / PREFLIGHT_ENV_MISMATCH).
 * Nothing here disables verification, follows redirects or retries. Tests inject the probes (no network, no credential).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Provider } from '../types.js';
import { sha256Canon } from '../core/canon.js';
import { classifySendFailure, H2EVAL_ENV_NAMES } from '../core/egress.js';
import { openJournal, verifyJournalText, type Journal } from '../core/journal.js';

export const PREFLIGHT_SCHEMA = 'h2eval.preflight_connectivity.v0';
export const CAMPAIGN_JOURNAL = 'campaign_journal.jsonl';
export const PREFLIGHT_MAX_AGE_MS = 60 * 60 * 1000;
export const PREFLIGHT_TIMEOUT_MS = 15_000;

/** Documented unauthenticated endpoints (GET). The expected status without credential is 401 (Google answers 403 PERMISSION_DENIED). */
export const PROVIDER_PROBES: Readonly<Record<Provider, { host: string; path: string; expectedStatus: readonly number[] }>> = Object.freeze({
  anthropic: { host: 'api.anthropic.com', path: '/v1/models', expectedStatus: [401] },
  openai: { host: 'api.openai.com', path: '/v1/models', expectedStatus: [401] },
  google: { host: 'generativelanguage.googleapis.com', path: '/v1beta/models', expectedStatus: [401, 403] },
});

export interface TlsProbeResult { authorized: boolean; authorizationError: string | null; issuer: string; subject: string; fingerprint256: string; validFrom: string; validTo: string; protocol: string | null }
export interface HttpProbeResult { status: number }
export interface PreflightProbes { tls: (host: string, timeoutMs: number) => Promise<TlsProbeResult>; http: (url: string, timeoutMs: number) => Promise<HttpProbeResult> }

const ident = (v: unknown): string => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(v) ? v : 'UNKNOWN');
const short = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, max) : 'UNKNOWN');
const dn = (v: unknown): string => { if (!v || typeof v !== 'object') return 'UNKNOWN'; const o = v as Record<string, unknown>; return short(['CN', 'O', 'OU'].filter((k) => typeof o[k] === 'string').map((k) => `${k}=${String(o[k])}`).join(', ') || 'UNKNOWN'); };

/** Default probes: node:tls with full verification (hard-coded `rejectUnauthorized: true`) and the global fetch WITHOUT any credential header. */
export const defaultProbes: PreflightProbes = {
  tls: (host, timeoutMs) => new Promise<TlsProbeResult>((resolve, reject) => {
    void import('node:tls').then((tls) => {
      const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      const t = setTimeout(() => { s.destroy(); reject(Object.assign(new Error('tls probe timeout'), { code: 'ERR_TLS_HANDSHAKE_TIMEOUT' })); }, timeoutMs);
      s.once('secureConnect', () => {
        clearTimeout(t);
        const c = s.getPeerCertificate(false);
        const ae = s.authorizationError as unknown as string | { code?: unknown; message?: unknown } | undefined;
        const aeCode = typeof ae === 'string' ? ae : ae && typeof ae === 'object' ? (ae.code ?? ae.message) : undefined;
        resolve({ authorized: s.authorized, authorizationError: s.authorized ? null : ident(aeCode), issuer: dn(c?.issuer), subject: dn(c?.subject), fingerprint256: short(c?.fingerprint256, 95), validFrom: short(c?.valid_from, 40), validTo: short(c?.valid_to, 40), protocol: s.getProtocol() });
        s.end();
      });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    }, reject);
  }),
  http: async (url, timeoutMs) => {
    const r = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    try { await r.arrayBuffer(); } catch { /* body irrelevant */ }
    return { status: r.status };
  },
};

/** sha256 over the environment SHAPE (never values): node version, sorted env var names, CA policy (path presence + file digest, system CA flag). */
/** VNEXT-8 (B06 R17-C2-2/3): the executor's OWN variables (H2EVAL_*) are excluded — the probe runs without the credential file name by procedure — and the Node command-line flags (execArgv, e.g. --use-system-ca) are included, since they change the trust policy without touching the env. */
export function envFingerprint(env: NodeJS.ProcessEnv = process.env, nodeVersion = process.version, execArgv: readonly string[] = process.execArgv): string {
  const caPath = typeof env['NODE_EXTRA_CA_CERTS'] === 'string' && env['NODE_EXTRA_CA_CERTS'] !== '' ? env['NODE_EXTRA_CA_CERTS'] : null;
  let caSha: string | null = null;
  if (caPath) { try { caSha = createHash('sha256').update(readFileSync(caPath)).digest('hex'); } catch { caSha = 'UNREADABLE'; } }
  return sha256Canon({ nodeVersion, names: Object.keys(env).filter((k) => typeof env[k] === 'string' && !/^H2EVAL_/i.test(k)).sort(), execArgv: [...execArgv].sort(), caPathPresent: caPath !== null, caSha256: caSha, useSystemCa: typeof env['NODE_USE_SYSTEM_CA'] === 'string' ? env['NODE_USE_SYSTEM_CA'] : null });
}

export interface PreflightBody { schema: typeof PREFLIGHT_SCHEMA; provider: Provider; host: string; verdict: 'PASS' | 'FAIL'; failCode: string | null; tls: { authorized: boolean; authorizationError: string | null; issuer: string; subject: string; fingerprint256: string; validFrom: string; validTo: string; protocol: string | null } | null; http: { status: number | null; expected: number[] } | null; elapsedMs: number; nodeVersion: string; envFingerprint: string; caPathPresent: boolean; useSystemCa: string | null; forbiddenEnvPresent: string[] }

export interface PreflightOptions { campaignDir: string; provider: Provider; env?: NodeJS.ProcessEnv; probes?: PreflightProbes; now?: () => number; timeoutMs?: number; nodeVersion?: string; /** VNEXT-8 (R17-C2-3): Node flags folded into the fingerprint (default process.execArgv) */ execArgv?: readonly string[] }

export const campaignJournalPath = (campaignDir: string): string => path.join(campaignDir, CAMPAIGN_JOURNAL);
export function openCampaignJournal(campaignDir: string): Journal { return openJournal(campaignJournalPath(campaignDir)); }

/** Runs the two probes (TLS first; HTTP only when the TLS chain verified) and appends ONE journal line. Never throws for a probe failure (⇒ FAIL). */
export async function preflightConnectivity(o: PreflightOptions): Promise<PreflightBody> {
  const env = o.env ?? process.env; const probes = o.probes ?? defaultProbes; const now = o.now ?? (() => Date.now()); const timeoutMs = o.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const spec = PROVIDER_PROBES[o.provider]; if (!spec) throw new TypeError(`unknown provider ${String(o.provider)}`);
  const started = now();
  const forbiddenPresent = H2EVAL_ENV_NAMES.forbidden.filter((n) => typeof env[n] === 'string' && env[n] !== '');
  const body: PreflightBody = { schema: PREFLIGHT_SCHEMA, provider: o.provider, host: spec.host, verdict: 'FAIL', failCode: null, tls: null, http: null, elapsedMs: 0, nodeVersion: o.nodeVersion ?? process.version, envFingerprint: envFingerprint(env, o.nodeVersion ?? process.version, o.execArgv ?? process.execArgv), caPathPresent: typeof env['NODE_EXTRA_CA_CERTS'] === 'string' && env['NODE_EXTRA_CA_CERTS'] !== '', useSystemCa: typeof env['NODE_USE_SYSTEM_CA'] === 'string' ? env['NODE_USE_SYSTEM_CA'] : null, forbiddenEnvPresent: forbiddenPresent };
  try {
    const t = await probes.tls(spec.host, timeoutMs);
    body.tls = { authorized: t.authorized, authorizationError: t.authorized ? null : ident(t.authorizationError ?? 'UNKNOWN'), issuer: short(t.issuer), subject: short(t.subject), fingerprint256: short(t.fingerprint256, 95), validFrom: short(t.validFrom, 40), validTo: short(t.validTo, 40), protocol: t.protocol ? short(t.protocol, 16) : null };
    if (!t.authorized) body.failCode = `TLS_${body.tls.authorizationError}`;
    else {
      const h = await probes.http(`https://${spec.host}${spec.path}`, timeoutMs);
      body.http = { status: h.status, expected: [...spec.expectedStatus] };
      if (!spec.expectedStatus.includes(h.status)) body.failCode = 'HTTP_STATUS_UNEXPECTED';
    }
  } catch (e) {
    const c = classifySendFailure(e); body.failCode = body.tls ? `HTTP_${c.causeCode}` : `TLS_${c.causeCode}`;
    if (body.tls && !body.http) body.http = { status: null, expected: [...spec.expectedStatus] };
  }
  if (forbiddenPresent.length && !body.failCode) body.failCode = 'FORBIDDEN_ENV_PRESENT';
  body.elapsedMs = Math.max(0, now() - started);
  body.verdict = body.failCode ? 'FAIL' : 'PASS';
  openCampaignJournal(o.campaignDir).append('PREFLIGHT_CONNECTIVITY', 'NONE', body as unknown as Record<string, unknown>);
  return body;
}

export interface PreflightRecord { body: PreflightBody; tsUtc: string }
/** Latest PREFLIGHT_CONNECTIVITY line of a provider (verified chain), or null. */
export class CampaignJournalError extends Error { constructor(public readonly code: 'CAMPAIGN_JOURNAL_INTEGRITY', detail = '') { super(`campaign journal: ${code} ${detail}`); this.name = 'CampaignJournalError'; } }
export function latestPreflight(campaignDir: string, provider: Provider): PreflightRecord | null {
  const p = campaignJournalPath(campaignDir); if (!existsSync(p)) return null;
  let all: ReturnType<typeof verifyJournalText>; try { all = verifyJournalText(readFileSync(p, 'utf8')); } catch (e) { throw new CampaignJournalError('CAMPAIGN_JOURNAL_INTEGRITY', (e as Error).message.slice(0, 120)); } // VNEXT-8 (R17-C2-5): own code, fail-closed
  const lines = all.filter((l) => l.kind === 'PREFLIGHT_CONNECTIVITY' && (l.body as { provider?: string }).provider === provider);
  const last = lines.at(-1); return last ? { body: last.body as unknown as PreflightBody, tsUtc: last.tsUtc } : null;
}

export type PreflightGateCode = 'PREFLIGHT_CONNECTIVITY_MISSING' | 'PREFLIGHT_CONNECTIVITY_FAILED' | 'PREFLIGHT_CONNECTIVITY_STALE' | 'PREFLIGHT_ENV_MISMATCH';
/** Gate for REAL: the latest preflight of the provider must be PASS, fresh and taken in the same environment shape as THIS process. */
export function preflightGate(campaignDir: string, provider: Provider, o: { envFingerprint: string; nowMs: number; maxAgeMs?: number }): PreflightGateCode | null {
  const r = latestPreflight(campaignDir, provider); if (!r) return 'PREFLIGHT_CONNECTIVITY_MISSING';
  if (r.body.verdict !== 'PASS') return 'PREFLIGHT_CONNECTIVITY_FAILED';
  const age = o.nowMs - Date.parse(r.tsUtc); if (!Number.isFinite(age) || age < 0 || age > (o.maxAgeMs ?? PREFLIGHT_MAX_AGE_MS)) return 'PREFLIGHT_CONNECTIVITY_STALE';
  if (r.body.envFingerprint !== o.envFingerprint) return 'PREFLIGHT_ENV_MISMATCH';
  return null;
}
