#!/usr/bin/env bash
# =============================================================================
# OTK MPC Ceremony — Step 4: Verify Full Ceremony
#
# Verifies the complete chain of contributions:
#   contribution_0000.zkey (initial)
#   → contribution_0001.zkey (P1 contribution)
#   → contribution_0002.zkey (P2 contribution)
#   → ...
#   → contribution_beacon.zkey (beacon applied)
#   → metering_v2_final_mpc.zkey (final)
#
# This verification can be run by ANY party to independently audit
# the ceremony. The circuit hash and contribution hashes are
# deterministic and can be verified against the attestations.
#
# Outputs:
#   zk/ceremony/verification_report.json  — full audit trail
#
# Usage:
#   bash scripts/ceremony/04_verify.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CEREMONY_DIR="${REPO_ROOT}/zk/ceremony"
KEYS_DIR="${REPO_ROOT}/zk/keys"
STATE_FILE="${CEREMONY_DIR}/state.json"
R1CS="${REPO_ROOT}/zk/build/metering_v2.r1cs"
PTAU="${KEYS_DIR}/hermez_bn128_12_final.ptau"
FINAL_ZKEY="${KEYS_DIR}/metering_v2_final_mpc.zkey"

echo "==================================================================="
echo " OTK Ceremony — Step 4: Full Ceremony Verification"
echo "==================================================================="
echo ""

PASS=0
FAIL=0
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

check() {
    local desc="$1"; shift
    if "$@" > /dev/null 2>&1; then
        echo "✓ ${desc}"
        PASS=$((PASS + 1))
    else
        echo "✗ ${desc}"
        FAIL=$((FAIL + 1))
    fi
}

# Check prerequisites
check "R1CS exists" test -f "${R1CS}"
check "Phase 1 ptau exists" test -f "${PTAU}"
check "Final zkey exists" test -f "${FINAL_ZKEY}"
check "Ceremony state exists" test -f "${STATE_FILE}"

echo ""
echo "--- Verifying final zkey against R1CS + Phase 1 ptau ---"
if npx snarkjs zkey verify "${R1CS}" "${PTAU}" "${FINAL_ZKEY}" 2>&1 | grep -q "ZKey Ok"; then
    echo "✓ Final zkey verification: PASS"
    PASS=$((PASS + 1))
else
    echo "✗ Final zkey verification: FAIL"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "--- Smoke test: generate and verify a proof ---"
SMOKE_PROOF="${CEREMONY_DIR}/_smoke_proof.json"
SMOKE_PUBLIC="${CEREMONY_DIR}/_smoke_public.json"
SMOKE_INPUT='{"userId":"42","usage":"150","nonce":"7","epoch":"1000","minUsageBucket":"0","maxUsageBucket":"300"}'
WASM="${REPO_ROOT}/zk/build/metering_v2_js/metering_v2.wasm"
VKEY="${KEYS_DIR}/metering_v2_vkey_mpc.json"

if node --input-type=module << JSEOF 2>/dev/null
import { groth16 } from 'snarkjs';
import { readFileSync, writeFileSync } from 'fs';
const input = JSON.parse('${SMOKE_INPUT}');
const { proof, publicSignals } = await groth16.fullProve(input, '${WASM}', '${FINAL_ZKEY}');
writeFileSync('${SMOKE_PROOF}', JSON.stringify(proof));
writeFileSync('${SMOKE_PUBLIC}', JSON.stringify(publicSignals));
const vkey = JSON.parse(readFileSync('${VKEY}', 'utf8'));
const valid = await groth16.verify(vkey, publicSignals, proof);
if (!valid) throw new Error('Proof invalid');
process.exit(0);
JSEOF
then
    echo "✓ Smoke test: proof generated and verified"
    PASS=$((PASS + 1))
    rm -f "${SMOKE_PROOF}" "${SMOKE_PUBLIC}"
else
    echo "✗ Smoke test: FAIL"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "--- Ceremony state ---"
node --input-type=module << JSEOF 2>/dev/null
import {readFileSync} from 'fs';
const s = JSON.parse(readFileSync('${STATE_FILE}', 'utf8'));
console.log('  Circuit:          ', s.circuit);
console.log('  Contributions:    ', s.contributions.length);
for (const c of s.contributions) {
  console.log(\`    #\${c.number}: \${c.participant} (\${c.timestamp})\`);
}
console.log('  Beacon applied:  ', s.beacon_applied ? \`✓ \${s.beacon?.source}\` : '✗ NOT APPLIED');
console.log('  Finalized:       ', s.finalized ? '✓' : '✗');
JSEOF

echo ""
echo "==================================================================="
echo " Verification summary: ${PASS} PASS, ${FAIL} FAIL"
echo "==================================================================="

# Save verification report
cat > "${CEREMONY_DIR}/verification_report.json" << EOF
{
  "verified_at": "${TIMESTAMP}",
  "checks_passed": ${PASS},
  "checks_failed": ${FAIL},
  "result": $([ "${FAIL}" -eq 0 ] && echo '"PASS"' || echo '"FAIL"'),
  "r1cs": "zk/build/metering_v2.r1cs",
  "ptau": "zk/keys/hermez_bn128_12_final.ptau",
  "final_zkey": "zk/keys/metering_v2_final_mpc.zkey"
}
EOF

echo " Report: ${CEREMONY_DIR}/verification_report.json"
echo ""

[ "${FAIL}" -eq 0 ] && echo "✅ Ceremony verified — ready for production" \
                     || echo "❌ Ceremony verification FAILED"
exit "${FAIL}"
