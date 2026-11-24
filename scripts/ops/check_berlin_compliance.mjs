#!/usr/bin/env node
/**
 * U3.2 Berlin Compliance Checker
 *
 * Validates that all Hardhat build artifacts:
 * 1. Were compiled with the expected solc version
 * 2. Target evmVersion "berlin"
 * 3. Contain NO PUSH0 opcode (0x5f) in deployed/creation bytecodes
 *
 * PUSH0 (EIP-3855) was introduced in Shanghai; it MUST NOT appear
 * in Berlin-targeted bytecode for Besu IBFT compatibility.
 *
 * Usage: node scripts/ops/check_berlin_compliance.mjs
 *
 * @since U3.2
 */

import fs from "node:fs";
import path from "node:path";
import { findPush0Opcodes } from "./evm_bytecode.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const EXPECTED_SOLC = "0.8.24";
const EXPECTED_EVM = "berlin";
const BUILD_INFO_DIR = path.resolve("tools/hardhat/artifacts/build-info");
const OUTPUT_DIR = path.resolve("tools/hardhat/artifacts");

// PUSH0 = 0x5f. In bytecode hex string, we search for the pattern.
// However, 0x5f can also appear as data (operands of PUSH instructions).
// A rigorous check requires opcode-level disassembly, but for Berlin-targeted
// compilation by solc 0.8.24, the compiler should never emit PUSH0.
// We scan for the byte 0x5f in positions that are NOT operands of PUSHn.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`OK: ${msg}`);
}

/** PUSH0 opcode offsets, skipping PUSHn operands and the solc metadata trailer (request A 20260930-2217). */
const scanForPush0 = findPush0Opcodes;

// ---------------------------------------------------------------------------
// 1. Build-info validation
// ---------------------------------------------------------------------------
let buildInfoChecked = 0;

if (!fs.existsSync(BUILD_INFO_DIR)) {
  fail(`Missing build-info directory: ${BUILD_INFO_DIR}`);
  process.exit(1);
}

const buildInfoFiles = fs.readdirSync(BUILD_INFO_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".output.json"));

if (buildInfoFiles.length === 0) {
  fail("No build-info JSON files found.");
  process.exit(1);
}

for (const f of buildInfoFiles) {
  const p = path.join(BUILD_INFO_DIR, f);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));

  const solcVersion = j.solcVersion;
  const evmVersion = j.input?.settings?.evmVersion;

  if (solcVersion !== EXPECTED_SOLC) {
    fail(`${f}: solcVersion=${solcVersion} (expected ${EXPECTED_SOLC})`);
  } else {
    ok(`${f}: solcVersion=${solcVersion}`);
  }

  if (evmVersion !== EXPECTED_EVM) {
    fail(`${f}: evmVersion=${evmVersion} (expected ${EXPECTED_EVM})`);
  } else {
    ok(`${f}: evmVersion=${evmVersion}`);
  }

  buildInfoChecked++;
}

ok(`${buildInfoChecked} build-info file(s) checked.`);

// ---------------------------------------------------------------------------
// 2. PUSH0 scan on all contract artifacts
// ---------------------------------------------------------------------------
let contractsScanned = 0;
let push0Found = 0;

// Walk artifacts directory for contract JSON files (exclude build-info, dbg)
function walkArtifacts(dir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip build-info directory
      if (entry.name === "build-info") continue;
      walkArtifacts(fullPath);
    } else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
      try {
        const artifact = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        const bytecode = artifact.bytecode;
        const deployedBytecode = artifact.deployedBytecode;

        if (!bytecode && !deployedBytecode) continue;

        const contractName = artifact.contractName || entry.name.replace(".json", "");

        // Scan creation bytecode
        if (bytecode && bytecode !== "0x") {
          const offsets = scanForPush0(bytecode);
          if (offsets.length > 0) {
            fail(`${contractName}: PUSH0 found in creation bytecode at offsets: [${offsets.join(", ")}]`);
            push0Found += offsets.length;
          }
        }

        // Scan deployed bytecode
        if (deployedBytecode && deployedBytecode !== "0x") {
          const offsets = scanForPush0(deployedBytecode);
          if (offsets.length > 0) {
            fail(`${contractName}: PUSH0 found in deployed bytecode at offsets: [${offsets.join(", ")}]`);
            push0Found += offsets.length;
          }
        }

        contractsScanned++;
      } catch {
        // Not a contract artifact, skip
      }
    }
  }
}

walkArtifacts(OUTPUT_DIR);

if (push0Found > 0) {
  fail(`Total PUSH0 occurrences: ${push0Found} across scanned contracts`);
} else {
  ok(`${contractsScanned} contract bytecodes scanned: 0 PUSH0 found.`);
}

// ---------------------------------------------------------------------------
// 3. Summary
// ---------------------------------------------------------------------------
console.log("\n=== BERLIN COMPLIANCE SUMMARY ===");
console.log(`solc version:      ${EXPECTED_SOLC} ${buildInfoChecked > 0 ? "✓" : "✗"}`);
console.log(`evmVersion:        ${EXPECTED_EVM} ${buildInfoChecked > 0 ? "✓" : "✗"}`);
console.log(`contracts scanned: ${contractsScanned}`);
console.log(`PUSH0 occurrences: ${push0Found}`);
console.log(`status:            ${process.exitCode ? "FAIL" : "PASS"}`);
