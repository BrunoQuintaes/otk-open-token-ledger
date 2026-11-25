#!/usr/bin/env bash
# Historical one-shot repository cleanup script (see the scope block below), kept as a record. It moves
# files with `git mv`, deletes listed untracked files, runs `npm test` and gate_r0_revalidate.sh, and
# commits when the gate prints GO. The `cd <HOME>/...` line is a redacted placeholder, so the script
# does not run as published; it is not part of any test or build.
# Usage: bash scripts/ops/global_cleanup_audit.sh   (only after replacing the placeholder path)
# ============================================================
# GLOBAL REPO CLEANUP + STRUCTURAL AUDIT (NO U8.5)
# ============================================================
# Scope:
# - Analyze ALL folders (docs, src, test, scripts, tools, infra, zk, root)
# - Detect duplicates, obsolete files, dead scripts, outdated docs
# - Archive legacy items safely (git mv -> docs/_archive/<TS>/)
# - Remove ONLY untracked junk
# - Produce structured technical report
# - Run Gate R0
# - Atomic commit
# - STOP before U8.5
# ============================================================

set -euo pipefail
cd <HOME>/otk-zk-metering

TS="$(date +%Y%m%d_%H%M%S)"
EVD="docs/_ops/u8/U8_GLOBAL_CLEANUP_${TS}"
ARCH="docs/_archive/${TS}"

mkdir -p "$EVD" "$ARCH"

echo "EVIDENCE_DIR=$EVD"
echo "ARCHIVE_DIR=$ARCH"

# ------------------------------------------------------------
# 0) CONTEXT SNAPSHOT
# ------------------------------------------------------------
{
  echo "=== GIT STATUS ==="
  git status -sb
  echo
  echo "=== LAST 40 COMMITS ==="
  git log -n 40 --oneline --decorate
  echo
  echo "=== FULL REPO TREE (depth 4) ==="
  (command -v tree >/dev/null && tree -a -L 4 .) || find . -maxdepth 4 -print
} | tee "$EVD/00_context.txt"

# ------------------------------------------------------------
# 1) GLOBAL INVENTORY
# ------------------------------------------------------------
{
  echo "=== ALL TRACKED FILES ==="
  git ls-files
  echo
  echo "=== DUPLICATE BASENAMES (global) ==="
  git ls-files | awk -F/ '{print $NF}' | sort | uniq -c | sort -nr | head -n 200
  echo
  echo "=== MULTIPLE SCRIPT TYPES (.ps1 vs .sh) ==="
  git ls-files | grep -E '\.(ps1|sh)$' || true
  echo
  echo "=== MULTIPLE ROADMAP VARIANTS ==="
  git ls-files | grep -Ei 'roadmap.*\.md$' || true
} | tee "$EVD/01_inventory.txt"

# ------------------------------------------------------------
# 2) STATIC ANALYSIS — POSSIBLE DEAD CODE
# Heuristics:
# - Files in src not referenced in imports
# - Old PowerShell scripts replaced by .sh
# ------------------------------------------------------------

{
  echo "=== POSSIBLE DEAD TS FILES (no import reference) ==="
  for f in $(git ls-files src | grep -E '\.ts$'); do
    name=$(basename "$f" .ts)
    refs=$(grep -R "$name" src test 2>/dev/null | wc -l)
    if [ "$refs" -le 1 ]; then
      echo "CANDIDATE_UNUSED: $f"
    fi
  done
} | tee "$EVD/02_deadcode_candidates.txt"

# ------------------------------------------------------------
# 3) OBSOLETE SCRIPTS (.ps1 replaced by .sh)
# ------------------------------------------------------------

{
  echo "=== POWERSHELL SCRIPTS ==="
  git ls-files | grep '\.ps1$' || true
} | tee "$EVD/03_ps1_scripts.txt"

# ------------------------------------------------------------
# 4) ARCHIVE STRATEGY
# - Move duplicate roadmaps (except canonical)
# - Move obsolete .ps1 if equivalent .sh exists
# - Move outdated snapshots/pre_refactor folders
# ------------------------------------------------------------

