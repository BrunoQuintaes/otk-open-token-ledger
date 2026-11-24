# CAL-ANTH — verificação independente da calibração Anthropic (CAL-ANTH-01 e CAL-ANTH-02)

**Rótulo: VERIFICAÇÃO INDEPENDENTE (suplementar). Separada da H1 (`../H1/`) e da H2 (`../H2/`); nada aqui é evidência da campanha H1.**

Origem dos dados: dois commits do repositório da H1 — CAL-ANTH-01 `b55c34298fa7e24ec936396117ce1c7e58f61805` e CAL-ANTH-02
`4120a7571f115eb02cc2cff09270a9ffe07265ae`. Os 13 arquivos de entrada em `inputs/` são **cópias byte-idênticas** desses commits (já eram sanitizados na origem).

## Comando de reprodução (offline)

```bash
node CAL-ANTH/scripts/reproduce_cal_anth.mjs --out <pasta-vazia-ou-inexistente>
```

Roda `scripts/recompute_cal_anth.mjs` — reimplementação **independente** das regras pré-registradas (regra de alerta, predição afim em
micro-inteiros, grade de limiar sobre a validação, bootstrap dos grupos do holdout com `mulberry32(20261014)`), **sem** usar o analisador original —
e compara com `expected/RECOMPUTE_RESULTS.json` (exceto data e caminhos de entrada; os mesmos 13 sha256 de entrada devem ser lidos).
Também confere o item 20 (abaixo). Exit 0 = tudo bateu.

## Resultado da verificação

`CAL_ANTH_VERIFICATION_REPORT.md` confere 20 números do relatório da CAL-ANTH:
**19 de 20 REPRODUZIDO** e **1 DIFERENTE POR DEFINIÇÃO** (item 20, escopo do custo por modelo — não é erro; vide `NOTA_ITEM_20_CUSTO_POR_MODELO.md`).
Nenhum número foi NÃO REPRODUTÍVEL.

## Conteúdo

- `CAL_ANTH_VERIFICATION_REPORT.md` — relatório item a item (número do relatório × recálculo independente × veredito).
- `inputs/cal01`, `inputs/cal02` — entradas mínimas (resultados de chamadas sanitizados, razão de custo, snapshot de preços, corpora, rótulos, modelo congelado, registro da avaliação de holdout).
- `protocol/` — protocolos pré-registrados e aditivo/esclarecimentos (texto sanitizado: o nome do autor virou "o autor").
- `expected/RECOMPUTE_RESULTS.json` — saída de referência do recálculo.

## O que esta pasta PROVA

- Que os números citados no relatório da CAL-ANTH (contagens, ajuste afim, limiares, métricas do holdout, ICs por bootstrap, aceite por modelo, erro por família,
  `count_tokens` × uso final) saem dos arquivos brutos por código independente.

## O que esta pasta NÃO prova

- **Custo calculado ≠ fatura:** o custo vem da tabela de preços congelada em `MODEL_PRICE_SNAPSHOT.json`, não de fatura do provedor.
- Não valida o estimador fora dos modelos, snapshots e corpus sintético da CAL-ANTH, nem generaliza para OpenAI/Google ou para a H2.
- "Independente" significa outro código sobre os mesmos dados brutos; não é auditoria externa.
