# R04 - Denominadores da campanha H1: de 219 realizadas a 211 pares (OpenAI) e equivalentes

Entrada: `runs/R02/inventory_662.jsonl` (sha256 6b9a0e6ac36f7618072399f27df2e12619057eb3ebf5a56998285c71cad65e26), derivado dos `_calls.jsonl` do baseline H1 `7606bc9b`. Cada operacao sai em **exatamente um** passo (particao verificada por provedor). Gerado por `scripts/build_denominators.mjs`.

## Cadeia por provedor

| provedor | S0 linhas | S1 realizadas (http 200) | saem em S1 (recusas) | S2 com conferencia capturada | saem em S2 (not_produced) | S3 pares de calibracao | saem em S3 (cache + besu) | train / validation / holdout | grupos no holdout |
|---|---|---|---|---|---|---|---|---|---|
| openai | 221 | 219 | 2 | 215 | 4 | 211 | 3 + 1 | 120 / 53 / 38 | 13 |
| anthropic | 220 | 219 | 1 | 214 | 5 | 210 | 3 + 1 | 119 / 54 / 37 | 13 |
| gemini | 221 | 220 | 1 | 216 | 4 | 212 | 3 + 1 | 121 / 54 / 37 | 13 |

## Dois denominadores distintos (sem dupla contagem)

- **COLETA** (custo calculado, tokens declarados, `campaign_summary.json`): todas as **realizadas** (S1): 219 openai + 219 anthropic + 220 gemini = **658**. Inclui cache-probe, besu e as concluidas sem conferencia.
- **CALIBRACAO** (perfis, metricas, RESULTADOS_CALIBRACAO.md): so os **pares** (S3): 211 + 210 + 212 = **633**. Exclui, nesta ordem, recusas (S1), concluidas sem comparacao de input capturada (S2), cache-probe e besu (S3).
- Uma operacao conta em um unico passo; as 4 recusas nao estao em nenhum dos dois denominadores (nem custo nem calibracao: ledger `refused`, costUsd 0).

## openai: 221 linhas -> 219 realizadas (-2 recusas) -> 215 com conferencia capturada (-4 not_produced) -> 211 pares (-3 cache, -1 besu) = 120/53/38

- **S0 -> S1** (saem 2): `cal-json-005-v1` http 429 (train, json; SIM (repeticao concluida)) [docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-10/pv3-openai-live-campaign-2026-10-07t04-48-20-564_calls.jsonl:88]; `cal-mixed_unicode-000-v1` http 400 (train, mixed_unicode; NAO (texto perdido para este provedor)) [docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-97/pv3-openai-live-campaign-2026-10-07t05-01-19-314_calls.jsonl:40].
- **S1 -> S2** (saem 4; estado da conferencia nas realizadas: compared/within_threshold=215, not_produced/=4): `cal-code_ts-000-v0` (holdout, code_ts; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-10/pv3-openai-live-campaign-2026-10-07t04-48-20-564_calls.jsonl:45]; `cal-numeric-008-v0` (train, numeric; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-137/pv3-openai-live-campaign-2026-10-07t05-09-06-868_calls.jsonl:50]; `cal-tiny-007-v0` (train, tiny; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-137/pv3-openai-live-campaign-2026-10-07t05-09-06-868_calls.jsonl:74]; `cal-markdown_table-008-v2` (validation, markdown_table; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/openai/campaign_start-index-97/pv3-openai-live-campaign-2026-10-07t05-01-19-314_calls.jsonl:38]. Nestas o registro tem usage declarado mas `conference.comparisons` vazio: sem contagem local, nao ha par. O motivo tecnico da nao-producao nao consta dos registros nem dos logs exportados.
- **S2 -> S3** (saem 4): cache-probe `cache-1 (cacheProbe=1, declared_input=3396, cache_read=0)`, `cache-2 (cacheProbe=2, declared_input=3396, cache_read=3328)`, `cache-3 (cacheProbe=3, declared_input=3396, cache_read=3328)`; besu `besu (declared_input=16, local=9)`. Tem contagem local e declarada (estao na coleta), mas nao sao amostras do corpus (sem `meta.group`/taskType calibration-sample): o escopo do perfil exclui "cache-probe repeats".
- **S3 -> splits**: train=120, validation=53, holdout=38 (regra sha256(`otk.calibration_corpus.synthetic.v1:<grupo>`) mod 100: <60 train, <80 validation, senao holdout; `meta.split=test` e o holdout). Por familia: pt_prose=27, en_prose=27, code_ts=26, json=27, markdown_table=26, mixed_unicode=26, numeric=26, tiny=26.

