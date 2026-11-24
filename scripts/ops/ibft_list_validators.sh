#!/usr/bin/env bash
# ibft_list_validators.sh — List active IBFT validators via RPC
#
# Usage: bash scripts/ops/ibft_list_validators.sh [rpc_url]
# Default RPC: http://127.0.0.1:8545

set -euo pipefail
RPC="${1:-http://127.0.0.1:8545}"

echo "IBFT validators @ $RPC"
echo ""

response=$(curl -sf --max-time 5 -X POST "$RPC" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"ibft_getValidatorsByBlockNumber","params":["latest"],"id":1}' \
  2>/dev/null) || {
    echo "❌ RPC unavailable at $RPC"
    echo "   Start network: bash scripts/ops/besu_up_full.sh"
    exit 1
  }

echo "$response" | grep -o '"result":\[[^]]*\]' | tr ',' '\n' | tr -d '"[]result:' | grep -v '^$' | nl -ba
echo ""
echo "Governance doc: docs/architecture/U7_GOVERNANCE_PLAN.md"
