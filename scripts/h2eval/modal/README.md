# H2-EVAL · modal (R14, C141 bloco B2) — adaptadores, parsers de usage, tabela de preços e estimadores ex ante

Dona: MET-02. Base imutável: H1 `7606bc9b` (só se **adiciona** sob `scripts/h2eval/modal/**` e `test/h2eval/modal/**`).
Contrato de dados: `runs/B1/CONTRACT_MIN_FOR_EXECUTOR.md` (v0) + adendo `CONTRACT_MIN_FOR_EXECUTOR_R2.md` (v0.1).
Interface de código: `scripts/h2eval/INTERFACES.md` + `scripts/h2eval/types.ts` da integradora (BOT-02; espelho local em `interfaces_v0.ts`).
Fatos de API (endpoints, campos, preços, fórmulas): `runs/R08/R08_COMPATIBILITY_MATRIX.{md,json}` e as páginas oficiais arquivadas em `runs/R08/official_docs/` (sha256 citados nos arquivos).

Tudo aqui é **puro e offline**: nenhuma rede, nenhuma credencial (só o *nome* do cabeçalho), nenhum log de conteúdo.

## Mapa

| arquivo | o que faz |
|---|---|
| `types.ts`, `canonical.ts` | `Count = bigint \| 'UNKNOWN' \| 'NOT_APPLICABLE'` (ausente nunca é zero), categorias canônicas **disjuntas**, `cacheObserved` pelo uso, termos de preço observados |
| `adapters/openai_chat.ts` | `POST /v1/chat/completions` gpt-4o-mini-2024-07-18: `service_tier:"default"`, `stream:false`, `max_completion_tokens`, sem parâmetro de raciocínio; parser: `prompt_tokens` **inclui** `cached_tokens` (subconjunto; múltiplos de 128), `reasoning_tokens` subconjunto da saída, recusa (`refusal`, `content_filter`), tool/áudio inesperado ⇒ `INCOMPLETE_UNEXPECTED_CONTENT`, erro sem uso |
| `adapters/anthropic_messages.ts` | `POST /v1/messages` haiku-4-5 / haiku-5-5: `service_tier:"standard_only"`, `stream:false`, `max_tokens`; haiku-4-5 **sem** `thinking`; haiku-5-5 `output_config.effort:"low"` (adaptativo não tem OFF documentado ⇒ NOT_VERIFIED); parser: `input_tokens` **exclui** cache, `cache_creation.ephemeral_5m/1h`, `thinking_tokens` subconjunto da saída; `inference_geo` us (1.1x), `speed` fast ⇒ custo UNKNOWN |
| `adapters/google_generate_content.ts` | `POST /v1beta/models/gemini-3.5-flash-lite:generateContent`: `thinkingConfig.thinkingLevel:"MINIMAL"` (não há OFF), `maxOutputTokens`, sem parâmetro de tier (resposta `usageMetadata.serviceTier` conferida); parser: `promptTokenCount` **inclui** `cachedContentTokenCount`, `thoughtsTokenCount` parcela separada cobrada como saída, `promptTokensDetails[modality]` ⇒ `imageUnits`/`audioUnits`; `blockReason`/`finishReason SAFETY` ⇒ recusa com uso |
| `adapters/index.ts` | registro por modelo da matriz; `modalitySupport` (áudio só Gemini) |
| `index.ts` | **`ADAPTERS: Record<UsageApi, ProviderAdapter>`** (INTERFACES §9): `buildRequest(plan, content)` aplica `plan.params` e **recusa parâmetro não documentado no R08** (`H2EVAL_PARAM_NOT_DOCUMENTED`), `parseRefusal`, `parseUsage` (`NormalizedUsageH2`, `U`, `cacheObserved`, `modelServed` bruto, `serviceTierServed`), `modelSupport` pelo catálogo H1 |
| `pricing/price_table_h2eval_v1.json` | tabela versionada `h2eval-v1-2026-11-10`, micro-USD/MTok, fonte = R08 (arquivo + sha256); **`null` = desconhecido, nunca 0**; haiku-5-5 por faixa de comprimento do prompt; Gemini Standard (Batch só como referência) |
| `pricing/pricing.ts` | `computeCost` exato em pico-USD (`CALCULATED` / `ESTIMATED_UPPER_BOUND` quando só o total é conhecido / `UNKNOWN`), **preço `null` necessário ⇒ `stopRunner`**; `costCap` pior caso (entrada ao maior preço entre entrada e escrita no TTL mais caro, saída no teto, **+ `reasoningAllowanceTokens`** 0/0/1 024/2 048); `capCovered` ⇒ `STOP_CAP_VIOLATION` |
| `estimators/text_otk.ts` | **texto = contador local do OTK importado** (`src/tokenization/localCounter.ts`, `otk.local_counter.b3@1`): o200k exato para gpt-4o-mini, cl100k aproximação para Anthropic/Gemini; haiku-5-5 marcado (tokenizador novo, ~30% mais tokens, não calibrado); qualquer parte não-texto ⇒ `UNSUPPORTED_FOR_ESTIMATION` |
| `estimators/image_openai_tiles.ts` | **NOVO, EXPERIMENTAL**: fórmula oficial por tiles (base 2 833 + 5 667/tile de 512 px; `low` = só base) com a citação literal |
| `estimators/image_anthropic_patches.ts` | **NOVO, EXPERIMENTAL**: ⌈w/28⌉×⌈h/28⌉ com os tiers (Standard 1 568 px/1 568; High-res 2 576 px/4 784); imagem fora do limite ⇒ só o teto documentado como **limite superior** (a página da regra de redimensionamento não foi arquivada) |
| `estimators/index.ts` | despacho: Google imagem e **todo áudio ⇒ `UNSUPPORTED_FOR_ESTIMATION`** (o "32 tok/s" do Gemini fica só como figura de referência; nunca se calcula erro contra estimador inexistente) |
| `contract_r2.ts` | adendo v0.1: `thinking` por modelo, `serviceTierRequested`, `cacheTtlRequested`, `modelDeprecation`, `exploratoryFormulaEstimate` (só imagem; inclui `gemini_rough`; **não substitui `L0`**) |
| `tools/gen_synthetic_images.mjs` | 10 PNGs determinísticos (gradiente/padrão; sem conteúdo de terceiros) + `MANIFEST.json` + `SHA256SUMS` |
| `tools/gen_synthetic_audio.mjs` | WAV PCM16 16 kHz mono, tons puros (10/60/180 s), **sem voz**; só `AUDIO_SPEC.json` (com sha256) é versionado; os WAVs se regeneram |

