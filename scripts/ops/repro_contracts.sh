#!/usr/bin/env bash
# Usage: bash scripts/ops/repro_contracts.sh v3|legacy|full   (the profiles are described below)
# Runs the Hardhat contract tests under tools/hardhat (`npx hardhat compile`, then `node --test`).
# Contract-test reproduction profiles (fechamento pós-S5, correção da fila — item 6). No test is removed:
#   bash scripts/ops/repro_contracts.sh v3      every tools/hardhat test EXCEPT the legacy PA-03 (needs no file
#                                               outside Git). Not "the whole historical suite".
#   bash scripts/ops/repro_contracts.sh legacy  PA-03 only (v1 Groth16 proof + on-chain), after checking that
#                                               zk/build/metering_v1_final.zkey is THE original artifact (sha256)
#   bash scripts/ops/repro_contracts.sh full    the whole suite, as the historical gates run it; without the
#                                               legacy artifact PA-03 is cancelled (exit != 0), never skipped
# The legacy zkey is not in Git: obtain it from the author and place it at zk/build/metering_v1_final.zkey.
# Regenerating it with scripts/setup/03_finalize.sh yields ANOTHER key (another hash) and is refused here.
set -u
PROFILE="${1:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ZKEY="$ROOT/zk/build/metering_v1_final.zkey"
ZKEY_SHA256="e53adcc7650a10b71b9e05e29c56d46700654f8937aaa6ba1e1616805628d60f"
LEGACY="PA03Closeout.test.js"
cd "$ROOT/tools/hardhat" || exit 2
case "$PROFILE" in
  v3)
    files=$(ls test/*.test.js | grep -v "$LEGACY")
    echo "profile v3: $(echo "$files" | wc -l) files (legacy $LEGACY excluded from THIS profile only)"
    npx hardhat compile && node --test $files ;;
  legacy)
    if [ ! -f "$ZKEY" ]; then echo "profile legacy: $ZKEY missing (obtain the original from the author; not in Git)"; exit 3; fi
    got=$(sha256sum "$ZKEY" | cut -d' ' -f1)
    if [ "$got" != "$ZKEY_SHA256" ]; then echo "profile legacy: sha256 $got != original $ZKEY_SHA256 (not the original artifact)"; exit 4; fi
    echo "profile legacy: original v1 zkey present (sha256 $got)"
    npx hardhat compile && node --test "test/$LEGACY" ;;
  full)
    echo "profile full: every file; PA-03 needs the legacy zkey ($( [ -f "$ZKEY" ] && echo present || echo ABSENT ))"
    npx hardhat compile && node --test test/*.test.js ;;
  *) echo "usage: $0 v3|legacy|full" >&2; exit 2 ;;
esac
