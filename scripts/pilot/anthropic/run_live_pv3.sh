#!/usr/bin/env bash
# PILOTO_V3 — live phases (Anthropic, OpenAI or Gemini), strictly serial, through runPilotV3.ts.
# Usage: as on the next line (the provider may also be gemini35). It makes PAID provider API calls, capped per
#   provider by the canonical budget ledger. Depends on files outside this repository (the heavy-lock helper,
#   the operator's ledger and the evaluation run folders), so it is kept as a record of how the live pilot ran.
#   bash scripts/pilot/anthropic/run_live_pv3.sh [--provider=anthropic|openai|gemini] [minimal stream disconnect sample besu]
# Per provider (default anthropic), fixed: output root (PILOTO_V3/live, PILOTO_V3/live_openai, PILOTO_V3/live_gemini), canonical ledger
# (<HOME>/otk-pilot/<provider>_budget_ledger.jsonl, US$ 3 each) and runner runPilotV3.ts.
#
# Credential: ANTHROPIC_API_KEY / OPENAI_API_KEY of this process or, when absent, the user-scope variable
# OTK_PILOT_ANTHROPIC_API_KEY / OTK_PILOT_OPENAI_API_KEY / OTK_PILOT_GEMINI_API_KEY (read straight into this process; never
# printed, logged or written), or the local file named by OTK_PV3_KEY_FILE (one bare value or NAME=value line for this
# provider's variable; read into memory only; never in test mode).
#
# Never repeating a possibly-paid call does not rely on exit codes. Every paid request is reserved first in the
# canonical ledger, so a phase MAY HAVE PAID iff the ledger gained a reservation while it ran (counted by parsing,
# ledgerCounts.mjs; an unreadable ledger or marker counts as possibly paid):
#  - exit 0                          → <phase>.done; the phase is never run again;
#  - exit ≠ 0 and a new reservation  → STOP; nothing runs again until the author decides;
#  - exit ≠ 0 and no new reservation → nothing was called; the phase may be run again.
# <phase>.started (ledger reservation count at start) survives an interrupted run; on the next invocation a
# reservation added since then turns it into STOP. Before each phase, open or uncertain reservations in the
# ledger block the run unless OTK_PV3_ACK_EXPOSURE equals their current count (an explicit author decision).
# The whole invocation holds the heavy lock (checked by owner), so the markers have one writer at a time.
#
# Test mode (OTK_PV3_TEST_HOOKS=1, used only by test/unit/pilot_v3_live_wrapper.test.ts): honours
# OTK_PV3_LIVE_ROOT, OTK_PV3_RUNNER, OTK_PILOT_LEDGER and PV3_LOCK_HELD, never reads the user-scope key and
# refuses any provider key that does not start with "stub-". Outside test mode those variables are ignored.
# Exit: 0 ok; 1 STOP/blocked/divergence; 3 no credential; 4 usage; otherwise the runner's exit code.
set -u
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")/../../.."
LOCK_OWNER=<HOME>/otk-exec-D1D8-20260930-1625/control/LOCKS/heavy/owner
PROVIDER=anthropic
case "${1:-}" in --provider=*) PROVIDER="${1#--provider=}"; shift;; esac
case "$PROVIDER" in
  anthropic) KEY_VAR=ANTHROPIC_API_KEY; USER_VAR=OTK_PILOT_ANTHROPIC_API_KEY; LIVE_DIR=live;;
  openai) KEY_VAR=OPENAI_API_KEY; USER_VAR=OTK_PILOT_OPENAI_API_KEY; LIVE_DIR=live_openai;;
  gemini) KEY_VAR=GEMINI_API_KEY; USER_VAR=OTK_PILOT_GEMINI_API_KEY; LIVE_DIR=live_gemini;;
  # gemini-3.5-flash-lite (author decision 2026-10-04): own output folder, SAME Gemini ledger (one US$ 3 cap per provider)
  gemini35) KEY_VAR=GEMINI_API_KEY; USER_VAR=OTK_PILOT_GEMINI_API_KEY; LIVE_DIR=live_gemini35;;
  *) echo "unknown provider $PROVIDER (nothing run)" >&2; exit 4;;
esac
TEST="${OTK_PV3_TEST_HOOKS:-0}"
if [ "$TEST" = 1 ]; then
  case "${!KEY_VAR:-}" in ''|stub-*) ;; *) echo "test mode refuses a non-stub $KEY_VAR" >&2; exit 4;; esac
  OUT_ROOT="${OTK_PV3_LIVE_ROOT:?}"; RUNNER="${OTK_PV3_RUNNER:?}"; LEDGER="${OTK_PILOT_LEDGER:?}"
else
  if [ -z "${PV3_LOCK_HELD:-}" ]; then
    export PV3_LOCK_HELD=1
    exec bash ../control/bin/heavy_lock.sh FPS5 pv3-live -- bash "$SELF" --provider="$PROVIDER" "$@"
  fi
  # the lock must be held by the heavy_lock.sh process that started this one (a stray PV3_LOCK_HELD is refused)
  if ! grep -q "^FPS5 pv3-live .* pid=$PPID " "$LOCK_OWNER" 2>/dev/null; then
    echo "heavy lock not held by this invocation (unset PV3_LOCK_HELD and run again)" >&2; exit 1
  fi
  OUT_ROOT=docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/PILOTO_V3/$LIVE_DIR
  RUNNER=scripts/pilot/anthropic/runPilotV3.ts
  LEDGER=<HOME>/otk-pilot/${PROVIDER%35}_budget_ledger.jsonl
