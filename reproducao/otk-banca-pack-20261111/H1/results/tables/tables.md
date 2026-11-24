# R05 - Tabelas recomputadas (parametros e limiares congelados dos perfis H1)

Estimadores: **RAW** = contagem local crua com o limiar heuristico v0 (16 tokens, 10%); **CALIBRADO** = afim congelado do perfil com o limiar congelado do perfil. Alvo sempre = **DECLARADO** pelo provedor. RMSE e metrica nova (nao existe no original). Quantis de erro relativo: nearest-rank, `--` quando n < 1/(1-q).

## Tabela 1 - Por modelo e split (todas as familias)

| modelo | split | estimador | n | grupos | vies | MAE | RMSE (novo) | max | p50 rel | p90 rel | p95 rel | p99 rel | falso alerta | det +10% | det +25% | det +50 tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gpt-4o-mini-2024-07-18 | train | RAW | 120 | 41 | -7 | 7 | 7 | 7 | 0.040 | 0.368 | 0.368 | 0.368 | 0.0% | 63.3% | 80.8% | 95.0% |
| gpt-4o-mini-2024-07-18 | train | CALIBRADO | 120 | 41 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 100.0% | 100.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | validation | RAW | 53 | 18 | -7 | 7 | 7 | 7 | 0.035 | 0.115 | 0.368 | -- | 0.0% | 77.4% | 94.3% | 100.0% |
| gpt-4o-mini-2024-07-18 | validation | CALIBRADO | 53 | 18 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | -- | 0.0% | 100.0% | 100.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | holdout | RAW | 38 | 13 | -7 | 7 | 7 | 7 | 0.028 | 0.097 | 0.350 | -- | 0.0% | 78.9% | 92.1% | 92.1% |
| gpt-4o-mini-2024-07-18 | holdout | CALIBRADO | 38 | 13 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | -- | 0.0% | 100.0% | 100.0% | 100.0% |
| claude-haiku-4-5-20251001 | train | RAW | 119 | 41 | -39.403 | 39.403 | 52.395 | 128 | 0.188 | 0.458 | 0.458 | 0.462 | 55.5% | 79.8% | 96.6% | 100.0% |
| claude-haiku-4-5-20251001 | train | CALIBRADO | 119 | 41 | 0.025 | 13.101 | 18.064 | 46 | 0.064 | 0.208 | 0.208 | 0.231 | 2.5% | 27.7% | 84.9% | 59.7% |
| claude-haiku-4-5-20251001 | validation | RAW | 54 | 18 | -46.630 | 46.630 | 57.146 | 113 | 0.178 | 0.229 | 0.458 | -- | 66.7% | 94.4% | 100.0% | 100.0% |
| claude-haiku-4-5-20251001 | validation | CALIBRADO | 54 | 18 | -1.907 | 14.167 | 18.565 | 51 | 0.053 | 0.139 | 0.208 | -- | 0.0% | 33.3% | 77.8% | 55.6% |
| claude-haiku-4-5-20251001 | holdout | RAW | 37 | 13 | -36.757 | 36.757 | 47.405 | 113 | 0.142 | 0.200 | 0.423 | -- | 45.9% | 91.9% | 97.3% | 100.0% |
| claude-haiku-4-5-20251001 | holdout | CALIBRADO | 37 | 13 | 6.027 | 13.811 | 18.340 | 54 | 0.052 | 0.143 | 0.167 | -- | 5.4% | 5.4% | 78.4% | 56.8% |
| gemini-3.5-flash-lite | train | RAW | 121 | 41 | -47.017 | 62.273 | 101.073 | 326 | 0.175 | 0.471 | 0.492 | 0.547 | 61.2% | 61.2% | 58.7% | 85.1% |
| gemini-3.5-flash-lite | train | CALIBRADO | 121 | 41 | -0.050 | 48.099 | 77.679 | 264 | 0.286 | 0.443 | 0.682 | 0.763 | 2.5% | 5.0% | 9.9% | 5.0% |
| gemini-3.5-flash-lite | validation | RAW | 54 | 18 | -45.704 | 75.074 | 122.334 | 405 | 0.169 | 0.535 | 0.537 | -- | 61.1% | 66.7% | 72.2% | 72.2% |
| gemini-3.5-flash-lite | validation | CALIBRADO | 54 | 18 | 10.185 | 73.889 | 115.431 | 323 | 0.188 | 0.604 | 0.626 | -- | 0.0% | 11.1% | 11.1% | 11.1% |
| gemini-3.5-flash-lite | holdout | RAW | 37 | 13 | -55.378 | 74.189 | 125.648 | 371 | 0.171 | 0.496 | 0.503 | -- | 67.6% | 78.4% | 86.5% | 94.6% |
| gemini-3.5-flash-lite | holdout | CALIBRADO | 37 | 13 | -0.189 | 58.135 | 100.250 | 285 | 0.185 | 0.412 | 0.749 | -- | 0.0% | 8.1% | 8.1% | 0.0% |

