#!/usr/bin/env bash
# =============================================================================
# OTK MPC Ceremony — Step 1: Initialize Phase 2 (Circuit-Specific Setup)
# Usage: bash scripts/ceremony/01_phase2_init.sh   (no arguments; reads no environment variables)
# Exit code 1 when a prerequisite file is missing. Overwrites state.json (starts a new ceremony state).
#
# Creates the initial contribution_0000.zkey from:
#   - The Hermez Phase 1 ptau (public, 176+ contributors)
#   - The metering_v2 R1CS (circuit-specific)
#
# This .zkey has NO human contribution yet (toxic waste = deterministic).
# The MPC ceremony participants will add their entropy in Step 2.
#
# Prerequisites:
#   - zk/build/metering_v2.r1cs  (compile: circom metering_v2.circom --r1cs)
#   - zk/keys/hermez_bn128_12_final.ptau  (run Step 0 first)
#
# Outputs:
#   zk/ceremony/contribution_0000.zkey  — initial (pre-ceremony) zkey
#   zk/ceremony/circuit_hash.txt        — circuit hash for audit
#   zk/ceremony/state.json              — ceremony coordinator state
#
# Usage:
#   bash scripts/ceremony/01_phase2_init.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEYS_DIR="${REPO_ROOT}/zk/keys"
CEREMONY_DIR="${REPO_ROOT}/zk/ceremony"
R1CS="${REPO_ROOT}/zk/build/metering_v2.r1cs"
PTAU="${KEYS_DIR}/hermez_bn128_12_final.ptau"
ZKEY_INIT="${CEREMONY_DIR}/contribution_0000.zkey"
STATE_FILE="${CEREMONY_DIR}/state.json"

echo "==================================================================="
echo " OTK Ceremony — Step 1: Phase 2 Initialization"
echo "==================================================================="

# Prerequisites check
if [ ! -f "${R1CS}" ]; then
    echo "❌ R1CS not found: ${R1CS}"
    echo "   Run: cd zk && circom circuits/metering_v2.circom --r1cs --output build/"
    exit 1
fi

if [ ! -f "${PTAU}" ]; then
    echo "❌ Phase 1 ptau not found: ${PTAU}"
    echo "   Run: bash scripts/ceremony/00_use_public_ptau.sh"
    exit 1
fi

mkdir -p "${CEREMONY_DIR}"

echo "Circuit:  ${R1CS}"
echo "Phase 1:  ${PTAU}"
echo "Output:   ${ZKEY_INIT}"
echo ""

# Generate initial zkey (no contribution yet)
echo "Generating initial zkey (phase 2 setup)..."
npx snarkjs groth16 setup "${R1CS}" "${PTAU}" "${ZKEY_INIT}" 2>&1 | tail -5

# Extract and save circuit hash
CIRCUIT_HASH=$(npx snarkjs zkey verify "${R1CS}" "${PTAU}" "${ZKEY_INIT}" 2>&1 \
    | grep "Circuit hash:" -A 4 | tail -4 | tr -d '[:space:]')
echo "${CIRCUIT_HASH}" > "${CEREMONY_DIR}/circuit_hash.txt"
echo "Circuit hash saved: ${CIRCUIT_HASH}"

# Initialize ceremony state
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "${STATE_FILE}" << EOF
{
  "circuit": "metering_v2.circom",
  "r1cs": "zk/build/metering_v2.r1cs",
  "ptau_source": "Hermez Perpetual Powers of Tau (pot12, 176+ contributors)",
  "ptau_file": "zk/keys/hermez_bn128_12_final.ptau",
  "started_at": "${TIMESTAMP}",
  "current_contribution": 0,
  "contributions": [],
  "beacon_applied": false,
  "finalized": false,
  "current_zkey": "zk/ceremony/contribution_0000.zkey"
}
EOF

echo ""
echo "==================================================================="
echo " ✅ Phase 2 initialized"
echo " ceremony state: ${STATE_FILE}"
echo " Next: send contribution_0000.zkey to Participant 1"
echo " Then: bash scripts/ceremony/02_participant.sh <name> <entropy>"
echo "==================================================================="
