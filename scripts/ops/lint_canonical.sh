#!/usr/bin/env bash
# lint_canonical.sh — Check presence of all canonical files (A11.2 + A11.4)
#
# Validates that the repository contains all required canonical files
# for documentation, configuration, and roadmap integrity.
#
# Returns: 0 if all present, 1 if any missing.
#
# Usage: bash scripts/ops/lint_canonical.sh
#
# @since A11.2 + A11.4 — Wave 1 Pack 12

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MISSING=0
CHECKED=0
PASSED=0

check_file() {
  local rel_path="$1"
  local desc="$2"
  local full_path="$REPO_ROOT/$rel_path"
  CHECKED=$((CHECKED + 1))

  if [ -f "$full_path" ]; then
    PASSED=$((PASSED + 1))
    echo "  [OK]   $rel_path  ($desc)"
  else
    MISSING=$((MISSING + 1))
    echo "  [FAIL] $rel_path  ($desc)"
  fi
}

echo "=========================================="
echo " Canonical File Lint"
echo "=========================================="
echo " Repo: $REPO_ROOT"
echo " Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# ── Core project files ──────────────────────────────────────────────

echo "--- Core Project Files ---"
check_file "CLAUDE.md"                           "Agent instructions"
check_file "package.json"                        "Node.js manifest"
check_file "tsconfig.json"                       "TypeScript config"

# ── Documentation index ─────────────────────────────────────────────

echo ""
echo "--- Documentation ---"
check_file "docs/DOCS_INDEX.md"                  "Docs index (canonical)"
check_file "docs/ROADMAP_UNIFIED.md"             "Unified roadmap"

# ── Roadmap tables ──────────────────────────────────────────────────

echo ""
echo "--- Roadmap Tables ---"
check_file "docs/CANONICAL_PHASE_TABLE.csv"      "Phase archive (historical)"
check_file "docs/CANONICAL_ROADMAP_TABLE.csv"    "Roadmap table (execution-ordered)"

# ── Canonical extensions ────────────────────────────────────────────

echo ""
echo "--- Canonical Extensions ---"
check_file "docs/_canonical/SECURITY_CANONICAL.md"  "Security canonical"

# ── Architecture ────────────────────────────────────────────────────

echo ""
echo "--- Architecture ---"
check_file "docs/architecture/architecture.md"   "C4 architecture doc"

# ── Gate R0 / Ops scripts ──────────────────────────────────────────

echo ""
echo "--- Ops Scripts ---"
check_file "scripts/ops/gate_r0_revalidate.sh"   "Gate R0 revalidation"
check_file "scripts/ops/preflight_claude.sh"      "Agent preflight check"

# ── API ─────────────────────────────────────────────────────────────

echo ""
echo "--- API ---"
check_file "docs/api/openapi.json"               "OpenAPI 3.1.0 spec"

# ── Summary ─────────────────────────────────────────────────────────

echo ""
echo "=========================================="
echo " Result: $PASSED/$CHECKED passed, $MISSING missing"
echo "=========================================="

if [ "$MISSING" -gt 0 ]; then
  echo " STATUS: FAIL"
  exit 1
else
  echo " STATUS: OK"
  exit 0
fi
