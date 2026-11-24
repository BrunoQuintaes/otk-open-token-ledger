# Demonstração acadêmica sem credenciais

Executa, num ambiente descartável, uma operação completa do OTK com um **provedor sintético** (responde como
`gpt-4o-mini-2024-07-18`): admissão → chamada ao provedor sintético → liquidação → recibo v3 assinado pelo operador →
CU de referência recomputada → prova ZK v3 → registro numa rede Besu local nova → casos negativos.
Não usa chave de API, conta paga, chave histórica, Google Drive nem a pasta Downloads.

CU = quantidade normalizada de consumo de serviços de IA.

## Requisitos

| Item | Versão usada na validação |
|---|---|
| Node.js / npm | 22.18.0 / 11.6.2 (`engines` aceita ≥ 20) |
| Docker com Compose | Docker Desktop 29.4.0, Compose 5.1.1 (Linux: Docker Engine com plugin compose) |
| bash e git | Git Bash no Windows (MSYS2) ou bash do Linux; git 2.x |
| Rede | registry npm, GitHub (circomlib), Docker Hub (postgres:16-alpine, redis:7-alpine, hyperledger/besu:25.12.0) |
| Hardware | 8 GB de RAM para o Docker recomendados (7 nós Besu); ~3 GB livres em disco |

## Execução

```bash
bash tools/academic_demo/run_demo.sh
```

Variáveis opcionais: `DEMO_KEEP=1` (mantém os contêineres para inspeção), `DEMO_OUT` (pasta do relatório),
`DEMO_BESU_DIR` (pasta das chaves de desenvolvimento da rede nova), portas e sub-redes (`DEMO_PG_PORT`,
`DEMO_REDIS_PORT`, `DEMO_SVC_SUBNET`, `DEMO_BESU_SUBNET`, `DEMO_RPC_PORT`, `DEMO_CHAIN_ID`). O roteiro recusa
sub-rede Docker já ocupada e pasta de rede já existente.

Duração observada: ~8 minutos (a rede Besu nova levou ~2,5 min até produzir o bloco 5).

## Resultado esperado

`DEMO_SUMMARY.json` com `"ok": true` e, em `07_receipt_check.json`:

| Verificação | Esperado |
|---|---|
| `storedDigestEqualsRecomputed` | true |
| `operatorSignatureVerifies` | true |
| `cuReferenceEqualsIndependentOracle` | true (oráculo escrito a partir da linha arquivada de preço do gpt-4o-mini: US$ 0,15 entrada, 0,075 cache, 0,60 saída por milhão) |
| `negativeChangedTokenCountRejected`, `negativeChangedTenantRejected`, `negativeOtherKeyRejected` | true (motivo `digest_mismatch` ou `unauthorized_signer`) |

Além disso: e2e sintético 9/9 consistente (`06_e2e_synthetic.txt`), testes negativos do registry v3 12/12 (prova,
sinal público, assinatura e assinante adulterados revertem) e ZK v3 6/6.

## O que a demonstração prova e o que não prova

Prova: o fluxo do protótipo funciona de ponta a ponta numa máquina nova; o recibo é íntegro e tem origem no operador; a
CU de referência é recomputável a partir do recibo; o registro on-chain recusa artefatos adulterados.
Não prova: que um provedor real contou corretamente (o provedor é sintético e, mesmo com provedor real, o OTK registra o
uso declarado pelo provedor); independência da rede (7 validadores de um único operador num único host); conciliação
com fatura.
