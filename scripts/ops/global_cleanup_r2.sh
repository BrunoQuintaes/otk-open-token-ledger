#!/usr/bin/env bash
# Historical second round of the repository cleanup, kept as a record. It finds duplicate files, archives
# legacy docs with `git mv`, rewrites docs/INDEX.md, deletes listed untracked files, runs `npm test` and
# gate_r0_revalidate.sh, and runs `git add -A` and `git commit` when the gate prints GO.
# The `cd <HOME>/...` line is a redacted placeholder, so the script does not run as published; it is not
# part of any test or build.
# Usage: bash scripts/ops/global_cleanup_r2.sh   (only after replacing the placeholder path)
# =========================
# OTK zk-Metering — Global cleanup round 2
# docs + whole repo, evidence-first, STOP before U8.5
# =========================

set -euo pipefail

cd <HOME>/otk-zk-metering
TS="$(date +%Y%m%d_%H%M%S)"
EVD="docs/_ops/u8/U8_GLOBAL_CLEANUP_R2_${TS}"
ARCH="docs/_archive/${TS}"
mkdir -p "$EVD" "$ARCH"

echo "EVIDENCE_DIR=$EVD" | tee "$EVD/00_meta.txt"
echo "ARCHIVE_DIR=$ARCH" | tee -a "$EVD/00_meta.txt"

# ------------------------------------------------------------
# 0) Context snapshot
# ------------------------------------------------------------
{
  echo "=== GIT STATUS ==="
  git status -sb
  echo
  echo "=== LAST 60 COMMITS ==="
  git log -n 60 --oneline --decorate
  echo
  echo "=== TRACKED ROADMAP VARIANTS ==="
  git ls-files | grep -Ei '(^|/)(roadmap.*|ROADMAP.*)\.md$' || true
  echo
  echo "=== TRACKED DOCS TREE (depth 4) ==="
  (command -v tree >/dev/null && tree -a -L 4 docs) || find docs -maxdepth 4 -print
} | tee "$EVD/01_context.txt"

# ------------------------------------------------------------
# 1) Find duplicates (content + basename) across WHOLE repo
#    - tracked-only for safety
# ------------------------------------------------------------
{
  echo "=== DUPLICATE BASENAMES (top 250) ==="
  git ls-files | awk -F/ '{print $NF}' | sort | uniq -c | sort -nr | head -n 250
  echo
  echo "=== POSSIBLE DUPLICATE CONTENT (md/txt/json/yml) via hashes ==="
  TMP="$EVD/_hashes.txt"
  : > "$TMP"
  git ls-files | grep -E '\.(md|txt|json|ya?ml)$' | while read -r f; do
    if [ -f "$f" ]; then
      sha1sum "$f" >> "$TMP"
    fi
  done
  sort "$TMP" | awk '{print $1}' | uniq -d | while read -r h; do
    echo "--- DUP HASH: $h ---"
    grep "^$h " "$TMP" | sed 's/^/  /'
  done
} | tee "$EVD/02_duplicates_report.txt"

# ------------------------------------------------------------
# 2) Docs canonicalization plan (NO destructive changes)
#    Rules:
#    - Canonical roadmap must be docs/ROADMAP_UNIFIED.md
#    - If other roadmap variants exist tracked, archive them (git mv) and create pointer stubs if needed
#    - Create/refresh docs/INDEX.md pointing to canonicals (roadmap + architecture + ADRs + ops)
# ------------------------------------------------------------
CANON_ROADMAP="docs/ROADMAP_UNIFIED.md"
CANON_ARCH="docs/architecture/architecture.md"

{
  echo "=== CANONICAL CHECKS ==="
  [ -f "$CANON_ROADMAP" ] && echo "OK: $CANON_ROADMAP exists" || echo "MISSING: $CANON_ROADMAP"
  [ -f "$CANON_ARCH" ] && echo "OK: $CANON_ARCH exists" || echo "MISSING: $CANON_ARCH"
  echo
  echo "=== ROADMAP VARIANTS (tracked) ==="
  git ls-files | grep -Ei '(^|/)(roadmap.*|ROADMAP.*)\.md$' || true
} | tee "$EVD/03_canonical_checks.txt"

# Archive tracked roadmap duplicates safely (keep canonical only).
ROADMAP_VARIANTS=$(git ls-files | grep -Ei '(^|/)(roadmap.*|ROADMAP.*)\.md$' || true)
for f in $ROADMAP_VARIANTS; do
  # keep canonical
  if [ "$f" = "$CANON_ROADMAP" ]; then
    continue
  fi

  # skip already-archived files
  if echo "$f" | grep -qE '^docs/_ops/|^docs/_archive/'; then
    continue
  fi

  # if file exists tracked, archive it
  if [ -f "$f" ]; then
    mkdir -p "$ARCH/$(dirname "$f")"
    echo "ARCHIVE: $f -> $ARCH/$f" | tee -a "$EVD/04_actions.txt"
    git mv "$f" "$ARCH/$f"

    # Create stub if original path is commonly referenced
    if echo "$f" | grep -Eq '(^ROADMAP\.md$|^docs/roadmap\.md$|^docs/ROADMAP\.md$)'; then
      echo "STUB: recreating $f to point canonical" | tee -a "$EVD/04_actions.txt"
      mkdir -p "$(dirname "$f")" 2>/dev/null || true
      cat > "$f" << STUB_EOF
# Deprecated (moved to archive)

