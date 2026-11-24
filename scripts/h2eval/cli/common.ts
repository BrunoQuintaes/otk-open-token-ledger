/**
 * R15 CLI — shared helpers. No network, no credential values: environment is read by NAME only for presence (never printed),
 * paths and fixed values come from H2EVAL_* (R16) or flags. Exit codes are stable (see EXIT).
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MatrixModel } from '../modal/types.js';
import type { ModelId } from '../corpus/s1Plan.js';
import { H2EVAL_ENV_NAMES } from '../core/egress.js';

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, REFUSED_BY_POLICY: 3, PLAN_INVALID: 4, STOPPED: 5, REAL_PRECONDITIONS: 6, INTERNAL: 7 });

export class CliError extends Error { constructor(public readonly exit: number, public readonly code: string, msg: string) { super(`${code}: ${msg}`); this.name = 'CliError'; } }

export interface Args { cmd: string | null; opts: Record<string, string | true>; rest: string[] }
export function parseArgs(argv: readonly string[]): Args {
  const out: Args = { cmd: null, opts: {}, rest: [] };
  const a = [...argv];
  if (a.length && !a[0]!.startsWith('--')) out.cmd = a.shift()!;
  while (a.length) {
    const t = a.shift()!;
    if (t.startsWith('--')) { const k = t.slice(2); const v = a[0] !== undefined && !a[0]!.startsWith('--') ? a.shift()! : true; out.opts[k] = v; } else out.rest.push(t);
  }
  return out;
}
export const optStr = (a: Args, k: string): string | undefined => (typeof a.opts[k] === 'string' ? (a.opts[k] as string) : undefined);
export const optFlag = (a: Args, k: string): boolean => a.opts[k] === true || a.opts[k] === 'true';
export function optNum(a: Args, k: string, dflt: number): number { const v = optStr(a, k); if (v === undefined) return dflt; const n = Number(v); if (!Number.isFinite(n)) throw new CliError(EXIT.USAGE, 'BAD_NUMBER', `--${k}`); return n; }

export const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
export const sha256Text = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
export const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
export const readJsonl = <T>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
export function writeJson(p: string, v: unknown): void { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 1) + '\n'); }
export function requireNewDir(p: string): void { if (existsSync(p)) throw new CliError(EXIT.USAGE, 'DIR_EXISTS', `${p} already exists (never overwritten)`); mkdirSync(p, { recursive: true }); }

/** Corpus model ids (R13) → exact API ids of the matrix (R08 §1). */
export const MODEL_ID_TO_MATRIX: Readonly<Record<ModelId, MatrixModel>> = Object.freeze({ 'gpt-4o-mini': 'gpt-4o-mini-2024-07-18', 'claude-haiku-4-5': 'claude-haiku-4-5-20251001', 'claude-haiku-5-5': 'claude-haiku-5-5', 'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite' }); // corpus S1 ids: ONLY the four legacy models (adding to ModelId would change the frozen corpus); the pilot models do not use the S1 corpus
export const MATRIX_TO_PROVIDER: Readonly<Record<MatrixModel, 'openai' | 'anthropic' | 'google'>> = Object.freeze({ 'gpt-4o-mini-2024-07-18': 'openai', 'claude-haiku-4-5-20251001': 'anthropic', 'claude-haiku-5-5': 'anthropic', 'claude-sonnet-5-5': 'anthropic', 'claude-opus-5-5': 'anthropic', 'gemini-3.5-flash-lite': 'google', 'gemini-3.1-flash-lite': 'google', 'gpt-6-luna': 'openai' });
export const MATRIX_TO_API = Object.freeze({ 'gpt-4o-mini-2024-07-18': 'openai.chat_completions', 'claude-haiku-4-5-20251001': 'anthropic.messages', 'claude-haiku-5-5': 'anthropic.messages', 'claude-sonnet-5-5': 'anthropic.messages', 'claude-opus-5-5': 'anthropic.messages', 'gemini-3.5-flash-lite': 'gemini.generate_content', 'gemini-3.1-flash-lite': 'gemini.generate_content', 'gpt-6-luna': 'openai.chat_completions' } as const);
export const MATRIX_TO_ENCODING: Readonly<Record<MatrixModel, 'o200k_base' | 'cl100k_base'>> = Object.freeze({ 'gpt-4o-mini-2024-07-18': 'o200k_base', 'claude-haiku-4-5-20251001': 'cl100k_base', 'claude-haiku-5-5': 'cl100k_base', 'claude-sonnet-5-5': 'cl100k_base', 'claude-opus-5-5': 'cl100k_base', 'gemini-3.5-flash-lite': 'cl100k_base', 'gemini-3.1-flash-lite': 'cl100k_base', 'gpt-6-luna': 'o200k_base' }); // E3G arm: local estimates only (approximate encodings), never the provider count

