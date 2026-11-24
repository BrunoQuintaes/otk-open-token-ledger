# Resultados da calibração do contador local (Fase 7)

Protocolo seguido sem alteração: `07_CALIBRATION_PROTOCOL.md` (commitado em `950199a`, antes de qualquer dado real).
Ajuste e checagens: `scripts/calibration/fitProfile.ts` e política `otk.calibration_acceptance.v1`, ambos sem mudança.
O holdout foi avaliado uma vez. Nenhum limiar, divisão, corpus ou exclusão mudou depois de ver os dados. A única
exclusão é o texto `mixed_unicode-000-v1`, que a OpenAI recusou sem uso final (regra de exclusão pré-declarada; a
Anthropic não o recebeu, porque a mesma exclusão foi aplicada aos dois por motivo achado offline, F-OVN2-08).

| Modelo (contador local) | Pares treino / validação / holdout (grupos no holdout) | Ajuste no treino | Holdout: viés, MAE, máximo | Falso alerta no holdout | Detecção de +25% | **calibrated** |
|---|---|---|---|---|---|---|
| gpt-4o-mini-2024-07-18 (o200k_base, exato) | 120 / 53 / 38 (13) | provedor = 1,000000 × local + 7 | 0, 0, 0 | 0 | 100% | **true** |
| claude-haiku-4-5-20251001 (cl100k_base, aproximação) | 119 / 54 / 37 (13) | 1,165964 × local + 4,10 | +6,0; 13,8; 54 | **5,4%** (2 de 37; limite 5%) | 78% | **false** |
| gemini-3.5-flash-lite (cl100k_base, aproximação) | 121 / 54 / 37 (13) | 1,252777 × local − 6,10 | −0,2; 58,1; 285 | 0 | **8%** (exigido 50%) | **false** |

## Leitura em linguagem simples

- **gpt-4o-mini:** a contagem local usa o mesmo tokenizador da OpenAI. Em todas as 211 chamadas válidas o provedor
  contou exatamente 7 tokens a mais (o "envelope" de uma mensagem). Com esse ajuste, o contador acerta 100% no
  holdout e detecta qualquer inflação. Escopo: uma mensagem de usuário, sem system, sem ferramentas, este snapshot.
- **Haiku 4.5:** não existe tokenizador local oficial da Anthropic; o OTK usa uma aproximação. A correção afim reduz
  o erro, mas 2 dos 37 textos do holdout ainda gerariam alerta falso (5,4% contra o limite de 5%). Pela regra, fica
  não calibrado. Mudar o limite agora seria ajustar a régua depois de ver o resultado.
- **Gemini 3.5:** a aproximação é ruim para este modelo (erro relativo mediano de 18%, p95 de 75%, maior em unicode e
  código). Para não dar alarme falso, o limiar escolhido na validação ficou tão largo que quase não detecta inflação.
  Fica não calibrado.

## No runtime

`probes/p7_calibration_load.mts`: o carregador real do runtime (`loadCalibrationProfilesFromDir`) lê os três perfis.
gpt-4o-mini-2024-07-18 → COMPATIBLE; Haiku e Gemini → NOT_CALIBRATED (continuam com `HEURISTIC_THRESHOLD_V0`). Para
o alias `gpt-4o-mini` o estado é ABSENT, porque o perfil vale para o snapshot medido e não declara aliases (não foram
acrescentados depois de ver os dados). Ligar perfis num ambiente (`OTK_CALIBRATION_PROFILES_DIR`) é decisão de
implantação, não feita aqui.

## O que isto não mostra

- Que o provedor contou certo: o alvo é o próprio número do provedor (circularidade).
- Comportamento com system, várias mensagens, ferramentas, imagens ou outros snapshots.
- Estabilidade no tempo (uma campanha de 30 minutos).
