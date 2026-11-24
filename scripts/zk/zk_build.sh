#!/usr/bin/env bash
# zk_build.sh — Compile metering_v1.circom → R1CS + WASM + SYM
#
# Prerequisites: circom installed globally (npm i -g circom)
# Usage: bash scripts/zk/zk_build.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CIRCUITS="$REPO_ROOT/zk/circuits"
BUILD="$REPO_ROOT/zk/build"

mkdir -p "$BUILD"

echo "═══════════════════════════════════════════"
echo "  ZK Build — metering_v1.circom"
echo "═══════════════════════════════════════════"
echo "  Circuits: $CIRCUITS"
echo "  Output:   $BUILD"
echo ""

if ! command -v circom &>/dev/null; then
  echo "❌ circom not found. Install: npm i -g circom"
  exit 1
fi

circom "$CIRCUITS/metering_v1.circom" \
  --r1cs --wasm --sym \
  -l "$CIRCUITS/circomlib/circuits" \
  -o "$BUILD"

echo ""
echo "✅ Build complete."
echo "   R1CS:  $BUILD/metering_v1.r1cs"
echo "   WASM:  $BUILD/metering_v1_js/metering_v1.wasm"
echo "   SYM:   $BUILD/metering_v1.sym"
echo ""
echo "Next: bash scripts/zk/zk_prove.sh"
