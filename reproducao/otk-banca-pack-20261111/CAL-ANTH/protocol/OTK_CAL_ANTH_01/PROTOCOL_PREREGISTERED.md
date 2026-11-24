# OTK-CAL-ANTH-01: protocolo pré-registrado (calibração do contador local contra a Anthropic)

Escrito e commitado **antes de qualquer chamada paga**. O SHA do commit fica em `PREREGISTRATION_SHA.txt`. Depois da
primeira chamada paga nada aqui muda; uma mudança vira protocolo v2, com os resultados da v1 publicados como estão.
Campanha **posterior** a M0/M1 (que ficam intocados). CU = quantidade normalizada de consumo de serviços de IA; esta
campanha não calcula CU (mede tokens de entrada).

## 1. Pergunta e hipóteses

**Pergunta primária.** Para cada modelo principal, o contador local do OTK (`otk.local_counter.b3@1`, aproximação
`cl100k_base`, montagem `otk.assembly.text_parts@1`, catálogo da baseline `7606bc9b`), corrigido por um ajuste afim
treinado só no treino, prevê o `input_tokens` final informado pela Anthropic bem o bastante para passar a política
`otk.calibration_acceptance.v1` **sem alteração** (falso alerta no holdout até 5%; detecção de +25% de pelo menos 50%;
n mínimos)?

**Hipóteses secundárias (descritivas, sem decisão automática):**
- H2: os modelos com tokenizador novo (Haiku 5.5; Sonnet 5.5, Opus 5.5 e Fable 5.1 com o tokenizador do Opus 4.7+)
  têm razão alvo/local maior que o Haiku 4.5 (a documentação fala em cerca de 1,0 a 1,35x; Haiku 5.5 cerca de 30% a mais).
- H3: o `count_tokens` da Anthropic coincide com o `input_tokens` final na maioria das chamadas (consistência da API;
  não é verificação independente).
- H4: o erro do contador local depende da família de texto (unicode e código piores, como em 07/10).
- H5: o perfil histórico do Haiku 4.5 (07/10, `calibrated=false`) mantém taxa de falso alerta parecida fora da amostra.

## 2. O que esta campanha não mostra
Que a Anthropic contou ou cobrou certo (o alvo é o número dela: circularidade já registrada); comportamento com system,
várias mensagens, ferramentas, imagens, cache, streaming ou outras configurações de raciocínio; estabilidade no tempo
além da janela da coleta. O `count_tokens` é calculado pela própria Anthropic e não é referência independente.

## 3. Painel (IDs exatos de `GET /v1/models`, `PREFLIGHT_MODELS.json`)

| Modelo | Papel | Configuração fixa da requisição |
|---|---|---|
| `claude-haiku-4-5-20251001` | principal (âncora histórica) | sem parâmetro de raciocínio |
| `claude-haiku-5-5` | principal | `thinking: {type: "disabled"}` (aceito no effort padrão, medium) |
| `claude-sonnet-5-5` | principal | `thinking: {type: "between_tools"}` (desligar é 400 neste modelo; sem ferramentas não há turno de raciocínio) |
| `claude-opus-5-5` | principal | `output_config: {effort: "low"}`; raciocínio não pode ser desligado; cobrado como saída e limitado por `max_tokens` |
| `claude-fable-5-1` | exploratório | `output_config: {effort: "low"}`; raciocínio sempre ligado |

Modelo indisponível vira `BLOCKED_MODEL`, sem substituição. O modelo devolvido é registrado; se diferir do pedido, a
observação é marcada e analisada à parte (nunca misturada como se fosse o mesmo snapshot).

## 4. Corpus, grupos e divisão (fixados antes)
- Gerador congelado `scripts/calibration/corpus.ts` (`otk.calibration_corpus.synthetic.v1`, sem mudança), **semente
  20261014** (nunca usada antes; conferido por busca no repositório), 8 famílias (prosa pt, prosa en, TypeScript, JSON,
  tabela markdown, unicode/multilíngue, numérico, curtíssimo), **12 grupos por família, 3 textos por grupo** (base + 2
  variantes) = **288 textos por modelo principal**. Namespace novo `cal1-*` (os grupos da campanha de 07/10 não são
  reusados; o holdout histórico não é reciclado).
- Divisão por **grupo inteiro**, estratificada por família: embaralhamento Fisher-Yates com semente `0x0ca1a701` sobre os
  12 grupos de cada família; os 6 primeiros vão para treino, os 3 seguintes para validação, os 3 últimos para holdout.
  Resultado: **144 / 72 / 72** textos; **24 grupos no holdout**. Variantes nunca cruzam divisões (teste offline).
- Exploratório (Fable 5.1): os 40 textos-base de 5 grupos de treino por família.
- Hashes: `CORPUS_MANIFEST.json` (sha256 de cada texto, do `corpus.jsonl` inteiro e contagem local por modelo).

## 5. Requisição (idêntica entre modelos, salvo a configuração fixa da seção 3)
Uma mensagem de usuário `Resuma em uma frase curta o texto a seguir.\n\n<texto>`; `max_tokens` **64**; sem stream, sem
system, sem ferramentas, sem `cache_control`, sem `fallbacks`, sem `temperature`. API Messages, `anthropic-version:
2023-06-01`. Antes de cada chamada, `count_tokens` gratuito com o mesmo corpo (sem `max_tokens`).

## 6. Alvo, preditor, exclusões e falhas (fixados antes)
- **Alvo:** `usage.input_tokens` da resposta final (proveniência `provider_final_usage.input_tokens`).
- **Preditor:** contagem do contador local do runtime sobre o mesmo corpo (`localInputCount`, igual ao runtime).
- **Observação válida:** HTTP 200 com `usage.input_tokens` numérico. `stop_reason: "refusal"` com uso entra (o
  `input_tokens` não depende da resposta) e é contado à parte.
