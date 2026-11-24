# R09 — Método H2-EVAL, revisão 2

Substitui `R09_METHOD.md` (rev. 1, mantida). Roadmap `68864e0f…`. Modelo efetivo: **Sonnet 5.5**. **Desenho offline.** Estado: **DRAFT_FOR_AUTHOR_RATIFICATION**. Coerente com `R07_MATRIX_R2.md` e `R10_PREREGISTRATION_H2EVAL_R2.md`. Fórmulas e política da H1 (`7606bc9b`) são reutilizadas **sem alteração**; os limiares da `otk.calibration_acceptance.v1` **não** mudam. Valores marcados "padrão" valem se o autor apenas ratificar.

## 1. Corpus novo

| Item | Regra |
|---|---|
| Versão e gerador | `otk.h2eval.corpus.v1`, gerador novo (a escrever pela equipe do executor), determinístico; sha256 do código no manifesto |
| **Semente (padrão)** | **20261110** (data do pré-registro). Prova de nunca usada: `verify_seed_unused.mjs` varre, só por leitura, os refs H1 `7606bc9b`, CAL-ANTH-01, CAL-ANTH-02, integração H1+CAL, `otk-night01-h1plus-hardening` e `otk-bot-realuse-01`: **0 ocorrências** (`SEED_VERIFICATION_R2.json`). Sementes já usadas encontradas: 20260930, 20261003, 20261006, 20261007, 20261014, 20261015, 20261016 e 211920641. O executor repete a varredura no congelamento e grava o resultado no manifesto; semente repetida é recusada |
| Conteúdo | sintético, sem dado pessoal; tarefas: resumo, correção de código, análise, geração de código, em tamanhos S e L |
| Estrutura | S1 = grupos de 3 variantes quase duplicadas de um texto-base; S2/S3 = diálogos roteirizados (histórico do assistente fixo) com prefixo de ~4 500 tokens |
| **Colisão de texto** | antes da coleta, igualdade byte a byte contra CAL-ANTH-01 (288), CAL-ANTH-02 desenvolvimento (720) e CAL-ANTH-02 holdout (192). Colisão → regenerar ou excluir. Motivo: achado K-02-A da verificação (18 textos repetidos entre CAL-01 e CAL-02) |
| Hash | sha256 do corpus e de cada prompt no manifesto do R10, antes de qualquer chamada |
| Piloto | grupos próprios `PILOT`, nunca reutilizados |

## 2. Split por grupo e por prompt

- Unidade = grupo (S1) ou diálogo (S2/S3). Variantes, repetições, turnos e **o mesmo prompt em todos os modelos** ficam no mesmo split.
- **Alocação balanceada por célula** (e não `mod 100`, que não garante contagens): ordenar por `sha256(semente | célula | índice)`; S1: 4/2/2 grupos por célula; S2: 9/3/3 de 15 diálogos; S3: ≈ 60/20/20.
- Atribuição calculada **uma vez**, antes da coleta, gravada no manifesto; teste automático de que nada cruza splits.
- O comparativo de resumo do Haiku 4.5 (opção B) recebe `split = COMPARATIVE`: fica **fora** de treino, validação e holdout do perfil.

## 3. Mínimos e o que a matriz fornece

| Mínimo da política (por modelo e perfil) | Exigido | Haiku 4.5 (B, 6 células) | demais modelos (8 células) |
|---|---|---|---|
| treino | ≥ 60 | 72 | 96 |
| validação | ≥ 30 | 36 | 48 |
| holdout | ≥ 30 | 36 | 48 |
| grupos no holdout | ≥ 10 | 12 | 16 |

Todos atendidos. Os mínimos servem ao **gate formal**, não são promessa de potência. Com 36 observações de holdout, um perfil realmente no limite de 5% de falso alerta passa só ≈ 46% das vezes (≤ 1 de 36); com 48, ≈ 57% (≤ 2 de 48); detecção de +25% com taxa verdadeira de 60%: ≈ 92% (36) e ≈ 94% (48). Cálculo binomial exato com chamadas independentes (otimista: os grupos reduzem o tamanho efetivo). Um FAIL perto do limite é compatível com perfil aceitável; isso entra na discussão, **sem mudar o critério**.

