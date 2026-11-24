#!/usr/bin/env bash
# H1R2 B3 - optional Linux/macOS twin of run_pa03_v1.ps1 (see README_PA03_V1.md). Runs ONLY the two legacy PA-03 v1
# contract tests (tools/hardhat/test/PA03Closeout.test.js) with the historical key found LOCALLY, after checking its
# SHA-256 against the published one; saves sanitized evidence outside the repository. The key is only hashed, never
# read, printed, copied or linked. No network unless NPM_CI=1 (npm ci) or COMPILE=1 (hardhat compile; solc download
# only if not cached). A local pass does NOT change the repository status (pending_author_evidence).
#   OTK_PA03_V1_ZKEY=/path/metering_v1_final.zkey [OUT_DIR=...] [NPM_CI=1] [COMPILE=1] bash tools/academic_demo/windows/run_pa03_v1.sh
# Exit: 0 both passed locally, 1 not both passed, 2 usage/env, 3 key not found, 4 hash differs, 5 deps/artifacts missing.
set -u
EXPECTED_SHA256="e53adcc7650a10b71b9e05e29c56d46700654f8937aaa6ba1e1616805628d60f"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HH="$ROOT/tools/hardhat"
TEST_FILE="test/PA03Closeout.test.js"
stop() { echo "[pa03-v1] STOP (exit $1): $2 -- status unchanged: pending_author_evidence" >&2; exit "$1"; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

grep -q "process.env.OTK_PA03_V1_ZKEY" "$HH/$TEST_FILE" || stop 2 "PA03Closeout.test.js does not read OTK_PA03_V1_ZKEY (checkout older than H1R2 B3)"
ZKEY=""
for c in "${OTK_PA03_V1_ZKEY:-}" "$ROOT/zk/build/metering_v1_final.zkey" "$ROOT/../integ/zk/build/metering_v1_final.zkey"; do
  if [ -n "$c" ] && [ -f "$c" ]; then ZKEY="$(cd "$(dirname "$c")" && pwd)/$(basename "$c")"; break; fi
done
[ -n "$ZKEY" ] || stop 3 "historical v1 key not found locally (set OTK_PA03_V1_ZKEY); do NOT regenerate it"
GOT="$(sha "$ZKEY")"
echo "[pa03-v1] key sha256 $GOT"
[ "$GOT" = "$EXPECTED_SHA256" ] || stop 4 "sha256 differs from the published $EXPECTED_SHA256 (not the original key); nothing was run"

OUT_DIR="${OUT_DIR:-$HOME/otk_pa03_v1_evidence/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT_DIR" && OUT_DIR="$(cd "$OUT_DIR" && pwd)"
case "$OUT_DIR/" in "$ROOT/"*) [ "${ALLOW_OUTPUT_INSIDE_REPO:-0}" = 1 ] || stop 2 "OUT_DIR is inside the repository";; esac

if [ "${NPM_CI:-0}" = 1 ]; then (cd "$ROOT" && npm ci --no-audit --no-fund) && (cd "$HH" && npm ci --no-audit --no-fund) || stop 5 "npm ci failed"; fi
[ -d "$HH/node_modules/hardhat" ] || stop 5 "tools/hardhat/node_modules missing (NPM_CI=1)"
if [ "${COMPILE:-0}" = 1 ]; then (cd "$HH" && npx hardhat compile) || stop 5 "hardhat compile failed"; fi
[ -d "$HH/artifacts" ] || stop 5 "tools/hardhat/artifacts missing (COMPILE=1)"

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RAW="$(mktemp -d)"
(cd "$HH" && OTK_PA03_V1_ZKEY="$ZKEY" node --test --test-reporter=tap --test-concurrency=1 "$TEST_FILE") >"$RAW/out" 2>"$RAW/err"
RC=$?
KDIR="$(dirname "$ZKEY")"
san() { sed -e "s#$ROOT#<REPO>#g" -e "s#$KDIR#<ZKEY_DIR>#g" -e "s#$HOME#<HOME>#g" "$1"; }
san "$RAW/out" >"$OUT_DIR/R07e_PA03_v1.tap.txt"; san "$RAW/err" >"$OUT_DIR/R07e_PA03_v1.stderr.txt"; rm -rf "$RAW"
n() { grep -E "^# $1 [0-9]+" "$OUT_DIR/R07e_PA03_v1.tap.txt" | awk '{print $3}'; }
RESULT=LOCAL_RUN_FAILED
[ "$RC" = 0 ] && [ "$(n tests)" = 2 ] && [ "$(n pass)" = 2 ] && [ "$(n skipped)" = 0 ] && RESULT=LOCAL_RUN_PASSED
cat >"$OUT_DIR/evidence.json" <<EOF
{"schema":"otk.h1r2.pa03_v1_author_run.v1","repository_status":"pending_author_evidence","local_result":"$RESULT",
 "started_utc":"$STARTED","finished_utc":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","commit_sha":"$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)",
 "tracked_changes":$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null | wc -l),"node_exit_code":$RC,
 "tap_counts":{"tests":"$(n tests)","pass":"$(n pass)","fail":"$(n fail)","skipped":"$(n skipped)"},
 "key":{"file_name":"$(basename "$ZKEY")","sha256":"$GOT","expected_sha256":"$EXPECTED_SHA256","content_saved":false},
 "environment":{"node":"$(node --version)","npm":"$(npm --version)","os":"$(uname -srm)","npm_ci_run":"${NPM_CI:-0}","hardhat_compile_run":"${COMPILE:-0}"}}
EOF
(cd "$OUT_DIR" && for f in R07e_PA03_v1.tap.txt R07e_PA03_v1.stderr.txt evidence.json; do echo "$(sha "$f")  $f"; done >SHA256SUMS.txt)
echo "[pa03-v1] local result: $RESULT (node exit $RC); evidence in $OUT_DIR; repository status stays pending_author_evidence"
[ "$RESULT" = LOCAL_RUN_PASSED ]