fi
BESU_DIR="${OTK_PILOT_BESU_DIR:-<HOME>/otk-exec-D1D8-20260930-1625/fps5-besu}"
PHASES="${*:-minimal stream disconnect sample besu}"
for ph in $PHASES; do case "$ph" in minimal|stream|disconnect|sample|besu) ;; *) echo "unknown phase $ph (nothing run)" >&2; exit 4;; esac; done
mkdir -p "$OUT_ROOT"
if [ -e "$OUT_ROOT/STOP" ]; then echo "STOP present ($(cat "$OUT_ROOT/STOP")): nothing runs until the author decides" >&2; exit 1; fi

stop() { echo "$1 $(date -Iseconds)" > "$OUT_ROOT/STOP"; echo "STOP: $1" >&2; exit 1; }
# "<reservations> <open> <uncertain>"; an unreadable ledger is treated as possibly paid
counts() { node scripts/pilot/anthropic/ledgerCounts.mjs "$LEDGER" || stop "canonical ledger unreadable ($LEDGER)"; }
reservations() { local c; c=$(counts) || exit 1; echo "${c%% *}"; }
exposure() { local c r o u; c=$(counts) || exit 1; read -r r o u <<< "$c"; echo $(( o + u )); }

if [ -z "${!KEY_VAR:-}" ] && [ "$TEST" != 1 ] && command -v powershell.exe >/dev/null 2>&1; then
  k="$(powershell.exe -NoProfile -Command "[Console]::Out.Write([Environment]::GetEnvironmentVariable('$USER_VAR','User'))" 2>/dev/null | tr -d '\r\n')"
  if [ -n "$k" ]; then export "$KEY_VAR=$k"; fi
  unset k
fi
if [ -z "${!KEY_VAR:-}" ] && [ "$TEST" != 1 ] && [ -n "${OTK_PV3_KEY_FILE:-}" ] && [ -r "$OTK_PV3_KEY_FILE" ]; then
  # one non-empty line: a bare value, or KEY_VAR=value; anything else is refused (the value is never printed)
  kf=""; kn=0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"; [ -z "${line//[[:space:]]/}" ] && continue; kn=$((kn + 1))
    case "$line" in "$KEY_VAR="*) kf="${line#"$KEY_VAR="}";; *=*) kf="";; *) kf="$line";; esac
  done < "$OTK_PV3_KEY_FILE"
  kf="${kf#"${kf%%[![:space:]]*}"}"; kf="${kf%"${kf##*[![:space:]]}"}"
  if [ "$kn" = 1 ] && [ -n "$kf" ] && [[ "$kf" != *[[:space:]]* ]]; then export "$KEY_VAR=$kf"; else echo "key file not usable for $KEY_VAR (expected one line)" >&2; fi
  unset kf kn line
fi
if [ -n "${!KEY_VAR:-}" ]; then echo "credential: present ($KEY_VAR)"; else echo "credential: absent ($KEY_VAR)" >&2; exit 3; fi

. scripts/ops/fps5_env.sh
export OTK_PILOT_PG_URL="$OTK_TEST_PG_URL" OTK_PILOT_LEDGER="$LEDGER"
echo "batch provider=$PROVIDER head=$(git rev-parse HEAD) dirty=$(git status --porcelain | wc -l) phases=[$PHASES] start=$(date -Iseconds)" >> "$OUT_ROOT/EXIT_CODES.txt"
for ph in $PHASES; do
  if [ -e "$OUT_ROOT/$ph.done" ]; then echo "$ph: already done, skipped"; continue; fi
  if [ -e "$OUT_ROOT/$ph.started" ]; then
    s0=$(tr -d '\r\n ' < "$OUT_ROOT/$ph.started")
    case "$s0" in ''|*[!0-9]*) stop "$ph.started is unreadable (interrupted run, possibly paid)";; esac
    r=$(reservations) || exit 1
    if [ "$r" -gt "$s0" ]; then stop "$ph was interrupted after a ledger reservation (possibly paid)"; fi
    rm -f "$OUT_ROOT/$ph.started"
  fi
  ex=$(exposure) || exit 1
  if [ "$ex" -gt 0 ] && [ "${OTK_PV3_ACK_EXPOSURE:-}" != "$ex" ]; then
    echo "ledger has $ex open/uncertain reservation(s): blocked (author decision: OTK_PV3_ACK_EXPOSURE=$ex)" >&2; exit 1
  fi
  r0=$(reservations) || exit 1; echo "$r0" > "$OUT_ROOT/$ph.started"
  extra=(); [ "$ph" = besu ] && extra=(--besu-dir="$BESU_DIR")
  node --import tsx "$RUNNER" --provider="$PROVIDER" --mode=live --phase="$ph" --out="$OUT_ROOT/$ph" "${extra[@]}" > "$OUT_ROOT/$ph.log" 2>&1
  rc=$?
  r1=$(reservations) || exit 1
  echo "$ph exit=$rc reservations=$r0->$r1 end=$(date -Iseconds)" >> "$OUT_ROOT/EXIT_CODES.txt"
  if [ "$rc" -eq 0 ]; then date -Iseconds > "$OUT_ROOT/$ph.done"; rm -f "$OUT_ROOT/$ph.started"; echo "$ph: ok"; continue; fi
  if [ "$r1" -gt "$r0" ]; then stop "$ph exit=$rc after $(( r1 - r0 )) ledger reservation(s); see $OUT_ROOT/$ph.log"; fi
  rm -f "$OUT_ROOT/$ph.started"
  echo "$ph: exit $rc with no ledger reservation (nothing was called); see $OUT_ROOT/$ph.log" >&2; exit "$rc"
done
