#!/usr/bin/env bash
# Academic demo without credentials (RUN-M1-24H-20261010, OTK-D20-F03-S01-W02). See tools/academic_demo/README.md.
# One synthetic operation through the real entrypoint: admission → synthetic provider (responds as gpt-4o-mini) →
# settlement → operator-signed receipt v3 → CU reference recomputed → proof v3 → registration on a NEW local Besu;
# then negative cases (tampered receipt refused; tampered proof/public signal/signature reverted on chain).
# No API key, no paid call, no historical key, no file outside the repository except the demo's own output dirs.
#
#   bash tools/academic_demo/run_demo.sh            # full run, removes its containers/volumes at the end
#   DEMO_KEEP=1 bash tools/academic_demo/run_demo.sh  # keep the environment for inspection
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 9
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${DEMO_OUT:-$ROOT/../otk-demo-report-$TS}"; mkdir -p "$OUT"
NET="${DEMO_BESU_DIR:-$ROOT/../otk-demo-besu-$TS}"   # throwaway dev keys of the demo network, outside the repository
SVC=${DEMO_SVC_PROJECT:-otk-demo-svc}; PGP=${DEMO_PG_PORT:-56532}; RDP=${DEMO_REDIS_PORT:-56579}; SVCNET=${DEMO_SVC_SUBNET:-172.31.237.0/24}
PROJ=${DEMO_BESU_PROJECT:-otk-demo-besu7}; SUBNET=${DEMO_BESU_SUBNET:-172.31.238}; CHAIN=${DEMO_CHAIN_ID:-16566}; RPC=${DEMO_RPC_PORT:-59545}
abs() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
OUTW="$(abs "$OUT")"; NETW="$(abs "$NET")"
log() { echo "$*" | tee -a "$OUT/STEPS.txt"; }
step() { local name="$1"; shift; local t0=$(date +%s); ( "$@" ) > "$OUT/$name.txt" 2>&1; local rc=$?; local s=$(grep -E '^# (tests|pass|fail|cancelled|skipped) ' "$OUT/$name.txt" | tr '\n' ' '); log "$(date -u +%FT%TZ) $name exit=$rc secs=$(( $(date +%s) - t0 )) $s"; return $rc; }
need() { local name="$1"; shift; step "$name" "$@" || { log "STOP: $name failed (see $OUT/$name.txt)"; cleanup; exit 1; }; }
# RB-01 (RUN-M1-RESUME-20261012): cleanup reports failure (a 'down' that fails or leaves objects behind) instead of
# always logging "cleanup done"; a signal also cleans up; the run ends with exit 0 only if DEMO_SUMMARY says ok.
CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return 0; CLEANED=1
  [ "${DEMO_KEEP:-0}" = 1 ] && { log "DEMO_KEEP=1: environment kept (projects $SVC, $PROJ)"; return 0; }
  local rc=0 p left
  if [ -f "$NET/docker-compose.yml" ]; then docker compose -p "$PROJ" -f "$NET/docker-compose.yml" down -v >> "$OUT/99_cleanup.txt" 2>&1 || rc=1; fi
  env OTK_TEST_PG_PORT=$PGP OTK_TEST_REDIS_PORT=$RDP OTK_TEST_SUBNET=$SVCNET docker compose -p "$SVC" -f infra/test/docker-compose.services.yml -f infra/test/docker-compose.services.subnet.yml down -v >> "$OUT/99_cleanup.txt" 2>&1 || rc=1
  for p in "$PROJ" "$SVC"; do
    left=$({ docker ps -aq --filter "label=com.docker.compose.project=$p"; docker volume ls -q --filter "label=com.docker.compose.project=$p"; } 2>/dev/null | grep -c .)
    [ "${left:-0}" = 0 ] || { echo "left in $p: $left" >> "$OUT/99_cleanup.txt"; rc=1; }
  done
  # H1-S12 (OTK-H1-MEGA 2026-10-13): the throwaway private keys of the demo network do not outlive the run; addresses,
  # genesis and deploy records in $NET stay as evidence. DEMO_KEEP_KEYS=1 keeps them for an authorised diagnosis.
  if [ "${DEMO_KEEP_KEYS:-0}" = 1 ]; then log "DEMO_KEEP_KEYS=1: private keys kept in $NET (diagnosis only)"
  elif [ -d "$NET" ]; then
    rm -f "$NET"/node*/key "$NET"/dev/*.key >> "$OUT/99_cleanup.txt" 2>&1 || rc=1
    rm -rf "$NET"/node*/data >> "$OUT/99_cleanup.txt" 2>&1 || rc=1
    left=$(find "$NET" -name key -o -name '*.key' 2>/dev/null | grep -c .)
    [ "${left:-0}" = 0 ] || { echo "keys left in $NET: $left" >> "$OUT/99_cleanup.txt"; rc=1; }
  fi
  if [ $rc = 0 ]; then log "cleanup done (containers and volumes of $SVC and $PROJ removed; private keys of the demo network deleted from $NET)"
  else log "CLEANUP FAILED (see $OUT/99_cleanup.txt)"; fi
  return $rc
}
on_signal() { log "STOP: signal $1"; cleanup; exit "$2"; }
trap 'on_signal INT 130' INT; trap 'on_signal TERM 143' TERM; trap 'on_signal HUP 129' HUP
# H1R2 (2026-10-13): a fixed host port inside the ephemeral range (Linux 32768-60999) can still be held by an outbound
# socket of an earlier step (e.g. TIME_WAIT of a client of the R07f PostgreSQL), and Docker then fails with "address
# already in use". Wait (max 120 s) until no TCP socket in any state uses the port; no-op without /proc/net/tcp.
port_quiet() {
  local p hex i
  [ -r /proc/net/tcp ] || return 0
  for p in "$@"; do
    hex=$(printf ':%04X' "$p")
    for i in $(seq 1 120); do
      cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk -v h="$hex" 'NR>1 && toupper(substr($2, length($2)-4)) == h {f=1} END {exit f?0:1}' || break
      [ "$i" = 1 ] && echo "waiting for host port $p (held by another socket)"
      sleep 1
    done
  done
  return 0
}
subnet_free() { ! docker network inspect $(docker network ls -q) --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -qx "$1"; }