ARCHIVE_INDEX="$ARCH/ARCHIVE_INDEX.md"
echo "# GLOBAL ARCHIVE INDEX — $TS" > "$ARCHIVE_INDEX"
echo "" >> "$ARCHIVE_INDEX"

# --- Roadmap duplicates ---
CANON="docs/ROADMAP_UNIFIED.md"
DUPS=$(git ls-files | grep -Ei 'roadmap.*\.md$' | grep -v "$CANON" || true)

for f in $DUPS; do
  if echo "$f" | grep -qE '^docs/_ops/|^docs/_archive/'; then
    continue
  fi
  dest="$ARCH/$f"
  mkdir -p "$(dirname "$dest")"
  git mv "$f" "$dest"
  echo "ARCHIVED roadmap duplicate: $f" >> "$ARCHIVE_INDEX"
done

# --- Archive ps1 if equivalent sh exists ---
for ps in $(git ls-files | grep '\.ps1$' || true); do
  base=$(basename "$ps" .ps1)
  sh_equiv=$(git ls-files | grep "${base}.sh$" || true)
  if [ -n "$sh_equiv" ]; then
    dest="$ARCH/$ps"
    mkdir -p "$(dirname "$dest")"
    git mv "$ps" "$dest"
    echo "ARCHIVED ps1 (replaced by sh): $ps" >> "$ARCHIVE_INDEX"
  fi
done

# --- Archive snapshot folders ---
SNAP=$(git ls-files | grep -Ei 'snapshot|pre_refactor|legacy' || true)
for f in $SNAP; do
  dest="$ARCH/$f"
  mkdir -p "$(dirname "$dest")"
  git mv "$f" "$dest" || true
  echo "ARCHIVED snapshot/legacy: $f" >> "$ARCHIVE_INDEX"
done

# ------------------------------------------------------------
# 5) CLEAN UNTRACKED JUNK (root txt etc)
# ------------------------------------------------------------
git status --porcelain | tee "$EVD/04_untracked_before.txt"

for f in 00_context.txt 01_gitlog.txt A1_gate_r0_initial.txt A2_git_grep_secrets.txt D5_tests.txt E1_gate_r0_final.txt; do
  if [ -f "$f" ] && ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    rm -f "$f"
    echo "REMOVED untracked junk: $f" >> "$EVD/05_untracked_removed.txt"
  fi
done

# ------------------------------------------------------------
# 6) VALIDATE BUILD + GATE R0
# ------------------------------------------------------------
echo "=== npm test ===" | tee "$EVD/06_tests.txt"
npm test 2>&1 | tee -a "$EVD/06_tests.txt" || true

echo "=== Gate R0 ===" | tee "$EVD/07_gate_r0.txt"
bash scripts/ops/gate_r0_revalidate.sh 2>&1 | tee -a "$EVD/07_gate_r0.txt" || true

# ------------------------------------------------------------
# 7) FINAL COMMIT (only if Gate R0 PASS)
# ------------------------------------------------------------
git status -sb | tee "$EVD/08_status.txt"

if grep -q "GATE R0 RESULT: GO" "$EVD/07_gate_r0.txt"; then
  git add docs src scripts tools infra zk "$EVD" || true
  git commit -m "chore: global repo cleanup + archive duplicates/legacy + structural audit (pre-U8.5)" \
    2>&1 | tee "$EVD/09_commit.txt" || true
else
  echo "STOP: Gate R0 not GO. No commit." | tee "$EVD/09_commit.txt"
fi

# ------------------------------------------------------------
# 8) REPORT
# ------------------------------------------------------------
cat > "$EVD/CLEANUP_SUMMARY.md" << SUMMARY_EOF
# Global Structural Audit — $TS

Scope:
- Docs
- src
- test
- scripts
- tools
- infra
- zk
- root

Actions:
- Archived duplicate roadmaps (except canonical)
- Archived obsolete .ps1 replaced by .sh
- Archived snapshot/legacy files
- Removed untracked junk
- Generated dead code candidates list
- Ran Gate R0
- Atomic commit (if PASS)

Evidence:
$EVD
SUMMARY_EOF

echo "DONE. Evidence: $EVD"
echo "STOPPOINT: U8.5 NOT STARTED"
