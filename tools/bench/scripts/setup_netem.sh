#!/usr/bin/env bash
# setup_netem.sh — Configure tc-netem WAN latency simulation
# Requires: NET_ADMIN capability (Docker: --cap-add NET_ADMIN)
#
# Usage: setup_netem.sh <delay_ms> [jitter_ms]
#
# Examples:
#   setup_netem.sh 50 5     # 50ms ± 5ms (WAN light)
#   setup_netem.sh 150 20   # 150ms ± 20ms (WAN heavy)
#   setup_netem.sh 0        # Remove netem (reset to loopback)

set -euo pipefail

DELAY="${1:-50}"
JITTER="${2:-5}"
INTERFACE="${NETEM_INTERFACE:-eth0}"

if [ "$DELAY" -eq 0 ]; then
  echo "[netem] Removing existing netem rules on $INTERFACE..."
  tc qdisc del dev "$INTERFACE" root 2>/dev/null && echo "[netem] Removed" || echo "[netem] No rules to remove"
  exit 0
fi

echo "[netem] Applying: interface=$INTERFACE delay=${DELAY}ms jitter=${JITTER}ms distribution=normal"

# Remove existing qdisc (ignore error if none)
tc qdisc del dev "$INTERFACE" root 2>/dev/null || true

# Apply netem with normal distribution jitter (realistic WAN behavior)
tc qdisc add dev "$INTERFACE" root netem \
  delay "${DELAY}ms" "${JITTER}ms" distribution normal \
  loss 0.01%  # Minimal packet loss (realistic WAN)

echo "[netem] Applied. Verification:"
tc qdisc show dev "$INTERFACE"
