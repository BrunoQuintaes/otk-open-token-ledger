# OTK-CAL-ANTH-02: protocolo pré-registrado (estimador por tokenizador e holdout novo)

Commitado **antes de qualquer chamada paga** desta campanha; SHA em `PREREGISTRATION_SHA.txt`. Campanha nova, posterior a
M0/M1 e à CAL-ANTH-01; não reabre o H1 (baseline `7606bc9b` intocada). CU = quantidade normalizada de consumo de
serviços de IA; aqui se mede só a contagem de tokens de entrada.

## 1. Pergunta
O estimador M2 (núcleo compartilhado de regressão sobre características observáveis, com ajuste inteiro por modelo),
com o detector D1 e os limiares congelados abaixo, passa a política `otk.calibration_acceptance.v2.candidate` num
**holdout novo e inédito**, separadamente para `claude-haiku-5-5`, `claude-sonnet-5-5` e `claude-opus-5-5`?

## 2. O que foi decidido no desenvolvimento (sem gasto; `METHOD_COMPARISON.md`)
- Dados: CAL-ANTH-01 só treino e validação (645 linhas; holdout dela nunca carregado) + corpus v2 de desenvolvimento
  (720 textos × 3 modelos) com rótulos gratuitos de `count_tokens` (2160 chamadas, 0 erros). Total 2805 observações,
  312 grupos. Os rótulos vêm do provedor.
- Regra de seleção fixada antes dos resultados (`DEVELOPMENT_PLAN.md`, commit `933e45d4`): a combinação mais simples que
  passa no portão. Escolhida: **M2 + D1** (falso alerta de validação 0,86%, detecção de +25% de 77%, MAE fora da dobra
  14,1 contra 54,9 do M0).
- Congelado em `FROZEN_MODEL.json` e `CALIBRATION_PROFILES/` (schema `otk.calibration_profile.v2`, proposta).

## 3. Estimador e detector congelados
- **Características** (`otk.cal_anth_02.features.v1`, `FEATURE_SPECIFICATION.md`): contagens locais `cl100k_base` e
  `o200k_base`, bytes UTF-8, pontos de código, dígitos, sequências de dígitos, espaços, quebras de linha, pontuação,
  letras latinas acentuadas, CJK, outros alfabetos, emoji. Nenhuma usa o rótulo de família do corpus.
- **M2:** `round(max(0, núcleo·características + intercepto + ajuste[modelo]))`; ajuste aprendido no desenvolvimento:
  Haiku 5.5 = 0, Sonnet 5.5 = 0, Opus 5.5 = +2.
- **D1:** alerta se `|declarado − estimado| > 12` tokens **e** `|declarado − estimado| / declarado > 0,14` (mesmo limiar
  para os três modelos, escolhido nas predições fora da dobra com falso alerta ≤ 1%).
- **Fora da distribuição:** `ESTIMATE_UNCERTAIN` (sem veredito) se `cl100k > 2407`, fração não latina > 0,777 ou fração de
  dígitos > 0,851. Abstenção conta contra a detecção, nunca como falso alerta.

## 4. Holdout novo
- Gerador `otk.cal_anth_02.corpus.v2`, **semente 20261016**, namespace `cal2ho`, 8 famílias × 8 grupos × 3 textos =
  **192 textos, 64 grupos**. Nenhum texto igual a um do desenvolvimento ou da CAL-ANTH-01 (grupos que colidiam foram
  sorteados de novo; os curtíssimos do holdout tendem a mensagens de duas partes porque as de uma palavra estavam no
  desenvolvimento). Nenhum rótulo pedido antes deste pré-registro. Hashes: `HOLDOUT_MANIFEST.json`.
- Requisição idêntica à da CAL-ANTH-01 (mensagem de usuário de resumo, `max_tokens` 64, configuração fixa por modelo).
- 192 chamadas por modelo, 576 no total, mais 3 de smoke com um texto fixo do desenvolvimento (não do holdout).
- Fable 5.1 fora desta fase.

## 5. Alvo, exclusões e falhas
Alvo: `usage.input_tokens` final. Válida: HTTP 200 com uso; recusa com uso entra. Falhas, incertos e orçamento seguem
as regras da CAL-ANTH-01 (incerto nunca repetido; 429 e 529 até 3 tentativas; 5 falhas seguidas param). Modelo devolvido
diferente do pedido: observação excluída e contada.

## 6. Política `otk.calibration_acceptance.v2.candidate` (a v1 continua imutável)
Por modelo, separadamente:
- **OUT_OF_SCOPE:** modelo indisponível ou mais de 5% das respostas com outro modelo devolvido.
- **INCONCLUSIVE:** menos de 150 observações válidas, menos de 50 grupos ou abstenção acima de 10%.
- **EXPERIMENTALLY_CALIBRATED:** falso alerta no holdout ≤ 5% **e** detecção de +25% ≥ 50% (critério histórico comparável).
- **CALIBRATION_NOT_ACCEPTED:** dados suficientes e alguma das duas condições falha.
- **Suplemento de confiança** (relatado, não muda o status): IC 95% por bootstrap de 2000 reamostragens dos 64 grupos
  (semente 20261016); marca se o limite superior do falso alerta < 5% e o limite inferior da detecção > 50%.

## 7. Análise (código congelado: `scripts/experiments/cal_anth_02/analyze2.ts`)
Por modelo: MAE, viés, p95, erro relativo mediano, falso alerta, detecção de +10%, +25% e +50 tokens, abstenções; por
família; análise **integral** (com recusas, primária) e **sem recusas** (estratificada, secundária); `count_tokens` contra
uso final; M0 (`cl100k` afim reajustado no desenvolvimento) no mesmo holdout, só como comparação. Os três modelos usam os
mesmos textos: as comparações entre modelos são pareadas e não independentes. Holdout avaliado **uma vez**.

## 8. Orçamento e parada
Teto **US$ 2,00** (razão próprio, `COST_LEDGER.jsonl`; o gasto da CAL-ANTH-01 fica separado). Pior caso offline
US$ 1,81. Reserva por chamada = `ceil((count_tokens × 1,05 + 16) × preço de entrada mais caro) + ceil(64 × preço de
saída)`. Sequencial. Parar ao completar as 576 observações planejadas, ou se o razão recusar, ou em erro de credencial,
saldo ou integridade. Sobra não é gasta.

## 9. Portão humano
Antes de qualquer chamada paga: autorização expressa do autor para US$ 2; confirmação de que o consumo do mês no
workspace (a CAL-ANTH-01 gastou US$ 1,38 em 15/10) deixa pelo menos US$ 2 dentro do limite mensal; workspace correto;
recarga automática desligada. Registro em `PAID_CALLS_AUTHORIZED.json`, validado pelo coletor.
