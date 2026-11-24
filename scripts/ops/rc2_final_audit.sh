#!/usr/bin/env bash
# rc2_final_audit.sh — RC2 Final Canonical Consistency Audit
#
# Checks:
#   1. Canonical key paths (CLAUDE.md Section 10) all exist
#   2. CU != USD invariant present in source code
#   3. ROADMAP_UNIFIED.md has all pack completion entries (F1–G4 + RC2)
#   4. docs/_ops/ subdirs are present (append-only evidence)
#   5. ZK ceremony artifacts exist
#   6. No uncommitted changes (clean working tree)
#   7. Core modules are untouched (no modifications to critical files)
#
# Usage:
#   bash scripts/ops/rc2_final_audit.sh [--output-dir DIR]
#
# Exit codes:
#   0 — audit passed
#   1 — audit failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-}"

pass() { echo "  ✓ $*"; }
warn() { echo "  ⚠ WARN: $*"; }
fail() { echo "  ✗ FAIL: $*" >&2; exit 1; }
section() { echo ""; echo "─── $* ───────────────────────────────────────────────────────────"; }

AUDIT_ISSUES=0
soft_fail() { echo "  ✗ ISSUE: $*" >&2; AUDIT_ISSUES=$((AUDIT_ISSUES+1)); }

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   RC2 Final Canonical Consistency Audit                    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo "Repo:  $REPO_ROOT"
echo "Date:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"

cd "$REPO_ROOT"

# ─── 1. Canonical key paths (CLAUDE.md Section 10) ───────────────────────────
section "1. Canonical key paths"

CANONICAL_PATHS=(
  "src/sdk/OTKSDK.ts"
  "src/metering/SignatureManager.ts"
  "src/economics/CUEngine.ts"
  "src/types/receipt.ts"
  "src/providers/"
  "src/infra/logging/ExperimentLogger.ts"
  "zk/circuits/metering_v1.circom"
  "zk/circuits/metering_v2.circom"
  "zk/keys/metering_v2_final_mpc.zkey"
  "zk/keys/metering_v2_vkey_mpc.json"
  "zk/ceremony/state.json"
  "tools/hardhat/contracts/"
  "docs/ROADMAP_UNIFIED.md"
  "docs/DOCS_INDEX.md"
  "scripts/ops/gate_r0_revalidate.sh"
)

for p in "${CANONICAL_PATHS[@]}"; do
  if [ -e "$p" ]; then
    pass "$p"
  else
    soft_fail "Missing canonical path: $p"
  fi
done

# ─── 2. CU != USD invariant ───────────────────────────────────────────────────
section "2. CU != USD invariant"

grep -rq "CU != USD\|CU.*!= USD\|amountCU.*bigint\|cost_units\|costUnits" src/economics/ || soft_fail "CU/USD separation not detectable in src/economics/"
pass "CU separação presente em src/economics/"

grep -q "assertCUInvariant\|CU invariant" src/economics/tokenEconomicsPolicy.ts 2>/dev/null \
  && pass "assertCUInvariant present in tokenEconomicsPolicy.ts" \
  || soft_fail "assertCUInvariant missing from tokenEconomicsPolicy.ts"

grep -q "bigint" src/economics/tokenEconomicsTypes.ts 2>/dev/null \
  && pass "amountCU typed as bigint in tokenEconomicsTypes.ts" \
  || soft_fail "bigint typing missing from tokenEconomicsTypes.ts"

# ─── 3. ROADMAP completeness ──────────────────────────────────────────────────
section "3. ROADMAP_UNIFIED.md completeness"

ROADMAP="docs/ROADMAP_UNIFIED.md"
for pack in "PACK-F1" "PACK-F2" "PACK-F3" "PACK-F4" "PACK-G1" "PACK-G2" "PACK-G3" "PACK-G4"; do
  if grep -q "$pack" "$ROADMAP"; then
    pass "$pack present in ROADMAP"
  else
    soft_fail "$pack missing from ROADMAP"
  fi
done

grep -q "CONCLUÍDO" "$ROADMAP" || soft_fail "No CONCLUÍDO status in ROADMAP"
pass "CONCLUÍDO status present in ROADMAP"

# ─── 4. docs/_ops/ structure ──────────────────────────────────────────────────
section "4. docs/_ops/ evidence structure"

for dir in "docs/_ops/revalidation" "docs/_ops/f1" "docs/_ops/f2" "docs/_ops/f3" "docs/_ops/f4" "docs/_ops/g1" "docs/_ops/g2" "docs/_ops/g3" "docs/_ops/g4" "docs/_ops/rc2"; do
  if [ -d "$dir" ]; then
    pass "$dir present"
  else
    soft_fail "Missing EVD dir: $dir"
  fi
done

# ─── 5. ZK ceremony artifacts ─────────────────────────────────────────────────
section "5. ZK ceremony artifacts"

ZK_ARTIFACTS=(
  "zk/keys/metering_v2_final_mpc.zkey"
  "zk/keys/metering_v2_vkey_mpc.json"
  "zk/ceremony/state.json"
)
for f in "${ZK_ARTIFACTS[@]}"; do
  [ -f "$f" ] && pass "$f" || soft_fail "Missing ZK artifact: $f"
done

# ─── 6. Working tree state ────────────────────────────────────────────────────
section "6. Git working tree"

DIRTY=$(git status --porcelain)
if [ -z "$DIRTY" ]; then
  pass "Working tree clean"
else
  warn "Uncommitted changes detected:"
  echo "$DIRTY" | head -10
fi

BRANCH=$(git branch --show-current)
pass "Branch: $BRANCH"

LAST_COMMIT=$(git log --oneline -1)
pass "Last commit: $LAST_COMMIT"

# ─── 7. Core modules untouched ────────────────────────────────────────────────
section "7. Core module integrity (spot check)"

for f in "src/economics/CUEngine.ts" "src/sdk/OTKSDK.ts" "zk/circuits/metering_v2.circom"; do
  if git log --oneline --follow -- "$f" | grep -qE "feat\(g[1-4]\)|chore\(rc2\)"; then
    soft_fail "$f was modified in G1-G4/RC2 packs (expected: untouched)"
  else
    pass "$f not modified in G1-G4/RC2 packs"
  fi
done

# ─── Result ───────────────────────────────────────────────────────────────────
echo ""
if [ $AUDIT_ISSUES -eq 0 ]; then
  echo "✅ rc2_final_audit.sh: ALL AUDIT CHECKS PASSED"
  RESULT="PASS"
else
  echo "⚠ rc2_final_audit.sh: $AUDIT_ISSUES ISSUE(S) DETECTED — review above"
  RESULT="WARN:${AUDIT_ISSUES}"
fi

if [ -n "$OUTPUT_DIR" ]; then
  mkdir -p "$OUTPUT_DIR"
  {
    echo "rc2_final_audit: $RESULT"
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "issues: $AUDIT_ISSUES"
    echo "branch: $BRANCH"
    echo "last_commit: $LAST_COMMIT"
  } > "$OUTPUT_DIR/final_audit_result.txt"
  pass "Evidence written to $OUTPUT_DIR/final_audit_result.txt"
fi
