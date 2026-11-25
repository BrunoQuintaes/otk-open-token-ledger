/**
 * S0 (run 20260930-1625), request A 20260930-2217: the PUSH0 detectors must not read the solc
 * metadata trailer as code, and must still flag a real PUSH0 opcode.
 *
 * Module under test: `findPush0Opcodes` and `executableEnd` from `scripts/ops/evm_bytecode.mjs`
 * (PUSH0 is the 0x5f opcode, not supported by the Berlin EVM of the local chain).
 *
 * Strategy / partitions: 0x5f as the operand of PUSH1 (data); a real PUSH0 in code (flagged);
 * 0x5f inside a well-formed metadata trailer (not flagged); a trailer with an inconsistent length
 * or a head that is not CBOR (the whole bytecode is scanned).
 *
 * Needs: nothing external (hand-written bytecode strings).
 *
 * Run just this file: `npx tsx --test test/unit/d1d8_s0_push0.test.ts`
 *
 * @module test/unit/d1d8_s0_push0.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPush0Opcodes, executableEnd } from '../../scripts/ops/evm_bytecode.mjs';

// CBOR map {"solc": 0x00 08 18} as solc emits it, plus a 2-byte length.
const SOLC_ONLY = 'a164736f6c6343000818';
const trailer = (cborHex: string) => cborHex + (cborHex.length / 2).toString(16).padStart(4, '0');
// A map with a 34-byte "ipfs" multihash that contains a 0x5f byte (the A false positive).
const IPFS_WITH_5F = 'a264697066735822' + '1220' + '5f'.repeat(1) + 'ab'.repeat(31) + '64736f6c6343000818';

test('0x5f as PUSH1 operand is data, not PUSH0', () => {
  assert.deepEqual(findPush0Opcodes('0x605f600155'), []);
});

test('a real PUSH0 opcode in code is still flagged', () => {
  assert.deepEqual(findPush0Opcodes('0x60015f55' + trailer(SOLC_ONLY)), [2]);
});

test('0x5f inside a well-formed metadata trailer is not flagged (was flagged before)', () => {
  const code = '6080604052' + '00';
  const hex = '0x' + code + trailer(IPFS_WITH_5F);
  assert.deepEqual(findPush0Opcodes(hex), []);
  // the old full walk would have reached the 0x5f byte inside the trailer
  const bytes = Buffer.from(hex.slice(2), 'hex');
  assert.equal(executableEnd(bytes), code.length / 2);
  assert.ok(bytes.subarray(executableEnd(bytes)).includes(0x5f));
});

test('inconsistent trailer length or non-CBOR head: whole code is scanned (conservative)', () => {
  assert.deepEqual(findPush0Opcodes('0x5f00' + 'ffff'), [0]);
  // declared length points at a non-map byte → not treated as trailer
  const notMap = '5f' + '0000' + '0003';
  assert.deepEqual(findPush0Opcodes('0x' + notMap), [0]);
});
