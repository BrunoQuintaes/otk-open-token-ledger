#!/usr/bin/env bash
# ibft_add_validator.sh — Propose adding a new IBFT validator
#
# IBFT 2.0: adding a validator requires a quorum vote (ceil((n+1)/2) validators).
# This script submits the proposal from node1 (default).
# Each existing validator must also call this independently to reach quorum.
#
# Usage: bash scripts/ops/ibft_add_validator.sh <0xADDRESS> [rpc_url]
# Default RPC: http://127.0.0.1:8545

set -euo pipefail
ADDRESS="${1:-}"
RPC="${2:-http://127.0.0.1:8545}"

if [[ -z "$ADDRESS" ]]; then
  echo "Usage: bash scripts/ops/ibft_add_validator.sh <0xADDRESS> [rpc_url]"
  exit 1
fi

if ! [[ "$ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "❌ Invalid address format: $ADDRESS (expected 0x + 40 hex chars)"
  exit 1
fi

echo "Proposing ADD validator: $ADDRESS"
echo "RPC: $RPC"
echo ""
echo "⚠️  This requires quorum approval from existing validators."
echo "   Each validator must independently submit this proposal."
echo ""

response=$(curl -sf --max-time 5 -X POST "$RPC" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"ibft_proposeValidatorVote\",\"params\":[\"$ADDRESS\",true],\"id\":1}" \
  2>/dev/null) || {
    echo "❌ RPC unavailable at $RPC"
    echo "   Start network: bash scripts/ops/besu_up_full.sh"
    exit 1
  }

echo "Response: $response"
echo ""
echo "Verify: bash scripts/ops/ibft_list_validators.sh $RPC"
