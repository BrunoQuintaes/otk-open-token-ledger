# Lado OTK real dos pilotos (cópias somente leitura)

Estes três arquivos são cópias byte a byte dos ledgers de orçamento dos pilotos reais de 03 e 04/10/2026.
Eles são o lado OTK da conciliação: o que o OTK (o executor do piloto) mediu e calculou.
Não são exportações dos provedores e não são faturas.

| Arquivo | Origem (somente leitura) | sha256 |
|---|---|---|
| real_otk_pilot_v3_anthropic_ledger_20261003.jsonl | <HOME>/otk-exec-D1D8-20260930-1625/integ/docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/PILOTO_V3/live/ledger_canonico_copia_20261003.jsonl | 87884e022dd2a7612ac2a8af6dd0b1c362940be74c081e814f7e2fc221198ecf |
| real_otk_pilot_v3_openai_ledger_20261003.jsonl | .../PILOTO_V3/live_openai/ledger_canonico_openai_copia_20261003.jsonl | c80ce7a916dda427fe53ac0ffcdf43d3492f67e13e25dfd5c6e84d720d8cad0e |
| real_otk_pilot_v3_gemini_ledger_20261004.jsonl | .../PILOTO_V3/live_gemini35/ledger_canonico_gemini_copia_20261004.jsonl | f981b2bf1944af3cfafa99debe90ba504093ee97c210baaaaea194710790af3d |

Tabelas de preço congeladas nas operações (checagem `price_table_frozen_in_operation` dos arquivos `*_calls.jsonl` da mesma pasta de origem):

- Anthropic: `anthropic-haiku45-official-2026-10-01` (scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json)
- OpenAI: `pilot-v3-anthropic-haiku45-openai-gpt4omini-official-2026-10-03` (scripts/pilot/price_table_pilot_v3_20261003.json)
- Gemini: `pilot-v3-anthropic-haiku45-openai-gpt4omini-gemini25fl-gemini35fl-official-2026-10-04` (scripts/pilot/price_table_pilot_v3_gemini35_20261004.json)

O ledger Gemini contém também a reserva recusada do Gemini 2.5 (HTTP 404, custo 0), que o carregador exclui com motivo.
O campo `costUsd` foi gravado pelo executor como número JavaScript; o carregador lê o texto exato e arredonda para pico-USD (meio para o par), registrando quando houve arredondamento.
