# H2-EVAL executor — interfaces (B2: R11/R12 core+record, R13 cache, R14 modal)

Versão `h2eval.interfaces.v0.1` (2026-11-10, rev. 2). Dona: BOT-02 (integradora). Base imutável: H1 `7606bc9b`. Contrato de dados:
`runs/B1/CONTRACT_MIN_FOR_EXECUTOR.md` (`h2eval.contract.min.v0`, sha256 `89be88ed…`) **+ adendo `CONTRACT_MIN_FOR_EXECUTOR_R2.md`**
(`v0.1`, sha256 `d52be4df…`, aditivo); matriz R07 R2; método R09 R2; pré-registro R10 R2 (aguarda ratificação: tudo parametrizável,
sem semente/tamanho fixos no código); compatibilidade R08; preflight de contas R16 (`H2EVAL_ENV.example`) e modelo de GO R17
(`h2eval.go.v1`). Tipos: `scripts/h2eval/types.ts`. **Rev. 2 (adendo):** §3 `split += COMPARATIVE`, `phase += COMPARATIVE_PAIRED`,
`params.thinking`, `params.cacheTtlRequested`, `params.serviceTierRequested?`; §4 `costCap.reasoningAllowanceTokens` + `capBasis`,
`counter.exploratoryFormulaEstimate|null`; §5 `modelDeprecation`, `exclusion`; §6 lote ≤ 60 chamadas e um modelo por lote, teto de
lote ≤ 25% do sub-ledger, `PAUSE_REVIEW_AT_80PCT`; §7 estado `NOT_RUN_BRANCH_LOCKED` (Google), GO `h2eval.go.v1`, nomes `H2EVAL_*`.

## 0. Regras que valem para as três frentes

1. **Só ADICIONAR** sob `scripts/h2eval/**` e `test/h2eval/**`. `git diff 7606bc9b -- . ':!scripts/h2eval' ':!test/h2eval'` fica vazio.
2. **Reutilizar por import** o contador da H1 (`src/tokenization/localCounter.ts`, `COUNTER_VERSION`), os tipos `src/types/d1d8/*`
   e as tabelas de preço congeladas (`scripts/pilot/price_table_*.json`, esquema `otk.price_table.v1`) como modelo. Nunca editá-los.
3. **Dado ausente nunca é zero**: todo contador é `number | 'UNKNOWN' | 'NOT_APPLICABLE'` (`Count`). Dinheiro = pico-USD em string
   decimal (`PicoUsd`), aritmética em `BigInt`.
4. **Sem conteúdo nos registros**: prompt/resposta ficam em `content/<sha256>` (dono: E2E-01). Journal, snapshot, usage, ledger e
   logs só carregam ids, hashes, contagens e pico-USD.
5. **Sem credencial em código, journal ou log.** A chave só existe em `process.env.<VAR>` do processo e só é lida pelo core no
   instante do envio REAL (modo inalcançável nos testes). Um canário no teste prova que ela nunca aparece em nenhum arquivo.
6. **Sem retry, sem fallback, concorrência 1.** O adaptador não faz I/O.
7. Ordem imutável de uma operação: `PLANNED` → `PRECALL_SNAPSHOT_COMMITTED` (fsync) → `RESERVED` (fsync) → `SENT` (fsync) → egress
   → `RESPONSE_RECEIVED | ERROR_WITH_USAGE | ERROR_NO_USAGE | TIMEOUT_UNCERTAIN` → `USAGE_PARSED` → `COST_COMPUTED` → `SETTLED`.

## 1. Divisão por diretório

| Diretório | Dono | Entrega |
|---|---|---|
| `scripts/h2eval/core/` | BOT-02 | `ids.ts` (operationId), `journal.ts` (append-only + hash chain + fsync), `ledger.ts` (sub-ledgers US$ 5/3/3, campanha 11, lote, reserva/liquidação), `stop.ts` (arquivo de stop, watchdog), `runner.ts` (máquina de estados serial, replay, modos OFFLINE/REAL), `egress.ts` (allowlist de hosts, injeção da credencial, modo REAL só com flag + arquivo de GO) |
| `scripts/h2eval/record/` | BOT-02 | `snapshot.ts` (snapshot pré-call imutável, hash canônico), `usage.ts` (validação/normalização do `NormalizedUsageH2` devolvido pelo adaptador; `cacheObserved`), `cost.ts` (teto `costCap`, custo ex post pela tabela, intervalo de cache, `capCovered`) |
| `scripts/h2eval/modal/` | MET-02 | um `ProviderAdapter` por provedor/API (`openai.chat_completions`, `anthropic.messages`, `gemini.generate_content`; imagem/áudio como partes), parsers de usage e de recusa, `modelSupport` do catálogo H1 |
| `scripts/h2eval/cache/` | E2E-01 | `ContentStore` (corpus/diálogos por hash), construção dos braços S1/S2_NOHIT/S3_HITATTEMPT (nonce, prefixo estável, diretivas por API), auditoria da diferença de tokens do nonce |
| `test/h2eval/<frente>/` | cada frente | node:test, offline, dublês |

## 2. Interface do adaptador de provedor (`ProviderAdapter`, dono MET-02)

```ts
interface ProviderAdapter {
  provider: 'openai'|'anthropic'|'google'; api: UsageApi; adapterVersion: string; officialHosts: readonly string[];
  buildRequest(plan: OperationPlan, content: ResolvedContent): BuiltRequest;   // puro
  parseRefusal(httpStatus: number, body: unknown): ParsedRefusal;              // puro
  parseUsage(body: unknown): NormalizedUsageH2;                                // puro
  modelSupport(modelRequested: string): ModelSupport;                          // catálogo H1
}
```

- `buildRequest` devolve `url` (host oficial), `headers` **sem** a credencial, `credentialHeader`/`credentialFormat` (o core injeta),
  `body` exato (o core calcula `requestBodySha256` sobre a serialização canônica), `textParts` (para o contador local) e
  `nonTextParts` (imagem/áudio/ferramentas ⇒ `UNSUPPORTED_FOR_ESTIMATION`). O adaptador **aplica** `plan.params` (max_tokens,
  temperatura, raciocínio, `service_tier`, diretivas de cache) e **nunca** inventa parâmetro não documentado no R08.
- `parseUsage` normaliza para as categorias do contrato §4, com a semântica do R08/MET-01:
  OpenAI `prompt_tokens` **inclui** `cached_tokens`; Anthropic `input_tokens` **exclui** leitura/escrita; Gemini `promptTokenCount`
  **inclui** `cachedContentTokenCount`, `thoughtsTokenCount` é parcela separada cobrada como saída. `U` = total de entrada
  normalizado. `cacheObserved` pelo uso: `HIT` se `cacheRead>0`, `CREATION` se `cacheRead=0` e escrita>0, `NO_HIT` se ambos 0,
  `UNKNOWN` se incompleto. `rawUsageSanitized` = só números. `modelServed` bruto.
- `parseRefusal`: código fechado, nunca texto do provedor; `usagePresent` distingue `REFUSED_WITH_USAGE`/`ERROR_WITH_USAGE` de
  `ERROR_NO_USAGE`.
