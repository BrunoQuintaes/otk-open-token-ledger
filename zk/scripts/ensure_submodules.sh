#!/usr/bin/env bash
set -euo pipefail

echo "== ensure_submodules =="
cd "$(cd "$(dirname "$0")/../.." && pwd)"

git submodule sync --recursive
git submodule update --init --recursive

echo "== submodules ok =="
git submodule status --recursive || true