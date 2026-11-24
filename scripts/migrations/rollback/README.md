# Rollback das migrations D1–D8 de C (100–103)

`scripts/ops/migrate.js` é só-avante e lê apenas `scripts/migrations/*.sql` do nível superior; esta pasta não é aplicada por ele.

As migrations 100–103 são **aditivas**: criam tabelas novas e não alteram `otk_receipts`, `otk_proof_jobs` nem as migrations 001–012. Por isso o rollback de **código** para o COMMON (`9a42ff2`) funciona sem tocar o banco: o código antigo ignora as tabelas novas.

Remover as tabelas novas é destrutivo (apaga operações, ledger, outbox, aberturas e recibos v3). Ordem obrigatória:

1. Backup: `pg_dump --table='otk_operations|otk_quota_usage|otk_money_budget|otk_ledger|otk_outbox|otk_openings|otk_receipts_v3|otk_conferences' "$OTK_DB_URL" > d1d8_c_backup.sql` (contém aberturas privadas: tratar como segredo).
2. Parar API, proxy e workers que usam essas tabelas.
3. `psql "$OTK_DB_URL" -f scripts/migrations/rollback/103_d1d8_receipts_v3.down.sql` e assim por diante, na ordem 103 → 100.

Cada `.down.sql` é idempotente (`DROP … IF EXISTS`) e também apaga a linha correspondente de `otk_migrations`, para que um `migrate.js` posterior reaplique a versão. Testado em `test/services/d1d8_c_schema.test.ts`.

## S4 (run 20260930-1625): 150_d1d8_s4_money

`150_d1d8_s4_money` adiciona o eixo monetário (coluna `otk_operations.money`, `otk_money_ledger`, `otk_money_budget_members`, `frozen_reason/frozen_at`). Rollback: `150_d1d8_s4_money.down.sql` **antes** de 103 → 100. Remove só o que a 150 criou; as linhas de operação continuam (testado em `test/services/d1d8_s4_migrations.test.ts`). Reaplicar a 150 reconstrói o eixo a partir de `reservation` + `reserved_money`; o que foi gasto sob a regra anterior fica marcado `origin = legacy_pre_s4`.

## Fechamento pós-S5: 151_d1d8_fps5_money_scope

`151_d1d8_fps5_money_scope` adiciona `otk_money_budget.money_policy` (política de limite exigida pelo orçamento), o índice `otk_operations_open_money_idx`, a função `otk_money_scope_lock(tenant)` e os gatilhos que serializam criação/vínculo/troca de política/remoção de orçamento com a admissão (RV2-01/AUD-6). Rollback: `151_d1d8_fps5_money_scope.down.sql` **antes** da 150. Não apaga operações nem saldos; o código anterior à 151 volta a ter a janela de corrida AUD-6.

## Fechamento pós-S5: 152_d1d8_fps5_price_schedule

`152_d1d8_fps5_price_schedule` adiciona `otk_operations.price_attempts`/`price_next_attempt_at` e o índice `otk_operations_price_due_idx` (agenda da reconciliação de preço pendente, RV2-02/AUD-4). Ordem de rollback: 152 → 151 → 150 → 103 … 100. Não altera estados de dinheiro nem timestamps de negócio.

## OVERNIGHT 20261005: 153_d1d8_request_digest_version

`153_d1d8_request_digest_version` adiciona `otk_operations.request_digest_version` (NULL = linha anterior, digerida com `otk.request_digest.v1`; linhas novas registram `otk.request_digest.v2`, identidade do pedido como o cliente o enviou). Só coluna, sem relação nova: por isso `ensureD1D8Schema` também confere `D1D8_COLUMNS`. Ordem de rollback: 153 → 152 → 151 → 150 → 103 … 100. Depois do rollback, código anterior à 153 compara digests v1 e responde 409 `operation_conflict` ao retry de operações admitidas como v2: nunca nova chamada ao provedor nem novo débito.

## OVERNIGHT 20261005: 154_d1d8_attribution

`154_d1d8_attribution` cria `otk_projects`, `otk_applications`, `otk_operation_attribution` e `otk_attribution_statements` (atribuição privada por projeto/tarefa, fase 7). Ordem de rollback: 154 → 153 → 152 → … O rollback apaga só a atribuição (projetos registrados, vínculos e declarações assinadas); operações, ledger e recibos ficam, e toda operação passa a aparecer como não atribuída.

## OVERNIGHT 20261005: 155_d1d8_erasure_tombstones

`155_d1d8_erasure_tombstones` cria `otk_erasure_tombstones` (fase 4: apagamento v3). Ordem de rollback: 155 → 154 → … AVISO: sem as lápides, o retry de uma operação apagada volta a ser admitido como operação nova (nova chamada ao provedor). Preservar o diário de apagamentos e reaplicá-lo depois de reaplicar a 155.
