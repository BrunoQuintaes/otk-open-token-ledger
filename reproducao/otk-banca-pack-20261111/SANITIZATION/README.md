# Sanitização do pacote

O pacote foi montado a partir de evidência bruta (somente leitura) e **sanitizado por regras determinísticas** (`../tools/sanitize_rules.mjs`),
com verificação independente por um scanner de padrões (`../tools/scan_sanitization.mjs`, que não importa as regras). A evidência bruta **não** acompanha o pacote.

## O que foi feito

| item | tratamento |
|---|---|
| chaves, tokens, segredos, arquivos de ambiente | não entraram no pacote; o scanner procura chaves de provedores, tokens, `Bearer`, blocos de chave privada, atribuições `chave = "…"` e menções a arquivos/pastas de segredos |
| e-mails | `<EMAIL_REDIGIDO>` (nenhum nos arquivos do pacote; apareceriam só em textos de terceiros, que não foram incluídos) |
| telefones | padrões estritos (código de país com separadores; `(DD) 9XXXX-XXXX`); nenhum encontrado. Padrões soltos de dígitos foram descartados de propósito: dariam milhares de falsos positivos em dados numéricos |
| caminhos de usuário do sistema (`X:\Users\<nome>`, `/Users/<nome>`, `/home/<nome>`) | `<HOME>` (o resto do caminho é preservado) |
| nomes de conta/usuário e do autor | `<CONTA>`; o nome do autor vira "o autor" (nos protocolos e relatórios) |
| IDs de resposta/requisição dos provedores | substituídos por `<prefixo>sha256-<16 hex>` = início do sha256 do ID original (hash determinístico: o mesmo ID dá sempre o mesmo hash, então a conferência `providerMessageId` = `expected` = `observed` continua possível). 658 IDs distintos substituídos (219 OpenAI + 219 Anthropic + 220 Gemini = as 658 operações concluídas). Os arquivos da CAL-ANTH já traziam apenas hashes (`providerRequestIdSha256_12`) |
| nomes de workspace/organização | o scanner procura campos de workspace/organização com valor nomeado (chave seguida de `:` ou `=` e texto entre aspas); nenhuma ocorrência. Também lista, como informativo, as menções soltas às palavras "workspace" e "account" (só texto genérico dos protocolos) |

## Verificação

- `scan_report.json` / `scan_report.md` — resultado do scanner sobre a árvore do pacote (veredito, contagem por categoria, sha256 da árvore varrida).
  O relatório e `SHA256SUMS` foram adicionados **depois** do scan; rodar o scanner de novo (`tools/reproduce_all.mjs` faz isso) varre também esses arquivos e deve continuar PASS.
- `scanner_negative_control.json` — controle negativo: o scanner foi testado com exemplos falsos de cada categoria bloqueante (todos detectados) e com uma pasta limpa (passa).
- `SOURCES.json` — para cada arquivo do pacote: origem, sha256 do arquivo bruto de origem, sha256 no pacote e se a sanitização o alterou (`changedBySanitization`).
- `fidelidade_vs_original.txt` — comparação, campo a campo, das saídas regeneradas a partir dos insumos sanitizados com as saídas originais:
  tabelas e dados (`pairs_633.csv`, `metrics_long.csv`, `tables.md`, `tables.tex`, `missing_explicit.csv`, `excluded_nominal.csv`) são **idênticos byte a byte**; nos JSON as únicas diferenças são
  campos de proveniência (sha256 dos arquivos de origem e caminho/sha256 do inventário), consequência direta de os insumos terem sido sanitizados.

## Limites

- O scanner detecta padrões; não prova ausência de qualquer dado pessoal imaginável (por exemplo, texto livre de terceiros). Os textos do corpus são sintéticos.
- Os IDs hasheados não são reversíveis a partir do pacote, mas quem tiver o ID original pode conferir o hash.
