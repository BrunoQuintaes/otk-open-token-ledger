#!/usr/bin/env bash
# Pre-deploy check of the whole stack: installs dependencies, runs the unit test suite, re-runs the R0 release
# gate (scripts/ops/gate_r0_revalidate.sh) and compiles the Solidity contracts with Hardhat.
#
# Usage: bash scripts/deploy_full_stack.sh   (from the repository root; no arguments)
# Effects: "npm ci" in the root and in tools/hardhat (replaces node_modules), test run, Hardhat build output.
# It does NOT deploy anything to a chain or server. Stops at the first failing step (set -e), with that
# step's exit code. Reads no environment variables itself.
set -e

echo "=== OTK Full Stack Deploy ==="

echo "[1] Install dependencies"
npm ci

echo "[2] Run tests"
npm test

echo "[3] Run Gate R0"
bash scripts/ops/gate_r0_revalidate.sh

echo "[4] Hardhat compile"
cd tools/hardhat
npm ci
npx hardhat compile
cd ../..

echo "=== DEPLOY CHECK COMPLETE ==="