Testes: `test/h2eval/modal/*.test.ts` (node:test via tsx, offline; fixtures de respostas documentadas em `test/h2eval/modal/fixtures/responses/`).

```bash
node node_modules/tsx/dist/cli.mjs --test test/h2eval/modal/*.test.ts
```

## Decisões honestas (e o que fica NOT_VERIFIED)

- **Ausente ≠ 0.** `prompt_tokens_details` ausente ⇒ `cacheRead` UNKNOWN e custo só como **limite superior**. Gemini omite campos zerados (proto3): `cachedContentTokenCount` ausente ⇒ UNKNOWN + limite superior; `thoughtsTokenCount` ausente é **derivado** só quando `totalTokenCount = prompt + candidates` (identidade documentada), senão UNKNOWN.
- **Custo é cálculo, não fatura.** Conferido contra o ledger da H1 (07/10/2026): 0.0000816 / 0.000754 / 0.000185 / 0.0002742 / 0.00076976 USD.
- **Haiku 5.5 sem OFF de raciocínio**: NOT_VERIFIED nas páginas arquivadas; usa-se `effort:"low"` e `thinking_tokens` é lido e cobrado como saída.
- **Imagem Anthropic acima do limite**: a regra exata de redimensionamento está numa página não arquivada ⇒ só o teto (1 568 / 4 784) como limite superior; os valores da tabela oficial (1 560, 1 564) ficam abaixo dele.
- **`parseUsage(body)` da interface não recebe a modalidade da requisição**: para OpenAI/Anthropic os tokens de imagem estão dentro de `prompt_tokens`/`input_tokens` sem campo próprio ⇒ `imageUnits` UNKNOWN quando há imagem; o `parseResponse(httpStatus, body, {requestModalities})` dos adaptadores dá a leitura completa (sugestão à integradora: passar a modalidade).
- **Binários**: `ResolvedContent` publicado só carrega `bytesSha256`; um adaptador puro não pode buscar bytes. O espelho aceita `bytesBase64` opcional; sem ele, `buildRequest` falha com `H2EVAL_BINARY_NOT_RESOLVED` (a resolver pela integradora/E2E-01 antes da chamada).
- **Hosts oficiais** (`api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`) vêm das referências de API; o core aplica a própria allowlist.
- Disponibilidade dos modelos na conta: NOT_VERIFIED (R08); `gpt-4o-mini-2024-07-18` deprecado com shutdown em 14/01/2027.

## R14-FIX (achados da integração B2: F-INT-1 e F-INT-2)

