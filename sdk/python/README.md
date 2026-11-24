# otk-metering (Python)

Python SDK for the OTK zk-Metering API. Uses only the Python standard library.

## Installation

```bash
pip install otk-metering
```

Or install from source:

```bash
cd sdk/python
pip install -e .
```

## Quick Start

```python
from otk_metering import OTKMeteringClient

client = OTKMeteringClient("http://localhost:8787", api_key="tok_your_key")

# Health check
health = client.health()
print(health["ok"])  # True

# Submit a receipt
result = client.submit_receipt({
    "provider": "openai",
    "model": "gpt-4",
    "inputTokens": 500,
    "outputTokens": 200,
    "costUnits": 1400,
    "latencyMs": 320,
    "timestamp": 1710500000,
    "requestId": "req-abc-123",
    "userId": "12345",
    "nonce": "1",
    "signature": "0x...",
    "epochId": "100",
})
print(result["stored"])  # True

# Get a receipt
receipt = client.get_receipt("req-abc-123")
print(receipt["provider"])  # "openai"

# Get balance
balance = client.get_balance("acme", "100")
print(balance["totalCU"])  # "1400"

# Get invoice
invoice = client.get_invoice("acme", "100")
print(len(invoice["invoice"]["lineItems"]))  # GET /invoices answers {"ok", "invoice"}
```

## Error Handling

```python
from otk_metering import OTKApiError

try:
    client.get_receipt("nonexistent")
except OTKApiError as e:
    print(e.status)  # 404
    print(e.body)    # {"error": "not_found"}
```

## Requirements

- Python >= 3.9
- No external dependencies (uses `urllib.request` from the standard library)

## License

MIT
