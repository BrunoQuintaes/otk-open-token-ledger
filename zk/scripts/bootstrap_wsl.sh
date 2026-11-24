#!/usr/bin/env bash
set -euo pipefail

echo "== phase3 bootstrap (WSL) =="

sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git dos2unix build-essential pkg-config libgmp-dev

# Node 20 LTS (NodeSource)
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Enforce Node 20 if another major is installed
if ! node -v | grep -qE '^v20\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# snarkjs pinned
sudo npm i -g snarkjs@0.7.6

echo "node path:"; command -v node || true
echo "node ver :"; node -v || true
echo "npm  path:"; command -v npm || true
echo "npm  ver :"; npm -v || true
echo "snarkjs p:"; command -v snarkjs || true
echo "snarkjs h:"; snarkjs -h 2>/dev/null | head -n 1 || true

echo "== bootstrap done =="