# Changelog

All notable changes to `@otk/metering-sdk` will be documented in this file.

## [Unreleased] - H1-S24 (2026-10-13)

### Fixed
- `getInvoice()` / `get_invoice()` called `GET /billing/invoice`, a route that does not exist (always 404); they now call
  `GET /invoices`. The TypeScript return type is `InvoiceEnvelope` (`{ ok, invoice }`), the shape the API answers.
- Python `get_balance()` / `get_invoice()` used `urllib.request.urlencode`, which does not exist (AttributeError on every
  call); they now use `urllib.parse.urlencode`.

### Known contract gaps (not changed, see docs/_ops/H1/LANED_20261013/S24_API_CONTRACT.md)
- `SubmitReceiptResponse` declares `stored`; the API answers `{ ok, requestId, costUnits, duplicate }`.
- `getReceipt()` is typed as the receipt; the API answers `{ ok, receipt, proofStatus, ... }`.

## [0.1.0] - 2026-03-15

### Added
- Initial SDK release (P1.5 — Wave 1 Pack 10)
- `OTKMeteringClient` class with typed configuration
- `submitReceipt()` — receipt ingestion
- `getReceipt()` — receipt retrieval by request ID
- `getBalance()` — CU balance query per tenant/epoch
- `getInvoice()` — invoice generation per tenant/epoch
- `health()` — API health check
- `OTKApiError` for structured error handling
- Full TypeScript typings for all request/response shapes