# never use real credentials: provider variables are removed by NAME (values are never read)
for v in $(compgen -e); do case "$v" in OTK_TEST_*|DEMO_*) continue ;; *API_KEY*|*SECRET*|*TOKEN*|*PASSWORD*|ANTHROPIC_*|OPENAI_*|GOOGLE_*|GEMINI_*|OTK_*) unset "$v" ;; esac; done
export OTK_TEST_PG_URL=postgres://otk:otk-test-only@127.0.0.1:$PGP/otk OTK_TEST_REDIS_URL=redis://:otk-test-only@127.0.0.1:$RDP
TSX="node node_modules/tsx/dist/cli.mjs"

# the commit the code came from: the package MANIFEST (one level above source/) wins over the local git of the reviewer
if [ -f ../MANIFEST.json ]; then DEMO_SOURCE="package:$(node -e "process.stdout.write(String(require('../MANIFEST.json').commit||'unknown'))")"
else DEMO_SOURCE="git:$(git rev-parse HEAD 2>/dev/null || echo unknown)"; fi
log "OTK academic demo $TS — source $DEMO_SOURCE — output $OUT"
# 1. preflight
need 01_preflight bash -c "node -v && npm -v && docker version --format '{{.Server.Version}}' && docker compose version && git --version"
[ -e "$NET" ] && { log "STOP: $NET exists (refusing to reuse a network)"; exit 2; }
subnet_free "$SVCNET" || { log "STOP: subnet $SVCNET is used by another docker network; set DEMO_SVC_SUBNET"; exit 4; }
subnet_free "$SUBNET.0/24" || { log "STOP: subnet $SUBNET.0/24 is used by another docker network; set DEMO_BESU_SUBNET"; exit 4; }
# 2. dependencies (lockfile only) and the public circomlib submodule
[ -d node_modules ] || need 02_npm_ci npm ci --no-audit --no-fund
[ -d tools/hardhat/node_modules ] || need 02b_npm_ci_hardhat bash -c "cd tools/hardhat && npm ci --no-audit --no-fund"
# circomlib (public, LGPL-3.0) pinned at the commit the circuits were built with; from a package without .git it is cloned
CIRCOMLIB_COMMIT=${DEMO_CIRCOMLIB_COMMIT:-35e54ea21da3e8762557234298dbb553c175ea8d}
if [ ! -f zk/circuits/circomlib/circuits/poseidon.circom ]; then
  if git ls-files --stage zk/circuits/circomlib 2>/dev/null | grep -q '^160000'; then need 02c_circomlib git submodule update --init zk/circuits/circomlib
  else need 02c_circomlib bash -c "rmdir zk/circuits/circomlib 2>/dev/null; git clone --quiet https://github.com/iden3/circomlib.git zk/circuits/circomlib && git -C zk/circuits/circomlib checkout --quiet $CIRCOMLIB_COMMIT && git -C zk/circuits/circomlib rev-parse HEAD"; fi
