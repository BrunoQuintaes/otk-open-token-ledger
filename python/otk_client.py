"""
OTK zk-Metering — Python Client (G1 / RB-064)

Thin HTTP client for the OTK metering REST API.
No external dependencies — uses Python stdlib only (urllib, json).

Endpoints covered:
  GET  /health             — liveness check
  GET  /version            — API version info
  GET  /metrics            — observability snapshot
  GET  /events/latest?n=N  — last N EventEnvelopes
  GET  /ratelimit/status   — adaptive rate limit state
  POST /ping               — echo body

Usage::

    from otk_client import OTKClient

    client = OTKClient("http://localhost:3000")
    print(client.health())
    print(client.metrics())
    print(client.ratelimit_status())
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


class OTKClient:
    """Minimal HTTP client for the OTK metering REST API.

    Args:
        base_url: Root URL of the running API server (default: http://localhost:3000).
        timeout:  Request timeout in seconds (default: 10.0).
    """

    def __init__(
        self,
        base_url: str = "http://localhost:3000",
        timeout: float = 10.0,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get(self, path: str) -> Any:
        url = f"{self._base}{path}"
        with urllib.request.urlopen(url, timeout=self._timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _post(self, path: str, body: str) -> Any:
        url = f"{self._base}{path}"
        data = body.encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST")
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        """GET /health — liveness/readiness check.

        Returns:
            {'ok': True, 'uptime': '...s', 'ts': '<ISO-8601>'}
        """
        return self._get("/health")

    def version(self) -> dict[str, Any]:
        """GET /version — API version metadata.

        Returns:
            {'apiVersion': '...', 'gitHead': '...' | None}
        """
        return self._get("/version")

    def metrics(self) -> dict[str, Any]:
        """GET /metrics — observability snapshot.

        Returns the MetricsCollector snapshot: provider metrics, CU
        totals, per-model error rates, and overall health status.

        Returns:
            {'capturedAt': <unix-ms>, 'providers': [...], 'health': '...'}
        """
        return self._get("/metrics")

    def events_latest(self, n: int = 10) -> dict[str, Any]:
        """GET /events/latest?n=N — last N dispatched EventEnvelopes.

        Args:
            n: Number of events to return (1–100, default 10).

        Returns:
            {'ok': True, 'events': [<EventEnvelope>, ...]}
        """
        n = max(1, min(100, int(n)))
        return self._get(f"/events/latest?n={n}")

    def ratelimit_status(self) -> dict[str, Any]:
        """GET /ratelimit/status — adaptive rate limit state.

        Returns:
            {'ok': True, 'trackedKeys': <int>}
        """
        return self._get("/ratelimit/status")

    def ping(self, body: str = "") -> dict[str, Any]:
        """POST /ping — echo the request body back.

        Args:
            body: Arbitrary string to echo.

        Returns:
            {'ok': True, 'echo': '<body>'}
        """
        return self._post("/ping", body)
