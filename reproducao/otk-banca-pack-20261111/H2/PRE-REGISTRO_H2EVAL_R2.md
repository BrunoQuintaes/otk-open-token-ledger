# PRÉ-REGISTRO H2-EVAL — revisão 2, pronto para ratificar

| | |
|---|---|
| Estado | **AGUARDA_RATIFICAÇÃO** (`DRAFT_FOR_AUTHOR_RATIFICATION`). Esta run **não ratifica** |
| Versão | `h2eval-prereg-v0.2-draft` · ID `OTK-H2EVAL-PREREG-20261110` · substitui `R10_PREREGISTRATION_H2EVAL_DRAFT.md` (v0.1, mantido) |
| Roadmap | `OTK-OPS-ACADEMIC-20261110-V2`, sha256 `68864e0f82b9281b912f747f24c78a52c83a9a7140297c7170a1dfe232ccf28c` |
| Autora | MVP-P2-ECON-02, **Sonnet 5.5** (`claude-sonnet-5-5`) |
| Manifesto | `R10_MANIFEST_R2.json` |

**Este documento não é GO para chamadas reais.** Cada GO (micro-piloto R17 e cada lote) é um ato separado do autor. Sem credencial, rede ou dado novo.

---

## Decisões do autor (uma página)

Se o autor disser apenas **"ratifico"**, valem os **padrões** abaixo. Tudo que não está nesta tabela é **padrão declarado** (fim da página).

| # | Decisão | Padrão se disser só "ratifico" | Alternativa | Por que a recomendação |
|---|---|---|---|---|
| 1 | **Matriz e braço do Haiku 4.5** | **M-FULL com Haiku 4.5 reduzido (opção B)**: 1 494 chamadas, pior caso **US$ 6,86** (Anthropic 3,74 / 5; OpenAI 0,32 / 3; Google 2,80 / 3) | A completo (1 536; US$ 7,15) · C só comparativo (1 257; US$ 4,64) | B responde só o que ainda não existe: a CAL-ANTH-01 já cobre calibração de resumo de uma mensagem no Haiku 4.5 (holdout 72, aceito na política v1). Mantém o pareamento de custo e qualidade nas 8 células e atende os mínimos (72/36/36 obs., 12 grupos). C não calibra o Haiku 4.5 |
| 2 | **Google no executor** | Braço Google **preparado e `NOT_RUN`** até **GO próprio** (fail-closed; isolamento, serialização, sem retries, stop por custo e tempo, limites oficiais inspecionados) | Abrir já com o GO dessa ratificação | O Google é a única linha perto do teto no pior caso (93%) e o teto por projeto do Google **não é hard cap imediato** (R08 §9). Sem o Google, o pior caso cai para US$ 4,06 |
| 3 | **Semente do corpus** | **20261110** (data do pré-registro). Prova de nunca usada: `SEED_VERIFICATION_R2.json` (0 ocorrências em 6 refs: H1, CAL-ANTH-01, CAL-ANTH-02, integração H1+CAL, hardening, realuse); o executor repete a varredura no congelamento e grava no manifesto; semente repetida é recusada | outro inteiro de 6 a 12 dígitos | derivada de dado público e verificável; sementes usadas: 20260930, 20261003, 20261006, 20261007, 20261014, 20261015, 20261016, 211920641 |
| 4 | **Política de aceite da calibração** | **v1 inalterada** (treino ≥ 60, validação ≥ 30, holdout ≥ 30, ≥ 10 grupos, falso alerta ≤ 5%, detecção de +25% ≥ 50%), por modelo e snapshot, holdout lido **uma vez** | também reportar a candidata `v2` (≥ 150 obs., ≥ 50 grupos) | `v2` exigiria ~3,1× o S1 e estouraria o teto Anthropic de US$ 5 no pior caso (≈ 7,4). O autor não precisa mexer em limiares |
| 5 | **Gasto e stops** | sub-ledgers **US$ 5 / 3 / 3** sem transferência; teto por operação = `costCap` gravado antes do envio; lote ≤ 60 chamadas com teto de 1,5× seu pior caso (e ≤ 25% do sub-ledger); uma chamada por vez, sem retry/fallback; pausa e revisão humana ao atingir 80% de um sub-ledger; STOP global em qualquer `Ctab > costCap` (detalhes na §5) | outros subtetos | o pior caso total (6,86) fica em 62% de US$ 11; os stops são do executor, não alertas de console |
| 6 | **Imagem e áudio** | **Exploratórios segregados incluídos**: imagem nos 4 modelos (uso declarado + fórmula oficial como comparação exploratória, **sem validar estimador**); áudio só no Gemini, dentro do GO do Google | adiar | custam ≈ US$ 0,14 no pior caso (≈ 2% do total) e respondem à crítica do orientador; sem estimador validado não há erro de contagem |