## anthropic: 220 linhas -> 219 realizadas (-1 recusas) -> 214 com conferencia capturada (-5 not_produced) -> 210 pares (-3 cache, -1 besu) = 119/54/37

- **S0 -> S1** (saem 1): `cal-en_prose-000-v0` http 429 (validation, en_prose; SIM (repeticao concluida)) [docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign/pv3-live-campaign-2026-10-07t04-57-14-774_calls.jsonl:28].
- **S1 -> S2** (saem 5; estado da conferencia nas realizadas: incomplete/not_applicable=214, not_produced/=5): `cal-en_prose-001-v0` (train, en_prose; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:4]; `cal-code_ts-006-v2` (train, code_ts; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:48]; `cal-json-000-v0` (holdout, json; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:55]; `cal-markdown_table-002-v1` (train, markdown_table; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:89]; `cal-numeric-005-v1` (holdout, numeric; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/anthropic/campaign_start-index-27/pv3-live-campaign-2026-10-07t05-11-27-123_calls.jsonl:151]. Nestas o registro tem usage declarado mas `conference.comparisons` vazio: sem contagem local, nao ha par. O motivo tecnico da nao-producao nao consta dos registros nem dos logs exportados.
- **S2 -> S3** (saem 4): cache-probe `cache-1 (cacheProbe=1, declared_input=4521, cache_read=0)`, `cache-2 (cacheProbe=2, declared_input=4521, cache_read=0)`, `cache-3 (cacheProbe=3, declared_input=4521, cache_read=0)`; besu `besu (declared_input=16, local=9)`. Tem contagem local e declarada (estao na coleta), mas nao sao amostras do corpus (sem `meta.group`/taskType calibration-sample): o escopo do perfil exclui "cache-probe repeats".
- **S3 -> splits**: train=119, validation=54, holdout=37 (regra sha256(`otk.calibration_corpus.synthetic.v1:<grupo>`) mod 100: <60 train, <80 validation, senao holdout; `meta.split=test` e o holdout). Por familia: pt_prose=27, en_prose=26, code_ts=26, json=26, markdown_table=26, mixed_unicode=26, numeric=26, tiny=27.
- **Antes de S0**: textos do corpus nunca enviados a este provedor: `mixed_unicode-000-v1` (por isso S0 = 220).

## gemini: 221 linhas -> 220 realizadas (-1 recusas) -> 216 com conferencia capturada (-4 not_produced) -> 212 pares (-3 cache, -1 besu) = 121/54/37

