# H1 — evidência histórica da campanha OVERNIGHT 2 (baseline `7606bc9b`)

**Rótulo: EVIDÊNCIA HISTÓRICA H1 — recomputável offline. Não é a H2, não é a CAL-ANTH.**
Baseline: `7606bc9be46bde8c1bc427c2eb4873bc1a474779`. Campanha de 07/10/2026 com três provedores
(OpenAI `gpt-4o-mini-2024-07-18`, Anthropic `claude-haiku-4-5-20251001`, Google `gemini-3.5-flash-lite`).
Nenhum bot de produção, rede ou credencial é necessário para demonstrar nada desta pasta: só Node >= 24 e os arquivos daqui.

## Comando de reprodução (offline)

```bash
node H1/scripts/reproduce_h1.mjs --out <pasta-vazia-ou-inexistente>
```

Executa, nesta ordem, os scripts originais sobre `inputs/h1_subset/` e compara cada arquivo regenerado, byte a byte (sha256), com o
arquivo correspondente do pacote (30 arquivos). Saída: `REPRODUCAO_H1.json` na pasta `--out`; exit 0 = tudo idêntico.

| passo | script | gera / confere |
|---|---|---|
| 1 | `scripts/build_inventory.mjs` | inventário das **662** operações (`inventory/`) |
| 2 | `scripts/build_denominators.mjs` | cadeia de denominadores 662 → 658 → pares (`denominators/`) |
| 3 | `scripts/recompute.mjs` | métricas, tabelas e comparação de calibração, **633** pares (`results/`) |
| 4 | `scripts/verify_corpus_prompts.mjs` | regenera o corpus com o gerador original (`generator/corpus.ts`), confere o sha256 `043b2561b898a375aad62d13be0c4822ccddd2b2d2c94738fdb97462885353e6`, os 216 prompts, os hashes de `docs_table.csv` e os `promptSha256`/`promptChars` dos manifestos |
| 5 | `explorer/build.mjs` | dados do explorador (`explorer/web/data/`) |

Os gráficos `results/figures/*` foram gerados por `scripts/figures.py` (Python + matplotlib) a partir de `results/data/`; **não** são
regenerados pelo comando acima (não exigem rede, mas exigem matplotlib); os PNG/PDF enviados são os originais, sem alteração.

## Explorador (somente leitura)

Abra `explorer/web/index.html` no navegador (arquivo local; a página tem política de segurança sem rede). Telas: visão geral, operações,
denominadores, métricas e uma aba **suplementar** com a CAL-ANTH-01 — essa aba é leitura da pasta `CAL-ANTH/`, **não** é evidência da H1.

## Conteúdo

- `inputs/h1_subset/` — subconjunto MÍNIMO e sanitizado da baseline lido pelos scripts: `_calls.jsonl`, `_manifest.json`, `_entrypoint.log.txt` de cada
  execução, `calibration/` (operações, resumo, perfis, resultados) e as três tabelas de preço congeladas. Não é a árvore completa da H1.
- `inventory/`, `denominators/`, `results/` — saídas dos passos 1–3 (regeneradas a partir dos insumos sanitizados).
- `corpus/` — corpus sintético (216 textos, semente 20261007, 9 grupos/família, 2 variantes/grupo), prompts literais, tabela de documentos
  (hash, tamanho, split), ligação documento↔operação e verificação dos hashes planejados nos manifestos.
- `generator/corpus.ts` — gerador original do corpus (`git show 7606bc9b:scripts/calibration/corpus.ts`, byte-idêntico).

## O que esta pasta PROVA

- As 662 operações da campanha, sua partição exata (658 consistentes + 4 recusas), a cadeia de denominadores e os 633 pares de calibração
  são recomputáveis dos arquivos brutos de execução, sem ajuste manual; o que falta (recusas, textos nunca concluídos, operações sem contagem local) fica
  listado de forma explícita em `inventory/missing_explicit.csv`, não preenchido com zero.
- O corpus de 216 textos é regenerável e coincide com o hash registrado pela campanha em todos os manifestos e no resumo.
- Os prompts enviados são reconstruíveis (prefixo fixo + texto do corpus) e seus sha256/tamanhos coincidem com o que o executor registrou antes de enviar.
- As tabelas de erro de calibração (tokens locais x declarados pelo provedor) saem dos mesmos dados.

## O que esta pasta NÃO prova

- **O corpo exato enviado na H1 não foi gravado em log.** A H1 registrou o hash e o tamanho do prompt, não o corpo HTTP; a serialização do corpo
  é verificada pelo código-fonte da época, não por captura.
- **Custo calculado ≠ fatura.** Os custos vêm da tabela pública congelada aplicada ao uso declarado; não foram conciliados com faturas.
- A "reserva" nos dados é um teto de segurança, não uma previsão.
- Corpus **sintético** (pt/en, código, JSON, tabela, unicode, numérico): não representa tráfego real nem outros modelos/provedores.
- Nenhuma generalização para a H2, para outros snapshots de modelo ou para cache, imagem e áudio.

## Sanitização e fidelidade

Os arquivos de execução foram sanitizados (veja `../SANITIZATION/`): caminhos de usuário viram `<HOME>`; IDs de resposta dos provedores viram
`<prefixo>sha256-<16 hex>` (hash determinístico do original; a igualdade entre os três campos que repetem o ID continua verificável).
Como o sha256 dos arquivos de origem mudou, os campos `source_file_sha256`, o sha do inventário e as chaves de proveniência das saídas
mudam em relação aos relatórios originais; **todos os números e tabelas** (pares, métricas, tabelas `.md`/`.tex`, denominadores, `missing_explicit.csv`)
são idênticos às saídas originais — comparação em `../SANITIZATION/fidelidade_vs_original.txt`.
