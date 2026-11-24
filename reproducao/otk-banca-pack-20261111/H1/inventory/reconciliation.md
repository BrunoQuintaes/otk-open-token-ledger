# R02 - Reconciliacao do inventario (662 linhas / 658 concluidas / 4 recusas)

Fonte: baseline H1 `7606bc9b` (copia de leitura via `git archive`), `docs/_ops/OVERNIGHT2_20261006/campaign/**/_calls.jsonl` (dirs `synthetic*` excluidos). Gerado por `scripts/build_inventory.mjs`. **Custo recalculado = calculo pela tabela congelada; NAO e fatura.**

| provedor | linhas | concluidas (http 200) | recusas | consistent=true | textos unicos concluidos (esperado 216) | cache | besu | pares de calibracao | train/val/holdout |
|---|---|---|---|---|---|---|---|---|---|
| openai | 221 | 219 | 2 | 219 | 215 | 3 | 1 | 211 | 120/53/38 |
| anthropic | 220 | 219 | 1 | 219 | 215 | 3 | 1 | 210 | 119/54/37 |
| gemini | 221 | 220 | 1 | 220 | 216 | 3 | 1 | 212 | 121/54/37 |
| **total** | 662 | 658 | 4 | | | | | 633 | |

## Recusas (4) - fora das 658

| provedor | label | http | split | fonte |
|---|---|---|---|---|
| openai | cal-json-005-v1 | 429 | train | docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-10/pv3-openai-live-campaign-2026-10-07t04-48-20-564_calls.jsonl:88 |
| openai | cal-mixed_unicode-000-v1 | 400 | train | docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-97/pv3-openai-live-campaign-2026-10-07t05-01-19-314_calls.jsonl:40 |
| anthropic | cal-en_prose-000-v0 | 429 | validation | docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign/pv3-live-campaign-2026-10-07t04-57-14-774_calls.jsonl:28 |
| gemini | cal-code_ts-004-v0 | 429 | validation | docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign/pv3-gemini35-live-campaign-2026-10-07t04-52-52-082_calls.jsonl:67 |

## Textos ausentes por provedor (EXPLICITO)

- **openai**: `mixed_unicode-000-v1` (recusa(s) sem repeticao bem-sucedida; tentativas: docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-97/pv3-openai-live-campaign-2026-10-07t05-01-19-314_calls.jsonl:40 http 400)
- **anthropic**: `mixed_unicode-000-v1` (nunca enviado a este provedor (ausente de todos os _calls.jsonl); tentativas: nenhuma)
- **gemini**: nenhum (216/216)

## Labels com mais de uma linha (repeticao apos recusa)

- openai `cal-json-005-v1`: docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-10/pv3-openai-live-campaign-2026-10-07t04-48-20-564_calls.jsonl:88 http 429 ; docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-97/pv3-openai-live-campaign-2026-10-07t05-01-19-314_calls.jsonl:1 http 200
- anthropic `cal-en_prose-000-v0`: docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:1 http 200 ; docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign/pv3-live-campaign-2026-10-07t04-57-14-774_calls.jsonl:28 http 429
- gemini `cal-code_ts-004-v0`: docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign_start-index-66/pv3-gemini35-live-campaign-2026-10-07t05-03-44-975_calls.jsonl:1 http 200 ; docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign/pv3-gemini35-live-campaign-2026-10-07t04-52-52-082_calls.jsonl:67 http 429

## Concluidas sem contagem local (conference not_produced) - coleta sim, calibracao nao

- openai `cal-code_ts-000-v0` split=holdout family=code_ts (docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-10/pv3-openai-live-campaign-2026-10-07t04-48-20-564_calls.jsonl:45)
- openai `cal-numeric-008-v0` split=train family=numeric (docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-137/pv3-openai-live-campaign-2026-10-07t05-09-06-868_calls.jsonl:50)
- openai `cal-tiny-007-v0` split=train family=tiny (docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-137/pv3-openai-live-campaign-2026-10-07t05-09-06-868_calls.jsonl:74)
- openai `cal-markdown_table-008-v2` split=validation family=markdown_table (docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-97/pv3-openai-live-campaign-2026-10-07t05-01-19-314_calls.jsonl:38)
- anthropic `cal-en_prose-001-v0` split=train family=en_prose (docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:4)
- anthropic `cal-code_ts-006-v2` split=train family=code_ts (docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:48)
- anthropic `cal-json-000-v0` split=holdout family=json (docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:55)
- anthropic `cal-markdown_table-002-v1` split=train family=markdown_table (docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:89)
- anthropic `cal-numeric-005-v1` split=holdout family=numeric (docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:151)
- gemini `cal-json-008-v2` split=train family=json (docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign_start-index-66/pv3-gemini35-live-campaign-2026-10-07t05-03-44-975_calls.jsonl:42)
- gemini `cal-markdown_table-005-v2` split=train family=markdown_table (docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign_start-index-66/pv3-gemini35-live-campaign-2026-10-07t05-03-44-975_calls.jsonl:60)
- gemini `cal-pt_prose-001-v2` split=holdout family=pt_prose (docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign/pv3-gemini35-live-campaign-2026-10-07t04-52-52-082_calls.jsonl:6)
- gemini `cal-code_ts-003-v1` split=holdout family=code_ts (docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign/pv3-gemini35-live-campaign-2026-10-07t04-52-52-082_calls.jsonl:65)

## Custo (USD) - calculado, NAO fatura

| provedor | soma ledger (registros) | soma recalculada (tabela congelada) | campaign_summary.json | linhas com diferenca |
|---|---|---|---|---|
| openai | 0.01105065 | 0.01105065 | 0.01105065 | 0 |
| anthropic | 0.096972 | 0.096972 | 0.096972 | 0 |
| gemini | 0.03047822 | 0.03047822 | 0.03047822 | 0 |
| **total** | 0.13850087 | 0.13850087 | | |

## Tokens declarados (somas das concluidas) x campaign_summary.json

| provedor | input declarado (inclui cache lido quando subset) | cache lido | output | summary input_uncached | summary cache_read | summary output_visible |
|---|---|---|---|---|---|---|
| openai | 57915 | 6656 | 4771 | 51259 | 6656 | 4771 |
| anthropic | 70997 | 0 | 5195 | 70997 | 0 | 5195 |
| gemini | 71810 | 4064 | 4013 | 67746 | 4064 | 4013 |

## Cruzamento 1:1 com calibration/campaign_ops.jsonl

- linhas em campaign_ops.jsonl: 662; opIds do inventario ausentes la: 0; opIds de la ausentes no inventario: 0
- custo divergente: 0; contagem local divergente: 0; split divergente: 0

## Timestamps

- O registro `_calls.jsonl` NAO tem timestamp por chamada. A coluna `ts_log_utc` vem do evento `conference_calibration_not_applied` do log do entrypoint (um por op concluida; e o instante do registro no log, nao o da chamada ao provedor). Recusas: sem evento, celula vazia.