**F-INT-2 (bloqueante, corrigido).** Causa raiz: o parser Anthropic devolvia `outputVisible` e `reasoning` = UNKNOWN sempre que a resposta não trazia `output_tokens_details` — o caso normal do Haiku 4.5 sem `thinking` — e, com categorias disjuntas, o custo ficava UNKNOWN e toda chamada terminava `UNCERTAIN_ISOLATED`. Regra nova (narrow): sem o detalhe **e** com thinking não habilitado (`ctx.thinkingRequested === false`, ou, só com o corpo, modelo manual-only `claude-haiku-4-5-*` sem bloco `thinking`/`redacted_thinking` na resposta) ⇒ `reasoning = NOT_APPLICABLE` (thinking desligado por construção, não "ausente") e `outputVisible = output_tokens`. Com bloco de thinking, ou modelo adaptativo (Haiku 5.5) sem o detalhe, continua UNKNOWN; detalhe presente sempre prevalece. Mesmo tratamento no gpt-4o-mini ("não é modelo de raciocínio", R08 §8) quando `completion_tokens_details` falta; Gemini já derivava `thoughtsTokenCount` de `totalTokenCount`. Teste: `test/h2eval/modal/r14fix.test.ts` reproduz o caso do executor (`ok_cache_creation_5m`: 120 × 1,00 + 4 600 × 1,25 + 24 × 5,00 = 0,00599 USD, CALCULATED).

**F-INT-1 (fonte única do corpo = adaptador; `bodyOf(plan, content) ⇒ {body, canonical, bodySha256}` exportado em `index.ts`).** Por campo, com a página arquivada no R08:

| provedor | campo | decisão | citação |
|---|---|---|---|
| Anthropic | `system` | sempre **array de blocos** `[{type:"text", text, cache_control?}]` | messages-create.html: "system: optional string or array of TextBlockParam { type: "text", text, cache_control, citations }" |
| Anthropic | `cache_control` | um único breakpoint explícito no **último bloco de texto da última mensagem do prefixo estável**; prefixo = primeiras `prefixMessages` mensagens do `ResolvedContent` **contando a de sistema** (diálogos do E2E-01: `prefixMessages = 1` ⇒ breakpoint no bloco de sistema); `prefixMessages` maior ⇒ último bloco da mensagem correspondente; `NOT_APPLICABLE` com plano de cache ⇒ última mensagem; sem plano de cache ⇒ nenhum `cache_control`; `ttl` = `params.cacheTtlRequested` (senão `ttl` da diretiva, senão 5 min, omitido no corpo) | prompt-caching.html: "Prompt caching references the entire prompt: tools, system, and messages (in that order), up to and including the block designated with cache_control"; "1-hour TTL … { "cache_control": { "type": "ephemeral", "ttl": "1h" } }" |
| Anthropic | `max_tokens`, `service_tier:"standard_only"`, `stream:false` | mantidos | messages-create.html ("max_tokens: number", "service_tier: optional "auto" or "standard_only"", "stream: optional boolean") |
| Anthropic | raciocínio | `params.thinking` (rev. 2) prevalece; Haiku 4.5: nada ou `thinking:{type:"enabled",budget_tokens}`; Haiku 5.5: `output_config.effort` | extended-thinking.html; messages-create.html ("output_config … effort") |
| OpenAI | teto de saída | **`max_completion_tokens`** — mudança DECLARADA em relação à H1 (que usou `max_tokens` para o mesmo snapshot) | chat-create.html: "max_completion_tokens: … including visible output tokens and reasoning tokens"; "max_tokens: … Deprecated … in favor of max_completion_tokens" |
| OpenAI | `content` | **string** quando a mensagem só tem texto (concatenação das partes); **array de partes** só quando há imagem (única forma que a transporta) | chat-create.html: "content: string or array of ChatCompletionContentPart … TextContent = string … Can contain text, image, or audio inputs" |
| OpenAI | `n` | **não enviado** (padrão documentado 1) | chat-create.html: "n: optional integer or null (default: 1)" |
| OpenAI | `service_tier:"default"`, `stream:false` | mantidos | chat-create.html |
| Google | `candidateCount` | **removido** (padrão documentado 1; BRG-01 reporta não suportado em Gemini 3+; nada o documenta para o 3.5 Flash-Lite) | generate-content.html: "candidateCount: … If unset, this will default to 1." |
| Google | `thinkingConfig.thinkingLevel` | enum exato da API: `MINIMAL` | generate-content.html: "MINIMAL: Little to no thinking." |
| Google | `systemInstruction.parts`, `contents[].role` user/model, `maxOutputTokens` | mantidos | generate-content.html |

`canonicalJson` = chaves ordenadas recursivamente, sem espaços; `bodySha256 = sha256(canonicalJson(body))`. A referência pré-registrável do E2E-01 passa a derivar de `bodyOf` (decisão da coordenadora).


## Páginas oficiais citadas — onde estão de fato e sha256 (R15-P2-2, integradora, 2026-11-11)

