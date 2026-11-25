#!/usr/bin/env bash
# Smoke test of a Besu JSON-RPC endpoint: prints eth_chainId and two eth_blockNumber readings taken
# 3 seconds apart, so a person can see whether the chain is producing blocks. It prints the raw JSON
# replies and does not compare them; the exit code does not say whether blocks advanced.
# Needs curl.
# Usage: bash scripts/ops/besu_rpc_smoke.sh [rpc-url]   (default http://127.0.0.1:8545)
set -euo pipefail
rpc="${1:-http://127.0.0.1:8545}"
call() {
  local m="$1"; shift
  curl -s "$rpc" -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$m\",\"params\":[]}"
}
echo "rpc=$rpc"
echo "eth_chainId: $(call eth_chainId)"
b1="$(call eth_blockNumber)"
sleep 3
b2="$(call eth_blockNumber)"
echo "block1=$b1"
echo "block2=$b2"
