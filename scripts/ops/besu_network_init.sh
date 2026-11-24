#!/usr/bin/env bash
# besu_network_init.sh — Gera genesis IBFT + chaves de nó (local, NÃO commitar)
# Uso: bash scripts/ops/besu_network_init.sh
# Pré-req: Docker disponível
# Saída: tools/besu/docker/network/{node1..4}/{genesis.json,data/key}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NET="$ROOT/tools/besu/docker/network"
CFG_DIR="$ROOT/tools/besu/docker/ibft_config"

echo "=== Besu IBFT network init ==="
echo "NET=$NET"

# 1) ibftConfigFile.json
mkdir -p "$CFG_DIR"
cat > "$CFG_DIR/ibftConfigFile.json" <<'JSON'
{
  "genesis": {
    "config": {
      "chainId": 1337,
      "berlinBlock": 0,
      "ibft2": {
        "blockperiodseconds": 2,
        "epochlength": 30000,
        "requesttimeoutseconds": 4
      }
    },
    "nonce": "0x0",
    "timestamp": "0x58ee40ba",
    "gasLimit": "0x47b760",
    "difficulty": "0x1",
    "mixHash": "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
    "coinbase": "0x0000000000000000000000000000000000000000",
    "alloc": {
      "0xfe3b557e8fb62b89f4916b721be55ceb828dbd73": {
        "privateKey": "8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63",
        "comment": "dev-funder-DO-NOT-USE-IN-PROD",
        "balance": "0xad78ebc5ac6200000"
      }
    }
  },
  "blockchain": {
    "nodes": {
      "generate": true,
      "count": 4
    }
  }
}
JSON

echo "ibftConfigFile.json written"

# 2) Generate via besu docker
# MSYS_NO_PATHCONV=1 prevents Git Bash on Windows from mangling /opt/... paths
# Remove output dir (besu operator fails if --to target already exists)
rm -rf "$CFG_DIR/output"

# MSYS_NO_PATHCONV=1 prevents Git Bash from converting /opt/... to C:\Program Files\Git\opt\...
# Use //opt (double slash) for in-container paths to further suppress conversion
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$CFG_DIR://opt/besu/config" \
  hyperledger/besu:latest \
  operator generate-blockchain-config \
    --config-file=//opt/besu/config/ibftConfigFile.json \
    --to=//opt/besu/config/output \
    --private-key-file-name=key

echo "besu operator generate-blockchain-config done"

# 3) Distribute to network/node1..4
mkdir -p "$NET"
idx=1
for key_dir in "$CFG_DIR/output/keys"/*/; do
  dest="$NET/node$idx"
  mkdir -p "$dest/data"
  cp "$CFG_DIR/output/genesis.json" "$dest/genesis.json"
  cp "$key_dir/key"     "$dest/data/key"
  cp "$key_dir/key.pub" "$dest/data/key.pub" 2>/dev/null || true
  echo "node$idx: $dest"
  idx=$((idx + 1))
done

echo ""
echo "=== DONE ==="
echo "Network prepared at: $NET"
echo "DO NOT commit keys in $NET or $CFG_DIR/output"
echo ""
echo "Next: update REPLACE_WITH_NODE1_ENODE in docker-compose.ibft.yml with:"
node1_pub=""
if [ -f "$NET/node1/data/key.pub" ]; then
  node1_pub=$(cat "$NET/node1/data/key.pub" | tr -d '0x\n')
  echo "  enode://${node1_pub}@node1:30303"
fi
echo "Then: bash scripts/ops/besu_up.sh"
