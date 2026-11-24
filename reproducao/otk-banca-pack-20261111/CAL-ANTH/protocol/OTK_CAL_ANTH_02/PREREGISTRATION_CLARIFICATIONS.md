# OTK-CAL-ANTH-02: esclarecimentos do pré-registro (antes de qualquer resultado do holdout)

Escrito antes de qualquer chamada paga e de qualquer resultado do holdout. **Não muda** o pré-registro `c5734dac`:
torna explícito o que já está no código congelado (`scripts/experiments/cal_anth_02/analyze2.ts` e `estimators.ts`) e
lista o único ponto que o pré-registro não define.

## 1. Integridade do congelamento (verificada em 15/10)
- Desde `c5734dac` só mudaram arquivos de checkpoint (`PREREGISTRATION_SHA.txt`, `NEXT_ACTION.md`, handoff).
- Recongelamento a partir dos mesmos dados de desenvolvimento, numa pasta separada: `FROZEN_MODEL.json`,
  `HOLDOUT_MANIFEST.json`, `holdout_corpus.jsonl` e os 3 perfis saem **idênticos byte a byte**.

## 2. Definições já fixadas no código congelado
| Item | Definição |
|---|---|
| Observação válida | linha do holdout (`stage = holdout`) com HTTP 200 e `usage.input_tokens`, inclusive recusa, e modelo devolvido igual ao pedido |
| n | número de observações válidas do modelo (inclui as abstenções) |
| Grupos | grupos de texto com pelo menos uma observação válida daquele modelo |
| Abstenção | estimativa fora do envelope (`ESTIMATE_UNCERTAIN`); sem veredito |
| Falso alerta | o detector D1 alerta sobre o número **declarado sem alteração**; taxa = alertas / n (abstenção nunca é falso alerta) |
| Inflação **simulada** | aplicada ao número declarado pela Anthropic, depois da coleta: +10% = `round(1,10·y)`, +25% = `round(1,25·y)`, +50 tokens = `y + 50`. Não é inflação real observada |
| Detecção | taxa = alertas sobre o declarado inflado / n (abstenção conta como não detectada) |
| Status | calculado na análise **integral** (com recusas); a análise sem recusas é secundária e não muda o status |
| Critério de aprovação | por modelo: falso alerta ≤ 5% e detecção de +25% ≥ 50%, com n ≥ 150, grupos ≥ 50 e abstenção ≤ 10%; senão INCONCLUSIVE; mais de 5% de modelo devolvido diferente = OUT_OF_SCOPE |
| Intervalos | bootstrap percentil de 2000 reamostragens dos grupos daquele modelo, semente 20261016; suplemento de confiança relatado, sem mudar o status |
| Três modelos | três avaliações separadas, cada uma com seu status; nenhum modelo é aprovado por compartilhar tokenizador. Os textos são os mesmos nos três (pareados): comparações entre modelos são descritivas |
| Comparação M0 | `cl100k` afim reajustado só no desenvolvimento, aplicado ao mesmo holdout, só descritivo |
| Validação e holdout | os números de validação (`METHOD_COMPARISON.md`) e os do holdout são relatados separadamente |

## 3. Risco conhecido, já coberto pelo plano
Na CAL-ANTH-01, em parte das recusas o uso final veio exatamente 22 tokens acima do `count_tokens`. Num texto curto, esses
+22 podem passar dos limiares (12 tokens e 14%) e gerar falso alerta na análise integral. Isso não muda nada: a integral
continua primária e a sem recusas fica como secundária, como já pré-registrado.

## 4. Ponto não definido no pré-registro: métrica agregada
O pré-registro define métricas e status **por modelo** e não define métrica agregada entre modelos. Pedido do autor
("por modelo e agregadas conforme o plano"): pelo plano não há agregado. Opção a decidir **antes** do holdout, sem efeito
no status: (a) nenhum agregado; (b) agregado descritivo empilhando os três modelos (n = soma; IC por bootstrap dos 64
grupos, reamostrando o grupo inteiro com as observações dos três modelos, para respeitar o pareamento).