- Campos de uso por provedor (R08): OpenAI `usage.prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`,
  `…audio_tokens`; Anthropic `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `cache_creation.ephemeral_5m_input_tokens/ephemeral_1h_input_tokens`, `output_tokens_details.thinking_tokens`; Gemini
  `usageMetadata.promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`,
  `promptTokensDetails[modality]`.

## 3. Plano de operação (`OperationPlan`) e identidade

- `operationId = sha256(protocolHash + ':' + cellId + ':' + promptId + ':' + rep + ':' + modelRequested)` (`core/ids.ts`,
  determinístico; o runner **consulta o journal** e não reenvia uma operação já `SENT`/terminal: `REPLAY_SKIPPED`).
- O plano vem do manifesto (R10): `split` (`train|validation|holdout|NONE|COMPARATIVE`), `phase` (`PILOT|CONFIRMATORY|
  EXPLORATORY_MODALITY|COMPARATIVE_PAIRED`), `plannedCacheArm`, `params`, hashes do conteúdo. O runner nunca deriva nada do
  resultado. `prefixSha256`/`nonce` são `NOT_APPLICABLE` fora de S2/S3.
- `params` (rev. 2, **obrigatórios antes do R15**): `thinking {mode: none|adaptive|manual|minimal, effort?|budgetTokens?|thinkingLevel?}`
  (R08 §8: Haiku 5.5 adaptativo por padrão; Gemini sem "off" ⇒ `minimal`; Haiku 4.5 ⇒ `none`) e `cacheTtlRequested: 5m|1h|NOT_APPLICABLE`
  (o teto usa sempre o TTL **mais caro**, independentemente do pedido). Opcional: `serviceTierRequested` (alias do contrato para `serviceTier`).
- Conteúdo: `plan.promptSha256` → `ContentStore.get()` → `ResolvedContent` (mensagens neutras com partes `text|image|audio`;
  `prefixMessages` delimita o prefixo estável). Binários por `getBytes(sha256)`; nunca logados.

## 4. Snapshot pré-call (`PrecallSnapshot`, dono BOT-02/record)

Gravado e **fsync** antes de `SENT`. `snapshotSha256 = sha256(JSON canônico do objeto sem o próprio campo)`; recomputado em toda
leitura; mismatch ⇒ `tamper` (teste prova que sobrescrever/alterar um byte é detectado e que a 2ª escrita do mesmo `snapshotId`
é recusada). Campos: identidade, `requestBodySha256`, `counter {version, L0, status, reasons}` (contador H1: `incomplete` ⇒
`estimateStatus = UNSUPPORTED_FOR_ESTIMATION`, `L0` fica `UNKNOWN`), `covariates` (só pré-call), `profile|null`,
`expectedCostUsd | 'UNKNOWN'`, `priceSnapshot {id, sha256, capturedUtc}`, `costCap {usd, basis, inputUpperBoundTokens,
maxOutputTokens, reasoningAllowanceTokens, capBasis {inputPriceMicro, cacheWritePriceUsedMicro, cacheWriteTtlUsed 5m|1h|NONE,
outputPriceMicro, roundedUpToMicroUsd}}`, `budgetBefore`, `cachePlan {arm, directives, minPrefixTokens, expectedBehavior}`.
`counter.exploratoryFormulaEstimate` (rev. 2 item 7): só para imagem, `{tokens, formula openai_tile|anthropic_28px|gemini_rough,
rawInputs}` ou `null`; **nunca substitui `L0`** (que segue `UNKNOWN` com `UNSUPPORTED_FOR_ESTIMATION` fora de texto puro).

`costCap` (pior caso, R07 R2 / R10 R2 §5.1 / adendo item 6): `inputUpperBoundTokens × max(preço entrada, preço de escrita de cache
no TTL mais caro) + (maxOutputTokens + reasoningAllowanceTokens) × preço de saída`, em pico-USD, **arredondado para cima ao
micro-USD**. A folga de raciocínio é política injetada pelo chamador (`CapPolicy.reasoningAllowanceTokens`: Haiku 5.5 1 024, Gemini
2 048, demais 0; parametrizável, não fixada no código); APIs que cobram raciocínio à parte (`gemini.generate_content`) **recusam folga 0**
(fail-closed, porque "`max_tokens` inclui raciocínio" é NOT_VERIFIED). `capBasis` registra o preço de escrita usado e o TTL. Preço ausente
para qualquer categoria necessária ⇒ `STOP_PRICE_UNKNOWN` **antes** de reservar. Nota do contador H1: pré-chamada a categoria
`output` é sempre `uncovered` (status `incomplete` é o estado normal); `L0` só é numérico quando `input` foi contado, nada do input
ficou descoberto e todas as partes são texto.

## 5. Registro pós-call (`PostcallRecord`, `CostTable`)

`usage` (ou `null`), `outcome`, `cost {usd|UNKNOWN, state CALCULATED|ESTIMATED|UNKNOWN, byCategory, capCovered, cacheInterval,
billing {NOT_AVAILABLE|PENDING|RECONCILED, observedUsd: null|…}, possiblyCharged}`. `billing.observedUsd` é **null** até conciliação
por lote (nunca estimado, nunca 0). `capCovered=false` ⇒ `STOP_GLOBAL` (falha de segurança). `TIMEOUT_UNCERTAIN`/queda ⇒
`UNCERTAIN_ISOLATED`, `possiblyCharged=true`, custo `UNKNOWN` com o teto como limite superior; **nunca reenvio automático**.
Rev. 2: `modelDeprecation` (`DEPRECATED_SHUTDOWN_2027-01-14|LEGACY|ACTIVE|UNKNOWN`, via `adapter.modelDeprecation?` opcional, R08 §1)
e `exclusion` (`NONE|EXCL_MODEL_MISMATCH`: `modelServed` fora do conjunto aceito pré-registrado `acceptedModelsServed[modelRequested]`,
com IDs datados; registrado, nunca descartado em silêncio; conta como falha para a pausa por falhas seguidas). Campos opcionais do uso
(rev. 2 itens 8/9): `promptTokensDetailsByModality`, `cacheRoundingNote: openai_128|NONE`, `nonceTokensDeclared` (S2).

## 6. Journal e ledger (dono BOT-02/core)

- `journal.jsonl`: `JournalLine {schema, seq, tsUtc, kind, operationId, body, prevHash, hash}`; `hash = sha256(linha canônica sem hash)`;
  `prevHash` encadeia; `seq` crescente; **append + fsync** por linha; verificação recusa buraco, reordenação ou edição.
- `ledger.jsonl` (eventos `reserve|settle|release|uncertain`) e `LedgerState` derivado: sub-ledgers `openai 3 / anthropic 5 / google 3`
  (pico-USD), campanha 11; **sem transferência cruzada**; reserva = `costCap` gravada antes de `SENT`; liquidação pelo custo calculado
  (`UNKNOWN` ⇒ fica como `possiblyCharged`, conta contra o sub-ledger, até conciliação).
- Lote (R10 R2 §5.1, adendo item 12): teto do lote **nunca acima de 25% do sub-ledger** do provedor (`batchesUsd` explícito acima disso
  é recusado; ausente ⇒ exatamente 25%); **≤ 60 chamadas** por lote (`maxBatchCalls`, o GO pode baixar, nunca subir) e **um modelo por
  lote**, ambos contados pelo journal (sobrevivem a reinício): `STOP_BATCH_SIZE`, `STOP_BATCH_MODEL_MIX`.
- Ao atingir **80%** do sub-ledger (comprometido = gasto + possivelmente cobrado + reservado): `PAUSE_REVIEW_AT_80PCT` antes de qualquer
  envio; só continua com `pauseAck[provider] = true` explícito (revisão humana), e mesmo assim nunca acima dos tetos.
- Paradas (`StopReason`): arquivo de stop (`STOP_FILE`, lido antes de cada operação), reserva excederia sub-ledger/lote/campanha
  (`STOP_BUDGET_*`), `STOP_CAP_VIOLATION`, `STOP_PRICE_UNKNOWN`, `STOP_PERSISTENCE` (fsync falhou), `STOP_UNCERTAIN`,
  `STOP_WATCHDOG` (tempo; extra, não substitui dinheiro), `STOP_CONSECUTIVE_FAILURES` (2 seguidas no mesmo modelo; proposta R10).

## 7. Modos e egress

- `mode: 'OFFLINE'` (único executável agora): `egress` é um dublê local injetado (função), sem socket; o runner é idêntico.
- `mode: 'REAL'`: exige **flag explícita** na configuração **e** arquivo de GO `h2eval.go.v1` válido (R17_GO_TEMPLATE.md; validador puro
  `validateGoV1` em `core/egress.ts`): nenhum `<placeholder>` no texto; `campaign`, `phase`, **um** `provider`, `modelIds ∋ modelRequested`,
  `batch.batchId` iguais aos do plano; `batch.maxCalls ≤ 60` e `oneModelPerBatch`; `caps.globalCampaignUsd = 11` e
  `pauseAtFractionOfSubLedger = 0.8`; `executor.version` e `executor.codeSha` **exatamente** os do executor; `preregistration.sha256`
  igual ao hash ratificado configurado (`preregistrationSha256`; sem ele REAL é inalcançável); janela `notBeforeUtc ≤ agora < expiresUtc`
  e `expiresUtc − agora ≤ 24 h`; `stops` com os 9 itens; `signedBy: human:<nome>` + `signatureStatement`; `goDigestSha256 = sha256(JSON
  canônico sem o campo)`. Além disso, nenhuma variável **proibida** no processo (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `GOOGLE_API_KEY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NODE_OPTIONS` ⇒ `FORBIDDEN_ENV_PRESENT`) e a variável da chave presente. Sem qualquer
  um ⇒ `ABORTED_BEFORE_SEND`, sem reserva, sem snapshot. Nos testes o modo REAL é **inalcançável** (prova: flag sem GO; GO sem flag;
  flag + GO v1 válido sem chave; flag + GO sem pré-registro configurado; flag + GO + chave com variável proibida — em todos nada sai
  e fetch nunca é chamado).
- Nomes de ambiente alinhados ao R16 (`H2EVAL_ENV_NAMES` em `core/egress.ts`): `H2EVAL_ANTHROPIC_API_KEY`, `H2EVAL_OPENAI_API_KEY`,
  `H2EVAL_GOOGLE_API_KEY` (credenciais, lidas só no `send` REAL), `H2EVAL_GO_FILE`, `H2EVAL_BATCH_DIR`, `H2EVAL_STOP_FILE`,
  `H2EVAL_BUDGET_CAMPAIGN_USD` (caminhos/fixos: o chamador passa para a configuração; o core não lê o ambiente para configurar).
- Braço **Google** (`lockedProviders`, padrão `['google']`; R10 R2 decisão 2; R16 §6): em OFFLINE é sempre `NOT_RUN_BRANCH_LOCKED`
  (terminal, nada reservado, nada enviado); em REAL só abre com GO **próprio** (o GO vale para um provedor; a validação é por provedor).
- Host do `url` tem de estar em `adapter.officialHosts` ∩ allowlist do core; credencial injetada no cabeçalho só no envio, nunca
  copiada para journal/snapshot/log; `redirect: 'error'`; `maxRetries 0`.

## 8. Artefatos por lote (`<batchDir>/`)

`journal.jsonl`, `ledger.jsonl`, `snapshots/<operationId>.json`, `records/<operationId>.json`, `content/<sha256>` (E2E-01),
`usage_raw_sanitized.jsonl`, `exclusions.jsonl`, `MANIFEST.json` (sha256 de cada arquivo, `executorVersion`, `executorCodeSha`,
`protocolHash`), `STOP` (arquivo de parada, presença basta). Journal rev. 2: kinds `NOT_RUN_BRANCH_LOCKED` e `PAUSE_REVIEW` adicionados.

## 9-bis. Integração realizada (`scripts/h2eval/index.ts`, BOT-02; TERMINAL_B2_INTEGRATION.json)

- `createH2EvalExecutor({batchDir, ledger, egress, capPolicy{inputUpperBoundTokens, reasoningAllowanceTokens?}, executorCodeSha, …})`:
  core `createExecutor` + `ADAPTERS` do MET-02 (com `modelDeprecation` do `contract_r2`) + `createContentStore` do E2E-01 envolto por
  `withResolvedBinaries` (bytes de imagem/áudio buscados por hash e anexados como `bytesBase64` só para o adaptador puro; nunca no
  journal/snapshot/registro) + tabela de preços h2eval-v1 do MET-02 adaptada por `priceTableFromModal` (tiers por comprimento do prompt:
  `micro(..., promptTokensHint)` — o teto usa o limite superior de entrada, o custo usa o `U` observado; `null` nunca vira 0; tiers
  `REFERENCE_ONLY` nunca usados) + `exploratoryFormulaFor` (fórmulas EXPERIMENTAIS do MET-02 só para imagem; `L0` segue `UNKNOWN`).
- Custo: categorias **disjuntas** (os parsers do MET-02 separam `outputVisible` e `reasoning`): raciocínio é cobrado ao preço de saída em
  toda API; `cacheObserved` depende só das contagens de cache (saída desconhecida não esconde o braço observado).
- Achados **fechados** (R14-FIX do MET-02, head `5e58178e`, + ajuste autorizado da integradora em `cache/dialogs.ts`):
  **F-INT-1** — o adaptador é a **fonte única** do corpo (`bodyOf(plan, content)` em `modal/index.ts`); `renderCall` (E2E-01) passou a
  **derivar** o corpo de referência de `bodyOf` (função `planOfCall` monta o `OperationPlan` da chamada; `openaiTokenParam` e
  `googleThinkingLevel` ficaram sem efeito); o plano de operações do R15 grava `bodySha256` por operação e o teste de integração exige
  `bodySha256` **igual** entre referência, corpo enviado e `requestBodySha256` do journal, nos 4 modelos, S2 e S3 (fixture
  `dialogs.testseed.json` regenerada). **F-INT-2** — Haiku 4.5 sem `output_tokens_details` e sem thinking ⇒ `reasoning NOT_APPLICABLE`,
  `outputVisible = output_tokens` ⇒ custo CALCULATED; braço operante (21/21 no ensaio).

## 9-ter. Endurecimento R15 (revisão independente B06, `runs/R15/R15_REVIEW_PHASE1.md`)

- **R15-A1** tetos efetivos nunca acima de 11 / 5 / 3 / 3 (`assertCapsWithinDefaults` em `openLedger`); o GO tem de declarar
  exatamente os tetos efetivos (`perProviderSubLedgerUsd`, `globalCampaignUsd`, `perBatchUsd` quando o lote tem teto) ⇒ `GO_CAPS_MISMATCH`.
- **R15-M1** replay confere `promptSha256`, braço e `requestBodySha256` contra a linha `PLANNED` ⇒ `REPLAY_PLAN_MISMATCH` / `STOP_REPLAY_PLAN_MISMATCH`.
- **R15-M2** trinco `<batchDir>/.lock` (`wx`, pid+nonce): titular ocupado no processo ou pid vivo estranho ⇒ `BatchLockedError`; instância
  ociosa do mesmo processo é superada (reinício) e perde o trinco (`LOCK_LOST`); `close()` libera.
- **R15-M3** na abertura o comprometido por provedor é reconstruído do journal e comparado ao ledger ⇒ `LedgerReconciliationError` recusa abrir.
- **R15-M4** `pauseAck` é uma lista assinada (`human:<nome>`, `source: go|operator`, `reference`), journalizada como `PAUSE_ACK`; em REAL só vale
  a do GO (`pauseAck80pct.acknowledgedBy`).
- **R15-M5** todo envio é limitado por `timeoutMs` (padrão 120 s; `AbortSignal.timeout` no fetch) ⇒ `TIMEOUT_UNCERTAIN`, reserva mantida.
- **R15-B3** `send` exige o token de uso único emitido pelo `preflight` para o mesmo corpo. **R15-B4** `headersTemplate` removido dos
  adaptadores. **R15-B1** `freeze-corpus` recusa referências não comparadas (`--allow-not-compared` só em ensaio). **R15-B5** o detector de
  placeholder recusa qualquer `<…>` no GO, inclusive em `signatureStatement`.

## 9-quater. Campanha R18–R20 (`cli/campaign.ts`, C143-A) e credencial por caminho (`core/envFile.ts`, lacuna R16)

- `plan --phase campaign`: lotes ≤ 60, um modelo **e um bloco** por lote, ordem travada **treino → comparativo → validação → holdout**
  (`block`, `order` no plano). Trava de código em `run --campaign-dir`: validação exige `gates/TRAIN_FROZEN.json` (`freeze-train`: todo lote de
  treino/comparativo terminal, sem reserva aberta, datasets exportados e hasheados); holdout exige `gates/VALIDATION_SELECTED.json` (`select`:
  perfil preditor com `paramsSha256`, assinado `human:`, após todos os lotes de validação terminais); `protocolHash` do gate tem de bater.
  No holdout o perfil selecionado e o `expectedCostUsd` entram no **snapshot pré-call** (imutável) via `ExecutorConfig.predictor`.
- `run-authorized --go <GO multilote>` (C144, ver 9-quinquies): vários lotes de UM GO `h2eval.go.multi.v1`, em série, na ordem do plano; o
  escopo assinado `h2eval.authorized_scope.v0` (C143-A) foi **substituído** pelo GO multilote, em OFFLINE e em REAL.
- `H2EVAL_ENV_FILE`: caminho (não secreto) de um arquivo lido **só** em REAL, **após** o preflight do GO, **só** a linha `H2EVAL_<PROVEDOR>_API_KEY=`;
  localização conferida por metadados (absoluto, existente, fora de árvore Git e de pasta de sync, ACL sem grupo amplo); variável **e** arquivo
  ⇒ `CREDENTIAL_SOURCE_AMBIGUOUS`; OFFLINE nunca abre o arquivo; valor nunca vai a `process.env`, journal, snapshot, registro ou erro.
- `--executor-sha` só é aceito quando nomeia o HEAD do checkout; REAL exige árvore limpa (`EXECUTOR_TREE_DIRTY`).
- **R15-D-1/D-2 (G15 sobre `26854a80`)**: `gateFor` revalida o artefato **inteiro** a cada uso — `TRAIN_FROZEN`: esquema, `protocolHash`, linhas com
  digests hex64 e `terminal == operations`, `sha256OfBatchList` **recalculado**, lista igual aos lotes de treino/comparativo do plano, tabela de
  forecast (`holdoutRead !== true`); `VALIDATION_SELECTED`: esquema, `protocolHash`, `selectedBy human:`, `paramsSha256 == sha256(params)`,
  `TRAIN_FROZEN` atual revalidado **e** `trainFrozenSha256` igual ao seu sha256 (alterado após o `select` ⇒ `GATE_TRAIN_FROZEN_CHANGED`), lista de
  validação igual ao plano. Códigos: `GATE_ARTIFACT_UNREADABLE/_SCHEMA`, `GATE_PROTOCOL_MISMATCH`, `GATE_BATCH_LIST_INVALID/_SHA_MISMATCH/_NOT_PLAN`,
  `GATE_FORECAST_INVALID/_READ_HOLDOUT`, `GATE_UNSIGNED`, `GATE_PROFILE_INVALID/_SHA_MISMATCH`, `GATE_TRAIN_FROZEN_CHANGED`. O digest do gate usado vai
  ao snapshot pré-call (`PrecallSnapshot.gateUsed {block, file, sha256}`, selado; `null` em treino/comparativo/piloto). Testes: `test/h2eval/cli/gates.test.ts`.

## 9-quinquies. GO multilote, ledger de estudo e política dos 80 % (C144, D144-03..06)

- **GO multilote `h2eval.go.multi.v1`** (`core/egress.ts: validateGoMultiV1`, exemplo em `runs/R18_R20/GO_EXAMPLE_h2eval.go.multi.v1.json`):
  `preregistrationSha256` ratificado, `executorCodeSha` = HEAD do checkout (em REAL, árvore limpa ⇒ `GO_EXECUTOR_TREE_DIRTY`), `planProtocolHash`,
  `batchIds` **explícitos e finitos** (curinga `*`/`?`/`all`, lista vazia ou duplicata ⇒ `GO_BATCHIDS_INVALID`; lote fora do plano ⇒
  `GO_BATCH_NOT_IN_PLAN`), `providers`/`modelIds` iguais ao escopo, `caps` **iguais** ao ledger efetivo **e** aos padrões (11 / 5 / 3 / 3, pausa 0,8;
  qualquer diferença ⇒ `GO_CAPS_MISMATCH`), `maxAttempts` ≤ nº de operações planejadas no escopo **e** ≤ 1 446 (`GO_MAX_ATTEMPTS`), janela UTC
  `notBeforeUtc`/`notAfterUtc` ≤ 72 h (`GO_NOT_YET_VALID`/`GO_EXPIRED`/`GO_WINDOW_TOO_LONG`), `nonces` por lote (hex 16–64, únicos;
  `GO_NONCES_INVALID`), `requiresG17ForCampaignBatches: true` obrigatório, `stops` completos, `signedBy: human:<nome>`, `goDigestSha256`
  canônico; opcionais por provedor `pauseAck80pct` e `preAuthorizeTo100pct` (ambos `human:` ⇒ senão `GO_PAUSE_ACK_INVALID`).
- **Execução** (`cli/run.ts: runAuthorized`): em SÉRIE, na ordem do plano (nunca a do GO), sob **um trinco de campanha** `<campaignDir>/.campaign.lock`
  (pid vivo ⇒ `DirLockedError`; uma operação paga por vez, global) e **um ledger de estudo** `<campaignDir>/ledger.jsonl` compartilhado por piloto e
  campanha (D144-04: 5/3/3 e 11 agregados; reconciliado na abertura com **todos** os journals de `<campaignDir>/batches/*/journal.jsonl` ⇒ o
  gasto do piloto é herdado pela campanha; antes da C144 cada lote abria o seu próprio ledger e os tetos não se somavam — corrigido).
  `status --ledger <caminho>` lê o ledger de estudo.
- **Anti-replay** (`cli/campaign.ts: registerNonce`, `<campaignDir>/go_nonces.jsonl`): lote iniciado sob o nonce N só continua (replay do journal)
  sob o mesmo N (`GO_NONCE_MISMATCH_FOR_STARTED_BATCH`); um nonce nunca serve a dois lotes (`GO_NONCE_REUSED`). Ambos param a série.
- **G17 por modelo** (`gate-g17`, `gates/G17_<modelo>.json`, `h2eval.gate.g17.v0`, `verdict PASS|FAIL|NOT_RUN`, `pilotProtocolHash`, `human:`):
  exigido para **todo** lote fora do bloco `pilot`; modelo sem `PASS` (ausente, `FAIL`, `NOT_RUN`, piloto diferente) ⇒ seus lotes `SKIPPED_GATE`
  e **os outros modelos seguem**. Um lote `SKIPPED_GATE` nunca é enviado; `freeze-train` continua a exigir todo lote de treino terminal, logo o braço
  tem de correr sob um GO posterior ou sair do plano antes da passagem a validação.
- **Google (D144-03)**: permanece `NOT_RUN_BRANCH_LOCKED`/`SKIPPED_GATE` salvo se o GO lista `google` **e** existe `gates/G16_GOOGLE.json`
  (`gate-g16-google`, `h2eval.gate.g16_google.v0`, `verdict PASS` com as quatro garantias `true`: projeto/faturamento dedicados, limite de
  exposição efetivo verificado, saídas/raciocínio cobrados verificados, credencial verificada, assinado `human:`).
- **Travas de bloco continuam valendo**: validação sem `TRAIN_FROZEN` / holdout sem `VALIDATION_SELECTED` ⇒ a série **para e espera** o artefato
  (`GATE_TRAIN_NOT_FROZEN`/`GATE_VALIDATION_NOT_SELECTED`, `HALT_ALL`); o GO multilote **não** dispensa gate algum.
- **Tabela de STOPs (`STOP_POLICY` em `cli/run.ts`)**: `HALT_ALL` (tudo para) = `STOP_FILE`, `STOP_BUDGET_CAMPAIGN`, `STOP_BUDGET_PROVIDER`,
  `STOP_BUDGET_BATCH`, `STOP_BUDGET_OPERATION`, `STOP_CAP_VIOLATION`, `STOP_PERSISTENCE`, `STOP_UNCERTAIN`, `STOP_REPLAY_PLAN_MISMATCH`,
  `STOP_WATCHDOG`, `PAUSE_REVIEW_AT_80PCT`, `STOP_MAX_ATTEMPTS`, falhas de gate/nonce e **qualquer código desconhecido**; `ISOLATE_ARM` (pula os
  lotes restantes daquele MODELO, os outros seguem) = `STOP_CONSECUTIVE_FAILURES`, `STOP_PRICE_UNKNOWN`, `STOP_BATCH_SIZE`, `STOP_BATCH_MODEL_MIX`,
  `NOT_RUN_BRANCH_LOCKED`, `SKIPPED_GATE`. Operação incerta nunca é repetida.
- **Pausa 80 % (D144-06, `core/runner.ts`)**: sem `preAuthorizeTo100pct` ⇒ `PAUSE_REVIEW_AT_80PCT` (comportamento anterior; `pauseAck80pct`
  assinado continua a ser a outra via, journalizada `PAUSE_ACK`). Com `preAuthorizeTo100pct` assinado para o provedor: no checkpoint o executor
  journaliza `PAUSE_PREAUTHORIZED` (uma vez por provedor) e segue **somente se** `spent + possiblyCharged + reserved + Σ costCap restante do
  escopo` ≤ sub-ledger; senão `PAUSE_REVIEW` com `preauthorized: true`, `detail: future_reservations_exceed_subledger` e para. Reserva futura
  do escopo = `ExecutorConfig.remainingScopeCapPico` (em `run-authorized`, soma dos `costCap` dos lotes ainda não corridos do mesmo provedor,
  excluídos os braços isolados).
- **Tentativas (D144-04)**: `ExecutorConfig.attemptsBudget` conta cada `SENT` do escopo; `used ≥ max` ⇒ `STOP_GLOBAL` / `STOP_MAX_ATTEMPTS`
  **antes** de `PLANNED`.
- **Estados/kinds novos**: `OperationState += SKIPPED_GATE`; `JournalKind += PAUSE_PREAUTHORIZED, SKIPPED_GATE`; `StopReason += STOP_MAX_ATTEMPTS`.
- Testes: `test/h2eval/cli/multigo.test.ts` (validador: expirado, ainda não válido, janela, lote fora do plano, curinga, nonces, SHA errado, árvore
  suja, tetos, maxAttempts, pré-registro, placeholder, digest, G17, assinatura; piloto + campanha em série; G17 FAIL isola um modelo; Google sem
  G16; nonce reaberto/reusado; trinco; ledger herdado; REAL recusado) e `test/h2eval/core/preauth.test.ts` (80 % sem/com pré-autorização, reserva
  futura estourando, pré-autorização não assinada, `STOP_MAX_ATTEMPTS`).

## 9-sexies. PROPOSTA do ciclo 2 (C147, incidente R17-001) — NÃO ADOTADA; branch `experiment/otk-h2-eval-cycle2-prop-20261111` sobre `d2c60a98`

Qualquer adoção muda o SHA do executor e **exige novo G15 (delta) e novo GO**; nada disto vale para a janela do GO-1. Decisão do autor.

- **A. Classificação da falha de envio** (`core/egress.ts: classifySendFailure`, `core/runner.ts`): a linha `TIMEOUT_UNCERTAIN` passa a carregar
  `causeCode` (identificador NÃO secreto do undici/Node — `e.cause.code` ou `e.code`, só `^[A-Z][A-Z0-9_]{2,63}$`, p.ex. `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
  `ECONNREFUSED`, `ENOTFOUND`; `TIMEOUT` para `EgressTimeout`/`TimeoutError`; senão `UNKNOWN`), `phaseHint` **derivado** da camada do código
  (`tls` | `dns` | `connect` | `timeout` | `unknown`; `ECONNRESET`/`EPIPE` ⇒ `unknown`, pois podem ocorrer depois do envio) e `elapsedMs` desde `SENT`.
  Texto de mensagem (pode conter URL/host) nunca entra no journal. **O estado não muda**: `UNCERTAIN`, isolado, `possiblyCharged`, reserva mantida,
  nunca reenviado. **Avaliação honesta de `NOT_SENT_PRECONNECT`**: o `fetch` nativo não expõe se algum byte foi escrito no socket; a inferência "código
  de verificação de certificado ⇒ nenhum byte HTTP" é de protocolo (o cliente HTTP só escreve após `secureConnect`), não observação do executor. Um
  estado comprovável exigiria transporte instrumentado (undici `Agent` com `connect` próprio que intercepta `socket.write`, ou `node:https`) —
  descrito em `runs/R17_REAL/CYCLE2/CYCLE2_PROPOSAL.md`, **não implementado**; por isso a operação continua `UNCERTAIN`.
- **A'. Variáveis proibidas**: `H2EVAL_ENV_NAMES.forbidden += SSLKEYLOGFILE, NODE_TLS_REJECT_UNAUTHORIZED` (⇒ `FORBIDDEN_ENV_PRESENT` em REAL).
- **B. `preflight-connectivity --provider <p> --campaign-dir <dir>`** (`cli/preflight.ts`): sonda **sem credencial** no ambiente idêntico ao do
  lançamento: (1) `tls.connect` com verificação integral (`rejectUnauthorized: true` fixo no código; teste de fonte proíbe o contrário) registrando
  emissor, sujeito, fingerprint sha256 da folha, validade e protocolo; (2) `GET` ao endpoint documentado sem cabeçalho de credencial, esperado **401**
  (Google 401|403); outro status ⇒ `HTTP_STATUS_UNEXPECTED`. Resultado anexado a **`<campaignDir>/campaign_journal.jsonl`** (mesmo formato encadeado,
  `kind PREFLIGHT_CONNECTIVITY`, `operationId NONE`, `h2eval.preflight_connectivity.v0`) com `envFingerprint = sha256(versão do Node, NOMES das
  variáveis ordenados — nunca valores —, presença + sha256 do arquivo `NODE_EXTRA_CA_CERTS`, valor de `NODE_USE_SYSTEM_CA`)`, `forbiddenEnvPresent`
  (nomes). Falha TLS ⇒ `TLS_<código>` e a sonda HTTP **não** é feita. **Gate REAL** (`cli/run.ts: realPreconditions` com `campaignDir`; `runAuthorized`
  verifica **todo** provedor do escopo): último preflight do provedor deve ser `PASS`, com ≤ 60 min e **mesmo** `envFingerprint` do processo do
  executor; senão exit 6 com `PREFLIGHT_CONNECTIVITY_MISSING | _FAILED | _STALE | PREFLIGHT_ENV_MISMATCH:<provedor>`. Nunca desativa verificação,
  nunca segue redirecionamento, nunca lê credencial.
- **C. Testes de recuperação idempotente** (`test/h2eval/cli/recovery.test.ts`, comportamento já presente em d2c60a98): queda entre `RESERVED` e `SENT`
  (reserva liberada, nunca reenviado, lote segue), entre `SENT` e resposta (`UNCERTAIN_ISOLATED crash_after_sent` ⇒ `STOP_UNCERTAIN`; a execução
  seguinte faz `REPLAY_SKIPPED` e completa; dinheiro incerto comprometido), ledger truncado (reconciliação recusa; 0 envios), journal/ledger com linha
  parcial (recusa; 0 envios; `status` reporta), replay byte-estável.
- **Semântica de retomada documentada** (`runs/R17_REAL/CYCLE2/RESUME_SEMANTICS_d2c60a98.md`): mesma pasta + mesmo GO ⇒ incerta `REPLAY_SKIPPED`,
  demais operações e lote seguinte correm; `HALT_ALL` é por processo (só o arquivo `STOP` persiste); reserva incerta conta no teto; nonce igual ⇒ `SAME`;
  `maxAttempts` **não** é cumulativo entre processos (lacuna documentada, não corrigida aqui).
- Testes: `test/h2eval/core/sendfailure.test.ts`, `test/h2eval/cli/preflight.test.ts`, `test/h2eval/cli/recovery.test.ts`; `JournalKind += PREFLIGHT_CONNECTIVITY`.

## 9-septies. EXECUTOR v-next CANDIDATO (C151, ENG-H2) — branch `experiment/otk-h2-eval-cycle2-prop-20261111` → `experiment/otk-h2-eval-vnext-20261111`; NÃO é G15, NÃO é GO; o SHA ratificado continua `d2c60a98`

Incorpora a proposta do ciclo 2 (9-sexies, auditada pelo B06: `runs/R17_REAL/CYCLE2/AUDIT_CYCLE2_PROPOSAL_B06.md`, APTA_COM_RESERVAS) e os itens 1–7 da C151.
Qualquer adoção exige **novo G15 (delta sobre `d2c60a98`) e novo GO** com o novo `executorCodeSha`; o R4 só gera planos **depois** de ratificado.

- **VNEXT-1 instrumentação** (`modal/types.ts ParsedResponse.stopReason/truncated`, `modal/index.ts toH2/completionOf`, `core/runner.ts`, `cli/status.ts`): o
  `stop_reason`/`finish_reason`/`finishReason` do provedor (identificador saneado) é gravado em `RESPONSE_RECEIVED {stopReason, completion}`, no record
  (`PostcallRecord.stopReason/completion`) e no export; `completion` deriva **só** da razão do provedor: `TRUNCATED_MAX_TOKENS` (anthropic `max_tokens`, openai `length`,
  gemini `MAX_TOKENS`) = **não concluída**; `REFUSED`; `COMPLETE` (`end_turn|stop|STOP|stop_sequence`); `OTHER`; `UNKNOWN` (ausente). `USAGE_PARSED` e o uso
  normalizado separam sempre `outputVisible` / `reasoning` / `outputTotal`. Taxa de conclusão (R3.2 §5.7 item 5) passa a ser mecânica.
- **VNEXT-2 desenho parametrizado** (`design/designParams.ts`, `h2eval.design_params.v1`): `maxTokens`, política de raciocínio (`OFF | ADAPTIVE effort | MANUAL budget |
  MINIMAL level`), `reasoningAllowanceTokens` e `inputBound {factor, extraTokens}` por modelo **e por braço** (VNEXT-8: `T1` summary, `T2` code_gen/code_fix, `T3` analysis,
  `T4` S2, `T5` S3 — `armOf(structure, task)`); nada hardcoded em `plan.ts`; `protocolHash = sha256(preregSha:corpusSha256:phase:designSha256)`; o plano grava
  `policy.design {file, sha256, designId, thinkingByModel, integrity, byModelArm, opsCheck}` e `policy.maxOutputTokensByModel`. **Matriz de suporte** documentada
  (`thinkingSupport`): Haiku 5.5 OFF = `thinking: {type: "disabled"}` (effort ≤ high; `runs/R17_REAL/H2_DIAG/docs/effort.html` sha256 `b069c61b…`, `thinking.html`
  `09378fd5…`), ADAPTIVE low|medium|high (`output_config.effort`), MANUAL recusado; Haiku 4.5 OFF (omite `thinking`) ou MANUAL (`budget_tokens`); GPT-4o mini só OFF;
  Gemini só MINIMAL (sem OFF). Combinação não documentada ⇒ `plan` recusa (`DESIGN_THINKING_UNDOCUMENTED`, exit 3). O adaptador Anthropic envia `thinking: {type: "disabled"}`
  quando a política é OFF no 5.5 e `parseUsage(body, {thinkingRequested})` marca `reasoning NOT_APPLICABLE`. Arquivos: `R3_2_DESIGN_PARAMS.json` (padrão; reproduz o
  d2c60a98: 256, 5.5 adaptive low/1024), `R4_DESIGN_PARAMS.v0.econ02.json` (cópia do arquivo da ECON-02, sha256 `e03225e2…`) e `R4_DESIGN_PARAMS.candidate.json`
  (conversor `convertR4DesignV0`; política do 5.5 por braço **transcrita da prosa** do v0: T1/T2/T4/T5 OFF, T3 ADAPTIVE low/1024; `inputBound` 1,6/64; **NÃO ratificado**).
  CLI: `plan --design-params <arquivo>` (substitui `--max-output-tokens`).
- **VNEXT-3 reservas do G15 final**: R15-G-1 `CAMPAIGN_IDENTITY.json` imutável (`init-campaign`), `campaignIdentitySha256` obrigatório no GO multilote
  (`GO_CAMPAIGN_IDENTITY_INVALID/MISSING/MISMATCH`); R15-G-2 `checkNonce` antes do lote e `commitNonce` **só após o primeiro `PLANNED`** (hook `ExecutorConfig.onJournal`);
  R15-G-3 `--pilot-protocol-hash` obrigatório fora do bloco `pilot` (`PILOT_PROTOCOL_HASH_REQUIRED`; o GO pode pinar `pilotProtocolHash` ⇒ `GO_PILOT_HASH_MISMATCH`);
  R15-G-4 `maxAttempts` cumulativo (`countSentInScope`; resumo com `attemptsPrior / attemptsThisRun / attemptsUsed`).
- **VNEXT-4 ambiente de lançamento**: `H2EVAL_ENV_NAMES.launchAllowlist` (= `runs/R17_REAL/RESUME/launch_env.sh`) e `LAUNCH_ENV_UNLISTED:<nomes>` nas pré-condições REAL
  (nomes, nunca valores; `H2EVAL_*` permitido). `preflight-connectivity` e `classifySendFailure` do ciclo 2 mantidos; correções do B06: idade do preflight julgada
  **uma vez** no início do `run-authorized` (R17-C2-1, `preflightNowMs`), `H2EVAL_*` fora do `envFingerprint` e `execArgv` dentro (R17-C2-2/3), `CAMPAIGN_JOURNAL_INTEGRITY` (R17-C2-5).
- **VNEXT-5 custos e herança**: teto por operação usa `maxTokens` e folga do desenho (OFF ⇒ folga 0); `core/ledger.ts` evento `inherit` a partir de
  `<campaignDir>/LEDGER_OPENING.json` (`h2eval.ledger_opening.v1`: `fromStudy {label, ledgerSha256, closedUtc}`, `providers {settledUsd, uncertainUsd}`, `signedBy human:`,
  `digestSha256`), aplicado uma vez como primeiras linhas; `committed = spent + uncertain + reserved + inherited` (tetos 5/3/3/11 e pausa 80 %); nunca liberado; reconciliação
  ignora `inherit`; recusas `LEDGER_OPENING_*`. Para o estudo R4: Anthropic `0.01200928` liquidado + `0.003662` incerto do R17 (`C:\otk-h2eval-runs\estudo` intocado).
- **VNEXT-6 D7 opção A**: `PlannedOperation.d7 {cacheArm, callIndex, eligibleForHit}` (S3 chamadas 2 e 3) marcado no plano.
- **VNEXT-7 ensaio**: `cli/offlineProvider.ts realism {inputTokenFactor, thinkingConsumesCapOnSingleTurnNoSystem}` e faltas `tls | reject_disabled | no_stop_reason`;
  `test/h2eval/cli/vnext_e2e.test.ts` reproduz o R17 (fase 1) e corre piloto → G17 → treino → freeze → validação → select → holdout sob desenho R4-like (fase 2).
- **VNEXT-8 paradas do R4** (`stops.r4New`): `STOP_STOP_REASON_MISSING` (HALT_ALL; aplicada **depois** de liquidar) e `STOP_THINKING_DISABLED_REJECTED` (HTTP 400 a pedido com
  `thinking disabled` ⇒ ISOLATE_ARM; o dinheiro fica como o ramo de custo deixou — sem uso ⇒ `possiblyCharged`); ligadas por `design.integrity`. `STOP_POLICY` tem 20 entradas.
  Códigos próprios no `run-authorized`: `LEDGER_RECONCILIATION`, `JOURNAL_INTEGRITY`, `LEDGER_OPENING_*`, `LOCK_*` (em vez de `INTERNAL`).
- **Lição do ensaio (técnica, registrada para o R4)**: com razão U/L0 ≈ 1,5 o `inputBoundFactor` 1,25 **não cobre** o teto na OpenAI (o teto só tem folga na Anthropic porque
  precifica a entrada ao preço de escrita de cache) ⇒ `STOP_CAP_VIOLATION`; o candidato R4 usa `inputBound 1,6/64` por modelo.
- **O que depende do R4 ratificado (não técnico)**: tetos e política por braço (transcrição a confirmar pela ECON-02/autor), `opsPerSplit` do R4 × corpus (o plano só
  **relata** em `opsCheck`), os valores da abertura herdada (assinatura humana), novo `protocolHash`/planos, G16, GO por subcampanha.
- Testes novos: `modal/stopreason`, `cli/design`, `cli/reserves`, `core/opening`, `cli/vnext_e2e`, `cli/vnext8` (além de `sendfailure`, `preflight`, `recovery` do ciclo 2).

### 9-septies-bis. Rodada FINAL antes de congelar o SHA (C151; G15-VNEXT do B06 sobre `bd371257` = PASS_COM_RESERVAS; R4 rev. 2 da ECON-02)

- **R17-V-7 condições (SC1)**: `perModel[m].conditions {appliesToArms, list[{conditionId, maxTokens, thinking, reasoningAllowanceTokens}], probe?}` — cada prompt S1 dos
  braços listados é planejado **uma vez por condição**, em ordem de bloco (lista), com `cellId = <cellId>~<conditionId>` ⇒ `operationId` distinto; `plan.condition` vai ao
  `PLANNED`, ao snapshot (`condition`), ao record (via journal) e ao export (`condition`, `probe`). Arquivo da SC1: `design/R4_R2_SC1.v1.json` (valores copiados dos três
  arquivos da ECON-02 vendorizados em `design/econ02/`, sha256 no `source`): B1 `OFF1024` ×6, B2 `ON1024` ×6, B3 `ON256` ×6, B4 S2 ×6, B5 S3 ×9 = **33 operações num só plano**.
- **R17-V-8 sonda P1**: `conditions.probe {conditionId, rule: 'P1'}` marca a **primeira** operação dessa condição (`plan.probe = 'P1'`, `policy.design.probe.operationId`).
  `run-authorized` executa a sonda **sozinha**: toda operação seguinte do lote só é admitida com `gates/P1_<modelo>.json` (`gate-p1`, `h2eval.gate.p1.v0`, `probeOperationId`,
  `PASS|FAIL`, `human:`); sem gate ⇒ `PAUSE_PROBE_GATE` (HALT_ALL, **nada enviado**); `FAIL`/sonda errada ⇒ `STOP_PROBE_FAILED` (HALT_ALL). Qualquer STOP **na sonda** (p.ex.
  `STOP_THINKING_DISABLED_REJECTED`) é HALT_ALL: a contingência do R4 (política ON) é um **novo desenho/plano/GO assinado**, nunca automática.
- **Semântica de pausa corrigida** (`core/runner.ts replayDecision`): linhas `PAUSE_REVIEW`/`PAUSE_PREAUTHORIZED` **não** são história da operação — uma operação pausada
  (80 %, sonda P1) é **executada de novo** depois do ato humano. Antes (d2c60a98 e `bd371257`), a operação pausada era abortada na retomada (`crash_before_reserve`) e perdida.
  `STOP_FILE` continua terminal para a operação em que caiu (comportamento anterior, registrado).
- **R17-V-5 isolamento por condição**: `STOP_THINKING_DISABLED_REJECTED` ⇒ `ISOLATE_CONDITION`: a condição **OFF** do modelo é isolada (`admit` ⇒ `SKIPPED_GATE` nas operações
  OFF restantes), as operações ON do mesmo modelo e os outros modelos seguem; resumo com `isolatedConditions`. Um 400 **sem** `thinking disabled` no pedido segue a regra geral.
- **R17-V-1 registro fora da pasta**: o GO pina `campaignDirCanonical` (`canonicalPath`: absoluto, barras `/`, letra de unidade minúscula; `GO_CAMPAIGN_DIR_INVALID/MISMATCH`) e
  `init-campaign` grava, além de `CAMPAIGN_IDENTITY.json`, um registro no **diretório de controle da máquina** (`H2EVAL_CONTROL_DIR` ou `~/.otk-h2eval/control/<campaignId>.json`,
  `h2eval.campaign_control.v1`) ligando identidade ↔ caminho canônico; `run-authorized` recusa `CAMPAIGN_CONTROL_MISSING | _IDENTITY_MISMATCH | _DIR_MISMATCH` — uma cópia byte
  a byte da pasta é recusada mesmo com um GO reescrito.
- **R17-V-2/V-3 abertura obrigatória e reconferida**: o GO pina `ledgerOpeningDigestSha256` (`'none'` ou hex64; `GO_LEDGER_OPENING_INVALID`); antes do trinco:
  `LEDGER_OPENING_UNEXPECTED` (GO `none` com arquivo presente), `LEDGER_OPENING_MISSING`, `LEDGER_OPENING_DIGEST_MISMATCH`; um ledger com linhas `inherit` só reabre **com** o
  arquivo (`LEDGER_OPENING_FILE_MISSING`) e as linhas são reconferidas contra ele (`LEDGER_OPENING_MISMATCH`); `status` lê a abertura ao lado do ledger. Quem assina é do autor
  (procedimento); o executor exige `human:`.
- **R17-V-4 shell**: `MSYSTEM` entra na allowlist (Git Bash o injeta mesmo sob `env -i`). **Shell documentado: Git Bash + `runs/R17_REAL/RESUME/launch_env.sh`, o MESMO para a
  sonda e para o executor** (a allowlist também contém nomes inócuos de shell: PWD, SHLVL, _, OLDPWD, HOME, LANG, LC_ALL, TZ — não é "= launch_env.sh" literalmente).
- **R17-V-6**: aceito e registrado (o anti-reenvio real é o replay do journal; o nonce protege contra reutilização de GO). **R17-V-9**: `CAMPAIGN_JOURNAL_INTEGRITY` vira
  código nas pré-condições. **R17-V-10**: `effort` omitido com `thinking disabled` (= medium) é intencional e documentado no adaptador.
- `STOP_POLICY` tem 22 entradas; novos `StopReason`: `PAUSE_PROBE_GATE`, `STOP_PROBE_FAILED`. Testes: `cli/vnext_final` (SC1 exata + negativos), `core/opening` (V-2/V-3),
  `cli/vnext8` (isolamento por condição), `cli/recovery` (cópias só com registro de controle próprio — o que um operador nunca deve fazer).

### 9-octies. Delta mínimo C153 (P4 assinada 2026-11-11T18:56Z: T3 = opção C, `NOT_EVALUATED`) — `arms.<Tn>.enabled`

- **Campo**: `perModel.<modelo>.arms.<Tn>.enabled?: boolean` (default `true`) e `reason?: string` (1..200) no `h2eval.design_params.v1`. Com `false`, `plan`
  **não emite** operação desse braço para esse modelo — S1 via `armOf(structure, task)` (sonda e campanha), diálogos T4/T5 idem — e registra a exclusão em
  `notPlanned` (`<modelo> arm <Tn>: disabled in design <designId> (<sha16>) — <reason>`) e em `policy.design.disabledArms[{model, arm, reason}]` (chave presente **só**
  quando há braço desligado). O `opsCheck` segue lendo `expectedOpsPerSplit`: o validador exige **0** esperado para braço desligado (e proíbe `conditions` nele),
  de modo que o `match` vem por construção, nunca por reconciliação. Desenhos **sem** o campo produzem plano **byte-idêntico** (salvo `generatedUtc`): invariância
  em `test/h2eval/cli/armfilter.test.ts` + regressão dourada contra `plan.sc1.json` (desenho `37cc9c6e…`) e `plan.campaign.haiku55.P4B.DRAFT.json` (OPTB) gerados
  por `a4da8651`. Runner, ledger, GO, egress e gates **não** mudam; o sha do desenho (logo o `protocolHash`) já cobre a mudança de desenho.

### 9-nonies. Preparo do ciclo 2 (C154) — perfil por ESTRUTURA no `select` e `freeze-corpus --groups-per-cell`

- **Perfil por estrutura**: `VALIDATION_SELECTED.profile.params[modelo]` continua `{a, b, out}` e pode trazer **`byStructure: { S1 | S2 | S3: {a, b, out} }`**;
  `predictorFrom` usa o triplo da estrutura da operação (`plan.structure`) e cai no triplo do modelo quando a estrutura não está listada. Método aceito
  também **`M1S`** (`PROFILE_METHODS` = M0, M1, M1S, M2; `PrecallSnapshot.profile.method` idem). A forma é validada **antes de gravar** o gate
  (`PROFILE_METHOD_INVALID`, `PROFILE_PARAMS_INVALID`: a/b/out finitos, chaves de `byStructure` ⊂ {S1,S2,S3}, cada uma um triplo completo) e **a cada
  uso** (`GATE_PROFILE_INVALID`). Perfis sem `byStructure` produzem exatamente o snapshot de antes. `paramsSha256` continua `sha256(JSON.stringify(params))`.
- **`freeze-corpus --groups-per-cell N`** (default 8, inalterado): expõe `BuildOptions.groupsPerCell` do gerador para a variante com holdout maior
  (12 ⇒ 6/3/3 grupos por célula); sem o flag o corpus é byte-idêntico ao do gerador anterior (teste `cycle2prep.test.ts`).
- **Já suportado, sem delta**: previsão de saída por estrutura (`meanByCell` por `cellId`, ridge com `isS2`/`isS3`), teto do T2 pelo desenho
  (`arms.T2.maxTokens`), pasta nova com um ledger cumulativo (`init-campaign` + `LEDGER_OPENING.json` herdando `settled`+`uncertain`; o GO pina
  identidade, caminho canônico e digest da abertura). Runner, ledger, egress e plan não mudam; regressão dourada SC1/P4B/P4C_R2 byte-idêntica.

### 9-decies. Preparo do ciclo 2, delta 2 (C154 / R5 rev. 3 §5–§7): composição explícita do corpus e condições na campanha

- **`freeze-corpus --split-plan <json>`** (`SplitPlan { cells?: {<cellId>: {train, validation, holdout}}, dialogs?: {S2_NOHIT|S3_HITATTEMPT: {...}}, pilotGroupsPerCell? }`):
  grupos por split **por célula** e diálogos por split **por braço** em contagens explícitas (`assignSplitsCounts`, mesma permutação semeada por hash);
  célula/braço com soma 0 **não é gerado**; `--repeats-per-cell N` expõe as repetições. O plano entra em `manifest.params.splitPlan` (logo no
  `corpusSha256`) **só quando presente**: sem ele, params e bytes são os de antes (teste `cycle2prep2.test.ts`, byte-identidade com `corpus_c2_candidate`).
- **`conditions` na fase CONFIRMATORY** (`plan.ts`): cada operação S1 dos braços listados é planejada uma vez por condição (`cellId~<conditionId>`,
  `plan.condition`, sonda `P1` na primeira da condição da sonda), exatamente como na sonda; o runner já tratava `condition`/`probe` sem olhar a fase.
  Uso: T3 como campanha independente (OFF-2048 × ON-low-4096) num plano único, bloco de treino, pasta própria. Sem `conditions`: plano idêntico.
- Regressão dourada SC1/P4B/P4C_R2 byte-idêntica; runner, ledger, egress e gates intocados.

## 10. CLI do executor (R15, `scripts/h2eval/cli/`, BOT-02)

`node node_modules/tsx/dist/cli.mjs scripts/h2eval/cli/main.ts <comando>`: `freeze-corpus` (gerador do E2E-01 como processo filho;
`FREEZE_CANDIDATE.json` **não ratificado**), `plan` (exige `--ratified-sha` = sha256 do pré-registro ratificado, ou `--unratified-rehearsal`
só para OFFLINE; piloto = 6 S1 + 3 S3 + 2 S2 diálogos = 21 chamadas por modelo; lote ≤ 60, um modelo; `costCap` por operação; teto do lote
`min(1,5 × Σ costCap, 25 % do sub-ledger)`; `inputUpperBoundTokens = ceil(1,25 × estimativa local) + 64`, parâmetros gravados no plano;
`bodySha256` por operação), `run --mode offline` (provedor simulado `cli/offlineProvider.ts`, único executável), `run --mode real --real`
(fail-closed: flag, plano ratificado, GO `h2eval.go.v1` válido para o lote/modelo/sha do executor/hash ratificado/janela, variável de
credencial PRESENTE, nenhuma proibida — qualquer falta ⇒ exit 6 **antes** de criar o executor), `status`, `stop` (arquivo), `export`
(dataset por operação: ex ante, declarado, custo de tabela, cobrança = NA). Códigos de saída: 0 · 2 uso · 3 política · 4 plano · 5 lote
parado · 6 pré-condições REAL · 7 interno.

## 9. Pontos de integração que as outras frentes expõem

- MET-02: `export const ADAPTERS: Record<UsageApi, ProviderAdapter>` em `scripts/h2eval/modal/index.ts` + fixtures de corpos de
  resposta por provedor (ok, recusa com uso, erro sem uso, uso parcial) em `test/h2eval/modal/fixtures/`.
- E2E-01: `export function createContentStore(dir): ContentStore` e `export function planArm(...)` em `scripts/h2eval/cache/index.ts`
  + diálogos sintéticos de teste (prefixo ≥ 4 500 tokens parametrizável) em `test/h2eval/cache/fixtures/`.
- BOT-02 integra em `scripts/h2eval/index.ts` (`createExecutor({mode, batchDir, adapters, contentStore, prices, caps, clock, egress})`).
