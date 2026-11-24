-- 011_billing_cycles.sql
-- W7-C BILL-03: Billing cycle tracking table
-- Stores per-tenant billing period totals for Stripe reporting and P&L

CREATE TABLE IF NOT EXISTS otk_billing_cycles (
  id            SERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  cycle_start   TEXT NOT NULL,   -- ISO date: "YYYY-MM-DD"
  cycle_end     TEXT NOT NULL,   -- ISO date: "YYYY-MM-DD"
  plan_tier     TEXT NOT NULL,   -- FREE | STARTER | PRO
  total_cu      BIGINT NOT NULL DEFAULT 0,
  total_usd     NUMERIC(12,6) NOT NULL DEFAULT 0,  -- provider cost (input to Stripe)
  margin_usd    NUMERIC(12,6),   -- OTK margin after markup (BILL-07)
  stripe_invoice_id TEXT,        -- Stripe invoice ID if billing was submitted
  status        TEXT NOT NULL DEFAULT 'open',  -- open | submitted | paid | failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- UNIQUE constraint required for ON CONFLICT (tenant_id, cycle_start) in BillingCycleWorker
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_cycles_tenant_cycle
  ON otk_billing_cycles (tenant_id, cycle_start);

CREATE INDEX IF NOT EXISTS idx_billing_cycles_status
  ON otk_billing_cycles (status, cycle_start);
