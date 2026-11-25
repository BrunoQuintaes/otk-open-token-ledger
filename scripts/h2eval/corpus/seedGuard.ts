/**
 * H2-EVAL / R13 — a semente do corpus novo NUNCA pode repetir uma semente já usada (R09 §1, R09 R2 §1, decisão D-3 do R10).
 * A lista fixa vem de SEED_VERIFICATION_R2.json (`seedsAlreadyUsedFound`, varredura só por leitura dos refs H1, CAL-ANTH-01/02,
 * integração H1+CAL, night01 e bot-realuse) mais as sementes lidas diretamente nos manifestos. Qualquer outra semente usada por rodada
 * que não esteja aqui entra em `extraForbidden` (arquivo `--forbidden-seeds`) e é re-verificada por `verifySeedUnused` (seedVerify.ts).
 *
 * In English: refuses a corpus seed that was already used by an earlier corpus (fixed list below plus an operator file
 * given with `--forbidden-seeds`), so a new corpus never repeats old texts. Called by `corpus/build.ts`,
 * `corpus/s1Corpus.ts` and `cache/dialogs.ts`. The git scan of other refs is in `seedVerify.ts`.
 *
 * @module scripts/h2eval/corpus/seedGuard
 */
/** Default seed (the pre-registration date); a different seed may be passed with `--seed`. */
export const DEFAULT_SEED = 20261110; // data do pré-registro (R09 R2 §1); é só o PADRÃO, o autor pode passar outra

/** Seeds already used by earlier corpora, each with the reason (where it was found). */
export const FORBIDDEN_SEEDS: Readonly<Record<number, string>> = Object.freeze({
  1103515245: 'SEED_VERIFICATION_R2: valor encontrado nos refs varridos (constante de gerador congruencial); tratado como usado',
  20260930: 'H1: CORPUS_SEED padrão de scripts/calibration/corpus.ts (corpus de desenvolvimento)',
  20261003: 'SEED_VERIFICATION_R2: encontrado nos refs varridos',
  20261006: 'H1: semente "final" de scripts/calibration/buildProfiles.ts',
  20261007: 'H1: campanha OVERNIGHT 2 (CAMPAIGN_CORPUS em runPilotV3.ts)',
  20261014: 'CAL-ANTH-01: corpusSeed (EXPERIMENT_MANIFEST.json / CORPUS_MANIFEST.json)',
  20261015: 'SEED_VERIFICATION_R2: encontrado nos refs varridos (CAL-ANTH-02)',
  20261016: 'CAL-ANTH-02: semente do holdout (HOLDOUT_MANIFEST.json, namespace cal2ho)',
  211920641: 'CAL-ANTH-01: splitSeed (0x0ca1a701)',
});

/** Raised when a seed is not acceptable; `code` says why (not an integer, out of range, or already used). */
export class SeedRejectedError extends Error {
  readonly code: 'SEED_NOT_INTEGER' | 'SEED_OUT_OF_RANGE' | 'SEED_ALREADY_USED';
  constructor(code: SeedRejectedError['code'], message: string) { super(message); this.name = 'SeedRejectedError'; this.code = code; }
}

/**
 * Lança se a semente não for inteira em [1, 2^32-1] ou se já foi usada (lista fixa + `extraForbidden`).
 *
 * @param seed - Candidate seed.
 * @param extraForbidden - More forbidden seeds (from the operator's `--forbidden-seeds` file).
 * @returns The seed, typed as a number, when it is acceptable.
 * @throws {SeedRejectedError} `SEED_NOT_INTEGER`, `SEED_OUT_OF_RANGE` (outside [1, 4294967295]) or `SEED_ALREADY_USED`.
 */
export function assertFreshSeed(seed: unknown, extraForbidden: readonly number[] = []): number {
  if (typeof seed !== 'number' || !Number.isInteger(seed)) throw new SeedRejectedError('SEED_NOT_INTEGER', 'a semente tem de ser um número inteiro');
  if (seed < 1 || seed > 0xffffffff) throw new SeedRejectedError('SEED_OUT_OF_RANGE', 'a semente tem de estar em [1, 4294967295]');
  const why = FORBIDDEN_SEEDS[seed] ?? (extraForbidden.includes(seed) ? 'lista extra de sementes proibidas (arquivo do operador)' : null);
  if (why) throw new SeedRejectedError('SEED_ALREADY_USED', `semente ${seed} já foi usada: ${why}`);
  return seed;
}
