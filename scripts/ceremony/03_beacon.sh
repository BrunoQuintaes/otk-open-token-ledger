#!/usr/bin/env bash
# =============================================================================
# OTK MPC Ceremony — Step 3: Apply Final Beacon (Public Randomness)
#
# The beacon is a public, unpredictable value that is applied AFTER all
# human contributions, ensuring the setup cannot be compromised even if
# ALL participants collude (as long as the beacon is external).
#
# BEACON OPTIONS (in order of security):
#   1. Bitcoin block hash (best): unpredictable, public, archived
#      Get: https://mempool.space/api/block-height/<N> → block hash
#   2. Ethereum block hash: similar properties
#   3. NIST Randomness Beacon: https://beacon.nist.gov/beacon/2.0/chain/last/pulse/last
#   4. Drand (distributed randomness): https://api.drand.sh/public/latest
#
# The coordinator publishes the beacon source BEFORE the ceremony ends,
# so participants can verify it was not chosen adversarially.
#
# Usage:
#   BEACON_HASH="<64-hex-char hash>" \
#   BEACON_SOURCE="Bitcoin block #830000" \
#   bash scripts/ceremony/03_beacon.sh
#
# Example:
#   BEACON_HASH="0000000000000000000168a2f81ab5b892b9b5f7..." \
#   BEACON_SOURCE="Bitcoin block #830000 (2024-02-22)" \
#   bash scripts/ceremony/03_beacon.sh
# =============================================================================
set -euo pipefail

BEACON_HASH="${BEACON_HASH:-}"
BEACON_SOURCE="${BEACON_SOURCE:-}"

if [ -z "${BEACON_HASH}" ]; then
    echo "Usage: BEACON_HASH=<hash> BEACON_SOURCE='<description>' bash scripts/ceremony/03_beacon.sh"
    echo ""
    echo "Obtain beacon from:"
    echo "  Bitcoin block: curl https://mempool.space/api/block-height/<N>"
    echo "  Ethereum block: cast block <N> --field hash --rpc-url https://eth.llamarpc.com"
    echo "  NIST beacon:  curl https://beacon.nist.gov/beacon/2.0/chain/last/pulse/last | jq .pulse.outputValue"
    echo "  Drand:        curl https://api.drand.sh/public/latest | jq -r .randomness"
    echo ""
    echo "Example:"
    echo "  export BEACON_HASH=\$(curl -s https://api.drand.sh/public/latest | node --input-type=module -e 'import s from \"node:stream\"; const c=[];process.stdin.on(\"data\",d=>c.push(d));process.stdin.on(\"end\",()=>console.log(JSON.parse(Buffer.concat(c)).randomness))')"
    echo "  export BEACON_SOURCE='Drand round \$(curl -s https://api.drand.sh/public/latest | node --input-type=module -e \"...\" )'"
    echo "  bash scripts/ceremony/03_beacon.sh"
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CEREMONY_DIR="${REPO_ROOT}/zk/ceremony"
STATE_FILE="${CEREMONY_DIR}/state.json"

# Find the last contribution zkey
CURRENT_CONTRIB=$(node --input-type=module << 'JSEOF'
import {readFileSync} from 'fs';
const s = JSON.parse(readFileSync(process.env.STATE_FILE, 'utf8'));
console.log(s.current_contribution);
JSEOF
)
export STATE_FILE

LAST_ZKEY="${CEREMONY_DIR}/contribution_$(printf "%04d" "${CURRENT_CONTRIB}").zkey"
BEACON_ZKEY="${CEREMONY_DIR}/contribution_beacon.zkey"
FINAL_ZKEY="${REPO_ROOT}/zk/keys/metering_v2_final_mpc.zkey"
VKEY_FINAL="${REPO_ROOT}/zk/keys/metering_v2_vkey_mpc.json"

echo "==================================================================="
echo " OTK Ceremony — Step 3: Apply Beacon"
echo "==================================================================="
echo ""
echo "Last contribution: ${LAST_ZKEY}"
echo "Beacon source:     ${BEACON_SOURCE}"
echo "Beacon hash:       ${BEACON_HASH}"
echo ""

if [ ! -f "${LAST_ZKEY}" ]; then
    echo "❌ Last contribution not found: ${LAST_ZKEY}"
    echo "   Run Step 2 for all participants first."
    exit 1
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Apply beacon (10 iterations — standard for Groth16)
echo "Applying beacon (10 hash iterations)..."
npx snarkjs zkey beacon \
    "${LAST_ZKEY}" \
    "${BEACON_ZKEY}" \
    "${BEACON_HASH}" \
    10 \
    --name="FinalBeacon-${BEACON_SOURCE}" \
    2>&1 | tail -5

echo "✓ Beacon applied"
echo ""

# Copy to final location
cp "${BEACON_ZKEY}" "${FINAL_ZKEY}"

# Export final verification key
echo "Exporting verification key..."
npx snarkjs zkey export verificationkey "${FINAL_ZKEY}" "${VKEY_FINAL}" 2>&1 | tail -3
echo "✓ vkey exported: ${VKEY_FINAL}"
echo ""

# Export final Solidity verifier
SOLIDITY_VERIFIER="${REPO_ROOT}/tools/hardhat/contracts/MeteringVerifierV2_MPC.sol"
echo "Exporting Solidity verifier..."
npx snarkjs zkey export solidityverifier "${FINAL_ZKEY}" "${SOLIDITY_VERIFIER}" 2>&1 | tail -3
echo "✓ Solidity verifier: ${SOLIDITY_VERIFIER}"
echo ""

# Update ceremony state
node --input-type=module << JSEOF
import {readFileSync, writeFileSync} from 'fs';
const state = JSON.parse(readFileSync('${STATE_FILE}', 'utf8'));
state.beacon = {
  hash: '${BEACON_HASH}',
  source: '${BEACON_SOURCE}',
  timestamp: '${TIMESTAMP}',
  iterations: 10
};
state.beacon_applied = true;
state.final_zkey = 'zk/keys/metering_v2_final_mpc.zkey';
state.final_vkey = 'zk/keys/metering_v2_vkey_mpc.json';
writeFileSync('${STATE_FILE}', JSON.stringify(state, null, 2));
console.log('State updated');
JSEOF

echo "==================================================================="
echo " ✅ Beacon applied — ceremony complete"
echo " Final zkey: ${FINAL_ZKEY}"
echo " Final vkey: ${VKEY_FINAL}"
echo " Verifier:   ${SOLIDITY_VERIFIER}"
echo " Next: verify with bash scripts/ceremony/04_verify.sh"
echo "==================================================================="
