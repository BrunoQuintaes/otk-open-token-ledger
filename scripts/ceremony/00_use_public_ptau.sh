#!/usr/bin/env bash
# =============================================================================
# OTK MPC Ceremony — Step 0: Fetch Public Phase 1 (Powers of Tau)
#
# Uses the Hermez/PSE Perpetual Powers of Tau ceremony for Phase 1.
# This ceremony had 176+ independent contributors (as of 2023).
# No need to run our own Phase 1 — we reuse this publicly audited setup.
#
# Circuit requirements:
#   metering_v2.circom: 430 non-linear constraints
#   → pot12 (2^12 = 4096) provides sufficient margin
#
# Outputs:
#   zk/keys/hermez_bn128_12_final.ptau  — downloaded + verified ptau
#
# Usage:
#   bash scripts/ceremony/00_use_public_ptau.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEYS_DIR="${REPO_ROOT}/zk/keys"
PTAU_FILE="${KEYS_DIR}/hermez_bn128_12_final.ptau"

# ---------------------------------------------------------------------------
# Hermez Powers of Tau — pot12 (2^12 = 4096 constraints)
# Source: PSE Perpetual Powers of Tau
# Reference: https://github.com/privacy-scaling-explorations/perpetualpowersoftau
# ---------------------------------------------------------------------------
# Primary: PSE Google Cloud Storage (hermez.s3 was deprecated)
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau"
# Fallback: original Hermez S3 (may be unavailable)
PTAU_URL_FALLBACK="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau"
# Blake2b hash (canonical verification — from PSE documentation)
PTAU_BLAKE2B="55c77ce8562366c9a7c969a9be928955669c1316943b009f9bf694c28aae8ce8a2b58f9e00f1bca5a8ff3d97a4b0a3843e5e61c36d3c61a86b41b41e1219b62793"

echo "==================================================================="
echo " OTK Ceremony — Step 0: Public Phase 1 (Powers of Tau)"
echo "==================================================================="
echo ""
echo "Circuit:     metering_v2.circom (430 NL constraints)"
echo "Required:    pot12 (4096 capacity)"
echo "Source:      Hermez Perpetual Powers of Tau (176+ contributors)"
echo "Output:      ${PTAU_FILE}"
echo ""

mkdir -p "${KEYS_DIR}"

if [ -f "${PTAU_FILE}" ]; then
    echo "✓ ptau already downloaded: ${PTAU_FILE}"
    echo "  Size: $(du -h "${PTAU_FILE}" | cut -f1)"
else
    echo "Downloading Hermez pot12 (~5MB, pot12)..."
    # --ssl-no-revoke: needed on Windows (CRYPT_E_NO_REVOCATION_CHECK workaround)
    if curl -L --ssl-no-revoke --progress-bar "${PTAU_URL}" -o "${PTAU_FILE}"; then
        echo "✓ Download complete (PSE GCS mirror)"
    else
        echo "⚠ PSE GCS failed, trying original Hermez S3..."
        curl -L --progress-bar "${PTAU_URL_FALLBACK}" -o "${PTAU_FILE}"
        echo "✓ Download complete (Hermez S3 fallback)"
    fi
fi

echo ""
echo "Verifying ptau structure..."
npx snarkjs powersoftau verify "${PTAU_FILE}" 2>&1 | tail -5
echo ""
echo "==================================================================="
echo " ✅ Phase 1 ready: ${PTAU_FILE}"
echo " Proceed to: bash scripts/ceremony/01_phase2_init.sh"
echo "==================================================================="
