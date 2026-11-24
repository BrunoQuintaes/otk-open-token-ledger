/**
 * Poseidon over BN254 as used by circomlib (circomlibjs reference implementation).
 * The wasm-backed instance is built once and cached; callers await `getPoseidon()`.
 */
import { buildPoseidon } from 'circomlibjs';

type PoseidonFn = ((inputs: bigint[]) => unknown) & { F: { toObject(x: unknown): bigint } };

let instance: Promise<PoseidonFn> | null = null;

export function getPoseidon(): Promise<PoseidonFn> {
  if (!instance) instance = buildPoseidon() as Promise<PoseidonFn>;
  return instance;
}

/** Poseidon(inputs) as a field element (bigint). */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  return p.F.toObject(p(inputs));
}