fi
need 02d_hardhat_compile bash -c "cd tools/hardhat && npx hardhat compile"
# 3. disposable PostgreSQL + Redis
port_quiet $PGP $RDP $RPC | tee -a "$OUT/STEPS.txt"
need 03_services_up env OTK_TEST_PG_PORT=$PGP OTK_TEST_REDIS_PORT=$RDP OTK_TEST_SUBNET=$SVCNET docker compose -p "$SVC" -f infra/test/docker-compose.services.yml -f infra/test/docker-compose.services.subnet.yml up -d --wait
# 4. NEW 7-validator Besu with fresh development keys; readiness is printed evidence, not an exit code
need 04_besu_generate node tools/besu/s4_gen_besu7.mjs --out "$NETW" --subnet $SUBNET --chain-id $CHAIN --rpc $RPC --project "$PROJ"
need 04b_besu_up docker compose -p "$PROJ" -f "$NET/docker-compose.yml" up -d
step 04c_besu_ready node tools/besu/wait_ready.mjs --rpc http://127.0.0.1:$RPC --chain-id $CHAIN --validators 7 --min-block 5 --timeout-ms 600000 --out "$OUTW/04c_besu_ready.json"
grep -q '"status":"READY"' "$OUT/04c_besu_ready.json" 2>/dev/null || { log "STOP: Besu not ready (see 04c_besu_ready.json)"; cleanup; exit 1; }
OPERATOR_ADDR="$(node -e "console.log(require('$NETW/network.json').dev.operator)")"
need 05_deploy_v3 bash -c "cd tools/hardhat && RPC=http://127.0.0.1:$RPC CHAIN_ID=$CHAIN PRIVKEY=0x\$(cat '$NETW/dev/deployer.key') OTK_V3_SIGNER_ADDRESS=$OPERATOR_ADDR OTK_DEPLOY_OUT='$NETW/deploy_v3_besu.json' npx hardhat run --network ibft scripts/deploy_v3.js"
# 6. synthetic operations through the real entrypoint, up to the on-chain registration (synthetic provider, run-local ledger)
export OTK_PILOT_PG_URL=$OTK_TEST_PG_URL
need 06_e2e_synthetic env "OPENAI_API_KEY=canary-demo-not-a-real-key" node --import tsx scripts/pilot/anthropic/runPilotV3.ts --provider=openai --mode=synthetic --phase=gate --out="$OUTW/e2e" --besu-dir="$NETW"
# 7. independent check of one receipt: signature, digest, CU reference vs. oracle, tampered copies refused
MAN="$(ls "$OUT"/e2e/*_manifest.json | head -1)"
need 07_verify_receipt node --import tsx tools/academic_demo/verify_demo_receipt.mts --manifest="$(abs "$MAN")" --besu-dir="$NETW" --out="$OUTW/07_receipt_check.json"
# 8. negative cases on proofs and on the registry (local Hardhat chain): tampered proof, public signal, signature, signer
need 08_negative_registry_v3 bash -c "cd tools/hardhat && node --test --test-concurrency=1 test/d1d8_a_registry_v3.test.js"
need 08b_zk_v3 $TSX --test test/zk/d1d8_a_circuit_v3.test.ts
# 9. summary
node -e "
const fs=require('fs');const p=require('path');const o='$OUTW';
const s=JSON.parse(fs.readFileSync(fs.readdirSync(o+'/e2e').filter(f=>f.endsWith('_summary.json')).map(f=>o+'/e2e/'+f)[0],'utf8'));
const rc=JSON.parse(fs.readFileSync(o+'/07_receipt_check.json','utf8'));
const sum={demo:'otk.academic_demo.v1',ok:s.consistent===s.calls&&rc.ok,source:'$DEMO_SOURCE',operations:s.calls,consistent:s.consistent,receiptCheck:rc.checks,cuReference:rc.cuReference,
 note:'synthetic provider; proves the pipeline and its integrity checks, not real provider counting; local Besu of one operator'};
fs.writeFileSync(o+'/DEMO_SUMMARY.json',JSON.stringify(sum,null,2)+'\n');console.log(JSON.stringify(sum,null,2));process.exit(sum.ok===true?0:1);" > "$OUT/09_summary.txt" 2>&1
SUMRC=$?
cat "$OUT/09_summary.txt" >> "$OUT/STEPS.txt"; cat "$OUT/09_summary.txt"
cleanup; CLRC=$?
[ $SUMRC = 0 ] || { log "STOP: DEMO_SUMMARY not ok or not written (see $OUT/09_summary.txt)"; exit 1; }
[ $CLRC = 0 ] || { log "STOP: cleanup failed"; exit 1; }
log "DEMO DONE — see $OUT/DEMO_SUMMARY.json"
