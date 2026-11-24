-- D1-D8 / S4: monetary axis separate from the CU settlement (audit ABC-03), shared money budgets and
-- guarantee freeze (audit ABC-04). Additive and idempotent, rollback in rollback/150_*.down.sql.
ALTER TABLE otk_operations ADD COLUMN IF NOT EXISTS money JSONB;
ALTER TABLE otk_money_budget ADD COLUMN IF NOT EXISTS frozen_reason TEXT;
ALTER TABLE otk_money_budget ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS otk_money_budget_members (
  budget_id        TEXT          NOT NULL REFERENCES otk_money_budget (budget_id),
  tenant_id        TEXT          NOT NULL,
  PRIMARY KEY (budget_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS otk_money_budget_members_tenant_idx ON otk_money_budget_members (tenant_id);

CREATE TABLE IF NOT EXISTS otk_money_ledger (
  budget_id        TEXT          NOT NULL,
  tenant_id        TEXT          NOT NULL,
  operation_id     TEXT          NOT NULL,
  units            NUMERIC(78,0) NOT NULL,
  reserved_units   NUMERIC(78,0) NOT NULL,
  price_table      JSONB,
  note             TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (budget_id, tenant_id, operation_id)
);

-- rows written before this migration (C semantics: money moved to spent at CU settlement) get
-- an explicit money axis, settled ones are marked legacy_pre_s4 (confirmed = what C moved to spent)
UPDATE otk_operations SET money = jsonb_build_object(
    'state', CASE reservation->>'state' WHEN 'settled' THEN 'settled' ELSE reservation->>'state' END,
    'reserved', jsonb_build_object('units', reserved_money::text, 'scale', '1000000000000', 'currency', 'USD'),
    'confirmed', CASE WHEN reservation->>'state' = 'settled' THEN reservation->'money' ELSE 'null'::jsonb END,
    'knownSubtotal', 'null'::jsonb, 'priceStatus', 'null'::jsonb, 'priceTable', 'null'::jsonb,
    'origin', CASE WHEN reservation->>'state' = 'settled' THEN to_jsonb('legacy_pre_s4'::text) ELSE 'null'::jsonb END)
  WHERE money IS NULL AND reserved_money IS NOT NULL;