- **Exclusões:** chamada sem uso final; observação de modelo devolvido diferente do pedido (analisada à parte).
- **Falhas:** 429 e 529 = não cobrado, até 3 tentativas com espera crescente; outros 4xx = não cobrado, sem nova
  tentativa (no smoke, para o estágio); 401/403 ou erro de saldo = para tudo; sem resposta HTTP, timeout ou 5xx sem uso =
  **incerto**, contado no razão pelo valor inteiro da reserva e **nunca** repetido automaticamente. Falhas ficam em
  `CALL_RESULTS_SANITIZED.jsonl`; nada é descartado em silêncio. 5 falhas seguidas param o estágio.

## 7. Análise (código congelado neste commit: `scripts/experiments/cal_anth_01/analyze.ts`)
**Primária, por modelo principal** (ajustador histórico `scripts/calibration/fitProfile.ts` sem mudança):
1. ajuste afim só no **treino**; 2. limiar escolhido só na **validação** (`selectThreshold`: falso alerta na validação
   até 1%, maior detecção média de +10%, +25% e +50 tokens); 3. **holdout avaliado uma vez** com parâmetros e limiar
   congelados; 4. `calibrated = true` só se todas as checagens de `otk.calibration_acceptance.v1` passarem (treino ≥ 60,
   validação ≥ 30, holdout ≥ 30, grupos no holdout ≥ 10, falso alerta no holdout ≤ 5%, detecção de +25% ≥ 50%).
   Falhou: `CALIBRATION_NOT_ACCEPTED`. Nenhuma checagem vira TODO e nenhum limite muda depois de ver dados.
Métricas por divisão com os parâmetros congelados: n, grupos, viés, MAE, mediana e p95 do erro absoluto, máximo,
mediana e p95 do erro relativo, falsos alertas e taxa, detecção de +10%, +25% e +50 tokens. **IC 95% por bootstrap
agrupado** (2000 reamostragens dos grupos do holdout, semente 20261014) para viés, MAE, falso alerta e detecção de +25%.
Por família no holdout. Taxa de falha e consistência do ID do modelo.

**Secundária:** (a) `count_tokens` − `input_tokens` final (n, iguais, média, mín., máx.); (b) **alternativa
pré-especificada**: `y = a·local + b·(code points não ASCII) + c` por mínimos quadrados no treino, limiar pela mesma
seleção na validação, métricas e checagens da mesma política no holdout, **só para comparação** (não gera perfil de
runtime, porque o runtime só aplica ajuste afim); (c) perfil histórico do Haiku 4.5 (07/10) aplicado sem mudança ao
holdout novo (transferência fora da amostra; o resultado de 07/10, `calibrated=false`, 2/37 = 5,4%, continua publicado).

**Exploratória (Fable 5.1):** razão alvo/local (mediana, p05, p95) e consistência da API; nunca `calibrated`.

**Comparação com 07/10:** só descritiva (corpus, divisão, `max_tokens` 64 contra 24 e janela diferentes); o
`input_tokens` não depende de `max_tokens`.

## 8. Orçamento e parada (fixados antes)
- Teto autorizado **US$ 10,00**; alvo de admissão **US$ 8,00** (o razão recusa reserva que leve exposição acima de
  US$ 8,00). Preços congelados em `MODEL_PRICE_SNAPSHOT.json` (página oficial arquivada com sha256).
- Reserva por chamada = `ceil((count_tokens × 1,05 + 16) × preço de entrada mais caro)` + `ceil(64 × preço de saída)`;
  sem `count_tokens`, entrada local × 2 + 64. Uma reserva aberta por vez; razão `COST_LEDGER.jsonl` com fsync.
- Estimativa offline do pior caso: US$ 1,79 para as 1192 chamadas (`CORPUS_MANIFEST.json`); smoke de 5 chamadas;
  ponta a ponta reservada em US$ 1,30. Exposição máxima planejada ≈ US$ 3,1.
- Ordem: smoke (estágio A), principais na ordem do painel (B), Fable (C) só se sobrar orçamento, ponta a ponta (CAL-5).
  Se faltar orçamento, o Fable sai primeiro; a cobertura dos principais nunca é reduzida para caber o Fable.
- Parar quando: amostra registrada completa; ou o razão recusar; ou erro de credencial, saldo ou integridade; ou falha
  técnica que impeça medição válida. Sobra de crédito não é gasta. Fase B (outra campanha) não é executada aqui.

## 9. Ponta a ponta pelo OTK congelado (CAL-5)
`scripts/pilot/anthropic/runPilotV3.ts` sem mudança, `--mode=live`, fases `minimal` (1 chamada) e `sample` (4 chamadas),
modelo `claude-haiku-4-5-20251001` (o único perfil do executor congelado), PostgreSQL isolado. **5 chamadas**, reservadas
antes no razão do experimento (US$ 1,30, pior caso do executor) e também no razão canônico do piloto. Conferências: as
do próprio executor (tenant, despacho, admissão de orçamento, uso, contagem local, metadados, recibo durável, decomposição
por categoria, oráculo de CU e preço, assinatura, limpeza). Se exigir mudança no H1: `INTEGRATION_BLOCKED`.

## 10. Portão humano (antes de qualquer chamada paga)
Confirmação do autor, no Console, de: organização e workspace corretos; chave do workspace certo; limite mensal de gasto
do workspace ≤ US$ 10; workspace não é o Default sem limite; recarga automática desligada; créditos disponíveis
conferidos. Sem isso o integrador não grava `PAID_CALLS_AUTHORIZED.json` e o coletor recusa rodar (código de saída 5).
