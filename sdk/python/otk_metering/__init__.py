"""
OTK zk-Metering Python SDK

Minimal client for the OTK zk-Metering REST API.
Uses only the Python standard library (urllib.request, json).

Usage:
    from otk_metering import OTKMeteringClient

    client = OTKMeteringClient("http://localhost:8787", api_key="tok_abc")
    health = client.health()
    print(health["ok"])  # True

Since: P1.8 — Wave 1 Pack 11
"""

import json
import urllib.parse
import urllib.request
import urllib.error
from typing import Any, Dict, Optional

__version__ = "0.1.0"
__all__ = ["OTKMeteringClient", "OTKApiError"]


class OTKApiError(Exception):
    """Raised when the API returns a non-2xx status code."""

    def __init__(self, message: str, status: int, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class OTKMeteringClient:
    """
    Client for the OTK zk-Metering REST API.

    Args:
        base_url: Base URL of the API (e.g. "http://localhost:8787").
        api_key: Optional bearer token for authenticated requests.
        timeout: Request timeout in seconds (default: 30).
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: int = 30,
    ):
        if not base_url:
            raise ValueError("base_url is required")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None

        req = urllib.request.Request(
            url,
            data=data,
            headers=self._headers(),
            method=method,
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            try:
                err_body = json.loads(e.read().decode("utf-8"))
            except Exception:
                err_body = e.read().decode("utf-8") if e.fp else None
            raise OTKApiError(
                f"HTTP {e.code} {e.reason}", status=e.code, body=err_body
            ) from None

    def health(self) -> Dict[str, Any]:
        """Check API health. Returns {"ok": true, "uptime": "...", "ts": "..."}."""
        return self._request("GET", "/health")

    def submit_receipt(self, receipt_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Submit a metering receipt.

        Args:
            receipt_data: Dict with keys: provider, model, inputTokens, outputTokens,
                          costUnits, latencyMs, timestamp, requestId, userId, nonce,
                          signature, epochId.

        Returns:
            {"stored": true, "requestId": "..."}
        """
        return self._request("POST", "/receipts", receipt_data)

    def get_receipt(self, request_id: str) -> Dict[str, Any]:
        """
        Retrieve a receipt by its request ID.

        Args:
            request_id: Unique request identifier.

        Returns:
            Receipt data dict.
        """
        encoded = urllib.request.quote(request_id, safe="")
        return self._request("GET", f"/receipts/{encoded}")

    def get_balance(self, tenant_id: str, epoch_id: str) -> Dict[str, Any]:
        """
        Get CU balance for a tenant in a given epoch.

        Args:
            tenant_id: Tenant identifier.
            epoch_id: Epoch identifier.

        Returns:
            {"tenantId": "...", "epochId": "...", "totalCU": "...", "entryCount": N}
        """
        qs = urllib.parse.urlencode({"tenantId": tenant_id, "epochId": epoch_id})
        return self._request("GET", f"/accounting/balance?{qs}")

    def get_invoice(self, tenant_id: str, epoch_id: str) -> Dict[str, Any]:
        """
        Generate an invoice for a tenant in a given epoch.

        Args:
            tenant_id: Tenant identifier.
            epoch_id: Epoch identifier.

        Returns:
            {"ok": True, "invoice": {...lineItems...}} as answered by GET /invoices.
            (H1-S24: the SDK called /billing/invoice, which does not exist, and
            urllib.request has no urlencode; both made this call always fail.)
        """
        qs = urllib.parse.urlencode({"tenantId": tenant_id, "epochId": epoch_id})
        return self._request("GET", f"/invoices?{qs}")