**Política candidata `v2` da CAL-ANTH-02 (≥ 150 observações e ≥ 50 grupos no holdout):** **não é o gate deste estudo** (a política v1 é a padrão). Atendê-la exigiria ~3,1× o S1 e ultrapassaria o teto Anthropic de US$ 5 no pior caso (R07 R2 §5).

## 4. Exclusões e dados faltantes

Códigos fechados (`CONTRACT_MIN_FOR_EXECUTOR.md` §7): `EXCL_NO_USAGE`, `EXCL_UNPARSEABLE`, `EXCL_MODEL_MISMATCH`, `EXCL_COUNTER_INCOMPLETE`, `EXCL_PROTOCOL_DEVIATION`. **Dado ausente nunca é zero**; sem imputação; casos completos para o erro de contagem, com tabela de exclusões por modelo e célula; sensibilidade de custo com `UNKNOWN` no teto e no uso declarado. Recusa com uso (`REFUSED_WITH_USAGE`; 147 na CAL-ANTH-01) permanece na contagem se `U` existe e é reportada em separado. **Conjunto de IDs servidos aceitos**, pré-registrado por modelo (inclui `gpt-4o-mini-2024-07-18` e `claude-haiku-4-5-20251001`).

## 5. Métricas

Contagem: viés, MAE, RMSE, máximo, quantis de `e` e de `|r|`, erro relativo mediano. Alerta: falso alerta e detecção (+10%, +25%, +50 tokens). Custo: `Ctab` por categoria, cobertura do teto, razão `Ĉcap/Ctab`, cobertura do intervalo de cache, custo por tarefa concluída. Cobrança: `ΣCbill/ΣCtab` por lote, quando atribuível. Qualidade: `Q` por modelo e célula. IC por **bootstrap por grupo** (percentil, *B* = 10 000, semente registrada) estratificado por célula; Clopper–Pearson para proporções. Sem p-valores nas análises descritivas.

**Oráculos.** `U` = uso declarado pago. `count_tokens` (Anthropic) e `countTokens` (Google) vêm do **mesmo provedor** e não são independentes; servem ao desenvolvimento e a diagnóstico, nunca como alvo confirmatório. Fora da circularidade só a conciliação em lote com a console/fatura, na granularidade que o provedor expõe (Anthropic: buckets de uso/custo; OpenAI: **NOT_VERIFIED**; Google: painel).

## 6. Calibração: quatro estimadores e regra de seleção

| Braço | Definição |
|---|---|
| **M0** | contador bruto `L0` (`otk.local_counter.b3@1`) |
| **M1** | ajuste afim por modelo, **só no treino**, `fitCalibrationProfile` da H1 (cópia byte-idêntica; hash no manifesto) |
| **M2F** | **M2 congelado da CAL-ANTH-02** (`FROZEN_MODEL.json`, 13 características pré-chamada), **sem refit**. Aplicado aos modelos 5.5 com o ajuste inteiro de cada um (Haiku 0, Sonnet 0); ao Haiku 4.5 e aos demais **sem ajuste calibrado**, rotulado "fora da família de origem" |
| **M2N** | `U ≈ α_s + β·L0 + γ·x` com intercepto por estrato *s* (tarefa × tamanho × estrutura), inclinação compartilhada e características de caracteres *x* (fração de dígitos, acentos, pontuação, código, linhas), **ridge**; λ de {0, 1, 10, 100} por validação cruzada **por grupo** (4 dobras) no treino. Até `n_treino/10` parâmetros efetivos |

