#!/usr/bin/env bash
# =============================================================================
# OTK MPC Ceremony — Step 2: Participant Contribution
#
# Each participant runs this script to add their entropy to the ceremony.
# "1 of N honest" model: if ANY participant destroys their entropy,
# the entire setup is secure (no single party can forge proofs).
#
# HOW IT WORKS:
#   1. Participant receives the current contribution_NNNN.zkey
#   2. Runs this script → generates contribution_NNNN+1.zkey
#   3. SECURELY DELETES their entropy (see instructions below)
#   4. Sends contribution_NNNN+1.zkey to coordinator
#   5. Coordinator verifies contribution hash (published in state.json)
#
# ENTROPY OPTIONS (in order of quality):
#   1. Hardware random: dd if=/dev/urandom bs=64 count=1 2>/dev/null | xxd -p
#   2. Dice (physical): 50+ dice rolls (DRAND method)
#   3. Passphrase: long, never reused (minimum viable, not recommended)
#
# Usage (coordinator runs on behalf of participant, or participant runs directly):
#   bash scripts/ceremony/02_participant.sh <name> <contribution_number>
#   Environment variable PARTICIPANT_ENTROPY must be set (piped securely).
#
# Example:
#   read -s PARTICIPANT_ENTROPY && export PARTICIPANT_ENTROPY
#   bash scripts/ceremony/02_participant.sh "Alice-FGV" 1
# =============================================================================
set -euo pipefail

PARTICIPANT_NAME="${1:-}"
CONTRIBUTION_NUM="${2:-}"

if [ -z "${PARTICIPANT_NAME}" ] || [ -z "${CONTRIBUTION_NUM}" ]; then
    echo "Usage: bash scripts/ceremony/02_participant.sh <name> <contribution_number>"
    echo ""
    echo "Example:"
    echo "  read -s PARTICIPANT_ENTROPY && export PARTICIPANT_ENTROPY"
    echo "  bash scripts/ceremony/02_participant.sh 'Alice-FGV' 1"
    exit 1
fi

if [ -z "${PARTICIPANT_ENTROPY:-}" ]; then
    echo "❌ PARTICIPANT_ENTROPY environment variable not set."
    echo "   Set it with: read -s PARTICIPANT_ENTROPY && export PARTICIPANT_ENTROPY"
    echo "   Use hardware randomness: dd if=/dev/urandom bs=64 count=1 2>/dev/null | xxd -p"
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CEREMONY_DIR="${REPO_ROOT}/zk/ceremony"
STATE_FILE="${CEREMONY_DIR}/state.json"

PREV_N=$(printf "%04d" $((CONTRIBUTION_NUM - 1)))
CURR_N=$(printf "%04d" "${CONTRIBUTION_NUM}")

ZKEY_IN="${CEREMONY_DIR}/contribution_${PREV_N}.zkey"
ZKEY_OUT="${CEREMONY_DIR}/contribution_${CURR_N}.zkey"
ATTESTATION="${CEREMONY_DIR}/attestation_${CURR_N}_${PARTICIPANT_NAME}.txt"

echo "==================================================================="
echo " OTK Ceremony — Step 2: Contribution #${CONTRIBUTION_NUM}"
echo " Participant: ${PARTICIPANT_NAME}"
echo "==================================================================="
echo ""

if [ ! -f "${ZKEY_IN}" ]; then
    echo "❌ Input zkey not found: ${ZKEY_IN}"
    echo "   Ensure previous contribution is complete."
    exit 1
fi

echo "Input:  ${ZKEY_IN} ($(du -h "${ZKEY_IN}" | cut -f1))"
echo "Output: ${ZKEY_OUT}"
echo ""

# Generate contribution using participant entropy
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "Generating contribution..."
CONTRIBUTION_HASH=$(echo "${PARTICIPANT_ENTROPY}" \
    | npx snarkjs zkey contribute "${ZKEY_IN}" "${ZKEY_OUT}" \
        --name="${PARTICIPANT_NAME}" \
        -v 2>&1 \
    | grep "Contribution Hash" -A 4 | tail -4 | tr -d '[:space:]')

echo "✓ Contribution generated"
echo ""
echo "Contribution hash: ${CONTRIBUTION_HASH}"
echo ""

# Generate attestation document
cat > "${ATTESTATION}" << EOF
=================================================================
OTK Ceremony Attestation — Contribution #${CONTRIBUTION_NUM}
=================================================================
Participant:  ${PARTICIPANT_NAME}
Timestamp:    ${TIMESTAMP}
Input zkey:   contribution_${PREV_N}.zkey
Output zkey:  contribution_${CURR_N}.zkey
Contribution hash:
${CONTRIBUTION_HASH}

I, ${PARTICIPANT_NAME}, certify that:
1. I generated entropy using a secure random source.
2. I did not retain or share my entropy after generating this contribution.
3. I independently verified the circuit hash before contributing.
4. The output zkey was transmitted to the coordinator via secure channel.

Circuit: metering_v2.circom (OTK zk-Metering — FGV DSR 2026)
=================================================================
EOF

echo "Attestation saved: ${ATTESTATION}"
echo ""

# ⚠️ CRITICAL: Destroy entropy after contribution
echo "⚠️  CRITICAL: Clear PARTICIPANT_ENTROPY from memory now:"
echo "   unset PARTICIPANT_ENTROPY"
echo "   history -c  # clear shell history"
echo ""

# Update ceremony state
# Fix (A-008): use relative path from REPO_ROOT so Node.js works on Windows
# (POSIX absolute paths like /c/Users/... are not understood by Node.js on Windows)
cd "${REPO_ROOT}"
CONTRIBUTIONS=$(node --input-type=module << JSEOF
import {readFileSync, writeFileSync} from 'fs';
const state = JSON.parse(readFileSync('zk/ceremony/state.json', 'utf8'));
state.contributions.push({
  number: ${CONTRIBUTION_NUM},
  participant: '${PARTICIPANT_NAME}',
  timestamp: '${TIMESTAMP}',
  contributionHash: '${CONTRIBUTION_HASH}',
  attestation: 'zk/ceremony/attestation_${CURR_N}_${PARTICIPANT_NAME}.txt'
});
state.current_contribution = ${CONTRIBUTION_NUM};
state.current_zkey = 'zk/ceremony/contribution_${CURR_N}.zkey';
writeFileSync('zk/ceremony/state.json', JSON.stringify(state, null, 2));
console.log(state.contributions.length);
JSEOF
)

echo "==================================================================="
echo " ✅ Contribution #${CONTRIBUTION_NUM} complete"
echo " Contributions so far: ${CONTRIBUTIONS}"
echo " Next participant: send contribution_${CURR_N}.zkey"
echo " Or: apply beacon (bash scripts/ceremony/03_beacon.sh)"
echo "==================================================================="
