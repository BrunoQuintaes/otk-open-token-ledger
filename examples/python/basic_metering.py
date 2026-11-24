"""
OTK zk-Metering — Python basic example (G1 / RB-064)

Demonstrates the full Python client workflow:
  1. Health check
  2. Metrics snapshot
  3. Rate limit status
  4. Latest events

Prerequisites: OTK API server running on http://localhost:3000.

Run:
    cd /path/to/otk-zk-metering
    npm run server &
    python examples/python/basic_metering.py
"""

from __future__ import annotations

import sys

# Allow running from repo root without installing the package
sys.path.insert(0, "python")

from otk_client import OTKClient  # noqa: E402


def main() -> None:
    client = OTKClient("http://localhost:3000")

    # --- Health check ---
    health = client.health()
    status = "UP" if health.get("ok") else "DOWN"
    print(f"[health]  status={status}  uptime={health.get('uptime')}s")

    # --- API version ---
    ver = client.version()
    print(f"[version] apiVersion={ver.get('apiVersion')}  gitHead={ver.get('gitHead')}")

    # --- Metrics snapshot ---
    snap = client.metrics()
    print(f"[metrics] health={snap.get('health')}  providers={len(snap.get('providers', []))}")
    for entry in snap.get("providers", []):
        print(f"          {entry.get('provider')}/{entry.get('model')} "
              f"cu={entry.get('totalCU')} status={entry.get('healthStatus')}")

    # --- Rate limit status ---
    rl = client.ratelimit_status()
    print(f"[rl]      trackedKeys={rl.get('trackedKeys')}")

    # --- Latest events ---
    evts = client.events_latest(n=3)
    print(f"[events]  count={len(evts.get('events', []))}")
    for ev in evts.get("events", []):
        print(f"          [{ev.get('eventKind')}] {ev.get('eventId')}")


if __name__ == "__main__":
    main()
