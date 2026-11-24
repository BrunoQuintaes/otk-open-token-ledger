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
 */

/** Política de bucket por tier de uso. */
export type BucketPolicy = "small" | "medium" | "large" | "custom";

export interface BucketConfig {
  policy: BucketPolicy;
  /** Step em CU (ex: 100n para small, 1000n para medium). */
  step: bigint;
}

/** Resolve config de bucket dado um CU bruto (auto-tier). */
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
 */
export function quantizeToBucket(cu: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("step must be > 0");
  const rem = cu % step;
  return rem === 0n ? cu : cu - rem + step;
}

/**
 * Retorna o bucket inferior e superior para um CU quantizado.
 * Útil para range proof: prova que CU_real ∈ [lower, upper].
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
