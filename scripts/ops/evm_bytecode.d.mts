/**
 * Types for scripts/ops/evm_bytecode.mjs (used by test/unit/d1d8_s0_push0.test.ts).
 *
 * @module scripts/ops/evm_bytecode.d
 */
/**
 * End offset (exclusive) of the executable part of the bytecode, before a well-formed solc metadata trailer.
 *
 * @param bytes - Raw bytecode.
 * @returns Byte offset; equals `bytes.length` when no well-formed trailer is found.
 */
export function executableEnd(bytes: Buffer): number;
/**
 * Byte offsets where 0x5f appears as an opcode (PUSH0) in the executable part of a hex bytecode string.
 *
 * @param hex - Bytecode as hex, with or without `0x`; empty, `0x`, null or undefined give `[]`.
 * @returns Byte offsets (not hex-character offsets), in increasing order.
 */
export function findPush0Opcodes(hex: string | null | undefined): number[];