## Tabela 2 - Por modelo e familia (todos os pares; estimador CALIBRADO)

| modelo | familia | n | vies | MAE | RMSE (novo) | max | p50 rel | p90 rel | falso alerta | det +25% |
|---|---|---|---|---|---|---|---|---|---|---|
| gpt-4o-mini-2024-07-18 | pt_prose | 27 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | en_prose | 27 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | code_ts | 26 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | json | 27 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | markdown_table | 26 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | mixed_unicode | 26 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | numeric | 26 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | tiny | 26 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | pt_prose | 27 | -13.074 | 13.074 | 14.866 | 25 | 0.034 | 0.046 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | en_prose | 26 | 20.115 | 20.115 | 22.006 | 35 | 0.088 | 0.099 | 0.0% | 30.8% |
| claude-haiku-4-5-20251001 | code_ts | 26 | -8.423 | 8.423 | 9.192 | 15 | 0.035 | 0.063 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | json | 26 | 4.885 | 4.885 | 7.593 | 20 | 0.006 | 0.044 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | markdown_table | 26 | -16.654 | 16.962 | 23.018 | 46 | 0.048 | 0.074 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | mixed_unicode | 26 | -4.885 | 11.654 | 13.611 | 24 | 0.060 | 0.173 | 11.5% | 100.0% |
| claude-haiku-4-5-20251001 | numeric | 26 | 28.346 | 28.346 | 33.040 | 54 | 0.131 | 0.142 | 7.7% | 23.1% |
| claude-haiku-4-5-20251001 | tiny | 27 | -4.889 | 4.889 | 4.929 | 6 | 0.208 | 0.240 | 0.0% | 100.0% |
| gemini-3.5-flash-lite | pt_prose | 26 | 114.692 | 114.692 | 126.982 | 197 | 0.390 | 0.438 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | en_prose | 27 | 43.481 | 43.481 | 46.611 | 68 | 0.190 | 0.205 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | code_ts | 26 | 1.538 | 3.385 | 4.306 | 9 | 0.019 | 0.022 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | json | 26 | -9.231 | 12.462 | 13.324 | 22 | 0.021 | 0.030 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | markdown_table | 26 | -15.385 | 17.846 | 24.701 | 48 | 0.063 | 0.103 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | mixed_unicode | 27 | 72.185 | 72.630 | 87.825 | 161 | 0.662 | 0.763 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | numeric | 27 | -179.889 | 179.889 | 203.114 | 323 | 0.387 | 0.439 | 11.1% | 77.8% |
| gemini-3.5-flash-lite | tiny | 27 | -4.111 | 4.111 | 4.141 | 5 | 0.286 | 0.333 | 0.0% | 0.0% |

## Tabela 3 - Holdout por familia (estimador CALIBRADO; `markdown_table` nao tem pares no holdout)

