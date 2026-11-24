#!/usr/bin/env bash
# Professor runbook, automated (RUN-M1-RESUME-20261012, RB-01). Follows docs/academic_release/PROFESSOR_RUNBOOK.md
# from the distributed tar in a NEW folder and ends with exit 0 ONLY when every mandatory step passed or matched
# the outcomes declared in docs/academic_release/expected_outcomes.json BY TEST NAME. Replaces the author-side
# runbook_from_package_v2.sh of RUN-M1-24H, which logged each exit code but always finished with "runbook done" / exit 0.
#
#   bash run_from_package.sh --tar OTK_ACADEMIC_RELEASE_<sha12>.tar --sha256-file <file received separately> \
#        --workdir <new short folder, e.g. C:/otkr1> --out <new report folder> [--skip-demo]
#
# Exit: 0 PASS / PASS_DECLARED · 1 FAIL (failed step and reason in RUNBOOK_RESULT.txt) · 2 usage
#       · 129/130/143 interrupted by HUP/INT/TERM (cleanup still runs).
# Docker: only compose projects named otk-rb-<RB_ID>-* are created and removed (never other projects or volumes).
# Never reads .env files, never needs an API key; provider/secret variables are removed by NAME before any step.
set -u -o pipefail

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
TAR=""; SHAFILE=""; WORK=""; OUT=""; SKIP_DEMO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tar) TAR="${2:-}"; shift 2 ;; --sha256-file) SHAFILE="${2:-}"; shift 2 ;;
    --workdir) WORK="${2:-}"; shift 2 ;; --out) OUT="${2:-}"; shift 2 ;;
    --skip-demo) SKIP_DEMO=1; shift ;; -h|--help) usage ;; *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$TAR" ] && [ -n "$SHAFILE" ] && [ -n "$WORK" ] && [ -n "$OUT" ] || usage
# Windows paths (C:\x\y) given to Git Bash: tar, mkdir and sha256sum need the POSIX form
posix() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else echo "$1"; fi; }
TAR="$(posix "$TAR")"; SHAFILE="$(posix "$SHAFILE")"; WORK="$(posix "$WORK")"; OUT="$(posix "$OUT")"
[ -e "$OUT" ] && { echo "refusing: report folder $OUT already exists" >&2; exit 2; }
mkdir -p "$OUT" || exit 2
OUT="$(cd "$OUT" && pwd)"
echo $$ > "$OUT/RUNNER_PID"
abs() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
# GNU tar reads "C:/x.tar" as host "C" (remote archive): force a local file when the option exists
TARL=""; tar --help 2>/dev/null | grep -q -- --force-local && TARL="--force-local"

RB_ID="$(echo "${RB_ID:-$(date -u +%Y%m%d%H%M%S)$$}" | tr -cd 'a-z0-9')"
SVC_PROJ="otk-rb-$RB_ID-svc"; DEMO_SVC_PROJ="otk-rb-$RB_ID-demo-svc"; DEMO_BESU_PROJ="otk-rb-$RB_ID-besu7"
PG_PORT=${RB_PG_PORT:-55432}; REDIS_PORT=${RB_REDIS_PORT:-56379}; SVC_SUBNET=${RB_SVC_SUBNET:-}  # free /24 chosen after preflight
STEPS="$OUT/RUNBOOK_STEPS.txt"; RESULT="$OUT/RUNBOOK_RESULT.txt"
FAILED_STEP=""; FAIL_REASON=""; INTERRUPTED=""; COMPLETED=0; DECLARED=0; DOCKER_USED=0; STEP_PID=""; WATCH_PID=""
SHA_EXPECTED=""; SHA_ACTUAL=""; PKG_COMMIT=""; SRC=""; CHECKER=""; EXPECTED=""

log() { echo "$*" | tee -a "$STEPS"; }

# never use real credentials: provider/secret variables are removed by NAME (values are never read)
for v in $(compgen -e); do
  case "$v" in RB_*|DEMO_*|OTK_TEST_*) continue ;;
    *API_KEY*|*SECRET*|*TOKEN*|*PASSWORD*|*PASSWD*|*CREDENTIAL*|*PRIVATE*|ANTHROPIC_*|OPENAI_*|GOOGLE_*|GEMINI_*|OTK_*) unset "$v" ;;
  esac