**Padrões declarados (não precisam de decisão):** δ da seleção M1/M2F/M2N = 10% relativo · ε de equivalência do cache = max(5 tokens, 1% de `U`) · tolerância de conciliação ≤ 1% · pausa do modelo após 2 recusas/erros seguidos ou > 20% de operações em `EXCL_*` num lote · modelos: gpt-4o-mini-2024-07-18, claude-haiku-4-5-20251001, gemini-3.5-flash-lite, claude-haiku-5-5 (Sonnet 5.5 fora) · M2F = M2 congelado da CAL-ANTH-02, sem refit · desenvolvimento do M2N com CAL-ANTH-01/02 sem tocar holdouts · colisão de texto verificada · chave nova criada e operada só pelo autor (sem ação desta run) · o horário do EDITORIAL_FREEZE é da coordenação, não do desenho.

**Lembrete:** ratificar o pré-registro **não** libera o piloto. Antes dele faltam G15/G16 (testes e preflight com credenciais operadas por você) e o **seu GO específico**.

---

## 1. Escopo e fronteira de evidência

H2-EVAL é um estudo novo, pós-congelamento, separado da H1 (`7606bc9b`, congelada) e da CAL-ANTH-01/02 (posteriores, suplementares, **verificadas** em `CAL_ANTH_VERIFICATION_REPORT.md`). A tese continua sendo a **conferência do consumo pelo lado do cliente**, sem alegar previsão universal. Rótulos que nunca se misturam: H1 · CAL-ANTH-01/02 · piloto exploratório · confirmatório · exploratório segregado (imagem/áudio) · Bot/D-ANTH-10/GS (fora). Nada altera a H1, seus limiares, holdouts ou pré-registros antigos; a dissertação não é editada.

## 2. Perguntas e hipóteses (`R06_HYPOTHESES.md`)

A. erro da contagem ex ante × uso declarado (M0; M1 e M2 reduzem o MAE em ≥ δ; erro independente do cache, margem ε) · B. custo ex post pela tabela (recálculo independente confere em 100%) · C. cobrança efetiva, só quando atribuível (senão `NOT_AVAILABLE`) · D. teto ≠ previsão (cobertura 100%; uma violação é STOP) · E. cache (custo dentro de `[hit total, sem hit]`; braço pelo **observado**) · F. detecção (política v1 inalterada) · G. calibração por modelo e snapshot, holdout uma vez · H. imagem/áudio exploratórios. Confirmatórias formais: **G1** (aceite por modelo) e **D1** (cobertura do teto).

## 3. Desenho (`R07_MATRIX_R2.md/.json`)

Fatores separados: tarefa · tamanho (S ~600–800 tok; L ~5 000) · estrutura (S1; S2 sem hit; S3 com tentativa de hit) · modalidade · modelo. IDs e preços atestados por documentação (R08), **não** pelo autor; disponibilidade na conta **NOT_VERIFIED**; `gpt-4o-mini-2024-07-18` é **deprecado** (desliga em 14/01/2027).

