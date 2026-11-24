#!/usr/bin/env bash
# =========================
# FINAL (TODAY) — Structural Scan + Architecture(C4) sanity + Fix witness ESM + Revalidate
# Evidence-first, atomic commit only if ALL GREEN, STOP before U8.5
# =========================

set -euo pipefail

cd <HOME>/otk-zk-metering
TS="$(date +%Y%m%d_%H%M%S)"
EVD="docs/_ops/u8/U8_FINAL_TODAY_AUDIT_${TS}"
ARCH="docs/_archive/${TS}"
mkdir -p "$EVD" "$ARCH"

echo "EVIDENCE_DIR=$EVD" | tee "$EVD/00_meta.txt"
echo "ARCHIVE_DIR=$ARCH" | tee -a "$EVD/00_meta.txt"

# ------------------------------------------------------------
# 0) Context snapshot
# ------------------------------------------------------------
{
  echo "=== CONTEXT ==="
  git status -sb
  echo
  echo "=== LAST 40 COMMITS ==="
  git log -n 40 --oneline --decorate
  echo
  echo "=== DOCS TREE (depth 4) ==="
  (command -v tree >/dev/null && tree -a -L 4 docs) || find docs -maxdepth 4 -print
  echo
  echo "=== ARCHITECTURE CANDIDATES (tracked) ==="
  git ls-files docs | grep -Ei '(architecture|arquitetura|c4|target)\.md$' || true
  echo
  echo "=== ROADMAP VARIANTS (tracked) ==="
  git ls-files | grep -Ei '(^|/)(roadmap.*|ROADMAP.*)\.md$' || true
} | tee "$EVD/01_context.txt"

# ------------------------------------------------------------
# 1) Ensure canonicals exist + archive obvious duplicates
# ------------------------------------------------------------
CANON_ROADMAP="docs/ROADMAP_UNIFIED.md"
CANON_ARCH="docs/architecture/architecture.md"

{
  echo "=== CANONICAL CHECKS ==="
  [ -f "$CANON_ROADMAP" ] && echo "OK: $CANON_ROADMAP" || echo "MISSING: $CANON_ROADMAP"
  [ -f "$CANON_ARCH" ] && echo "OK: $CANON_ARCH" || echo "MISSING: $CANON_ARCH"
  [ -f "docs/INDEX.md" ] && echo "OK: docs/INDEX.md" || echo "MISSING: docs/INDEX.md"
} | tee "$EVD/02_canonical_checks.txt"

# Archive architecture duplicates (tracked) safely, keep canonical only.
ARCH_CANDIDATES=$(git ls-files docs | grep -Ei '(^docs/(ARQUITETURA|architecture|target|c4)\.md$|^docs/architecture/target\.md$|^docs/ARQUITETURA\.md$)' || true)

for f in $ARCH_CANDIDATES; do
  if [ "$f" = "$CANON_ARCH" ]; then
    continue
  fi
  if echo "$f" | grep -qE '^docs/_ops/|^docs/_archive/'; then
    continue
  fi

  if [ -f "$f" ]; then
    mkdir -p "$ARCH/$(dirname "$f")"
    echo "ARCHIVE_ARCH_DOC: $f -> $ARCH/$f" | tee -a "$EVD/03_actions.txt"
    git mv "$f" "$ARCH/$f"

    if echo "$f" | grep -Eq '(^docs/ARQUITETURA\.md$|^docs/architecture/target\.md$|^docs/architecture\.md$)'; then
      echo "STUB: recreating $f to point canonical" | tee -a "$EVD/03_actions.txt"
      mkdir -p "$(dirname "$f")" 2>/dev/null || true
      cat > "$f" << STUB_EOF
# Deprecated (moved to archive)