**Dados de desenvolvimento (antes do congelamento, sem custo):** CAL-ANTH-01 treino + validação e CAL-ANTH-02 desenvolvimento (2 805 observações / 312 grupos) servem para escolher as características de *x*, a grade de λ e o número de estratos; podem entrar como linhas extras de treino do M2N com um indicador de origem (`legacy_summary`), **sem** serem contadas nos mínimos da política. Holdouts já vistos (CAL-ANTH-01 e 02) **não** selecionam nada; aparecem só como comparativo pós-hoc rotulado.

**Seleção (na validação, por modelo, do mais simples ao mais complexo):** M0 → M1 só se o MAE de validação melhorar ≥ δ → M2F e M2N só se melhorarem ≥ δ sobre o melhor anterior; M2N também precisa melhorar na validação cruzada por grupo. **δ padrão = 10% relativo.** Empate ou dúvida → o mais simples. **Limiar de alerta** só na validação (`selectThreshold` da H1). **Congelamento (G22)** de perfil, parâmetros, limiar e hashes **antes** de qualquer leitura do holdout.

## 7. Regra do holdout

O holdout é coletado com os demais dados, mas treino e validação **não leem** linhas `holdout` (filtro por `split` com teste). Avaliação **uma única vez** (R23): PASS/FAIL conforme as 6 checagens da política v1, **por modelo e por snapshot**. Proibido depois de ver o holdout: mudar limiar, critério, split, exclusões, fórmula ou perfil; retirar pontos; reavaliar. Mudança vira nova versão; o resultado anterior continua publicado.

## 8. Piloto exploratório × amostra confirmatória

| | Piloto (R17) | Confirmatória (R18–R20) |
|---|---|---|
| Objetivo | parser, unidades, taxa de hit, recusas, custo | hipóteses do R06 |
| Dados | grupos `PILOT` | grupos do manifesto |
| Entra em treino/validação/holdout | **não** | sim |
| Pode mudar o protocolo | só por emenda versionada, e o piloto sai do inferencial | não |
| Pode dimensionar | **só o braço de cache** (taxa de hit) | nada |

Sem olhadas intermediárias nos resultados confirmatórios, exceto paradas de segurança e orçamento.

## 9. Critérios de parada

| Tipo | Regra |
|---|---|
| Orçamento | reserva excederia o sub-ledger → `STOP_BUDGET` do provedor (US$ 5 / 3 / 3, sem transferência) |
| Segurança | `Ctab > Ĉcap`, uso/custo incerto, preço desconhecido, queda do executor, falha de persistência → STOP/ISOLATE |
| Qualidade dos dados | > 20% das operações de um modelo em `EXCL_*` num lote → pausar o modelo (padrão) |
| Erros | 2 recusas/erros seguidos no mesmo modelo → pausar o modelo (padrão) |
| Cache | `p_baixo < 0,3` no piloto → braço de cache do modelo `NOT_RUN` |
| Tempo | limite de sessão como proteção **extra** |
| Científica | sem parada por eficácia nem futilidade |

## 10. Imagem e áudio

`UNSUPPORTED_FOR_ESTIMATION`: sem erro contra oráculo incompatível. Para OpenAI e Anthropic a **fórmula oficial** (R08 §5) é registrada como estimativa **exploratória** ao lado do uso declarado, sem validar o resultado como calibração e sem promover a fórmula a estimador. Áudio só no Gemini (32 tokens/s), dentro do GO do Google.

## 11. Reprodutibilidade

Node e dependências fixados; scripts com hash no manifesto; semente do bootstrap registrada; saída por comando único; versão dos preços registrada; **ID servido** gravado em cada operação (o snapshot `gpt-4o-mini-2024-07-18` sai da API em 14/01/2027).

## 12. Gate proposto

**G09 (análise sem vazamento e amostras adequadas à pergunta): PROPOSTO PASS_WITH_RESERVATIONS.** Método, split, mínimos (atendidos nas duas configurações), colisão de texto, desenvolvimento sem tocar holdouts e semente verificável estão definidos. Reservas: a ratificação do autor, o gerador de corpus ainda não escrito (a colisão e a semente são verificadas na geração), e as NOT_VERIFIED do R08.