| Bloco | Por modelo | Total (opção B) |
|---|---|---|
| S1 | 8 células × 8 grupos × 3 variantes + 24 repetições = 216 (Haiku 4.5: 6 células + 12 comparativos + 18 repetições = 174) | 864 − 42 = 822 |
| S2 | 15 diálogos × 3 = 45 | 180 |
| S3 | até 30 diálogos × 3 = 90 (dimensionado pelo piloto) | 360 |
| Piloto segregado | 23 (Gemini 25) | 94 |
| Imagem | 8 | 32 |
| Áudio | 6 (só Gemini) | 6 |
| **Total (B)** | | **1 494** |

Pareável: S1 texto (mesmo prompt em todos os modelos). Não pareável: S2/S3, imagem, áudio.

## 4. Amostra, split, método e análise (`R09_METHOD_R2.md`)

Split por **grupo/diálogo**, alocação balanceada por célula, calculada uma vez antes da coleta; variantes, repetições e o mesmo prompt entre modelos ficam no mesmo split. Mínimos da política v1 atendidos: 96/48/48 obs. e 32/16/16 grupos (72/36/36 e 24/12/12 no Haiku 4.5 reduzido). Estimadores: **M0**, **M1**, **M2F** (M2 congelado da CAL-ANTH-02, sem refit), **M2N** (estratificado, ridge, validação cruzada por grupo). Seleção do mais simples ao mais complexo na validação; limiar só na validação; congelamento antes do holdout; holdout lido uma vez. Métricas: viés, MAE, RMSE, quantis, erro relativo, cobertura; IC por bootstrap por grupo e Clopper–Pearson. **Proibido depois de ver o holdout:** mudar limiar, critério, split, exclusões, fórmula ou perfil. Dado ausente nunca é zero; exclusões por códigos fechados. Com 36–48 observações de holdout, um perfil realmente em 5% de falso alerta passa só 46–57% das vezes; um FAIL próximo do limite entra na discussão sem mudar o critério.

## 5. Plano de gasto e stops

### 5.1 Níveis

| Nível | Regra |
|---|---|
| **Operação** | `costCap` calculado por chamada (entrada ao maior preço entre entrada e escrita de cache, TTL mais caro; saída no teto + folga de raciocínio onde ele não se desliga), arredondado para cima, gravado e hasheado **antes** do envio. `Ctab > costCap` → **STOP global** |
| **Lote** | ≤ 60 chamadas, um modelo por lote. Teto do lote = 1,5 × a soma dos `costCap` do lote, nunca acima de 25% do sub-ledger do provedor. Lote que excederia o teto é interrompido; só blocos completos entram na análise |
| **Provedor** | sub-ledger independente (Anthropic US$ 5, OpenAI US$ 3, Google US$ 3), **sem transferência cruzada**. Reserva que excederia o sub-ledger → `STOP_BUDGET` do provedor. Ao atingir **80%** do sub-ledger: pausa e revisão humana |
| **Global** | contador cumulativo `budgetCampaignUsd = 11`. Preço desconhecido, uso/custo incerto, queda do executor, falha de persistência, saída excedida, retries → **STOP/ISOLATE** |
| **Execução** | uma chamada por vez; **sem retry, sem fallback, sem concorrência** no início; limite de tempo apenas como proteção **adicional** |

Alertas de console **não** são hard cap (a Anthropic tem teto mensal de tier; o hard limit da OpenAI existe, mas o valor é do autor; o teto por projeto do Google tem latência de ~10 min). A contabilidade é separada de D-ANTH-10, GR2, MP-02, Bot e do orçamento do console. Registro imutável: despesa **estimada × efetiva/documentada** por operação, lote e provedor; fatura e tabela nunca misturadas.

### 5.2 Pior caso planejado (opção B), em US$

