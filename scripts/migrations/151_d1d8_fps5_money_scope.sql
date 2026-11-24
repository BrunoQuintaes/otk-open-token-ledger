-- D1-D8 / fechamento pós-S5 (RV2-01, AUD-6): the money scope of a tenant is decided atomically with
-- the admission. Admission takes otk_money_scope_lock(tenant), then reads/locks the budgets that apply.
-- Creating a budget or linking a tenant takes the same lock (trigger); changing a budget's policy or
-- deleting it holds the budget row lock that admissions also take. Additive and idempotent, rollback in
-- rollback/151_*.down.sql.
ALTER TABLE otk_money_budget ADD COLUMN IF NOT EXISTS money_policy TEXT;
UPDATE otk_money_budget SET money_policy = 'otk.money_bound_policy.v2@2026-10-02' WHERE money_policy IS NULL;
ALTER TABLE otk_money_budget ALTER COLUMN money_policy SET DEFAULT 'otk.money_bound_policy.v2@2026-10-02';
ALTER TABLE otk_money_budget ALTER COLUMN money_policy SET NOT NULL;
CREATE INDEX IF NOT EXISTS otk_operations_open_money_idx ON otk_operations (tenant_id)
  WHERE money->>'state' IN ('held', 'held_uncertain', 'pending_price') OR reservation->>'state' IN ('held', 'held_uncertain');

CREATE OR REPLACE FUNCTION otk_money_scope_lock(p_tenant TEXT) RETURNS void LANGUAGE sql AS $fn$
  SELECT pg_advisory_xact_lock(hashtextextended('otk_money_scope:' || p_tenant, 0))
$fn$;

CREATE OR REPLACE FUNCTION otk_money_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v_bad TEXT;
BEGIN
  IF TG_TABLE_NAME = 'otk_money_budget' AND TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'otk_money_budget_owner_immutable: budget % (create a new budget instead)', OLD.budget_id;
  END IF;
  IF TG_TABLE_NAME = 'otk_money_budget' AND TG_OP = 'DELETE' THEN
    -- the budget row is locked by this statement; an admission that locked it first has committed
    SELECT tenant_id || '/' || operation_id INTO v_bad FROM otk_operations
     WHERE OLD.budget_id = ANY (budget_ids)
       AND (money->>'state' IN ('held', 'held_uncertain', 'pending_price') OR reservation->>'state' IN ('held', 'held_uncertain'))
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'otk_money_scope_open_exposure: budget % still holds open operation %', OLD.budget_id, v_bad;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'otk_money_budget' AND TG_OP = 'UPDATE' THEN
    -- policy change: refused while an operation reserved under another policy is open in this budget
    SELECT tenant_id || '/' || operation_id INTO v_bad FROM otk_operations
     WHERE OLD.budget_id = ANY (budget_ids)
       AND (money->>'state' IN ('held', 'held_uncertain', 'pending_price') OR reservation->>'state' IN ('held', 'held_uncertain'))
       AND limits->>'moneyBoundPolicy' IS DISTINCT FROM NEW.money_policy
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'otk_money_scope_open_exposure: budget % has open operation % reserved under another policy', OLD.budget_id, v_bad;
    END IF;
    RETURN NEW;
  END IF;
  -- INSERT of a budget, INSERT/UPDATE of a membership: NEW.tenant_id enters the scope of NEW.budget_id
  PERFORM otk_money_scope_lock(NEW.tenant_id);
  SELECT tenant_id || '/' || operation_id INTO v_bad FROM otk_operations
   WHERE tenant_id = NEW.tenant_id
     AND (money->>'state' IN ('held', 'held_uncertain', 'pending_price') OR reservation->>'state' IN ('held', 'held_uncertain'))
     AND NOT (NEW.budget_id = ANY (budget_ids))
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'otk_money_scope_open_exposure: tenant % has open operation % not covered by budget %', NEW.tenant_id, v_bad, NEW.budget_id;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER otk_money_budget_scope_ins BEFORE INSERT ON otk_money_budget
  FOR EACH ROW EXECUTE FUNCTION otk_money_scope_guard();
CREATE OR REPLACE TRIGGER otk_money_budget_scope_upd BEFORE UPDATE OF tenant_id, money_policy ON otk_money_budget
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.money_policy IS DISTINCT FROM NEW.money_policy)
  EXECUTE FUNCTION otk_money_scope_guard();
CREATE OR REPLACE TRIGGER otk_money_budget_scope_del BEFORE DELETE ON otk_money_budget
  FOR EACH ROW EXECUTE FUNCTION otk_money_scope_guard();
CREATE OR REPLACE TRIGGER otk_money_budget_members_scope BEFORE INSERT OR UPDATE ON otk_money_budget_members
  FOR EACH ROW EXECUTE FUNCTION otk_money_scope_guard();