Canonical architecture: \`$CANON_ARCH\`

This file is kept as a pointer only.
STUB_EOF
      git add "$f"
    fi
  fi
done

# Refresh docs/INDEX.md
cat > docs/INDEX.md << INDEX_EOF
# Docs Index (Canonical)

## Canonical References
- Roadmap (U0-U12): \`$CANON_ROADMAP\`
- Architecture (C4 + ADR-backed decisions): \`$CANON_ARCH\`
- ADRs: \`docs/architecture/adr/\`
- Ops Evidence: \`docs/_ops/\`
- Archive (do not use as source of truth): \`docs/_archive/\`

## Rules (Non-negotiable)
- Do not create new roadmap files. Update \`docs/ROADMAP_UNIFIED.md\` only.
- Do not create parallel architecture docs. Update \`docs/architecture/architecture.md\` only.
- Deprecated docs must be moved via \`git mv\` into \`docs/_archive/<timestamp>/\`.
INDEX_EOF

git add docs/INDEX.md

# ------------------------------------------------------------
# 2) Fix witness generation under ESM ("type":"module") projects
# ------------------------------------------------------------
mkdir -p scripts/zk

cat > scripts/zk/generate_witness.cjs << 'CJS_EOF'
#!/usr/bin/env node
/**
 * Wrapper to execute circom-generated witness calculator in projects with "type":"module".
 * Usage:
 *   node scripts/zk/generate_witness.cjs <wasm> <input.json> <wtns> [witness_calculator.js_dir]
 *
 * Default witness_calculator dir:
 *   zk/build/metering_v1_js
 */
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const [,, wasmPath, inputPath, wtnsPath, wcDirArg] = process.argv;
if (!wasmPath || !inputPath || !wtnsPath) {
  die("Usage: node scripts/zk/generate_witness.cjs <wasm> <input.json> <wtns> [witness_calculator_dir]");
}

const wcDir = wcDirArg || path.join("zk", "build", "metering_v1_js");
const wcFile = path.join(wcDir, "witness_calculator.js");
if (!fs.existsSync(wcFile)) die("Missing witness_calculator.js at: " + wcFile);

const requireFromWcDir = createRequire(path.resolve(wcFile));
const wc = requireFromWcDir("./witness_calculator.js");

(async () => {
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const buffer = fs.readFileSync(wasmPath);

  const calculator = await wc(buffer);
  const witness = await calculator.calculateWTNSBin(input, 0);

  fs.writeFileSync(wtnsPath, witness);
  console.log("OK: wrote witness -> " + wtnsPath);
})().catch((e) => {
  console.error("Witness generation failed:", e);
  process.exit(1);
});
CJS_EOF

chmod +x scripts/zk/generate_witness.cjs
git add scripts/zk/generate_witness.cjs

# Patch verify_binding.sh (if exists) to use wrapper (safe, idempotent)
if [ -f scripts/zk/verify_binding.sh ]; then
  cp scripts/zk/verify_binding.sh "$EVD/verify_binding.sh.before" || true
  if grep -q "generate_witness\.js" scripts/zk/verify_binding.sh; then
    sed -i 's|generate_witness\.js|../../../scripts/zk/generate_witness.cjs|g' scripts/zk/verify_binding.sh || true
    echo "PATCH: scripts/zk/verify_binding.sh updated to use generate_witness.cjs" | tee -a "$EVD/03_actions.txt"
    git add scripts/zk/verify_binding.sh
  fi
fi

# Patch CircuitBinding.test.ts to call wrapper instead of circom-generated .js
CB_TEST="test/integration/CircuitBinding.test.ts"
if [ -f "$CB_TEST" ]; then
  cp "$CB_TEST" "$EVD/CircuitBinding.test.ts.before" || true
  # We'll handle this via a targeted python patch for reliability
  python3 - "$CB_TEST" << 'PYEOF'
import sys, re, pathlib

p = pathlib.Path(sys.argv[1])
txt = p.read_text(encoding="utf-8", errors="ignore")

old_pattern = r'generate_witness\.js'
if re.search(old_pattern, txt):
    # Replace any reference to the circom-generated generate_witness.js with our .cjs wrapper
    # The key replacement: change the node command to use the wrapper
    txt = txt.replace(
        'zk\\\\build\\\\metering_v1_js\\\\generate_witness.js',
        'scripts\\\\zk\\\\generate_witness.cjs'
    )
    txt = txt.replace(
        'zk/build/metering_v1_js/generate_witness.js',
        'scripts/zk/generate_witness.cjs'
    )
    # Also add the witness_calculator dir as last arg if not present
    # Handle the Windows backslash path variant
    txt = txt.replace(
        '"zk\\\\build\\\\metering_v1_js\\\\metering_v1.wasm" "zk\\\\build\\\\test_input.json" "zk\\\\build\\\\test_witness.wtns"',
        '"zk\\\\build\\\\metering_v1_js\\\\metering_v1.wasm" "zk\\\\build\\\\test_input.json" "zk\\\\build\\\\test_witness.wtns" "zk\\\\build\\\\metering_v1_js"'
    )
    txt = txt.replace(
        '"zk/build/metering_v1_js/metering_v1.wasm" "zk/build/test_input.json" "zk/build/test_witness.wtns"',
        '"zk/build/metering_v1_js/metering_v1.wasm" "zk/build/test_input.json" "zk/build/test_witness.wtns" "zk/build/metering_v1_js"'
    )
    p.write_text(txt, encoding="utf-8")
    print("PATCHED: CircuitBinding.test.ts -> generate_witness.cjs")
else:
    print("NO CHANGE: generate_witness.js not found in test")
PYEOF
  git add "$CB_TEST"
  echo "PATCH: CircuitBinding.test.ts processed" | tee -a "$EVD/03_actions.txt"
fi

# ------------------------------------------------------------
# 3) Revalidate (tests + Gate R0)
# ------------------------------------------------------------
echo "=== npm test (FINAL) ===" | tee "$EVD/04_tests.txt"
set +e
npm test 2>&1 | tee -a "$EVD/04_tests.txt"
TEST_RC=${PIPESTATUS[0]}
set -e

echo "=== Gate R0 (FINAL) ===" | tee "$EVD/05_gate_r0.txt"
set +e
bash scripts/ops/gate_r0_revalidate.sh 2>&1 | tee -a "$EVD/05_gate_r0.txt"
GATE_RC=${PIPESTATUS[0]}
set -e

# ------------------------------------------------------------
# 4) Final summary + atomic commit only if ALL GREEN
# ------------------------------------------------------------
cat > "$EVD/FINAL_TODAY_SUMMARY.md" << SUMMARY_EOF
# Final Today — Structural + Architecture(C4) + Witness ESM Fix ($TS)

## Goals
- Keep canonical docs only:
  - docs/ROADMAP_UNIFIED.md
  - docs/architecture/architecture.md (C4 + ADR-backed)
  - docs/architecture/adr/*
  - docs/INDEX.md
- Archive duplicates safely via git mv into docs/_archive/$TS/
- Fix witness generation under ESM (Node + "type":"module")
- Revalidate: npm test + Gate R0
- STOPPOINT: do not start U8.5

## Results
- TEST_RC=$TEST_RC
- GATE_RC=$GATE_RC

Evidence dir: $EVD
SUMMARY_EOF

git add "$EVD" docs/INDEX.md docs/_archive scripts/zk/generate_witness.cjs 2>/dev/null || true
git status -sb | tee "$EVD/06_status_precommit.txt"

ALL_GREEN=0
if [ "$TEST_RC" -eq 0 ] && grep -q "GATE R0 RESULT: GO" "$EVD/05_gate_r0.txt"; then
  ALL_GREEN=1
fi

if [ "$ALL_GREEN" -eq 1 ]; then
  git add -A
  git commit -m "chore: final today audit (docs canon + C4 sanity + witness ESM fix) [pre-U8.5]" \
    2>&1 | tee "$EVD/07_commit.txt" || true
  echo "COMMIT=YES" | tee -a "$EVD/07_commit.txt"
else
  echo "STOP: Not all green (TEST_RC=$TEST_RC, GATE_RC=$GATE_RC). No commit." | tee "$EVD/07_commit.txt"
fi

echo "STOPPOINT: U8.5 NOT STARTED" | tee "$EVD/99_STOPPOINT.txt"
echo "DONE. Evidence: $EVD"