/** Local text token counters (js-tiktoken) by encoding, or null when the package is unavailable (then estimates are UNKNOWN, never 0). */
export function loadTextCounters(): Record<'o200k_base' | 'cl100k_base', (t: string) => number> | null {
  try {
    const req = createRequire(import.meta.url);
    const { Tiktoken } = req('js-tiktoken') as { Tiktoken: new (r: unknown) => { encode(t: string, a: string[], d: string[]): number[] } };
    const mk = (n: string) => { const r = req(`js-tiktoken/ranks/${n}`) as { default?: unknown }; const e = new Tiktoken(r.default ?? r); return (t: string) => (t.length === 0 ? 0 : e.encode(t, [], []).length); };
    return { o200k_base: mk('o200k_base'), cl100k_base: mk('cl100k_base') };
  } catch { return null; }
}

/** Presence-only view of the executor environment (R16 names). Values are never returned. */
export function envPresence(env: NodeJS.ProcessEnv = process.env) {
  const present = (n: string) => typeof env[n] === 'string' && env[n] !== '';
  return {
    credentials: Object.fromEntries(Object.entries(H2EVAL_ENV_NAMES.credentials).map(([p, n]) => [p, present(n)])) as Record<'openai' | 'anthropic' | 'google', boolean>,
    goFile: present(H2EVAL_ENV_NAMES.goFile) ? env[H2EVAL_ENV_NAMES.goFile]! : null,
    batchDir: present(H2EVAL_ENV_NAMES.batchDir) ? env[H2EVAL_ENV_NAMES.batchDir]! : null,
    stopFile: present(H2EVAL_ENV_NAMES.stopFile) ? env[H2EVAL_ENV_NAMES.stopFile]! : null,
    budgetCampaignUsd: present(H2EVAL_ENV_NAMES.budgetCampaignUsd) ? env[H2EVAL_ENV_NAMES.budgetCampaignUsd]! : null,
    envFile: present(H2EVAL_ENV_NAMES.envFile) ? env[H2EVAL_ENV_NAMES.envFile]! : null,
    forbiddenPresent: H2EVAL_ENV_NAMES.forbidden.filter((n) => present(n)),
    /** VNEXT-4: variable NAMES outside the documented launch allowlist (and not H2EVAL_*); values never read. */
    unlisted: Object.keys(env).filter((n) => typeof env[n] === 'string' && !/^H2EVAL_/i.test(n) && !H2EVAL_ENV_NAMES.launchAllowlist.includes(n.toUpperCase())).sort(),
  };
}

/** R15-P2-1: executor code identity is ALWAYS read from git (HEAD + porcelain); an override is only accepted when it names that same HEAD. */
export function executorIdentity(root: string): { sha: string; clean: boolean } {
  try {
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const porcelain = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    return { sha, clean: porcelain.length === 0 };
  } catch { throw new CliError(EXIT.INTERNAL, 'NO_GIT_SHA', 'cannot read git HEAD of the executor checkout'); }
}
export function executorCodeSha(root: string, override?: string): string {
  const id = executorIdentity(root);
  if (override !== undefined) {
    if (!/^[0-9a-f]{7,64}$/.test(override)) throw new CliError(EXIT.USAGE, 'BAD_SHA', '--executor-sha');
    if (!id.sha.startsWith(override)) throw new CliError(EXIT.REFUSED_BY_POLICY, 'EXECUTOR_SHA_MISMATCH', `--executor-sha does not name the checked-out HEAD`);
  }
  return id.sha;
}
/** C144: exclusive lock file (wx) for a study/campaign directory: one paid operation at a time GLOBALLY. Live foreign pid => refused; stale => taken over. */
export class DirLockedError extends Error { constructor(public readonly lockPath: string, public readonly pid: number) { super(`directory locked by live pid ${pid}: ${lockPath}`); this.name = 'DirLockedError'; } }
export function acquireDirLock(dir: string, name = '.campaign.lock'): () => void {
  const { existsSync: ex, readFileSync: rf, unlinkSync: ul, writeFileSync: wf } = require('node:fs') as typeof import('node:fs');
  const lockPath = path.join(dir, name);
  if (ex(lockPath)) {
    let held: { pid?: number } = {}; try { held = JSON.parse(rf(lockPath, 'utf8')) as { pid?: number }; } catch { held = {}; }
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
    if (typeof held.pid === 'number' && held.pid !== process.pid && alive(held.pid)) throw new DirLockedError(lockPath, held.pid);
    ul(lockPath);
  }
  mkdirSync(dir, { recursive: true });
  wf(lockPath, JSON.stringify({ pid: process.pid, sinceUtc: new Date().toISOString() }), { flag: 'wx' });
  return () => { try { ul(lockPath); } catch { /* gone */ } };
}

export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');
