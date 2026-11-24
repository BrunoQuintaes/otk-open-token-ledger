# CAL_ANTH_VERIFY — verificação independente da CAL-ANTH-01 (e da CAL-ANTH-02) — C141

- **Run:** CAL_ANTH_VERIFY (B06, pista acadêmica P0). **Modelo efetivo:** `claude-fable-5-1`. **Data:** 2026-11-10.
- **Autorização:** o autor, ordem C141, 10/11/2026 21:58 UTC ("evidência SUPLEMENTAR, não H1 confirmatória; verificar autenticidade, autoria, integridade, versões e possível CAL-ANTH-02 antes de incorporar").
- **Fonte (somente leitura):** clone `C:\dev\otk-i10-20261104` (porcelain 0; nada alterado em branch algum). Cópias extraídas com `git archive` para o scratchpad. Commit **`b55c34298fa7e24ec936396117ce1c7e58f61805`** (branch `origin/experiment/otk-cal-anth-01-20261014`, head = este commit), pasta `docs/_ops/experiments/OTK_CAL_ANTH_01/`. CAL-ANTH-02: `4120a7571f115eb02cc2cff09270a9ffe07265ae` (`origin/experiment/otk-cal-anth-02-20261015`). h1plus: `fd681d29` (`origin/exp/h1plus-cal-anth-integration-20261015`).
- **Método:** recálculo **sem** usar `analyze.ts`/`fitProfile.ts` (reimplementação das definições pré-registradas em `recompute_cal_anth.mjs`, nesta pasta; saída `RECOMPUTE_RESULTS.json`). Sem rede, sem chamadas pagas, sem chaves.

## Veredito: **apta como evidência suplementar: SIM** (com as fronteiras do §6; sem ressalva de integridade)

## 1. Integridade, autoria e ordem temporal

| Item | Resultado |
|---|---|
| `EVIDENCE_MANIFEST.json` (63 entradas, regra "sha256 com CRLF→LF") | **63/63 conferem** contra os blobs de `b55c342` (34 arquivos da pasta + 12 scripts `scripts/experiments/cal_anth_01/*` + `scripts/calibration` não incluído + teste offline + handoff) |
| `PREREGISTRATION_SHA.txt` | `d30daf3780e615463e491943e8dd72cee2838c11` = commit do pré-registro; o blob de `PROTOCOL_PREREGISTERED.md` é **idêntico** em `d30daf37` e em `b55c342` (`129cce0d…`), sha256 `a7cd4ea7…` |
| Pré-registro ANTES do primeiro dado | commit `d30daf37` em **2026-10-15T00:43:32Z**; primeira reserva no razão **00:58:44Z**; primeira chamada **00:58:45Z**. Diferença 15 min. Sim. |
| Emenda 1 (`6ad2fb01`, 00:58:20Z) | **24 s antes** da primeira chamada paga; muda **só** controles financeiros/autorização (overrun bloqueia, reserva interrompida = incerta, portão valida `PAID_CALLS_AUTHORIZED.json`, CAL-5 pelo mesmo razão, 5 testes negativos). Corpus, semente, divisão, modelos, alvo, análise e política **não** mudam (conferido por diff: só 3 arquivos novos, nenhum do protocolo). **Antes de ver dados.** |
| Código de análise congelado | `analyze.ts` blob **idêntico** em `d30daf37` e `b55c342` (`8184f4dc…`), sha256 `02ea4b49…` = `analysisCodeSha256` do `RESULTS_PER_MODEL.json` e do `HOLDOUT_EVALUATION_RECORD.json` |
| Autoria/portão humano | `PAID_CALLS_AUTHORIZED.json`: confirmação do autor registrada (itens do Console), `fingerprintIsNotProofOfWorkspace: true`, saldo prévio não informado. Commits de autor único na branch. |
| Sequência de commits × dados | A smoke (`d90a419e`) → B 1152 (`e539f5a1`) → C Fable 40 (`a2e9f46d`) → **análise/holdout** (`93fbcc68`, 01:35:24Z; `evaluatedAt` 01:35:14Z) → E2E 5 chamadas (`a8644dc1`) → relatórios (`b55c3429`). Blobs de `RESULTS_PER_MODEL.json`, `HOLDOUT_EVALUATION_RECORD.json`, perfis e `CALL_RESULTS_SANITIZED.jsonl` **inalterados** de `93fbcc68` a `b55c342`. |