done

# children from /proc (MSYS: /proc/<pid>/ppid; Linux: field after "(comm) state" in /proc/<pid>/stat); not "ps -ef",
# which takes minutes on some Windows machines (user-name lookup per process) and cannot be interrupted by timeout
child_pids() {
  local d pp st
  for d in /proc/[0-9]*; do
    if [ -r "$d/ppid" ]; then pp=$(cat "$d/ppid" 2>/dev/null)
    else st=$(cat "$d/stat" 2>/dev/null) || continue; st="${st##*) }"; pp=$(echo "$st" | cut -d' ' -f2); fi
    [ "$pp" = "$1" ] && echo "${d#/proc/}"
  done
  return 0
}
kill_tree() { # $1 = pid of a step subshell; children are listed first, the parent is stopped before them (so it
  # cannot react to a dying child), native Windows children are killed through their Windows pid
  local p="$1" c kids=""
  if [ -r "/proc/$p/winpid" ] && command -v taskkill >/dev/null 2>&1; then
    # Windows: the whole process tree (MSYS and native children) in one call
    taskkill //T //F //PID "$(cat "/proc/$p/winpid")" >/dev/null 2>&1
  else
    kids="$(child_pids "$p")"
  fi
  kill -TERM "$p" 2>/dev/null
  for c in $kids; do kill_tree "$c"; done
  return 0
}

project_leftovers() { # prints what is left of one compose project (containers, volumes, networks)
  local p="$1"
  { docker ps -aq --filter "label=com.docker.compose.project=$p"
    docker volume ls -q --filter "label=com.docker.compose.project=$p"
    docker network ls -q --filter "label=com.docker.compose.project=$p"; } 2>/dev/null | grep -c .
}
cleanup_all() { # removes ONLY this run's projects; returns 1 if anything is left or docker refuses
  [ "$DOCKER_USED" = 1 ] || { echo "cleanup: no docker project was started" >> "$OUT/99_cleanup.txt"; return 0; }
  local p ok=0 left
  for p in "$SVC_PROJ" "$DEMO_SVC_PROJ" "$DEMO_BESU_PROJ"; do
    left=$(project_leftovers "$p")
    if [ "${left:-0}" != 0 ]; then
      docker compose -p "$p" down -v --remove-orphans >> "$OUT/99_cleanup.txt" 2>&1 || { echo "cleanup: down failed for $p" >> "$OUT/99_cleanup.txt"; ok=1; }
      left=$(project_leftovers "$p")
      [ "${left:-0}" = 0 ] || { echo "cleanup: $left objects left in project $p" >> "$OUT/99_cleanup.txt"; ok=1; }
    fi
  done
  return $ok
}

finish() {
  local code=0 verdict cleanup="OK"
  trap '' INT TERM HUP
  [ -n "$WATCH_PID" ] && kill_tree "$WATCH_PID"
  [ -n "$STEP_PID" ] && kill_tree "$STEP_PID"
  cleanup_all || cleanup="FAILED"
  if [ -n "$INTERRUPTED" ]; then verdict="INTERRUPTED"; code=$INTERRUPTED_CODE; FAIL_REASON="signal $INTERRUPTED during ${CUR_STEP:-start}"
  elif [ -n "$FAILED_STEP" ]; then verdict="FAIL"; code=1
  elif [ "$cleanup" != OK ]; then verdict="FAIL"; code=1; FAILED_STEP="99_cleanup"; FAIL_REASON="cleanup left objects or docker refused (see 99_cleanup.txt)"
  elif [ "$COMPLETED" != 1 ]; then verdict="FAIL"; code=1; FAILED_STEP="${CUR_STEP:-start}"; FAIL_REASON="runner stopped before the last step"
  elif [ "$DECLARED" = 1 ]; then verdict="PASS_DECLARED"
  else verdict="PASS"; fi
  [ "$cleanup" != OK ] && [ "$code" = 0 ] && { verdict="FAIL"; code=1; }
  { echo "verdict=$verdict"; echo "exit_code=$code"; echo "failed_step=$FAILED_STEP"; echo "reason=$FAIL_REASON"
    echo "cleanup=$cleanup"; echo "rb_id=$RB_ID"; echo "projects=$SVC_PROJ $DEMO_SVC_PROJ $DEMO_BESU_PROJ"
    echo "package=$(abs "$TAR")"; echo "sha256_expected=$SHA_EXPECTED"; echo "sha256_actual=$SHA_ACTUAL"
    echo "package_commit=$PKG_COMMIT"; echo "skip_demo=$SKIP_DEMO"; echo "finished_utc=$(date -u +%FT%TZ)"; } > "$RESULT"
  log "RUNBOOK_RESULT=$verdict exit=$code${FAILED_STEP:+ failed_step=$FAILED_STEP}${FAIL_REASON:+ reason=$FAIL_REASON} cleanup=$cleanup"
  exit "$code"
}
on_signal() { INTERRUPTED="$1"; INTERRUPTED_CODE="$2"; exit "$2"; }
trap finish EXIT
trap 'on_signal INT 130' INT; trap 'on_signal TERM 143' TERM; trap 'on_signal HUP 129' HUP

