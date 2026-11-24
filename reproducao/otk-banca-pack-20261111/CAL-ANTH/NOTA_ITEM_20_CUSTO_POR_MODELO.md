# Nota — item 20 da verificação: custo por modelo (diferença de ESCOPO, não erro)

**Veredito do item 20: DIFERENTE POR DEFINIÇÃO (documentado).** É o único dos 20 itens que não é "REPRODUZIDO"; os outros 19 são REPRODUZIDO.

Exemplo, Haiku 4.5 (`claude-haiku-4-5-20251001`), em micro-USD (µUSD), calculado pela tabela de preços congelada (não é fatura):

| onde aparece | valor | o que conta |
|---|---:|---|
| `inputs/cal01/…/RESULTS_PER_MODEL.json`, campo `operations.costMicroUsd` | **134.055** | só o estágio `core` (**288** chamadas) |
| tabela de custo do relatório da CAL-ANTH | **134.247** | `core` **mais** a chamada de `smoke` (**289** chamadas) |
| diferença | 192 | custo da 1 chamada de `smoke` |

Os dois números existem e estão corretos para o seu escopo. Quem citar custo por modelo deve dizer qual escopo usa (apenas `core`, ou `core` + `smoke`).
`scripts/reproduce_cal_anth.mjs` recalcula as duas somas a partir de `CALL_RESULTS_SANITIZED.jsonl` e confere 134.055 (288 chamadas) e 134.247 (289 chamadas).
