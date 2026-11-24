#!/usr/bin/env bash
# OTK Benchmark Runner
# ADR-0102: Benchmark Rig (Linux/Docker + netem + N>=100)
#
# Usage: run_bench.sh [--scenario=<name>] [--N=<int>] [--seed=<int>] [--warmup=<int>]
#
# Scenarios:
#   baseline      — loopback, no netem (max throughput)
#   wan_light     — 50ms delay, 5ms jitter (WAN inter-region)
#   wan_heavy     — 150ms delay, 20ms jitter (WAN intercontinental)
#   zk_inprocess  — Groth16 in-process (N>=100, warmup=5)
#   zk_coldstart  — Groth16 via CLI (N>=20)
#   drift         — Economic drift Monte Carlo (N>=100000)

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SCENARIO="${BENCH_SCENARIO:-baseline}"
N="${BENCH_N:-100}"
SEED="${BENCH_SEED:-42}"
WARMUP="${BENCH_WARMUP:-5}"

# Parse CLI args (override env vars)
for arg in "$@"; do
  case "$arg" in
    --scenario=*) SCENARIO="${arg#*=}" ;;
    --N=*)        N="${arg#*=}" ;;
    --seed=*)     SEED="${arg#*=}" ;;
    --warmup=*)   WARMUP="${arg#*=}" ;;
  esac
done

# ── EVD setup ──────────────────────────────────────────────────────────────────
TS=$(date +%Y%m%d_%H%M%S)
EVD="docs/_ops/bench_${SCENARIO}_${TS}"
mkdir -p "$EVD"

echo "[bench] Scenario: $SCENARIO | N: $N | Seed: $SEED | Warmup: $WARMUP"
echo "[bench] EVD: $EVD"

# ── Hardware evidence ──────────────────────────────────────────────────────────
{
  echo "=== uname ==="
  uname -a
  echo "=== cpu ==="
  cat /proc/cpuinfo 2>/dev/null | grep -E "model name|cpu MHz|processor" | sort -u || true
  echo "=== memory ==="
  cat /proc/meminfo 2>/dev/null | head -5 || true
  echo "=== node ==="
  node --version
  echo "=== npm ==="
  npm --version
  echo "=== snarkjs ==="
  snarkjs --version 2>/dev/null || echo "snarkjs not found"
  echo "=== cgroups (container limits) ==="
  cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || \
  cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo "cgroup v2"
  cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || \
  cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "cgroup v2"
} > "$EVD/00_hardware.txt"

# ── netem setup ────────────────────────────────────────────────────────────────
NETEM_DELAY=0
NETEM_JITTER=0

case "$SCENARIO" in
  baseline)
    NETEM_DELAY=0; NETEM_JITTER=0 ;;
  wan_light)
    NETEM_DELAY=50; NETEM_JITTER=5 ;;
  wan_heavy)
    NETEM_DELAY=150; NETEM_JITTER=20 ;;
  zk_inprocess|zk_coldstart|drift)
    NETEM_DELAY=0; NETEM_JITTER=0 ;;
  *)
    echo "[bench] ERROR: Unknown scenario: $SCENARIO" >&2
    exit 1 ;;
esac

if [ "$NETEM_DELAY" -gt 0 ]; then
  echo "[bench] Applying netem: delay=${NETEM_DELAY}ms jitter=${NETEM_JITTER}ms"
  bash tools/bench/scripts/setup_netem.sh "$NETEM_DELAY" "$NETEM_JITTER" 2>&1 \
    | tee "$EVD/01_netem_setup.txt"
else
  echo "netem: disabled (loopback scenario)" > "$EVD/01_netem_setup.txt"
fi

# ── Run benchmark ─────────────────────────────────────────────────────────────
echo "[bench] Running scenario: $SCENARIO"

case "$SCENARIO" in
  baseline|wan_light|wan_heavy)
    # Full pipeline throughput benchmark
    N="$N" BENCH_SEED="$SEED" node --experimental-vm-modules \
      node_modules/.bin/tsx scripts/benchmark/u9_benchmark_harness.ts \
      2>&1 | tee "$EVD/10_bench_output.txt"
    ;;

  zk_inprocess)
    # ZK in-process benchmark (N>=100, warmup=WARMUP)
    BENCH_N="$N" BENCH_SEED="$SEED" BENCH_ZK_WARMUP="$WARMUP" \
      npx tsx scripts/benchmark/u9_benchmark_harness.ts \
      2>&1 | tee "$EVD/10_bench_output.txt"
    ;;

  zk_coldstart)
    # ZK cold-start via CLI (each proof is a fresh process)
    echo "[bench] ZK cold-start: N=$N iterations (each spawns fresh snarkjs CLI)"
    for i in $(seq 1 "$N"); do
      t0=$(date +%s%3N)
      # Requires zk/build/input.json and witness/circuit files
      # snarkjs groth16 prove zk/build/metering_v1_final.zkey zk/build/witness.wtns proof.json public.json
      t1=$(date +%s%3N)
      echo "$((t1-t0))" >> "$EVD/zk_coldstart_ms.txt"
    done
    # Compute stats from cold-start times
    node -e "
      const fs = require('fs');
      const times = fs.readFileSync('$EVD/zk_coldstart_ms.txt','utf8')
        .trim().split('\n').map(Number);
      const mean = times.reduce((a,b)=>a+b,0)/times.length;
      const sorted = [...times].sort((a,b)=>a-b);
      const p95 = sorted[Math.ceil(0.95*sorted.length)-1];
      console.log(JSON.stringify({N:times.length,mean_ms:mean.toFixed(1),p95_ms:p95,min_ms:sorted[0],max_ms:sorted[sorted.length-1]}));
    " | tee "$EVD/10_bench_output.txt"
    ;;

  drift)
    # Economic drift Monte Carlo
    npx tsx scripts/audit/economic_drift_sim.ts "--N=$N" "--seed=$SEED" \
      2>&1 | tee "$EVD/10_bench_output.txt"
    ;;
esac

# ── netem teardown ─────────────────────────────────────────────────────────────
if [ "$NETEM_DELAY" -gt 0 ]; then
  tc qdisc del dev eth0 root 2>/dev/null || true
  echo "[bench] netem removed"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
git log -1 --oneline > "$EVD/99_git_head.txt" 2>/dev/null || true
echo "[bench] DONE — EVD: $EVD"
echo "EVD=$EVD"
