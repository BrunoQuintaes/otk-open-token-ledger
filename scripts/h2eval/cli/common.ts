/**
 * R15 CLI — shared helpers. No network, no credential values: environment is read by NAME only for presence (never printed),
 * paths and fixed values come from H2EVAL_* (R16) or flags. Exit codes are stable (see EXIT).
 *
 * Used by every `scripts/h2eval/cli/*` command: argument parsing, the stable exit codes and {@link CliError}, small
 * hashing and JSON file helpers, the model-id tables (corpus id to matrix id, provider, API and local tokenizer
 * encoding), the presence-only view of the executor environment (variable names from `H2EVAL_ENV_NAMES` in
 * `../core/egress.ts`), the git identity of the executor checkout and an exclusive directory lock. It runs `git` as a
 * child process (read-only) and writes only the files a caller asks for.
 *
 * @module scripts/h2eval/cli/common
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

/**
 * Process exit codes of the CLI: 0 OK, 2 usage error, 3 refused by policy, 4 invalid plan, 5 stopped (a run halted before
 * the end, or a verification did not pass), 6 preconditions of a real (paid) run not met, 7 internal error.
 */
export const EXIT = Object.freeze({ OK: 0, USAGE: 2, REFUSED_BY_POLICY: 3, PLAN_INVALID: 4, STOPPED: 5, REAL_PRECONDITIONS: 6, INTERNAL: 7 });

/** Error that ends a CLI command with a given exit code (`exit`, one of {@link EXIT}) and a stable `code`; the message is `<code>: <msg>`. */
export class CliError extends Error { constructor(public readonly exit: number, public readonly code: string, msg: string) { super(`${code}: ${msg}`); this.name = 'CliError'; } }

/** Parsed command line: the subcommand (`null` when the first argument is an option), `--key value` / `--flag` options and positional arguments. */
export interface Args { cmd: string | null; opts: Record<string, string | true>; rest: string[] }
/**
 * Parses `argv` (without the node and script paths): an optional leading subcommand, then `--key value` pairs; an
 * option followed by another option or by nothing is a boolean flag (`true`).
 *
 * @param argv - Arguments; not mutated.
 * @returns The parsed arguments.
 */
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
/**
 * Reads a string option.
 *
 * @param a - Parsed arguments.
 * @param k - Option name without `--`.
 * @returns The value, or `undefined` when absent or given as a bare flag.
 */
export const optStr = (a: Args, k: string): string | undefined => (typeof a.opts[k] === 'string' ? (a.opts[k] as string) : undefined);
/**
 * Reads a boolean flag.
 *
 * @param a - Parsed arguments.
 * @param k - Option name without `--`.
 * @returns `true` when given bare or as `--k true`.
 */
export const optFlag = (a: Args, k: string): boolean => a.opts[k] === true || a.opts[k] === 'true';
/**
 * Reads a numeric option.
 *
 * @param a - Parsed arguments.
 * @param k - Option name without `--`.
 * @param dflt - Value when the option is absent.
 * @returns The number.
 * @throws {@link CliError} With exit USAGE and code `BAD_NUMBER` when the value is not a finite number.
 */
export function optNum(a: Args, k: string, dflt: number): number { const v = optStr(a, k); if (v === undefined) return dflt; const n = Number(v); if (!Number.isFinite(n)) throw new CliError(EXIT.USAGE, 'BAD_NUMBER', `--${k}`); return n; }

/**
 * SHA-256 of a file's bytes.
 *
 * @param p - File path.
 * @returns Lowercase hex digest.
 */
export const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
/**
 * SHA-256 of a string encoded as UTF-8.
 *
 * @param s - Text.
 * @returns Lowercase hex digest.
 */
export const sha256Text = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/**
 * Reads and parses a JSON file (no schema validation; the type is the caller's assertion).
 *
 * @param p - File path.
 * @returns The parsed value.
 */
export const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
/**
 * Reads a JSON Lines file, skipping empty lines.
 *
 * @param p - File path.
 * @returns One parsed value per non-empty line.
 */
export const readJsonl = <T>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
/**
 * Writes a value as JSON (one-space indent, BigInt as decimal text, final newline), creating the parent folder.
 * Overwrites an existing file.
 *
 * @param p - File path.
 * @param v - Value to write.
 */
export function writeJson(p: string, v: unknown): void { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 1) + '\n'); }
/**
 * Creates a folder that must not exist yet, so an output folder is never overwritten.
 *
 * @param p - Folder path.
 * @throws {@link CliError} With exit USAGE and code `DIR_EXISTS` when the path already exists.
 */
export function requireNewDir(p: string): void { if (existsSync(p)) throw new CliError(EXIT.USAGE, 'DIR_EXISTS', `${p} already exists (never overwritten)`); mkdirSync(p, { recursive: true }); }

