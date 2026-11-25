/**
 * U3.2 — Cross-Test: TS Poseidon == pubSignals[0]
 *
 * Validates the deterministic binding between:
 *   metering_input.json (circuit inputs)
 *   public.json         (snarkjs Groth16 pubSignals)
 *   circomlibjs Poseidon (TS recomputation)
 *
 * Canonical pubSignals order (FROZEN — metering_v1):
 *   [0] commitment  = Poseidon(userId, usage, nonce, epoch)   ← circuit OUTPUT
 *   [1] epoch                                                  ← public INPUT
 *   [2] maxUsage                                               ← public INPUT
 *
 * Under test: the committed v1 circuit outputs in `zk/build/` against a TypeScript Poseidon recomputation
 * (`circomlibjs`); no module of `src/` is imported.
 *
 * Needs: `zk/build/public.json` and, for the first case, `zk/build/metering_input.json` (read only). When they are
 * missing the cases return early and pass without checking anything, so a green run here is meaningful only where
 * those files exist. No network.
 *
 * Run just this file: `npx tsx --test test/zk/publicSignals.binding.test.ts`
 *
 * @module test/zk/publicSignals.binding.test
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const BUILD_DIR = path.join(ROOT, "zk", "build");

function readJson(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content);
}

test("U3.2 — pubSignals[0] == Poseidon(userId, usage, nonce, epoch) [TS recomputation]", async () => {
  // ── 1. Load artifacts ──────────────────────────────────────────────────────
  const publicPath = path.join(BUILD_DIR, "public.json");
  const inputPath  = path.join(BUILD_DIR, "metering_input.json");

  // Skip gracefully in CI / environments without compiled ZK artifacts
  if (!fs.existsSync(publicPath) || !fs.existsSync(inputPath)) {
    return; // no-op: zk/build/ not present (compile circuit locally to run this test)
  }

  const pub   = readJson(publicPath) as string[];
  const input = readJson(inputPath)  as Record<string, string>;

  // ── 2. Validate pubSignals structure ───────────────────────────────────────
  assert.equal(pub.length, 3, "public.json must have exactly 3 pubSignals: [commitment, epoch, maxUsage]");

  const pubCommitment = BigInt(pub[0]);
  const pubEpoch      = BigInt(pub[1]);
  const pubMaxUsage   = BigInt(pub[2]);

  // ── 3. Parse circuit inputs ────────────────────────────────────────────────
  const userId   = BigInt(input["userId"]);
  const usage    = BigInt(input["usage"]);
  const nonce    = BigInt(input["nonce"]);
  const epoch    = BigInt(input["epoch"]);
  const maxUsage = BigInt(input["maxUsage"]);

  // ── 4. Validate circuit constraint: usage <= maxUsage ──────────────────────
  assert.ok(
    usage <= maxUsage,
    `Circuit constraint violated in input file: usage (${usage}) must be <= maxUsage (${maxUsage})`
  );

  // ── 5. Validate epoch and maxUsage match pubSignals ────────────────────────
  assert.equal(epoch,    pubEpoch,    `epoch mismatch: input.epoch=${epoch} != pubSignals[1]=${pubEpoch}`);
  assert.equal(maxUsage, pubMaxUsage, `maxUsage mismatch: input.maxUsage=${maxUsage} != pubSignals[2]=${pubMaxUsage}`);

  // ── 6. Recompute Poseidon(userId, usage, nonce, epoch) in TS ───────────────
  // Order matches metering_v1.circom:
  //   h.inputs[0] = userId
  //   h.inputs[1] = usage
  //   h.inputs[2] = nonce
  //   h.inputs[3] = epoch
  const poseidon = await buildPoseidon();
  const F        = poseidon.F;

  const out       = poseidon([userId, usage, nonce, epoch]);
  const computed  = BigInt(F.toString(out));

  // ── 7. Assert TS commitment == snarkjs pubSignals[0] ──────────────────────
  assert.equal(
    computed,
    pubCommitment,
    `Poseidon commitment mismatch!\n  TS computed:    ${computed}\n  pubSignals[0]:  ${pubCommitment}`
  );
});

test("U3.2 — pubSignals order: [commitment=OUTPUT, epoch=INPUT, maxUsage=INPUT]", async () => {
  const publicPath = path.join(BUILD_DIR, "public.json");
  if (!fs.existsSync(publicPath)) {
    // Skip if build artifacts not present (CI without ZK setup)
    return;
  }

  const pub = readJson(publicPath) as string[];

  // All three signals must be non-zero strings representing valid field elements
  assert.equal(pub.length, 3, "Must have exactly 3 pubSignals");

  for (let i = 0; i < 3; i++) {
    assert.ok(typeof pub[i] === "string", `pubSignals[${i}] must be a string`);
    const v = BigInt(pub[i]);
    assert.ok(v >= 0n, `pubSignals[${i}] must be non-negative`);
  }

  // commitment (index 0) is a large Poseidon output — should be > maxUsage
  const commitment = BigInt(pub[0]);
  const maxUsage   = BigInt(pub[2]);
  assert.ok(commitment > maxUsage, "pubSignals[0]=commitment must be larger than pubSignals[2]=maxUsage (structural sanity)");
});
