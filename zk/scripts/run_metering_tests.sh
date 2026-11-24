#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZK_DIR="$ROOT/zk"
BUILD_DIR="$ZK_DIR/build"
SCRIPT_DIR="$ZK_DIR/scripts"
CIRCUIT="$ZK_DIR/circuits/metering_v1.circom"
DEMO="$SCRIPT_DIR/run_metering_demo.sh"

TS="$(date +"%Y%m%d_%H%M%S")"
OUT_DIR="$ROOT/docs/_ops/u8/U8_3_TESTS_${TS}"
mkdir -p "$OUT_DIR"
mkdir -p "$BUILD_DIR"

SUMMARY="$OUT_DIR/SUMMARY.csv"
echo "case,expected,actual,notes" > "$SUMMARY"

run_case () {
  local name="$1"
  local userId="$2"
  local usage="$3"
  local nonce="$4"
  local epoch="$5"
  local maxUsage="$6"
  local expected="$7"

  local input="$BUILD_DIR/metering_input.json"
  local log="$OUT_DIR/${name}.log"

  cat > "$input" <<EOF
{
  "userId": "$userId",
  "usage": "$usage",
  "nonce": "$nonce",
  "epoch": "$epoch",
  "maxUsage": "$maxUsage"
}
EOF

  set +e
  bash "$DEMO" >"$log" 2>&1
  local rc=$?
  set -e

  if [[ "$expected" == "PASS" ]]; then
    if [[ $rc -eq 0 ]]; then
      echo "$name,PASS,PASS,ok" >> "$SUMMARY"
    else
      echo "$name,PASS,FAIL,exit=$rc" >> "$SUMMARY"
    fi
  else
    # expected FAIL
    if [[ $rc -ne 0 ]]; then
      echo "$name,FAIL,FAIL,exit=$rc" >> "$SUMMARY"
    else
      echo "$name,FAIL,PASS,unexpected success" >> "$SUMMARY"
    fi
  fi
}

# Guardrails
test -f "$CIRCUIT" || { echo "ERR: missing circuit: $CIRCUIT"; exit 2; }
test -f "$DEMO" || { echo "ERR: missing demo script: $DEMO"; exit 3; }

# Cases
run_case "valid_usage_0"        "12345678901234567890" "0"    "111" "1" "1000" "PASS"
run_case "valid_usage_max"      "12345678901234567890" "1000" "222" "1" "1000" "PASS"
run_case "valid_usage_random"   "12345678901234567890" "777"  "333" "1" "1000" "PASS"

run_case "invalid_usage_gt_max" "12345678901234567890" "1001" "444" "1" "1000" "FAIL"

echo "OK: tests finished. See $SUMMARY"