/** Corpus model ids (R13) → exact API ids of the matrix (R08 §1). */
export const MODEL_ID_TO_MATRIX: Readonly<Record<ModelId, MatrixModel>> = Object.freeze({ 'gpt-4o-mini': 'gpt-4o-mini-2024-07-18', 'claude-haiku-4-5': 'claude-haiku-4-5-20251001', 'claude-haiku-5-5': 'claude-haiku-5-5', 'gemini-3.5-flash-lite': 'gemini-3.5-flash-lite' }); // corpus S1 ids: ONLY the four legacy models (adding to ModelId would change the frozen corpus); the pilot models do not use the S1 corpus
/** Provider of each matrix model id. */
export const MATRIX_TO_PROVIDER: Readonly<Record<MatrixModel, 'openai' | 'anthropic' | 'google'>> = Object.freeze({ 'gpt-4o-mini-2024-07-18': 'openai', 'claude-haiku-4-5-20251001': 'anthropic', 'claude-haiku-5-5': 'anthropic', 'claude-sonnet-5-5': 'anthropic', 'claude-opus-5-5': 'anthropic', 'gemini-3.5-flash-lite': 'google', 'gemini-3.1-flash-lite': 'google', 'gpt-6-luna': 'openai' });
/** API family each matrix model is called through. */
export const MATRIX_TO_API = Object.freeze({ 'gpt-4o-mini-2024-07-18': 'openai.chat_completions', 'claude-haiku-4-5-20251001': 'anthropic.messages', 'claude-haiku-5-5': 'anthropic.messages', 'claude-sonnet-5-5': 'anthropic.messages', 'claude-opus-5-5': 'anthropic.messages', 'gemini-3.5-flash-lite': 'gemini.generate_content', 'gemini-3.1-flash-lite': 'gemini.generate_content', 'gpt-6-luna': 'openai.chat_completions' } as const);
/** Local tokenizer encoding used for estimates per matrix model (an approximation for non-OpenAI models, never the provider's count). */
export const MATRIX_TO_ENCODING: Readonly<Record<MatrixModel, 'o200k_base' | 'cl100k_base'>> = Object.freeze({ 'gpt-4o-mini-2024-07-18': 'o200k_base', 'claude-haiku-4-5-20251001': 'cl100k_base', 'claude-haiku-5-5': 'cl100k_base', 'claude-sonnet-5-5': 'cl100k_base', 'claude-opus-5-5': 'cl100k_base', 'gemini-3.5-flash-lite': 'cl100k_base', 'gemini-3.1-flash-lite': 'cl100k_base', 'gpt-6-luna': 'o200k_base' }); // E3G arm: local estimates only (approximate encodings), never the provider count

/**
 * Local text token counters (js-tiktoken) by encoding, or null when the package is unavailable (then estimates are UNKNOWN, never 0).
 *
 * @returns A counter per encoding (empty text counts 0 tokens), or `null` when `js-tiktoken` cannot be loaded.
 */
export function loadTextCounters(): Record<'o200k_base' | 'cl100k_base', (t: string) => number> | null {
  try {
    const req = createRequire(import.meta.url);
    const { Tiktoken } = req('js-tiktoken') as { Tiktoken: new (r: unknown) => { encode(t: string, a: string[], d: string[]): number[] } };
    const mk = (n: string) => { const r = req(`js-tiktoken/ranks/${n}`) as { default?: unknown }; const e = new Tiktoken(r.default ?? r); return (t: string) => (t.length === 0 ? 0 : e.encode(t, [], []).length); };
    return { o200k_base: mk('o200k_base'), cl100k_base: mk('cl100k_base') };
  } catch { return null; }
}

/**
 * Presence-only view of the executor environment (R16 names). Values are never returned.
 *
 * Exception: the path-like settings (GO file, batch folder, stop file, env file) and the campaign budget are returned
 * as their values, because they are paths or numbers, not credentials. Credentials are reported only as booleans.
 *
 * @param env - Environment to inspect; defaults to `process.env`. Not mutated.
 * @returns Credential presence per provider, the path/budget settings (`null` when unset), the names of forbidden
 *   variables that are set, and the names outside the launch allowlist.
 */
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

/**
 * R15-P2-1: executor code identity is ALWAYS read from git (HEAD + porcelain); an override is only accepted when it names that same HEAD.
 *
 * @param root - Repository folder of the executor checkout.
 * @returns The HEAD commit and whether the working tree has no changes (`git status --porcelain` empty).
 * @throws {@link CliError} With exit INTERNAL and code `NO_GIT_SHA` when git cannot be run or HEAD cannot be read.
 */
export function executorIdentity(root: string): { sha: string; clean: boolean } {
  try {
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const porcelain = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    return { sha, clean: porcelain.length === 0 };
  } catch { throw new CliError(EXIT.INTERNAL, 'NO_GIT_SHA', 'cannot read git HEAD of the executor checkout'); }
}
/**
 * Returns the executor's HEAD commit, checking an optional override against it.
 *
 * @param root - Repository folder of the executor checkout.
 * @param override - Optional abbreviated or full commit given on the command line; it must be a prefix of HEAD.
 * @returns The full HEAD commit (never the override).
 * @throws {@link CliError} `NO_GIT_SHA` when git fails, `BAD_SHA` (USAGE) for a malformed override, or
 *   `EXECUTOR_SHA_MISMATCH` (REFUSED_BY_POLICY) when the override does not name HEAD.
 */
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
/**
 * Takes the exclusive lock file of a study or campaign folder, so only one paid operation runs at a time.
 *
 * A lock held by a live process other than this one is refused; a lock whose process is gone (or unreadable) is
 * removed and taken over. Creates the folder when missing.
 *
 * @param dir - Folder to lock.
 * @param name - Lock file name inside the folder; default `.campaign.lock`.
 * @returns A release function that deletes the lock file (safe to call twice).
 * @throws {@link DirLockedError} When another live process holds the lock.
 */
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

/** Absolute path of the repository root, derived from this file's location (three folders up), with Windows drive paths fixed. */
export const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');
