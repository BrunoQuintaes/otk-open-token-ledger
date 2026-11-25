/**
 * R15 `freeze-corpus`: runs the E2E-01 corpus generator (scripts/h2eval/corpus/build.ts, unchanged) as a child process — seed by
 * parameter, seed-usage scan over the git refs, byte-level text collision, manifest with sha256 — and wraps the result in a
 * FREEZE_CANDIDATE.json. It does NOT freeze the study: the candidate waits for the author's ratification (G10); the block below is
 * left blank on purpose. No network; the only reads outside the output dir are git refs of the clone (read-only).
 *
 * The generator runs through the local `tsx` CLI (`node_modules/tsx/dist/cli.mjs` unless `tsxCli` is given) with the
 * repository root as working folder. Called by the CLI entry point (`./main.ts`).
 *
 * @module scripts/h2eval/cli/freeze
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CliError, EXIT, REPO_ROOT, readJson, sha256File, writeJson } from './common.js';

/**
 * Options of {@link freezeCorpus}, passed to the corpus generator as flags: output folder (must not exist), seed,
 * repository to scan for used seeds, S2/S3 dialog counts, prefix length in characters, the per-split plan file and
 * repeats; `noRepoScan` skips the seed scan, `h1CampaignCorpus` adds a reference corpus for the collision check and
 * `tsxCli` overrides the tsx path.
 */
export interface FreezeOptions { out: string; seed?: number; repo?: string; s2?: number; s3?: number; prefixChars?: number; /** C154: groups per S1 cell (generator default 8); 12 gives a holdout 1.5x larger with the same design */ groupsPerCell?: number; /** C154 (R5): arquivo JSON {cells:{<cellId>:{train,validation,holdout}}, dialogs:{S2_NOHIT|S3_HITATTEMPT:{...}}, pilotGroupsPerCell?} */ splitPlanFile?: string; /** C154 (R5): repeticoes por celula (padrao do gerador 3; 0 = sem repeticoes) */ repeatsPerCell?: number; noRepoScan?: boolean; h1CampaignCorpus?: string; tsxCli?: string; /** rehearsal only: accept a collision report with references that could not be compared (never for a freeze) */ allowNotCompared?: boolean }
/**
 * Content of `FREEZE_CANDIDATE.json`: status, generator code hash, corpus and manifest hashes, the SHA-256 of every
 * output file (the `content` folder excluded), the seed and collision verdicts, and an empty ratification block that
 * only the author fills in.
 */
export interface FreezeCandidate { schema: 'h2eval.freeze_candidate.v0'; /** E4: sha256 of the generator code files (manifest.generator.codeSha256) so a stale candidate is visible */ generatorCodeSha256: string; status: 'CANDIDATE_NOT_RATIFIED' | 'CANDIDATE_NOT_RATIFIED_INCOMPLETE_REFERENCES' | 'REJECTED_INCOMPLETE_REFERENCES'; notCompared: string[]; out: string; seed: number; corpusSha256: string; manifestSha256: string; files: Record<string, string>; seedVerdict: string; collisionVerdict: string; counts: unknown; generatorStdout: unknown; ratification: { ratified: null; ratifiedBy: null; ratifiedUtc: null; ratifiedHash: null; note: string } }

/**
 * Generates the corpus into `o.out` and writes `FREEZE_CANDIDATE.json` there.
 *
 * The candidate is written even when it is rejected, so the reason stays on disk.
 *
 * @param o - Freeze options.
 * @returns The candidate (not ratified).
 * @throws {@link CliError} USAGE `DIR_EXISTS` when `o.out` exists; `GENERATOR_FAILED` (REFUSED_BY_POLICY for generator
 *   exit 3 or 4, INTERNAL otherwise); REFUSED_BY_POLICY `COLLISION_REFS_INCOMPLETE` when a reference corpus could not
 *   be compared and `allowNotCompared` is not set.
 */
export function freezeCorpus(o: FreezeOptions): FreezeCandidate {
  if (existsSync(o.out)) throw new CliError(EXIT.USAGE, 'DIR_EXISTS', o.out);
  const tsx = o.tsxCli ?? path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const args = [tsx, path.join(REPO_ROOT, 'scripts', 'h2eval', 'corpus', 'build.ts'), '--out', o.out];
  if (o.seed !== undefined) args.push('--seed', String(o.seed));
  if (o.repo) args.push('--repo', o.repo);
  if (o.s2 !== undefined) args.push('--s2', String(o.s2));
  if (o.s3 !== undefined) args.push('--s3', String(o.s3));
  if (o.prefixChars !== undefined) args.push('--prefix-chars', String(o.prefixChars));
  if (o.groupsPerCell !== undefined) args.push('--groups-per-cell', String(o.groupsPerCell)); // C154
  if (o.splitPlanFile !== undefined) args.push('--split-plan', o.splitPlanFile); // C154 (R5)
  if (o.repeatsPerCell !== undefined) args.push('--repeats-per-cell', String(o.repeatsPerCell)); // C154 (R5)
  if (o.h1CampaignCorpus) args.push('--h1-campaign-corpus', o.h1CampaignCorpus);
  if (o.noRepoScan) args.push('--no-repo-scan');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.status !== 0) throw new CliError(r.status === 3 || r.status === 4 ? EXIT.REFUSED_BY_POLICY : EXIT.INTERNAL, 'GENERATOR_FAILED', `exit ${r.status}: ${(r.stderr || '').trim().slice(0, 400)}`);
  const stdout = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as { seed: number; corpusSha256: string; counts: unknown; seedVerdict: string; collisionVerdict: string };
  const files: Record<string, string> = {};
  for (const f of readdirSync(o.out).filter((x) => x !== 'content')) files[f] = sha256File(path.join(o.out, f));
  const manifest = readJson<{ corpusSha256: string; generator?: { codeSha256?: string } }>(path.join(o.out, 'manifest.json'));
  // R15-B1: a freeze candidate needs EVERY reference corpus compared; an absent reference is not silently skipped
  const notCompared = readJson<{ notCompared?: string[] }>(path.join(o.out, 'text_collision_report.json')).notCompared ?? [];
  const status: FreezeCandidate['status'] = notCompared.length === 0 ? 'CANDIDATE_NOT_RATIFIED' : o.allowNotCompared ? 'CANDIDATE_NOT_RATIFIED_INCOMPLETE_REFERENCES' : 'REJECTED_INCOMPLETE_REFERENCES';
  const cand: FreezeCandidate = { schema: 'h2eval.freeze_candidate.v0', generatorCodeSha256: manifest.generator?.codeSha256 ?? 'UNKNOWN', status, notCompared, out: o.out, seed: stdout.seed, corpusSha256: manifest.corpusSha256, manifestSha256: files['manifest.json']!, files, seedVerdict: stdout.seedVerdict, collisionVerdict: stdout.collisionVerdict, counts: stdout.counts, generatorStdout: stdout, ratification: { ratified: null, ratifiedBy: null, ratifiedUtc: null, ratifiedHash: null, note: 'G10: the author ratifies the pre-registration AND this corpus hash; until then nothing is frozen and no plan can be REAL' } };
  writeJson(path.join(o.out, 'FREEZE_CANDIDATE.json'), cand);
  if (status === 'REJECTED_INCOMPLETE_REFERENCES') throw new CliError(EXIT.REFUSED_BY_POLICY, 'COLLISION_REFS_INCOMPLETE', `references not compared: ${notCompared.join(', ')} (pass --h1-campaign-corpus / fix the clone; --allow-not-compared only for rehearsals)`);
  return cand;
}