| Lote | Anthropic | OpenAI | Google |
|---|---|---|---|
| Piloto segregado | 0,256 | 0,029 | 0,175 |
| S1 texto | 1,641 | 0,148 | 1,571 |
| S1 comparativo (Haiku 4.5) | 0,076 | — | — |
| S2 | 0,577 | 0,040 | 0,322 |
| S3 | 1,155 | 0,080 | 0,643 |
| Imagem | 0,030 | 0,028 | 0,046 |
| Áudio | — | — | 0,038 |
| **Total** | **3,735** | **0,324** | **2,796** |
| Teto / fração | 5,00 / 0,75 | 3,00 / 0,11 | 3,00 / 0,93 |

Pior caso, não previsão. A folga de raciocínio do Gemini (2 048 tokens por chamada, **suposição**) responde por quase todo o Google: sem folga, US$ 0,74. Não inclui retries (proibidos) nem mudança de preço.

### 5.3 Stops de dados e ciência

| Condição | Ação |
|---|---|
| 2 recusas/erros seguidos no mesmo modelo | pausar o modelo |
| > 20% de operações em `EXCL_*` num lote | pausar o modelo |
| `p_baixo < 0,3` no piloto | braço de cache do modelo `NOT_RUN`; a taxa é registrada |
| `modelServed` fora do conjunto aceito | `EXCL_MODEL_MISMATCH`; pausa se repetir |
| Sem parada por eficácia ou futilidade | não há análise intermediária |

## 6. Piloto × confirmatório

| | Piloto (R17) | Confirmatório (R18–R20) |
|---|---|---|
| Finalidade | parser, unidades, taxa de hit, recusas, custo, telemetria, **dimensionar só o braço de cache** | testar as hipóteses |
| Dados | grupos `PILOT` próprios (23–25 chamadas por modelo) | grupos do manifesto |
| Treino/validação/holdout | **nunca** | sim |
| Muda o protocolo? | só por **emenda versionada** antes da confirmatória; o piloto sai do inferencial | não |
| Autorização | GO específico (provedor, IDs, lote, operação máxima, saldo/limites verificados, stops, versão do executor) | GO de cada lote |

## 7. Qualidade

Rubrica binária determinística (pontos-chave verificados em código; sem juiz humano nem LLM), definida antes dos dados; usada para custo por tarefa concluída e como covariável descritiva; **nunca** critério de aceite da calibração.

## 8. Ordem e gates

R08 ✔ e `CAL_ANTH_VERIFY` ✔ → G07/G09 (propostos PASS_WITH_RESERVATIONS) → **ratificação (G10, AGUARDA_RATIFICAÇÃO)** → R11–R14 (já destravados pelo contrato mínimo) → R15/R16 → **GO específico** → R17 → G17 → GO de lote → R18–R20 → R21 → R22 (congela) → R23 (holdout uma vez) → R24/R25. Imagem e áudio dependem de qualificação do parser (R14).

## 9. Desvios e emendas

Mudança material vira nova versão, com motivo, data e hash **antes** de nova coleta; resultados de versões anteriores continuam publicados. Desvios durante a coleta são **relatados**, não corrigidos em silêncio.

## 10. Limitações declaradas

Pior caso, não previsão. Preços atestados por documentação, não por fatura nem pelo autor; disponibilidade na conta NOT_VERIFIED. O alvo é o uso declarado pelo provedor (não oráculo independente). Perfis valem por modelo, snapshot e formato de requisição. Imagem e áudio sem estimador validado. Quatro modelos, corpus sintético: sem generalização para tráfego real. O holdout de 36–48 observações tem poder limitado para aprovar perfis no limite dos critérios. `gpt-4o-mini-2024-07-18` deixa de existir em 14/01/2027. Conciliação com a OpenAI NOT_VERIFIED.

## 11. Bloco de ratificação

| Campo | Valor |
|---|---|
| Ratificado (sim / com ressalvas / não) | ___ |
| Decisões diferentes do padrão (nº e valor) | ___ |
| Hash do arquivo ratificado | ___ |
| Data e hora (UTC) | ___ |
| Assinatura | ___ |