## 2. Recálculo independente (tabela número a número)

| # | Número afirmado | Obtido por mim | Estado |
|---|---|---|---|
| 1 | 1.202 chamadas | 1.197 linhas em `CALL_RESULTS_SANITIZED.jsonl` + 5 E2E (`E2E_RESULTS.jsonl`) = **1.202**; razão: 1.199 reservas / 1.199 liquidações (1.197 + 2 fases E2E) | REPRODUZIDO |
| 2 | Por modelo: 289 / 289 / 289 / 289 / 41 / 5 | Haiku 4.5 289 (1 smoke + 288), Haiku 5.5 289, Sonnet 5.5 289, Opus 5.5 289, Fable 41 (1 + 40), E2E 5 | REPRODUZIDO |
| 3 | Válidas 1.198; 4 HTTP 400 não cobrados; 0 incertas | 1.193 + 5 E2E = **1.198**; **4** × HTTP 400 (1 por modelo principal, mesmo texto `cal1-mixed_unicode-010-v1`); **0** incertas; modelo devolvido = pedido em 100% | REPRODUZIDO |
| 4 | 147 recusas com uso de entrada | **147** (Haiku 5.5: 64; Sonnet 5.5: 70; Opus 5.5: 3; Fable: 10); todas HTTP 200 com `input_tokens`; famílias pt/en/unicode como no relatório | REPRODUZIDO |
| 5 | Custo US$ 1,380180 (tabela congelada, não fatura) | soma de `costMicroUsd` das linhas 1.375.649 + E2E 4.531 = **1.380.180 µUSD**; soma das liquidações do razão = **1.380.180**; recálculo tokens × preços de `MODEL_PRICE_SNAPSHOT.json` = igual por modelo (Haiku 5.5: 15.576 vs 15.594, diferença de 18 µUSD por arredondamento por componente) | REPRODUZIDO |
| 6 | Haiku 4.5: treino 143, validação 72, holdout 72, 24 grupos | 143 / 72 / 72 / 24 | REPRODUZIDO |
| 7 | Ajuste afim 1,164781 × local + 2,601779 | OLS próprio no treino: **1,164781 / 2,601779** | REPRODUZIDO |
| 8 | Limiar 7 tokens e 13,9054 % | grade própria na validação (FA ≤ 1 %, maior poder): **7 / 0,139054** | REPRODUZIDO |
| 9 | Holdout: viés −0,8; MAE 16,6; mediana 11; p95 43; máx 56 | −0,847222 / **16,597222** / 11 / 43 / 56 | REPRODUZIDO |
| 10 | Falso alerta 3/72 = 4,2 % | **3/72 = 0,041667** (os 3 na família numérica) | REPRODUZIDO |
| 11 | Detecção +25 % ≈ 79 % | **0,791667** (57/72); +10 % 0,361; +50 tok 0,583 | REPRODUZIDO |
| 12 | IC 95 % bootstrap (2000 reamostragens dos 24 grupos, semente 20261014): FA 0–12,5 %; det 62,5–95,8 %; MAE 11,8–22,5 | reimplementação própria (mulberry32): **[0, 0,125] / [0,625, 0,958333] / [11,777778, 22,472222]**; viés [−9,35, 7,82] | REPRODUZIDO (bit a bit) |
| 13 | Haiku 4.5 CALIBRATION_ACCEPTED | 6/6 checagens da política v1 passam no meu recálculo | REPRODUZIDO |
| 14 | Haiku 5.5 / Sonnet 5.5 / Opus 5.5 NOT_ACCEPTED, detecção 12,5 % | parâmetros, limiares (13/0,407625; 11/0,407625; 13/0,407408), MAE 40,9/41,3/40,2, FA 3/4/3, **det +25 % = 0,125 nos três** e ICs iguais aos relatados | REPRODUZIDO |
| 15 | Erro por família (holdout, MAE): numérico 39,0 / 118,0 / 118,7 / 117,2; prosa pt 17,7 / 110,6 / 109,9 / 111,0 | iguais às 6 casas nas 8 famílias × 4 modelos | REPRODUZIDO |
| 16 | `count_tokens` = uso final: 287/287 Haiku 4.5 e Opus; divergências só em recusas (7 e 13), sempre +22 | 287/287; 287/287; Haiku 5.5 280/287 (7 ≠, todas recusas, diferença −22 no `count_tokens`); Sonnet 274/287 (13 ≠, idem) | REPRODUZIDO |
| 17 | Tokenizador compartilhado: Haiku 5.5 = Sonnet 5.5 em 217/217; Opus = +2 em 222/222 | 217/217; 222/222 | REPRODUZIDO |
| 18 | Perfil 07/10 no holdout novo: FA 3/72, det 79 %, MAE 16,0 | parâmetros do relatório (1,165964 / 4,101752; 6 / 0,142062): 3/72; 0,791667; 16,013889 | REPRODUZIDO |
| 19 | Fable: razão mediana 1,46 (p05 1,10, p95 2,29), 10 recusas | 1,461538 / 1,101266 / 2,285714; 10 | REPRODUZIDO |
| 20 | Custo por modelo em `RESULTS_PER_MODEL.json` (ex.: Haiku 4.5 134.055) × tabela do relatório (134.247) | os dois números existem: o JSON conta só o estágio `core` (288), a tabela inclui a smoke. Não é erro, é escopo diferente; explicitar se citado | DIFERENTE por definição (documentado) |

