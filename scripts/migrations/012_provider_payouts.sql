-- 012_provider_payouts.sql
-- W9-A PAY-04: Provider payout tracking table
-- Tracks the amounts OTK owes to AI providers at end of billing cycle.
CREATE TABLE IF NOT EXISTS otk_provider_payouts (
  id                SERIAL PRIMARY KEY,
  provider          TEXT NOT NULL,
  cycle_start       TEXT NOT NULL,
  cycle_end         TEXT NOT NULL,
  provider_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, cycle_start)
);
