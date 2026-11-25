/**
 * Poseidon over BN254 as used by circomlib (circomlibjs reference implementation).
 * The wasm-backed instance is built once and cached; callers await `getPoseidon()`.
 *
 * @module src/zk/v3/poseidon
 */
import { buildPoseidon } from 'circomlibjs';

type PoseidonFn = ((inputs: bigint[]) => unknown) & { F: { toObject(x: unknown): bigint } };

let instance: Promise<PoseidonFn> | null = null;

/**
 * Returns the shared Poseidon instance, building it on first use.
 *
 * @returns A promise of the hash function (the same promise on every call).
 */
export function getPoseidon(): Promise<PoseidonFn> {
  if (!instance) instance = buildPoseidon() as Promise<PoseidonFn>;
  return instance;
}

/**
 * Poseidon(inputs) as a field element (bigint).
 *
 * @param inputs - Field elements to hash.
 * @returns The hash as a field element.
 */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  return p.F.toObject(p(inputs));
}