fail() { FAILED_STEP="$1"; FAIL_REASON="$2"; exit 1; }

# run_step <name> <rc|tap> <timeout_s> <command...>: the step runs in the background so a signal is handled at once;
# a watchdog kills it after the timeout. tap steps are classified by check_outcomes.mjs against the declared outcomes.
run_step() {
  local name="$1" kind="$2" tmo="$3"; shift 3
  CUR_STEP="$name"; local slog="$OUT/$name.txt" t0; t0=$(date +%s)
  ( export RB_STEP="$name"; "$@" ) > "$slog" 2>&1 &
  STEP_PID=$!
  ( sleep "$tmo" && echo "TIMEOUT after ${tmo}s" > "$slog.timeout" && kill_tree "$STEP_PID" ) >/dev/null 2>&1 &
  WATCH_PID=$!
  wait "$STEP_PID"; local rc=$?
  kill_tree "$WATCH_PID"; wait "$WATCH_PID" 2>/dev/null; WATCH_PID=""; STEP_PID=""
  local verdict reason="" counts=""
  if [ -f "$slog.timeout" ]; then verdict=FAIL; reason="$(cat "$slog.timeout")"
  elif [ "$kind" = tap ]; then
    local js; js=$(node "$CHECKER" --expected "$EXPECTED" --step "$name" --log "$(abs "$slog")" --rc "$rc" 2>&1)
    local crc=$?; echo "$js" > "$slog.verdict.json"
    case "$js" in *'"verdict":"PASS_DECLARED"'*) verdict=PASS_DECLARED; DECLARED=1 ;; *'"verdict":"PASS"'*) verdict=PASS ;; *) verdict=FAIL ;; esac
    [ "$crc" = 0 ] || verdict=FAIL
    [ "$verdict" = FAIL ] && reason="$(echo "$js" | sed -n 's/.*"reasons":\[\(.*\)\],"counts".*/\1/p' | cut -c1-600)"
    [ "$verdict" = FAIL ] && [ -z "$reason" ] && reason="$(echo "$js" | cut -c1-600)"
    counts="$(echo "$js" | sed -n 's/.*"counts":\({[^}]*}\).*/\1/p')"
  else
    [ "$rc" = 0 ] && verdict=PASS || { verdict=FAIL; reason="exit code $rc"; }
  fi
  log "$(date -u +%FT%TZ) $name verdict=$verdict exit=$rc secs=$(( $(date +%s) - t0 )) $counts"
  [ "$verdict" = FAIL ] && fail "$name" "${reason:-exit code $rc}"
  return 0
}

log "OTK professor runbook (run_from_package.sh) rb_id=$RB_ID started $(date -u +%FT%TZ) runner_sha256=$(sha256sum < "$SELF" | cut -c1-64)"

