# OTK-CAL-ANTH-01: Emenda 1 ao protocolo (antes de qualquer chamada paga)

Registrada **antes da primeira chamada paga**. O pré-registro original (`d30daf37`, `PROTOCOL_PREREGISTERED.md`) fica
intacto. Esta emenda muda **somente controles financeiros e de autorização**; nenhuma escolha científica (corpus, semente,
divisão, modelos, requisição, alvo, preditor, exclusões, análise, política de aceitação, holdout) foi alterada.
Motivo: endurecimento pedido pelo autor na continuação autorizada (seção 3), antes da coleta.

| # | Mudança | Onde |
|---|---|---|
| A1.1 | Liquidação **acima** da reserva: registrada com o valor real (`overrun: true`, gasto nunca escondido) e **bloqueia** toda reserva seguinte (`overrun_block`) até revisão humana; o coletor para | `budget.ts`, `collect.ts` |
| A1.2 | Reserva deixada aberta por processo interrompido: liquidada como **incerta** pelo valor inteiro (`settleInterrupted`), linha `interrupted_process` em `CALL_RESULTS_SANITIZED.jsonl`, documento **não** repetido | `budget.ts`, `collect.ts` |
| A1.3 | Portão de chamadas pagas valida o conteúdo de `PAID_CALLS_AUTHORIZED.json` (campanha, branch, baseline, pré-registro, US$ 10 e US$ 8, confirmação humana item por item, ressalva de que a impressão digital da chave não prova vínculo ao workspace) e o estado do git (branch atual; baseline e pré-registro ancestrais do HEAD) | `authorization.ts`, `collect.ts`, `e2e.ts` |
| A1.4 | O ponta a ponta (CAL-5) passa pelo **mesmo** razão do experimento: reserva por fase antes (minimal US$ 0,26; sample US$ 1,04), liquidação pelo delta do razão canônico do piloto (qualquer incerto novo = incerto pelo valor inteiro), chave só no ambiente do processo filho, com lista fechada de variáveis | `e2e.ts` |
| A1.5 | Testes negativos: liquidação acima da reserva, reserva interrompida, retomada após interrupção, autorização inválida (7 variantes); orçamento insuficiente já coberto | `test/unit/cal_anth_01_offline.test.ts` (14/14) |

Total de chamadas, teto (US$ 10), alvo de admissão (US$ 8) e pior caso planejado (cerca de US$ 3,1) inalterados.
