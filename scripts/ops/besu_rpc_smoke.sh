#!/usr/bin/env bash
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
