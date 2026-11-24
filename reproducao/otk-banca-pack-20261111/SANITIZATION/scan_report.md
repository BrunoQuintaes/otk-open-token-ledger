# Relatório do scanner de sanitização

- raiz: `otk-banca-pack-20261111`
- arquivos varridos: 162 (22796940 bytes)
- sha256 da árvore varrida: `22892ce01b538622cd73611855243dc8afda5611c78a019f40acb2bd2ff96d17`
- **veredito: PASS** (0 achado(s) bloqueante(s))

| categoria | ocorrências | bloqueante |
|---|---:|:-:|
| caminho_usuario_windows | 0 | sim |
| caminho_usuario_unix | 0 | sim |
| email | 0 | sim |
| telefone_internacional | 0 | sim |
| telefone_br | 0 | sim |
| chave_sk | 0 | sim |
| chave_google | 0 | sim |
| token_github | 0 | sim |
| token_slack | 0 | sim |
| chave_aws | 0 | sim |
| bearer | 0 | sim |
| chave_privada_pem | 0 | sim |
| atribuicao_segredo | 0 | sim |
| id_requisicao_anthropic | 0 | sim |
| id_requisicao_openai | 0 | sim |
| x_request_id | 0 | sim |
| gemini_response_id_valor | 0 | sim |
| nome_pessoa_ou_conta | 0 | sim |
| arquivo_segredo | 0 | sim |
| workspace_ou_org_nomeado | 0 | sim |
| revisao_palavra_workspace | 11 | não (informativo) |
| revisao_palavra_account | 1 | não (informativo) |

O scanner varre texto e binários (como latin1). Achados são mascarados no relatório (4 primeiros caracteres + tamanho + sha256 curto).