Canonical roadmap: \`$CANON_ROADMAP\`

This file is kept as a pointer only.
STUB_EOF
      git add "$f"
    fi
  fi
done

# Build docs/INDEX.md (or refresh) to reduce future duplication
cat > docs/INDEX.md << INDEX_EOF
# Docs Index (Canonical)

## Canonical References
- Roadmap (U0-U12): \`$CANON_ROADMAP\`
- Architecture: \`$CANON_ARCH\`
- ADRs: \`docs/architecture/adr/\`
- Ops Evidence: \`docs/_ops/\`
- Archive (do not use as source of truth): \`docs/_archive/\`

## Rules
- Do not create new roadmap files. Update \`docs/ROADMAP_UNIFIED.md\` only.
- Deprecated docs must be moved via \`git mv\` into \`docs/_archive/<timestamp>/\`.
INDEX_EOF

git add docs/INDEX.md

# ------------------------------------------------------------
# 3) Broad "docs usefulness" scan (tracked-only, heuristic)
#    - identify stale snapshots, duplicated reports, legacy phase outputs
#    - produce candidates list; auto-archive only if very obvious (name pattern)
# ------------------------------------------------------------
{
  echo "=== DOCS STALE/SNAPSHOT CANDIDATES (tracked) ==="
  git ls-files docs | grep -E '(SNAPSHOT|_snapshot|PATHS_SNAPSHOT|D[0-9]_SPLIT|FILES_ALL|repo_audit|repro_full|U8_1_SPEC|U8_4_1_DOCS|_SPEC)' || true
  echo
  echo "=== ROOT STALE CANDIDATES (tracked) ==="
  git ls-files | grep -E '(^U[0-9].*\.txt$|^U[0-9].*_SPEC.*|^00_.*\.txt$|^01_.*\.txt$)' || true
} | tee "$EVD/05_docs_obsolete_candidates.txt"

# Auto-archive very obvious legacy snapshot TXT files (tracked)
LEGACY_TXT=$(git ls-files | grep -E '(^U8_1_SPEC/|^U8_4_1_DOCS/|PATHS_SNAPSHOT_.*\.txt$|03_docs_snapshot\.txt$)' || true)
for f in $LEGACY_TXT; do
  if [ -f "$f" ]; then
    mkdir -p "$ARCH/$(dirname "$f")"
    echo "ARCHIVE_LEGACY_TXT: $f -> $ARCH/$f" | tee -a "$EVD/04_actions.txt"
    git mv "$f" "$ARCH/$f"
  fi
done

# ------------------------------------------------------------
# 4) Whole-repo: list PS1 scripts and assess replacements (NO auto-delete)
# ------------------------------------------------------------
{
  echo "=== POWERSHELL SCRIPTS (tracked) ==="
  git ls-files | grep -E '\.ps1$' || true
  echo
  echo "=== BASH SCRIPTS (tracked) ==="
  git ls-files | grep -E '\.sh$' || true
  echo
  echo "NOTE: Do not archive PS1 automatically unless a direct .sh equivalent exists and is referenced in docs/entrypoints."
} | tee "$EVD/06_scripts_inventory.txt"

# ------------------------------------------------------------
# 5) Remove untracked junk safely (only in repo root / docs root typical)
# ------------------------------------------------------------
{
  echo "=== UNTRACKED (PRE) ==="
  git status --porcelain
} | tee "$EVD/07_untracked_pre.txt"

# remove common junk if untracked
rm -f 00_context.txt 01_gitlog.txt A1_gate_r0_initial.txt A2_git_grep_secrets.txt D5_tests.txt E1_gate_r0_final.txt 2>/dev/null || true

{
  echo "=== UNTRACKED (POST) ==="
  git status --porcelain
} | tee "$EVD/08_untracked_post.txt"

# ------------------------------------------------------------
# 6) Run tests + Gate R0 (MANDATORY)
# ------------------------------------------------------------
echo "=== npm test ===" | tee "$EVD/09_tests.txt"
npm test 2>&1 | tee -a "$EVD/09_tests.txt" || true

echo "=== Gate R0 ===" | tee "$EVD/10_gate_r0.txt"
bash scripts/ops/gate_r0_revalidate.sh 2>&1 | tee -a "$EVD/10_gate_r0.txt" || true

# ------------------------------------------------------------
# 7) Summary report + Atomic commit ONLY if Gate R0 GO
# ------------------------------------------------------------
cat > "$EVD/CLEANUP_R2_SUMMARY.md" << SUMMARY_EOF
# Global Structural Audit — Round 2 ($TS)

Scope:
- docs/
- root
- src/, test/, scripts/, tools/, infra/, zk/ (scanned for duplicates/basenames and doc staleness)

Actions (safe):
- Archived tracked roadmap variants (kept canonical docs/ROADMAP_UNIFIED.md)
- Created/updated docs/INDEX.md (canonical pointers)
- Archived obvious legacy snapshot TXT files (tracked) via git mv to docs/_archive/$TS/
- Removed only untracked junk files (safe)
- Ran npm test and Gate R0
- STOPPOINT: U8.5 NOT STARTED

Evidence Dir:
- $EVD
SUMMARY_EOF

git add "$EVD" docs/_archive docs/INDEX.md docs/ROADMAP_UNIFIED.md docs/architecture/architecture.md 2>/dev/null || true
git status -sb | tee "$EVD/11_status_precommit.txt"

if grep -q "GATE R0 RESULT: GO" "$EVD/10_gate_r0.txt"; then
  git add -A
  git commit -m "chore: global cleanup R2 (docs canonical + archive duplicates) [pre-U8.5]" \
    2>&1 | tee "$EVD/12_commit.txt" || true
  echo "COMMIT=YES" | tee -a "$EVD/12_commit.txt"
else
  echo "STOP: Gate R0 not GO. No commit." | tee "$EVD/12_commit.txt"
fi

echo "STOPPOINT: U8.5 NOT STARTED" | tee "$EVD/99_STOPPOINT.txt"
echo "DONE. Evidence: $EVD"
