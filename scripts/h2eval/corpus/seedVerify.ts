/**
 * H2-EVAL / R13 — varredura de semente nunca usada, repetida no congelamento (CONTRACT_MIN R2 item 13, R09 R2 §1). SOMENTE LEITURA:
 * `git grep -w <semente>` em cada ref de um repositório existente (sem checkout, sem escrita). O resultado vira `seed_verification.json`.
 * A prova de ausência vale só para os refs varridos; um ref que não resolve é registrado como NOT_SCANNED e nunca conta como "limpo".
 *
 * In English: read-only proof that a candidate seed never appears in the earlier evaluation branches, by running
 * `git grep -w <seed>` on each ref (no checkout, no writes). The result becomes `seed_verification.json`. Absence holds
 * only for the scanned refs; a ref that does not resolve is recorded as not scanned and the verdict is then
 * `INCOMPLETE_SCAN`, never clean. Called by `corpus/build.ts`.
 *
 * @module scripts/h2eval/corpus/seedVerify
 */
import { spawnSync } from 'node:child_process';

/** Git refs scanned by default: the evaluated commit and the earlier calibration and integration branches. */
export const DEFAULT_SCAN_REFS: readonly string[] = Object.freeze([
  '7606bc9b', 'origin/experiment/otk-cal-anth-01-20261014', 'origin/experiment/otk-cal-anth-02-20261015',
  'origin/exp/h1plus-cal-anth-integration-20261015', 'origin/exp/otk-night01-h1plus-hardening', 'origin/experiment/otk-bot-realuse-01-20261022',
]);

/** Scan result of one ref; `files` lists at most 50 paths that contain the seed as a whole word. */
export interface SeedRefScan { ref: string; commit: string | 'NOT_RESOLVED'; scanned: boolean; filesContainingSeed: number; files: string[] }
/** Content of `seed_verification.json`; `verdict` is `FOUND`, `NOT_FOUND_IN_SCANNED_REFS` or `INCOMPLETE_SCAN`. */
export interface SeedVerification {
  schema: 'otk.h2eval.seed_verification.v1'; candidateSeed: string; repo: string; method: string; refs: SeedRefScan[];
  candidateFoundInAnyRef: boolean; allRefsScanned: boolean; verdict: 'NOT_FOUND_IN_SCANNED_REFS' | 'FOUND' | 'INCOMPLETE_SCAN'; limits: string[];
}

const git = (repo: string, args: string[]): { status: number | null; out: string } => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: r.stdout ?? '' };
};

/**
 * Scans each ref of a local git repository for the seed, read-only.
 *
 * @param seed - Candidate seed.
 * @param repo - Path of an existing git clone (only read).
 * @param refs - Refs to scan (default {@link DEFAULT_SCAN_REFS}).
 * @returns The verification record; `FOUND` wins over an incomplete scan. Git failures are recorded, not thrown.
 */
export function verifySeedUnused(seed: number, repo: string, refs: readonly string[] = DEFAULT_SCAN_REFS): SeedVerification {
  const scans: SeedRefScan[] = refs.map((ref) => {
    const rp = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (rp.status !== 0) return { ref, commit: 'NOT_RESOLVED', scanned: false, filesContainingSeed: 0, files: [] };
    const g = git(repo, ['grep', '-w', '-l', '-I', '-e', String(seed), ref]);
    if (g.status !== 0 && g.status !== 1) return { ref, commit: rp.out.trim(), scanned: false, filesContainingSeed: 0, files: [] }; // 1 = nenhuma ocorrência; outro = erro
    const files = g.out.split('\n').filter(Boolean).map((l) => l.replace(`${ref}:`, ''));
    return { ref, commit: rp.out.trim(), scanned: true, filesContainingSeed: files.length, files: files.slice(0, 50) };
  });
  const found = scans.some((s) => s.filesContainingSeed > 0); const all = scans.every((s) => s.scanned);
  return { schema: 'otk.h2eval.seed_verification.v1', candidateSeed: String(seed), repo, method: 'git grep -w -l <semente> em cada ref (somente leitura)', refs: scans, candidateFoundInAnyRef: found, allRefsScanned: all,
    verdict: found ? 'FOUND' : all ? 'NOT_FOUND_IN_SCANNED_REFS' : 'INCOMPLETE_SCAN',
    limits: ['prova de ausência só vale para os refs varridos', 'não varre repositórios fora de `repo`', 'ref não resolvido = NOT_SCANNED (nunca "limpo")'] };
}