# R00 preflight: tools and the network the runbook needs (npm registry, GitHub for circomlib, Docker Hub images)
preflight() {
  local ok=0
  for t in node npm git docker tar sha256sum awk; do command -v "$t" >/dev/null 2>&1 || { echo "missing tool: $t"; ok=1; }; done
  [ $ok = 0 ] || return 1
  echo "node $(node -v)"; echo "npm $(npm -v)"; git --version; echo "docker server $(docker version --format '{{.Server.Version}}')" || return 1
  docker compose version || return 1
  node -e 'process.exit(Number(process.versions.node.split(".")[0])>=20?0:1)' || { echo "node >= 20 required"; return 1; }
  [ "${RB_SKIP_NETWORK_CHECK:-0}" = 1 ] && { echo "network check skipped (RB_SKIP_NETWORK_CHECK=1)"; return 0; }
  npm ping >/dev/null 2>&1 || { echo "network: npm registry unreachable"; ok=1; }
  git ls-remote --heads https://github.com/iden3/circomlib.git >/dev/null 2>&1 || { echo "network: github.com unreachable (the demo clones circomlib)"; ok=1; }
  return $ok
}
run_step R00_preflight rc 300 preflight

# three free /24 (services, demo services, demo Besu) unless given: other Docker networks on the machine are never reused
used_subnets() { docker network inspect $(docker network ls -q) --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -v '^$'; }
FREE="$(used="$(used_subnets)"; for n in $(seq 100 199); do echo "$used" | grep -qx "172.31.$n.0/24" || echo "172.31.$n"; done | head -3 | tr '\n' ' ')"
set -- $FREE
[ $# = 3 ] || fail R00_preflight "no three free 172.31.100-199.0/24 Docker subnets; set RB_SVC_SUBNET, DEMO_SVC_SUBNET and DEMO_BESU_SUBNET"
[ -n "$SVC_SUBNET" ] || SVC_SUBNET="$1.0/24"
DEMO_SVC_SUBNET="${DEMO_SVC_SUBNET:-$2.0/24}"; DEMO_BESU_SUBNET="${DEMO_BESU_SUBNET:-$3}"
log "subnets: services $SVC_SUBNET, demo services $DEMO_SVC_SUBNET, demo Besu $DEMO_BESU_SUBNET.0/24"

# R01 integrity: the computed sha256 is COMPARED with the value received through a separate channel
CUR_STEP=R01_sha256
[ -f "$TAR" ] || fail R01_sha256 "package file not found: $TAR"
[ -f "$SHAFILE" ] || fail R01_sha256 "expected-hash file not found: $SHAFILE"
SHA_EXPECTED="$(head -c 4096 "$SHAFILE" | tr -d '\r' | grep -oiE '^[0-9a-f]{64}' | head -1 | tr 'A-F' 'a-f')"
[ -n "$SHA_EXPECTED" ] || fail R01_sha256 "expected-hash file has no 64-hex sha256 at the start of a line"
[ "$(head -c 4096 "$SHAFILE" | tr -d '\r' | grep -ciE '^[0-9a-f]{64}')" = 1 ] || fail R01_sha256 "expected-hash file has more than one hash"
SHA_ACTUAL="$(sha256sum < "$TAR" | cut -c1-64)"  # stdin: a path with "\\" makes sha256sum prefix the line with "\\"
log "$(date -u +%FT%TZ) R01_sha256 expected=$SHA_EXPECTED actual=$SHA_ACTUAL"
[ "$SHA_ACTUAL" = "$SHA_EXPECTED" ] || fail R01_sha256 "sha256 mismatch: the package is not the one announced"

# R02a listing safety before extracting: one top folder, no absolute path, no '..', only regular files and folders
listing_safety() {
  tar $TARL -tvf "$TAR" > "$OUT/R02a_listing_verbose.txt" || return 1
  tar $TARL -tf "$TAR" > "$OUT/R02a_listing.txt" || return 1
  local bad
  bad=$(awk '{print substr($1,1,1)}' "$OUT/R02a_listing_verbose.txt" | grep -vc '^[-d]$'); [ "$bad" = 0 ] || { echo "entries that are not regular files or folders: $bad"; return 1; }
  grep -nE '^/|^[A-Za-z]:|(^|/)\.\.(/|$)|\\' "$OUT/R02a_listing.txt" && { echo "unsafe path in the package"; return 1; }
  [ "$(cut -d/ -f1 "$OUT/R02a_listing.txt" | sort -u | grep -c .)" = 1 ] || { echo "more than one top-level entry"; return 1; }
  cut -d/ -f1 "$OUT/R02a_listing.txt" | sort -u | grep -qE '^OTK_ACADEMIC_RELEASE_[0-9a-f]{12}$' || { echo "top folder is not OTK_ACADEMIC_RELEASE_<sha12>"; return 1; }
  echo "entries: $(grep -c . "$OUT/R02a_listing.txt")"
}
run_step R02a_listing_safety rc 300 listing_safety

[ -e "$WORK" ] && fail R02_extract "workdir $WORK already exists (refusing to reuse a folder)"
run_step R02_extract rc 900 bash -c 'mkdir -p "$1" && tar $3 --no-same-owner -xf "$2" -C "$1"' _ "$WORK" "$TAR" "$TARL"
WORK="$(cd "$WORK" && pwd)"; PKG="$(ls -d "$WORK"/OTK_ACADEMIC_RELEASE_* | head -1)"; SRC="$PKG/source"
CHECKER="$(abs "$SRC/tools/academic_demo/check_outcomes.mjs")"; EXPECTED="$(abs "$SRC/docs/academic_release/expected_outcomes.json")"

# R02c every file matches MANIFEST.json (sha256), nothing missing, nothing extra; this runner is the packaged one
verify_manifest() {
  node - "$(abs "$PKG")" "$(abs "$SELF")" <<'EOF'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [pkg, self] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(path.join(pkg, 'MANIFEST.json'), 'utf8'));
const src = path.join(pkg, 'source'); const seen = new Set(); let bad = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (e.isFile()) seen.add(path.relative(src, p).split(path.sep).join('/')); else { console.log('NOT A FILE', p); bad++; } } };
walk(src);
for (const [rel, f] of Object.entries(m.files)) {
  if (!seen.has(rel)) { console.log('MISSING', rel); bad++; continue; }
  const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(src, rel))).digest('hex');
  if (h !== f.sha256) { console.log('HASH MISMATCH', rel); bad++; }
  seen.delete(rel);
}
for (const rel of seen) { console.log('NOT IN MANIFEST', rel); bad++; }
const packaged = path.join(src, 'tools/academic_demo/run_from_package.sh');
const hs = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if (!fs.existsSync(packaged)) { console.log('runner not in package'); bad++; }
else if (hs(packaged) !== hs(self) && process.env.RB_ALLOW_RUNNER_MISMATCH !== '1') { console.log('this runner differs from the packaged tools/academic_demo/run_from_package.sh'); bad++; }
for (const need of ['docs/academic_release/expected_outcomes.json', 'tools/academic_demo/check_outcomes.mjs']) if (!m.files[need]) { console.log('MANIFEST lacks', need); bad++; }
console.log(`files in manifest: ${Object.keys(m.files).length}; problems: ${bad}; commit: ${m.commit}`);
process.exit(bad ? 1 : 0);
EOF
}
run_step R02c_manifest rc 900 verify_manifest
PKG_COMMIT="$(sed -n 's/.*commit: \([0-9a-f]*\)$/\1/p' "$OUT/R02c_manifest.txt" | tail -1)"

