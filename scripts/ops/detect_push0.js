#!/usr/bin/env node
/**
 * detect_push0.js — PUSH0 (0x5f) opcode detector for Hardhat artifacts
 *
 * Parses EVM bytecode using a proper instruction-stream walker:
 *   - PUSH0 (0x5f) as an OPCODE → real PUSH0, Berlin-incompatible
 *   - 0x5f as DATA inside PUSH1..PUSH32 → harmless constant byte, NOT flagged
 *   - 0x5f inside the solc CBOR metadata trailer (never executed) → NOT flagged
 *
 * PUSH0 was introduced in Shanghai (EIP-3855) and is NOT available in Berlin EVM (Besu IBFT).
 *
 * Exit codes:
 *   0 — no PUSH0 opcode found (safe to deploy to Berlin EVM)
 *   2 — PUSH0 opcode detected (fix evmVersion in hardhat.config.js)
 *
 * Usage:
 *   node scripts/ops/detect_push0.js
 *
 * Gate R0: called by scripts/ops/gate_r0_revalidate.sh (CHECK 2b)
 * ADR: docs/architecture/adr/ADR-EVM-0002-berlin-compat-no-push0.md
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPush0Opcodes } from "./evm_bytecode.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACTS_DIR = path.join(ROOT, "tools", "hardhat", "artifacts");

/** Recursively collect all contract artifact .json files (excluding .dbg.json) */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(p, out);
    } else if (ent.isFile() && ent.name.endsWith(".json") && !ent.name.endsWith(".dbg.json")) {
      out.push(p);
    }
  }
  return out;
}

// Opcode walker that skips PUSHn operands and the solc metadata trailer (request A 20260930-2217).

const files = walk(ARTIFACTS_DIR);

if (files.length === 0) {
  console.error("WARN: No artifacts found in", ARTIFACTS_DIR);
  console.error("      Run 'npx hardhat compile' in tools/hardhat/ first.");
  process.exit(0); // non-blocking if artifacts not built yet
}

const hits = [];
for (const f of files) {
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    continue;
  }

  const inBytecode         = findPush0Opcodes(artifact.bytecode);
  const inDeployedBytecode = findPush0Opcodes(artifact.deployedBytecode);

  if (inBytecode.length > 0 || inDeployedBytecode.length > 0) {
    hits.push({
      file: path.relative(ROOT, f),
      bytecodePositions:         inBytecode,
      deployedBytecodePositions: inDeployedBytecode,
    });
  }
}

const scanned = files.length;

if (hits.length > 0) {
  process.stderr.write(`\nPUSH0 (0x5f) OPCODE DETECTED — Berlin EVM incompatible!\n`);
  process.stderr.write(`Scanned: ${scanned} artifact(s)\n\n`);
  process.stderr.write(`Affected artifacts (opcode positions):\n`);
  for (const h of hits) {
    if (h.bytecodePositions.length > 0) {
      process.stderr.write(`  - ${h.file} [bytecode @ ${h.bytecodePositions.slice(0, 5).join(", ")}]\n`);
    }
    if (h.deployedBytecodePositions.length > 0) {
      process.stderr.write(`  - ${h.file} [deployedBytecode @ ${h.deployedBytecodePositions.slice(0, 5).join(", ")}]\n`);
    }
  }
  process.stderr.write(`\nFix: ensure tools/hardhat/hardhat.config.js has:\n`);
  process.stderr.write(`  settings: { evmVersion: "berlin" }\n`);
  process.stderr.write(`  ADR: docs/architecture/adr/ADR-EVM-0002-berlin-compat-no-push0.md\n\n`);
  process.exit(2);
}

console.log(`OK: no PUSH0 opcode (0x5f) found in ${scanned} artifact(s) — Berlin EVM safe`);
process.exit(0);