| modelo | familia | n | vies | MAE | max | falso alerta | det +25% |
|---|---|---|---|---|---|---|---|
| gpt-4o-mini-2024-07-18 | pt_prose | 3 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | en_prose | 9 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | code_ts | 8 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | json | 6 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | markdown_table | 0 | -- | -- | -- | -- | -- |
| gpt-4o-mini-2024-07-18 | mixed_unicode | 3 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | numeric | 6 | 0 | 0 | 0 | 0.0% | 100.0% |
| gpt-4o-mini-2024-07-18 | tiny | 3 | 0 | 0 | 0 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | pt_prose | 3 | -14 | 14 | 14 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | en_prose | 9 | 16.556 | 16.556 | 27 | 0.0% | 33.3% |
| claude-haiku-4-5-20251001 | code_ts | 9 | -9.889 | 9.889 | 15 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | json | 5 | 5.600 | 5.600 | 7 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | markdown_table | 0 | -- | -- | -- | -- | -- |
| claude-haiku-4-5-20251001 | mixed_unicode | 3 | 23.333 | 23.333 | 24 | 0.0% | 100.0% |
| claude-haiku-4-5-20251001 | numeric | 5 | 24 | 24 | 54 | 40.0% | 60.0% |
| claude-haiku-4-5-20251001 | tiny | 3 | -4.333 | 4.333 | 5 | 0.0% | 100.0% |
| gemini-3.5-flash-lite | pt_prose | 2 | 118 | 118 | 118 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | en_prose | 9 | 34.333 | 34.333 | 57 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | code_ts | 8 | 3.375 | 4.125 | 6 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | json | 6 | -5.500 | 10.167 | 16 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | markdown_table | 0 | -- | -- | -- | -- | -- |
| gemini-3.5-flash-lite | mixed_unicode | 3 | 161 | 161 | 161 | 0.0% | 0.0% |
| gemini-3.5-flash-lite | numeric | 6 | -169.333 | 169.333 | 285 | 0.0% | 50.0% |
| gemini-3.5-flash-lite | tiny | 3 | -4.333 | 4.333 | 5 | 0.0% | 0.0% |

## Tabela 4 - Comparacao com o original (perfis H1 e RESULTADOS_CALIBRACAO.md)

| modelo | train | validation | holdout | falso alerta holdout | det +25% holdout | derivacao do limiar (validacao) | parametros (verif.) | limiar (verif.) | calibrated |
|---|---|---|---|---|---|---|---|---|---|
| gpt-4o-mini-2024-07-18 | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | true -> true |
| claude-haiku-4-5-20251001 | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | false -> false |
| gemini-3.5-flash-lite | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | REPRODUZIDO | false -> false |

## Tabela 5 - RESULTADOS_CALIBRACAO.md x recomputado

| modelo | pares (md) | pares (rec.) | holdout vies; MAE; max (md) | (rec.) | falso alerta (md) | (rec.) | det +25% (md) | (rec.) | calibrated (md) | (rec.) |
|---|---|---|---|---|---|---|---|---|---|---|
| gpt-4o-mini-2024-07-18 | 120 / 53 / 38 (13) | 120 / 53 / 38 (13) | 0, 0, 0 | 0; 0; 0 | 0 | 0 (0 de 38) | 100% | 100% | true | true |
| claude-haiku-4-5-20251001 | 119 / 54 / 37 (13) | 119 / 54 / 37 (13) | +6,0; 13,8; 54 | 6.027027; 13.810811; 54 | 5,4% (2 de 37) | 0.054054 (2 de 37) | 78% | 78% | false | false |
| gemini-3.5-flash-lite | 121 / 54 / 37 (13) | 121 / 54 / 37 (13) | -0,2; 58,1; 285 | -0.189189; 58.135135; 285 | 0 | 0 (0 de 37) | 8% | 8% | false | false |