Nenhum número NÃO REPRODUTÍVEL. Nenhum número DIFERENTE além do item 20 (diferença de escopo smoke/core).

## 3. Holdout avaliado uma única vez?

**Sim, sem sinal de reajuste.** (a) O script recusa reexecução quando `HOLDOUT_EVALUATION_RECORD.json` existe (código, `analyze.ts` linha 69). (b) O registro (`evaluatedAt` 01:35:14Z) e o `RESULTS_PER_MODEL.json` (`generatedAt` 01:35:14Z) nasceram no mesmo instante, commit `93fbcc68` 10 s depois; nenhum blob mudou até `b55c342`. (c) O limiar vem só da validação (reproduzi a grade e obtive o mesmo par); a política v1 é a do pré-registro. (d) A análise alternativa (não-ASCII) foi pré-especificada e **falhou** (publicada mesmo assim). (e) A CAL-ANTH-02 declara e eu confirmo que **não** reavaliou o holdout da CAL-01 com o M2. Ressalva honesta: a leitura "o perfil de 07/10 passaria aqui" é descritiva e correta, mas não converte o resultado negativo de 07/10.

## 4. CAL-ANTH-02 — o que é, para NÃO repetirmos

- **Natureza:** **nova coleta paga + reanálise de desenvolvimento.** Desenvolvimento **sem gasto** (treino+validação da CAL-01, 645 linhas, holdout da CAL-01 nunca carregado; + corpus v2 de 720 textos × 3 modelos com **2.160 rótulos gratuitos** de `count_tokens`, 0 pagos — conferido em `DEV_LABELS.jsonl`), estimador **M2** (13 características observáveis pré-chamada, núcleo compartilhado, ajuste inteiro por modelo: Haiku 0, Sonnet 0, Opus +2) e detector **D1** (|Δ| > 12 **e** > 14 %), congelados em `FROZEN_MODEL.json`. Depois, **holdout novo** (gerador v2, semente 20261016, 192 textos, 64 grupos, 8 famílias) **pago**.
- **Pré-registrada:** sim, `c5734dac` (2026-10-15T02:50:24Z), adendo analítico 1 `269544f1` (12:30Z, agregado descritivo, única mudança no `analyze2.ts`, sha `27d7ee47…` = o do registro de holdout). Autorização do autor registrada 12:43:52Z (US$ 2, recarga off, margem no limite mensal).
- **Chamadas, quando, custo (recalculado por mim):** **579** (3 smoke + 192 × 3), **2026-10-15 12:45:59Z a 13:06:03Z**, **US$ 0,849509** (tabela congelada; não fatura), 0 recusas, 0 modelo trocado, `count_tokens` = uso final 579/579. Holdout avaliado uma vez (13:07:58Z; dados commitados antes, `b7e423e3`); blobs de resultados inalterados até `4120a757`. `EVIDENCE_MANIFEST` 49/49 conferem.
- **O que muda vs 01:** preditor (reta sobre `cl100k` → M2), limiar (≈41 % → 14 %), holdout maior e inédito (72 → 192 textos; **0** textos em comum com a CAL-01 ou com o desenvolvimento), política **candidata** `otk.calibration_acceptance.v2.candidate` (não a v1), inflação **simulada** explícita.
- **Veredito por modelo:** Haiku 5.5, Sonnet 5.5, Opus 5.5 = **EXPERIMENTALLY_CALIBRATED** (MAE 16,2; FA 0/192; det +25 % 77,1 / 77,1 / 77,6 %). A própria campanha avisa: **os três são uma só medida** (Sonnet = Haiku em 192/192; Opus = Haiku + 2 em 192/192); limite superior exato do FA 1,9 % (por observação) a 5,6 % (por grupo); det +10 % só 10,9 %; numérico 37,5 % e curtíssimo 25 %. Perfis v2 **não carregáveis pelo H1**, sem ponta a ponta.
- **Achado meu (novo, pequeno): K-02-A.** O corpus de desenvolvimento da CAL-02 contém **18 textos byte a byte iguais** a textos da CAL-01 (família curtíssima, gerador com poucas combinações): 16 do treino e **2 do holdout da CAL-01** (`cal1-tiny-004-v1`, `-v2` → `cal2dev-tiny-013-v0/v1`). Os rótulos usados foram `count_tokens` gratuitos (não o uso pago da CAL-01), mas o **texto** do holdout da CAL-01 entrou no desenvolvimento do M2 (2 de 2.805 observações). Efeito prático nulo; a frase "holdout da CAL-01 nunca carregado" continua verdadeira quanto aos dados, mas "nenhum texto do holdout da CAL-01 visto no desenvolvimento" **não** pode ser afirmada. O holdout da CAL-02 (192) **não** tem sobreposição com nada.
- **Responde "preciso comprar mais calibração Anthropic?"** Para o escopo **mensagem única de resumo, só tokens de entrada, Haiku 5.5/Sonnet 5.5/Opus 5.5, corpus sintético v2**: **sim, já existe** um holdout inédito de 192 textos com estimador congelado e pré-registrado; repetir isso seria redundante. **Não responde** para: Haiku 4.5 com M2 (não avaliado), tráfego real, multi-turn/cache/system/ferramentas/mídia, tokens de saída, modelos posteriores a 15/10 (Fable, modelos de 11/2026), nem para um M2 **reavaliado na política v1**.

