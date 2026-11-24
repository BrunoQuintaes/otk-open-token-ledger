# Campanha real da OVERNIGHT 2 (Fase 6): resumo

Janela: 07/10/2026, 04:47:08 a 05:17:45 UTC (`JANELA_UTC.md`). Código: `5f4c357` a `b42d05c` (executor e wrapper
commitados; cada manifesto registra commit, árvore e se havia alteração). Corpus: semente 20261007, sha256
`043b2561b898a375aad62d13be0c4822ccddd2b2d2c94738fdb97462885353e6`. Teto: razão canônico cumulativo de US$ 3 por provedor.

## Chamadas e custo (só desta execução)

| Provedor / modelo devolvido | Chamadas consistentes | Recusadas antes de haver uso | Custo calculado (tabela pública congelada; não é fatura) |
|---|---|---|---|
| Anthropic / claude-haiku-4-5-20251001 | 219 | 1 (cota do OTK) | US$ 0.096972 |
| Google / gemini-3.5-flash-lite | 220 | 1 (cota do OTK) | US$ 0.03047822 |
| OpenAI / gpt-4o-mini-2024-07-18 | 219 | 2 (cota do OTK; 400 invalid_json, F-OVN2-08) | US$ 0.01105065 |
| **Total** | **658** | 4, custo 0 | **US$ 0.13850087** |

Por provedor: 216 textos da campanha (OpenAI e Anthropic sem o texto excluído por F-OVN2-08; o Gemini o aceitou),
3 da sondagem de cache e 1 chamada com registro na Besu. Razões ao fim: 0 reservas abertas, 0 incertas.

## Quantidades observadas (categorias canônicas disjuntas, somadas)

| Modelo | input_uncached | input_cache_read | input_cache_write | output_visible | output_reasoning |
|---|---|---|---|---|---|
| Haiku 4.5 | 70997 | 0 | 0 | 5195 | 0 |
| Gemini 3.5 Flash-Lite | 67746 | 4064 | 0 | 4013 | 0 |
| gpt-4o-mini | 51259 | 6656 | 0 | 4771 | 0 |

Cache observado no real: OpenAI (automático) e Gemini (implícito); nada na Anthropic (o proxy não usa cache explícito).
Raciocínio relatado: 0 no Gemini 3.5 com `thinkingLevel: minimal`.

## CU de referência CANDIDATA (perfil 2026-10; normalização NÃO escolhida)

| Modelo | Referência: entrada não cacheada do gpt-4o-mini | Referência abstrata: US$ 1/MTok | CU legada de desenvolvimento (recibos) |
|---|---|---|---|
| Haiku 4.5 | 646480.000000000 | 96972.000000000 | 67048.96 |
| Gemini 3.5 Flash-Lite | 203188.133333333 | 30478.220000000 | 40944.42 |
| gpt-4o-mini | 73671.000000000 | 11050.650000000 | 25074.4 |

Leitura:
1. As duas colunas candidatas diferem só pela escala (fator 20/3 entre elas, em todos os modelos).
2. Na referência abstrata de US$ 1/MTok a CU coincide numericamente com o custo em micro-dólares (por exemplo, Haiku
   96 972 CU e US$ 0,096972), porque em outubro o preço corrente ainda é o preço-base. Num período posterior com preço
   diferente, os dois números se separam. Essa coincidência é um argumento contra essa opção (convida a ler CU como
   dinheiro) e entra na decisão DN-01.
3. A CU legada usava pesos sem derivação (0,88 por token no Haiku, 0,54 no Gemini, 0,4 no gpt-4o-mini) e não separa
   categorias: ela põe a saída e o cache no mesmo peso da entrada.

Arquivos: `calibration/campaign_ops.jsonl` (uma linha por operação), `calibration/campaign_summary.json`.
