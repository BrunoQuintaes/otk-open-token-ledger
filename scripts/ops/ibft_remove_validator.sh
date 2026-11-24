#!/usr/bin/env bash
# ibft_remove_validator.sh — Propose removing an IBFT validator
#
# IBFT 2.0: removal also requires quorum vote.
# WARNING: Removing below minimum (f=1 → min 4 validators) breaks consensus.
#
# Usage: bash scripts/ops/ibft_remove_validator.sh <0xADDRESS> [rpc_url]
# Default RPC: http://127.0.0.1:8545

set -euo pipefail
ADDRESS="${1:-}"
RPC="${2:-http://127.0.0.1:8545}"

if [[ -z "$ADDRESS" ]]; then
  echo "Usage: bash scripts/ops/ibft_remove_validator.sh <0xADDRESS> [rpc_url]"
  exit 1
fi

if ! [[ "$ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "❌ Invalid address format: $ADDRESS (expected 0x + 40 hex chars)"
  exit 1
fi

echo "⚠️  WARNING: Removing a validator reduces fault tolerance."
echo "   Current minimum: 4 validators (f=1, requires 3f+1=4)"
echo "   Removing below 4 breaks IBFT consensus."
echo ""
echo "Proposing REMOVE validator: $ADDRESS"
echo "RPC: $RPC"
echo ""

response=$(curl -sf --max-time 5 -X POST "$RPC" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"ibft_proposeValidatorVote\",\"params\":[\"$ADDRESS\",false],\"id\":1}" \
  2>/dev/null) || {
    echo "❌ RPC unavailable at $RPC"
    echo "   Start network: bash scripts/ops/besu_up_full.sh"
    exit 1
  }

echo "Response: $response"
echo ""
echo "Verify: bash scripts/ops/ibft_list_validators.sh $RPC"
