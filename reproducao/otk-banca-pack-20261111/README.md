# Pacote para a banca — OTK (versão 20261111)

Pacote **local, mínimo e sanitizado**. Preparado para revisão do autor: **não foi publicado**, nenhum colaborador foi convidado e nenhum dado pessoal foi anexado.
Tudo roda **offline** com **Node >= 24** (sem rede, sem credenciais, sem bot de produção, sem dependências a instalar).

Há **três versões separadas**, cada uma com rótulo próprio. Não misturar números entre elas.

| pasta | rótulo | o que é |
|---|---|---|
| [`H1/`](H1/README.md) | **EVIDÊNCIA HISTÓRICA H1** (baseline `7606bc9b`, campanha de 07/10/2026) | inventário das 662 operações, corpus/prompts/hashes, denominadores, tabelas, figuras, scripts de recomputo e explorador |
| [`CAL-ANTH/`](CAL-ANTH/README.md) | **VERIFICAÇÃO INDEPENDENTE** da calibração Anthropic (suplementar) | relatório de verificação (19 de 20 REPRODUZIDO + 1 DIFERENTE POR DEFINIÇÃO), entradas e script de recálculo |
| [`H2/`](H2/README.md) | **PRE-REGISTRO NAO RATIFICADO — SEM RESULTADOS** | apenas o protocolo proposto do H2-EVAL |

## Reproduzir tudo (um comando)

```bash
node tools/reproduce_all.mjs --out <pasta-vazia-ou-inexistente>
```

Confere o `SHA256SUMS`, roda o scanner de sanitização no pacote inteiro, roda o controle negativo do scanner, reproduz a H1 (30 arquivos idênticos byte a byte
às saídas do pacote; corpus de 216 textos com sha256 `043b2561b898a375aad62d13be0c4822ccddd2b2d2c94738fdb97462885353e6`) e reproduz a CAL-ANTH.
Resultado em `<out>/REPRODUCAO_PACOTE.json`; exit 0 = tudo passou. Também dá para rodar cada parte:

```bash
node H1/scripts/reproduce_h1.mjs --out <pasta>
```

```bash
node CAL-ANTH/scripts/reproduce_cal_anth.mjs --out <pasta>
```

```bash
node tools/scan_sanitization.mjs --root . --out scan.json
```

```bash
node tools/sums.mjs verify
```

## O que cada pasta PROVA e NÃO PROVA

**H1 — prova:** as 662 operações (658 consistentes + 4 recusas), a cadeia de denominadores, os 633 pares de calibração e as tabelas de erro são recomputáveis dos
arquivos brutos de execução; o corpus sintético de 216 textos e seus prompts são regeneráveis e conferem com os hashes registrados na campanha.
**H1 — NÃO prova:** o corpo exato enviado não foi logado na H1 (só hash e tamanho do prompt); custo é *calculado* pela tabela pública congelada, **não é fatura**;
a "reserva" é teto de segurança, não previsão; corpus sintético e apenas três modelos de três provedores — sem generalização.

**CAL-ANTH — prova:** que os números do relatório da CAL-ANTH saem dos arquivos brutos por código independente (19 de 20 reproduzidos; o item 20 é diferença de escopo documentada:
134.055 µUSD = só o estágio `core` com 288 chamadas, no JSON; 134.247 µUSD = `core` + `smoke`, na tabela do relatório).
**CAL-ANTH — NÃO prova:** custo real faturado (tabela congelada, não fatura), nem validade fora dos modelos/snapshots/corpus da CAL-ANTH, nem desempenho em OpenAI/Google/H2.

**H2 — prova:** nada empírico. É um desenho de estudo **proposto**, aguardando ratificação do autor; **não há resultados** nem chamadas realizadas. Ratificar não libera chamadas reais.

## Limites gerais

- O corpo exato enviado ao provedor não foi logado na H1; só se confere hash/tamanho do prompt e o código-fonte da época.
- Custo calculado ≠ fatura (todas as pastas).
- A sanitização troca IDs de resposta dos provedores por hashes e remove caminhos/nomes; por isso `source_file_sha256` e campos de proveniência das saídas diferem das saídas originais, enquanto
  **todos os números e tabelas** são idênticos (ver `SANITIZATION/fidelidade_vs_original.txt`).
- Os gráficos de `H1/results/figures/` são os originais; sua regeneração exige Python + matplotlib e não faz parte do comando offline.

## Estrutura

```
README.md  SHA256SUMS
H1/          inputs/h1_subset  inventory  denominators  corpus  results  generator  explorer  scripts
CAL-ANTH/    inputs/cal01  inputs/cal02  protocol  expected  scripts  (relatório e nota do item 20)
H2/          protocolo proposto (sem resultados)
SANITIZATION/ regras, relatório do scanner, controle negativo, proveniência, fidelidade
tools/       scan_sanitization  sanitize_rules  selftest_scanner  sums  reproduce_all
```

## Antes de qualquer circulação

Este pacote só deve sair desta máquina com **aprovação do autor**. O arquivo ZIP `otk-banca-pack-20261111.zip` (ao lado desta pasta, fora dela) contém exatamente estes arquivos dentro de uma pasta-raiz `otk-banca-pack-20261111/`.
