/**
 * CU Bucketing — Privacy quantization
 *
 * Quantiza CU para a próxima faixa (bucket) determinística.
 * Publicado on-chain no lugar do CU exato para limitar inferência de volume.
 *
 * ADR: docs/architecture/adr/ADR-0101-privacy-bucketing-rangeproof.md
 *
 * Nota: Esta implementação existe em src/economics/CUEngine.ts (modo bucketed).
 * Este módulo expõe a função isolada + tipos de política formal.
 *
 * (English) Legacy CU bucketing for on-chain publication: rounds a CU value up to a multiple of a step chosen
 * by size tier. Used by `src/batch/BatchAggregator.ts`. The v3 public bucket policy is in
 * `publicBucketPolicy.ts`. Pure functions; no I/O.
 *
 * @module src/privacy/bucketing
 */

/** Política de bucket por tier de uso. */
export type BucketPolicy = "small" | "medium" | "large" | "custom";

/** Bucket tier and its step (CU). */
export interface BucketConfig {
  policy: BucketPolicy;
  /** Step em CU (ex: 100n para small, 1000n para medium). */
  step: bigint;
}

/**
 * Resolve config de bucket dado um CU bruto (auto-tier).
 *
 * @param cuRaw - Exact CU.
 * @returns `small` (step 100) below 10 000 CU, `medium` (step 1 000) below 1 000 000 CU, else `large` (step 10 000).
 */
export function resolveBucketConfig(cuRaw: bigint): BucketConfig {
  // TODO(U8.7.1): aplicar política tiered conforme ADR-0101:
  //   small  (<  10_000n CU): step = 100n
  //   medium (< 1_000_000n CU): step = 1_000n
  //   large  (>= 1_000_000n CU): step = 10_000n
  if (cuRaw < 10_000n) return { policy: "small", step: 100n };
  if (cuRaw < 1_000_000n) return { policy: "medium", step: 1_000n };
  return { policy: "large", step: 10_000n };
}

/**
 * Quantiza CU para o próximo múltiplo de `step` (round-up determinístico).
 *
 * Exemplos:
 *   quantizeToBucket(1234n, 100n) === 1300n
 *   quantizeToBucket(1300n, 100n) === 1300n  (exato, sem arredondamento)
 *   quantizeToBucket(1301n, 100n) === 1400n
 *
 * @param cu - CU value (>= 0 expected; negative values are not rejected).
 * @param step - Bucket step (> 0).
 * @returns The smallest multiple of `step` that is >= `cu`.
 * @throws {Error} When `step` <= 0.
 */
export function quantizeToBucket(cu: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("step must be > 0");
  const rem = cu % step;
  return rem === 0n ? cu : cu - rem + step;
}

/**
 * Retorna o bucket inferior e superior para um CU quantizado.
 * Útil para range proof: prova que CU_real ∈ [lower, upper].
 *
 * @param cuBucketed - A value returned by {@link quantizeToBucket}.
 * @param step - The same step.
 * @returns `[cuBucketed - step + 1, cuBucketed]` (lower is negative for a 0 bucket).
 * @throws {Error} When `step` <= 0.
 */
export function bucketBounds(
  cuBucketed: bigint,
  step: bigint
): { lower: bigint; upper: bigint } {
  if (step <= 0n) throw new Error("step must be > 0");
  return {
    lower: cuBucketed - step + 1n,
    upper: cuBucketed,
  };
}
