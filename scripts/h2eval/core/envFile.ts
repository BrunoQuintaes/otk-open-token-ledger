/**
 * R16 gap (EXECUTOR_GAP_ENV_FILE.md): credential loader by PATH (`H2EVAL_ENV_FILE`). The file is opened only inside the executor
 * process, only in REAL mode, only after the GO preflight, and only the single line `<VAR>=<value>` of the provider of the batch is
 * parsed; the value goes straight into the request header and the reference is dropped. Nothing here assigns to process.env, spawns,
 * logs, or exposes value / prefix / hash / length. Location checks (absolute, exists, outside any Git tree, outside sync folders, ACL
 * without wide groups) are metadata-only and mirror R16 `check_env_file_shape.mjs`; the checks are injectable for OFFLINE tests.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type EnvFileCode = 'ENV_FILE_NOT_ABSOLUTE' | 'ENV_FILE_MISSING' | 'ENV_FILE_IN_GIT_TREE' | 'ENV_FILE_IN_SYNC_FOLDER' | 'ENV_FILE_ACL' | 'ENV_FILE_SHAPE' | 'ENV_FILE_VAR_ABSENT' | 'ENV_FILE_VAR_DUPLICATE';
export class EnvFileRefused extends Error { constructor(public readonly code: EnvFileCode) { super(`env file refused: ${code}`); this.name = 'EnvFileRefused'; } }

export interface EnvFileChecks {
  /** walks up from the file's directory looking for a `.git` entry (R16: HOME of this machine is a Git tree) */
  insideGitTree?: (filePath: string) => boolean;
  insideSyncFolder?: (filePath: string) => boolean;
  /** true when the ACL grants a wide group (Everyone / Users / Authenticated Users) or inherits entries; null = cannot tell (refused) */
  aclWide?: (filePath: string) => boolean | null;
}

export const SYNC_FOLDER_RE = /(^|[\\/])(onedrive[^\\/]*|dropbox|google drive|googledrive|meu drive|icloud[^\\/]*|box|sync)([\\/]|$)/i;
export function defaultInsideGitTree(p: string): boolean {
  let d = path.dirname(path.resolve(p));
  for (let i = 0; i < 60; i += 1) { if (existsSync(path.join(d, '.git'))) return true; const up = path.dirname(d); if (up === d) break; d = up; }
  return false;
}
export const defaultInsideSyncFolder = (p: string): boolean => SYNC_FOLDER_RE.test(path.resolve(p));
export function defaultAclWide(p: string): boolean | null {
  if (process.platform === 'win32') {
    const r = spawnSync('icacls', [p], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    return /(Everyone|BUILTIN\\Users|Authenticated Users|Todos|Usu.rios)\b[^\r\n]*:\(/i.test(r.stdout) || /\(I\)/.test(r.stdout);
  }
  return (statSync(p).mode & 0o077) !== 0;
}

/** Location checks (metadata only; the file is NOT opened). Throws EnvFileRefused with a fixed code. */
export function checkEnvFileLocation(filePath: string | undefined, checks: EnvFileChecks = {}): string {
  if (!filePath || !path.isAbsolute(filePath)) throw new EnvFileRefused('ENV_FILE_NOT_ABSOLUTE');
  if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new EnvFileRefused('ENV_FILE_MISSING');
  if ((checks.insideGitTree ?? defaultInsideGitTree)(filePath)) throw new EnvFileRefused('ENV_FILE_IN_GIT_TREE');
  if ((checks.insideSyncFolder ?? defaultInsideSyncFolder)(filePath)) throw new EnvFileRefused('ENV_FILE_IN_SYNC_FOLDER');
  const acl = (checks.aclWide ?? defaultAclWide)(filePath);
  if (acl !== false) throw new EnvFileRefused('ENV_FILE_ACL');
  return filePath;
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/**
 * Reads ONLY the line of `varName` (strict: one definition, no quotes/whitespace/control characters, 20..400 printable ASCII chars; BOM
 * and CRLF tolerated). Other lines are never parsed beyond the name match. Returns the value; the caller must drop it after use.
 */
export function readEnvFileVar(filePath: string, varName: string): string {
  if (!NAME_RE.test(varName) || !varName.startsWith('H2EVAL_')) throw new EnvFileRefused('ENV_FILE_SHAPE');
  const text = readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const prefix = `${varName}=`;
  const hits = text.split(/\r?\n/).filter((l) => l.startsWith(prefix));
  if (hits.length === 0) throw new EnvFileRefused('ENV_FILE_VAR_ABSENT');
  if (hits.length > 1) throw new EnvFileRefused('ENV_FILE_VAR_DUPLICATE');
  const value = hits[0]!.slice(prefix.length);
  if (value.length < 20 || value.length > 400 || !/^[\x21-\x7e]+$/.test(value) || /["'`]/.test(value)) throw new EnvFileRefused('ENV_FILE_SHAPE');
  return value;
}
