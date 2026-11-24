#!/usr/bin/env bash
# =============================================================================
# 01_init_ceremony.sh — Phase 1: Powers of Tau initialization
#
# Usage:
#   bash scripts/setup/01_init_ceremony.sh [POWER] [OUTPUT_DIR]
#
# Arguments:
#   POWER       — Tau power (default: 12, supports up to 2^12 = 4096 constraints)
#   OUTPUT_DIR  — Directory to write ptau files (default: zk/ceremony/phase1)
#
# Outputs:
#   <OUTPUT_DIR>/pot<POWER>_0000.ptau  — initial (unconstrained) ptau
#   <OUTPUT_DIR>/ceremony_log.txt       — ceremony log with SHA256 hashes
#
# NOTE: If using existing ptau (from Hermez or other ceremony), skip this step
#       and go directly to 02_phase2_start.sh.
#
# SECURITY: This script generates new ptau. In production, use ptau from a
#           public ceremony (Hermez, Aztec, etc.) for stronger security guarantees.
# =============================================================================

set -euo pipefail

POWER="${1:-12}"
OUTPUT_DIR="${2:-zk/ceremony/phase1}"
REPO_ROOT="$(git rev-parse --show-toplevel)"

cd "$REPO_ROOT"

echo "== OTK Trusted Setup — Phase 1 (Powers of Tau) =="
echo "Power: $POWER (max constraints: $((2**POWER)))"
echo "Output: $OUTPUT_DIR"
echo ""

mkdir -p "$OUTPUT_DIR"
LOG="$OUTPUT_DIR/ceremony_log.txt"
echo "timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOG"
echo "power: $POWER" >> "$LOG"
echo "repo_commit: $(git rev-parse HEAD)" >> "$LOG"
echo "" >> "$LOG"

# Check snarkjs is available
if ! command -v snarkjs &>/dev/null; then
  echo "ERROR: snarkjs not found. Install with: npm install -g snarkjs" >&2
  exit 1
fi

PTAU_INIT="$OUTPUT_DIR/pot${POWER}_0000.ptau"

echo "Step 1: snarkjs powersoftau new bn128 $POWER ..."
snarkjs powersoftau new bn128 "$POWER" "$PTAU_INIT" -v 2>&1 | tee -a "$LOG"

echo "" | tee -a "$LOG"
echo "✅ Initial ptau generated: $PTAU_INIT" | tee -a "$LOG"

# Record hash for audit trail
if command -v sha256sum &>/dev/null; then
  SHA=$(sha256sum "$PTAU_INIT" | awk '{print $1}')
elif command -v shasum &>/dev/null; then
  SHA=$(shasum -a 256 "$PTAU_INIT" | awk '{print $1}')
else
  SHA="(sha256 not available)"
fi

echo "sha256_ptau_init: $SHA" >> "$LOG"
echo "sha256: $SHA" | tee -a /dev/tty

echo ""
echo "Next step:"
echo "  bash scripts/setup/02_contribute.sh $POWER \"$OUTPUT_DIR\""