- **S0 -> S1** (saem 1): `cal-code_ts-004-v0` http 429 (validation, code_ts; SIM (repeticao concluida)) [docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign/pv3-gemini35-live-campaign-2026-10-07t04-52-52-082_calls.jsonl:67].
- **S1 -> S2** (saem 4; estado da conferencia nas realizadas: incomplete/not_applicable=216, not_produced/=4): `cal-json-008-v2` (train, json; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign_start-index-66/pv3-gemini35-live-campaign-2026-10-07t05-03-44-975_calls.jsonl:42]; `cal-markdown_table-005-v2` (train, markdown_table; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign_start-index-66/pv3-gemini35-live-campaign-2026-10-07t05-03-44-975_calls.jsonl:60]; `cal-pt_prose-001-v2` (holdout, pt_prose; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign/pv3-gemini35-live-campaign-2026-10-07t04-52-52-082_calls.jsonl:6]; `cal-code_ts-003-v1` (holdout, code_ts; conference.state=not_produced) [docs/_ops/OVERNIGHT2_20261006/campaign/gemini35/campaign/pv3-gemini35-live-campaign-2026-10-07t04-52-52-082_calls.jsonl:65]. Nestas o registro tem usage declarado mas `conference.comparisons` vazio: sem contagem local, nao ha par. O motivo tecnico da nao-producao nao consta dos registros nem dos logs exportados.
- **S2 -> S3** (saem 4): cache-probe `cache-1 (cacheProbe=1, declared_input=4228, cache_read=)`, `cache-2 (cacheProbe=2, declared_input=4228, cache_read=2032)`, `cache-3 (cacheProbe=3, declared_input=4228, cache_read=2032)`; besu `besu (declared_input=10, local=9)`. Tem contagem local e declarada (estao na coleta), mas nao sao amostras do corpus (sem `meta.group`/taskType calibration-sample): o escopo do perfil exclui "cache-probe repeats".
- **S3 -> splits**: train=121, validation=54, holdout=37 (regra sha256(`otk.calibration_corpus.synthetic.v1:<grupo>`) mod 100: <60 train, <80 validation, senao holdout; `meta.split=test` e o holdout). Por familia: pt_prose=26, en_prose=27, code_ts=26, json=26, markdown_table=26, mixed_unicode=27, numeric=27, tiny=27.

## Split x familia (pares)

### openai

| split | pt_prose | en_prose | code_ts | json | markdown_table | mixed_unicode | numeric | tiny | total |
|---|---|---|---|---|---|---|---|---|---|
| train | 15 | 12 | 9 | 15 | 18 | 17 | 14 | 20 | 120 |
| validation | 9 | 6 | 9 | 6 | 8 | 6 | 6 | 3 | 53 |
| holdout | 3 | 9 | 8 | 6 | 0 | 3 | 6 | 3 | 38 |

### anthropic

| split | pt_prose | en_prose | code_ts | json | markdown_table | mixed_unicode | numeric | tiny | total |
|---|---|---|---|---|---|---|---|---|---|
| train | 15 | 11 | 8 | 15 | 17 | 17 | 15 | 21 | 119 |
| validation | 9 | 6 | 9 | 6 | 9 | 6 | 6 | 3 | 54 |
| holdout | 3 | 9 | 9 | 5 | 0 | 3 | 5 | 3 | 37 |

### gemini

| split | pt_prose | en_prose | code_ts | json | markdown_table | mixed_unicode | numeric | tiny | total |
|---|---|---|---|---|---|---|---|---|---|
| train | 15 | 12 | 9 | 14 | 17 | 18 | 15 | 21 | 121 |
| validation | 9 | 6 | 9 | 6 | 9 | 6 | 6 | 3 | 54 |
| holdout | 2 | 9 | 8 | 6 | 0 | 3 | 6 | 3 | 37 |

## mixed_unicode-000-v1 (exclusao pre-declarada)

- **openai**: enviado, recusado http 400 invalid_json (S1), nunca repetido: texto ausente para a OpenAI
- **anthropic**: NUNCA enviado (ausente de todos os _calls.jsonl da Anthropic): a exclusao pre-declarada foi aplicada antes do envio (F-OVN2-08, RESULTADOS_CALIBRACAO.md); por isso a Anthropic tem 220 linhas e nao 221
- **gemini**: enviado e concluido (http 200): entra na coleta e nos pares da Gemini

## Verificacao

- particao por provedor: openai=true, anthropic=true, gemini=true; total de linhas 662, realizadas 658, pares 633, excluidas nominais 29 (29 esperadas).
- lista nominal completa das excluidas, com passo e motivo: `excluded_nominal.csv`.

