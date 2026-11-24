#!/usr/bin/env bash
set -e

echo "=== OTK Full Stack Deploy ==="

echo "[1] Install dependencies"
npm ci

echo "[2] Run tests"
npm test

echo "[3] Run Gate R0"
bash scripts/ops/gate_r0_revalidate.sh

echo "[4] Hardhat compile"
cd tools/hardhat
npm ci
npx hardhat compile
cd ../..

echo "=== DEPLOY CHECK COMPLETE ==="