Todas as páginas citadas nos cabeçalhos dos adaptadores/estimadores/tabela de preços estão em `runs/R08/official_docs/` (orquestrador) e listadas em `runs/R08/official_docs/SHA256SUMS.txt`. Cinco delas (`anthropic/messages-create.html`, `anthropic/service-tiers.html`, `openai/chat-create.html`, `google/generate-content.html`, `google/thinking.html`) foram copiadas em 2026-11-11 do arquivo local do MVP (`evidence_coord/official_docs_20261110`, mesmos sha256; nenhuma rede) porque a revisão independente (R15-P2-2) as encontrou citadas mas ausentes do R08.

| Arquivo | sha256 |
|---|---|
| `runs/R08/official_docs/anthropic/messages-create.html` | `c21333d2c1127be3a9719c0553cc37ecdf4c433ac5f5df0d25b624d5ddf7245f` |
| `runs/R08/official_docs/anthropic/messages-usage-object.html` | `b1e4adbc0a991eaa7f198105d93749909d3f228113ee633c7997422c0b05c535` |
| `runs/R08/official_docs/anthropic/pricing.html` | `96b086acd8827d84b293ab83782d21edbbd9aa6fd3622e13d2a77828a30121ec` |
| `runs/R08/official_docs/anthropic/prompt-caching.html` | `791e0e8cffba38d3941e692df7dd5b01b68c21cda6b7c0572e6271087ace05fc` |
| `runs/R08/official_docs/anthropic/vision.html` | `58d5ce271304d5d319411ac9e7ce4ebecdee77978014f6a29e15b1df57f8c91f` |
| `runs/R08/official_docs/anthropic/extended-thinking.html` | `9f8002582c6cfb59068cc3c707b7bdcc29e306671761a664d240f770f1b4eee7` |
| `runs/R08/official_docs/anthropic/models-overview.html` | `e09176cd45047b054acebb33b87bf883c1d9c46d954bc446cb0dc33efa5ba5cc` |
| `runs/R08/official_docs/anthropic/service-tiers.html` | `bb807c3cad278a8e6e0a276506d134efdebf7ebd878bddeafb4ff443542beed8` |
| `runs/R08/official_docs/anthropic/haiku-4-5.html` | `3e8dbcc9569fef78cd984665766ce23915356b47ae0573fc36fcaae6dc2a142a` |
| `runs/R08/official_docs/anthropic/haiku-5-5.html` | `017889df8c09e31a802bd6846eb687d8e7c575a4cbba68a8d11023cf59a518a7` |
| `runs/R08/official_docs/openai/chat-create.html` | `8023dec7e96c149296d7d3ffcb21b32fb793f139cf80d17e0087f5c24e342b89` |
| `runs/R08/official_docs/openai/prompt-caching.html` | `807539ec31c269e7f2f9ebd4ec67a0fbd8b2a7e6af03954bb514cb62d020bf93` |
| `runs/R08/official_docs/openai/gpt-4o-mini.html` | `53bb89b832c4827b6b9a9d344c107ffbc16a04cd1c50a68c981ca6ea7da81a45` |
| `runs/R08/official_docs/openai/images-vision.html` | `25aa452da3aebba35724b7cfcc71ac26e1f20efc8d1559ee069d66c5218dcd6f` |
| `runs/R08/official_docs/openai/pricing.html` | `f23adcab316164c5f3525b95fa49c6d2209bd37b7c1395f5a469b2ef3a7996e2` |
| `runs/R08/official_docs/openai/deprecations.html` | `954fdef4463594fd7a0715957ee85129d12b454345905f23cb6ba894161bc1d9` |
| `runs/R08/official_docs/google/generate-content.html` | `9ba73e90b7323be46adf54c66de0af572853392e5f11f03b27c6307f1d9e4cf0` |
| `runs/R08/official_docs/google/pricing.html` | `cc04b4c529ae9843f27183af769134293f77fc0514a4a0082710a8cde671c1cd` |
| `runs/R08/official_docs/google/caching.html` | `c5acaf7c8874acce2171e20cecf76e7277c4b2891e24f9174717e3dc474ce54f` |
| `runs/R08/official_docs/google/thinking.html` | `db73d9499c8f1e09290ad815021abff0f15dbdf190cdae2b71445797a8c57200` |
| `runs/R08/official_docs/google/image-understanding.html` | `f196f033c135ccbd9fa9b5e94bb6d520b9c3c58a6c36b9c803df0356ddacbd94` |
| `runs/R08/official_docs/google/audio.html` | `12128e76bf4ab9310fa2377f269a9536fa4f2c5447b0444835b08527cda7e5f7` |
| `runs/R08/official_docs/google/deprecations.html` | `ce4cdf5fd31b64d5c195b8c43c41e63d176b33bf0e7705ec999be34b90a33174` |
| `runs/R08/official_docs/google/model_gemini-3.5-flash-lite.html` | `53080fc0875b9d74cd594f646e60ad4e3ffc30e329d0dcd9113e3fc1b5c522ae` |