## 5. Branch `exp/h1plus-cal-anth-integration-20261015` (`fd681d29`)

Integra o M2/D1 da CAL-02 ao runtime do H1 **sem tocar a baseline `7606bc9b`** (base da branch; não contém os commits das campanhas; pina 21 artefatos da CAL-02/01 por sha256 em `scripts/calibration/h1plus/FROZEN_PINS.json`). Entrega: perfil de runtime novo `otk.calibration_profile.feature_linear.v1` gerado bit a bit do `FROZEN_MODEL.json` (perfis candidatos v2 continuam recusados), extração das 13 características no momento da contagem, conferência por `scope` (IN_SCOPE assinado), 13 arquivos de `src` (+853 −24), codec, testes (3665/3662/0/3 em clone limpo, serviços H1+ 20/20, Gate R0 GO, CI verde), auditoria em 2 rodadas, matriz de equivalência (0 divergências em 2805 + 576 observações e 2304 relatórios). **Estado:** experimental, não integrada à main/H1 congelado, continuada em `exp/otk-night01-h1plus-hardening` (16/10). A própria matriz declara: "fixtures de dados já revelados; **não constituem nova validação independente**". Para a dissertação: engenharia de integração, não evidência científica nova.

## 6. Fronteira de validade para o texto

**Pode afirmar:** campanha **posterior e suplementar** à H1 (15/10 vs 07/10), pré-registrada e commitada antes do primeiro dado, com análise congelada e holdout avaliado uma vez; 1.202 chamadas, custo **calculado** US$ 1,380180 pela tabela congelada; Haiku 4.5 **aceito pela política v1 nesta amostra** (FA 3/72, IC 0–12,5 % contendo 5 %: "resultado do protocolo, não margem segura"); Haiku 5.5/Sonnet 5.5/Opus 5.5 **não aceitos** (det +25 % 12,5 %) com diagnóstico por família (numérico e prosa PT); `count_tokens` e uso final vêm **ambos da Anthropic** (consistência da API, 287/287; divergência +22 só em recusas), **não** verificação independente; 147 recusas com uso contadas; 5 chamadas ponta a ponta no Haiku 4.5 pelo OTK congelado, sem cobertura geral.
**Não pode afirmar:** que revoga o resultado negativo da H1 (07/10) para o Haiku 4.5 (protocolos e amostras diferentes; o de 07/10 continua válido; "o perfil 07/10 passaria aqui" é só descritivo); que o OTK verificou cobrança ou detectou inflação real (inflação só simulada); cache, multimodal, multi-turn, system, ferramentas, streaming, tokens de saída; estabilidade além de 40 min de 15/10; que os perfis estão em uso no H1; que CAL-02 é "três evidências" (é uma); que os perfis v2 foram validados pela política v1.

