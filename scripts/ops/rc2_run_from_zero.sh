#!/usr/bin/env bash
# rc2_run_from_zero.sh — RC2 Bootstrap Validation
#
# Simulates a run-from-zero by validating all prerequisites, running
# npm test, Gate R0, and Hardhat compile from the repo root.
#
# Usage:
#   bash scripts/ops/rc2_run_from_zero.sh [--output-dir DIR]
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-}"

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ FAIL: $*" >&2; exit 1; }
section() { echo ""; echo "─── $* ───────────────────────────────────────────────────────────"; }

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   RC2 Run-from-zero Bootstrap Validation                   ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo "Repo:      $REPO_ROOT"
echo "Date:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

cd "$REPO_ROOT"

# ─── 1. Prerequisites ────────────────────────────────────────────────────────
section "1. Prerequisites"

command -v node &>/dev/null || fail "node not found — install Node.js 18+"
pass "node $(node --version)"

command -v npm &>/dev/null || fail "npm not found"
pass "npm $(npm --version)"

# ─── 2. Repository structure ─────────────────────────────────────────────────
section "2. Repository structure"

for f in \
  "CLAUDE.md" \
  "package.json" \
  "package-lock.json" \
  "tsconfig.json" \
  "docs/DOCS_INDEX.md" \
  "docs/ROADMAP_UNIFIED.md" \
  "docs/_canonical/CORE.md" \
  "scripts/ops/gate_r0_revalidate.sh" \
  "src/sdk/OTKSDK.ts" \
  "src/economics/CUEngine.ts" \
  "zk/keys/metering_v2_final_mpc.zkey" \
  "zk/keys/metering_v2_vkey_mpc.json"
do
  [ -f "$f" ] || fail "Missing canonical file: $f"
  pass "$f"
done

# ─── 3. Dependencies installed ───────────────────────────────────────────────
section "3. Dependencies"

[ -d "node_modules" ] || fail "node_modules missing — run: npm install"
pass "node_modules present"

node -e "require('./node_modules/tsx/package.json')" 2>/dev/null || fail "tsx not found in node_modules"
pass "tsx $(node -e "console.log(require('./node_modules/tsx/package.json').version)")"

# ─── 4. npm test ─────────────────────────────────────────────────────────────
section "4. npm test"

TEST_OUTPUT=$(npm test 2>&1)
echo "$TEST_OUTPUT" | tail -12

PASS_COUNT=$(echo "$TEST_OUTPUT" | grep "^ℹ pass" | awk '{print $3}')
FAIL_COUNT=$(echo "$TEST_OUTPUT" | grep "^ℹ fail" | awk '{print $3}')

[ "${FAIL_COUNT:-1}" = "0" ] || fail "npm test: FAIL_COUNT=${FAIL_COUNT}"
pass "npm test: ${PASS_COUNT} PASS, 0 FAIL"

# ─── 5. Hardhat compile ──────────────────────────────────────────────────────
section "5. Hardhat compile (tools/hardhat)"

cd tools/hardhat
HARDHAT_OUTPUT=$(npx hardhat compile 2>&1)
echo "$HARDHAT_OUTPUT" | tail -5
[ -d "artifacts" ] || fail "Hardhat artifacts missing after compile"
pass "Hardhat compile: artifacts present"
cd "$REPO_ROOT"

# ─── 6. Gate R0 ──────────────────────────────────────────────────────────────
section "6. Gate R0"

GATE_OUTPUT=$(bash scripts/ops/gate_r0_revalidate.sh 2>&1)
echo "$GATE_OUTPUT" | grep -E "GATE R0 RESULT|GO|FAIL" | head -5

if echo "$GATE_OUTPUT" | grep -q "GATE R0 RESULT: GO"; then
  pass "Gate R0: GO"
else
  fail "Gate R0 did not return GO"
fi

# ─── 7. Output ───────────────────────────────────────────────────────────────
if [ -n "$OUTPUT_DIR" ]; then
  mkdir -p "$OUTPUT_DIR"
  {
    echo "rc2_run_from_zero: ALL CHECKS PASSED"
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "tests: ${PASS_COUNT} PASS"
  } > "$OUTPUT_DIR/run_from_zero_result.txt"
  pass "Evidence written to $OUTPUT_DIR/run_from_zero_result.txt"
fi

echo ""
echo "✅ rc2_run_from_zero.sh: ALL CHECKS PASSED"
echo "   Tests: ${PASS_COUNT}/717+ expected"
echo "   Gate R0: GO"