cd "$SRC" || fail R02_extract "source folder missing"
run_step R02b_git_init rc 900 bash -c "git init -q && git -c core.autocrlf=false -c core.longpaths=true add -A && git -c core.longpaths=true -c user.name=banca -c user.email=banca@example.test commit -qm pacote && git log --oneline -1"
run_step R04_npm_ci rc 1800 npm ci --no-audit --no-fund
run_step R04b_npm_ci_hardhat rc 1800 bash -c "cd tools/hardhat && npm ci --no-audit --no-fund"
run_step R06_hardhat_compile rc 900 bash -c "cd tools/hardhat && npx hardhat compile"
run_step R06b_tsc rc 900 node node_modules/typescript/bin/tsc --noEmit --pretty false
# F-H1-13 (H1 2026-10-13): Node >= 23 prints the spec reporter by default even when piped; check_outcomes.mjs parses TAP,
# so every step names the TAP reporter explicitly (a professor with Node 24 would otherwise fail every step)
run_step R07_npm_test tap 2700 npm run -s test:tap
run_step R07c_cu_reference tap 600 node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap test/unit/cu_reference.test.ts test/unit/cu_reference_digest_pin.test.ts
run_step R07d_zk_v3 tap 900 node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap test/zk/d1d8_a_circuit_v3.test.ts
run_step R07e_contracts tap 1200 bash -c "cd tools/hardhat && node --test --test-reporter=tap --test-concurrency=1 test/*.test.js"