## 7. Implicação para o estudo novo (M2 estratificado)

- **Amostra existente para DESENVOLVER:** sim. CAL-01 treino+validação (215 textos × 4 modelos = 645 obs. + 143 Haiku 4.5 adicionais se incluído) e CAL-02 desenvolvimento (720 textos × 3 modelos, rótulos gratuitos) = **2.805 observações / 312 grupos**, já usados para desenvolver o M2. Podem ser reusados para desenvolvimento, inclusive estratificado por família, **sem** tocar holdouts.
- **Holdouts já vistos (não usar para selecionar nada):** CAL-01 holdout (72 textos × 4 modelos, inclusive Haiku 4.5) e CAL-02 holdout (192 × 3). Ambos já tiveram uma olhada; usá-los para escolher estimador/limiar é a "terceira olhada" que o protocolo da CAL-02 recusou. Podem ser citados como **comparativo pós-hoc rotulado**, nunca como validação.
- **Split independente novo necessário:** um holdout **inédito** por grupo, gerado com semente nova e **verificação de não colisão de texto** contra CAL-01 (288), CAL-02 dev (720) e CAL-02 holdout (192) — o achado K-02-A mostra que a família curtíssima colide por construção; recomendo excluir ou regenerar textos curtíssimos com namespace de vocabulário distinto. Tamanho mínimo pela política v1: holdout ≥ 30 e ≥ 10 grupos; pela v2.candidate ≥ 150 e ≥ 50 grupos; para separar famílias com IC útil, ≥ 24 por família (como na CAL-02). Se o M2 estratificado for avaliado também no Haiku 4.5, é uma célula **nova** (M2 nunca foi avaliado nesse modelo). Rótulos gratuitos de `count_tokens` servem para desenvolvimento; o holdout confirmatório deve usar `usage.input_tokens` **pago** (alvo real do protocolo) e, se o estudo quiser sair da circularidade, incluir ao menos um oráculo que não seja da Anthropic (ex.: fatura/CSV do console por dia, reconhecendo a granularidade).
- **Custo de referência:** CAL-02 gastou US$ 0,85 por 579 chamadas; um holdout de 192 textos × 3 modelos novos cabe em ≈ US$ 0,9; × 4 modelos (com Haiku 4.5, 10× mais caro por token que o Haiku 5.5) ≈ US$ 1,0.

## Bloqueios
Nenhum para incorporar como suplementar. Decisões do autor: (i) citar K-02-A na CAL-02 se ela entrar no texto; (ii) ao citar custos por modelo, escolher a tabela (com smoke) ou o JSON (`core`); (iii) política v1 × v2.candidate explicitada sempre que CAL-02 for mencionada.