# R07f services: own project, ports and subnet; containers removed even when 'up' or the tests fail
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
services() {
  subnet_free "$SVC_SUBNET" || { echo "SERVICES_UP_FAILED: subnet $SVC_SUBNET in use; set RB_SVC_SUBNET"; return 1; }
  local cf="-f infra/test/docker-compose.services.yml -f infra/test/docker-compose.services.subnet.yml"
  export OTK_TEST_PG_PORT=$PG_PORT OTK_TEST_REDIS_PORT=$REDIS_PORT OTK_TEST_SUBNET=$SVC_SUBNET
  port_quiet "$PG_PORT" "$REDIS_PORT"
  if ! docker compose -p "$SVC_PROJ" $cf up -d --wait; then
    echo "SERVICES_UP_FAILED"; docker compose -p "$SVC_PROJ" $cf ps -a
    docker compose -p "$SVC_PROJ" $cf down -v; return 1
  fi
  export OTK_TEST_PG_URL=postgres://otk:otk-test-only@127.0.0.1:$PG_PORT/otk
  export OTK_TEST_REDIS_URL=redis://:otk-test-only@127.0.0.1:$REDIS_PORT
  export OTK_TEST_PG_CONTAINER=$SVC_PROJ-postgres-1
  node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap --test-concurrency=1 $(ls test/services/*.test.ts | grep -v 'int02_besu\|int_real')
  local rc=$?
  docker compose -p "$SVC_PROJ" $cf down -v || { echo "SERVICES_DOWN_FAILED"; [ $rc = 0 ] && rc=1; }
  return $rc
}
DOCKER_USED=1
run_step R07f_services tap 3600 services

# R08 demonstration (steps 5 and 8-14 of the runbook), then its summary must say ok and name this package
if [ "$SKIP_DEMO" = 1 ]; then log "$(date -u +%FT%TZ) R08_demo SKIPPED_BY_OPTION (--skip-demo): the run cannot be PASS"; DECLARED=1; FAIL_REASON="demo skipped by option"
else
  run_step R08_demo rc 3600 env DEMO_OUT="$(abs "$OUT")/demo" DEMO_BESU_DIR="$(abs "$WORK")/demo-besu" \
    DEMO_SVC_PROJECT="$DEMO_SVC_PROJ" DEMO_BESU_PROJECT="$DEMO_BESU_PROJ" DEMO_SVC_SUBNET="$DEMO_SVC_SUBNET" DEMO_BESU_SUBNET="$DEMO_BESU_SUBNET" \
    bash tools/academic_demo/run_demo.sh
  CUR_STEP=R08b_demo_summary
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const want = "package:" + process.argv[2];
    const ok = s.ok === true && s.source === want && s.operations > 0 && s.consistent === s.operations
      && s.receiptCheck && Object.values(s.receiptCheck).every((v) => v === true);
    console.log(JSON.stringify({ ok: s.ok, source: s.source, want, operations: s.operations, consistent: s.consistent }));
    process.exit(ok ? 0 : 1);' "$(abs "$OUT")/demo/DEMO_SUMMARY.json" "$PKG_COMMIT" > "$OUT/R08b_demo_summary.txt" 2>&1 \
    || fail R08b_demo_summary "DEMO_SUMMARY.json missing, not ok, or from another source (see R08b_demo_summary.txt)"
  log "$(date -u +%FT%TZ) R08b_demo_summary verdict=PASS $(cat "$OUT/R08b_demo_summary.txt")"
fi
[ "$SKIP_DEMO" = 1 ] && fail R08_demo "demo skipped by option (--skip-demo): partial run, not a PASS"
COMPLETED=1
