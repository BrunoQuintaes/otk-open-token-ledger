# PA-03 v1: execução local pelo autor (Windows)

**Status no repositório: `pending_author_evidence`.** Este diretório não muda esse status. Ele dá ao autor
(Bruno) um jeito reprodutível e auditável de rodar os 2 testes legados na máquina dele e de guardar evidência
sanitizada. A decisão correspondente é a N-D8 em `docs/_ops/H1_S01_S24_20261013/11_OPEN_HUMAN_DECISIONS.md`.

## O que fica pendente

Na bateria R07e (`tools/hardhat`, 71 testes: 69 PASS + 2 SKIP), os 2 SKIP são os testes de
`tools/hardhat/test/PA03Closeout.test.js`:

- `PA-03 Closeout — Full Loop (ZK Proof + On-Chain) > generates fresh ZK proof and submits on-chain — captures real txHash`
- `PA-03 Closeout — Full Loop (ZK Proof + On-Chain) > second submit with same commitment is rejected (anti-replay)`

Os dois só rodam quando existe a chave histórica de prova v1 `metering_v1_final.zkey` (cerca de 360 KB). Ela
não é versionada nem distribuída, e só existe na máquina do autor. Sem a chave, cada teste é pulado com o
motivo declarado: `skip: V1_KEY_ABSENT`. Os dois aparecem em `docs/academic_release/expected_outcomes.json` →
`R07e_contracts.pending_author_evidence`.

**Não regenere a chave.** `scripts/setup/03_finalize.sh` gera outra chave, com outro hash, e o script recusa
essa chave. Também não crie uma chave substituta.

Hash SHA-256 publicado da chave original. É a mesma fonte usada por `scripts/ops/repro_contracts.sh` (`ZKEY_SHA256`)
e pela proveniência em `docs/_ops/EXECUCAO_D1_D8_20260930/.../04b_legacy_zkey_provenance.txt`:

```
e53adcc7650a10b71b9e05e29c56d46700654f8937aaa6ba1e1616805628d60f  metering_v1_final.zkey
```

## Como rodar (Windows PowerShell 5.1 ou pwsh 7)

Na raiz do clone, com Node 22 e npm no PATH:

```powershell
# primeira vez: -NpmCi (npm ci na raiz e em tools\hardhat) e -Compile (hardhat compile) usam a rede
powershell -ExecutionPolicy Bypass -File tools\academic_demo\windows\run_pa03_v1.ps1 `
  -ZkeyPath 'C:\caminho\local\metering_v1_final.zkey' -NpmCi -Compile

# depois (sem rede): dependências e artifacts já presentes
$env:OTK_PA03_V1_ZKEY = 'C:\caminho\local\metering_v1_final.zkey'
powershell -ExecutionPolicy Bypass -File tools\academic_demo\windows\run_pa03_v1.ps1
```

Parâmetros:

| Parâmetro | Efeito |
|---|---|
| `-ZkeyPath <arquivo>` | Caminho local da chave. Tem precedência. |
| (env) `OTK_PA03_V1_ZKEY` | Usada quando `-ZkeyPath` não é passado. |
| (padrão) | Procura em `<repo>\zk\build\metering_v1_final.zkey` (caminho que o teste sempre usou) e depois em `<repo>\..\integ\zk\build\metering_v1_final.zkey` (layout registrado na proveniência). |
| `-OutDir <dir>` | Destino da evidência. Padrão: `%USERPROFILE%\otk_pa03_v1_evidence\<timestamp UTC>`. Se o destino ficar dentro do repositório, o script recusa, a menos que se passe `-AllowOutputInsideRepo`. Também recusa um destino que contenha a própria chave. |
| `-NpmCi` | Roda `npm ci --no-audit --no-fund` na raiz e em `tools\hardhat`. **Usa a rede.** Opcional. |
| `-Compile` | Roda `npx hardhat compile`. Baixa o solc 0.8.24 **apenas** se ele ainda não estiver em cache. Opcional. |
| `-RepoRoot <dir>` | Raiz do clone. Padrão: três níveis acima do script. |
| `-TimeoutSec <n>` | Limite de tempo do `node --test`. Padrão: 1200. |

O script não usa `git push`, não envia nada e não faz chamada de rede fora de `-NpmCi` e `-Compile`.

Equivalente opcional para Linux/macOS:
`OTK_PA03_V1_ZKEY=/caminho/metering_v1_final.zkey [NPM_CI=1] [COMPILE=1] bash tools/academic_demo/windows/run_pa03_v1.sh`.

## O que o script faz

1. **Localiza** a chave apenas no disco local, na ordem da tabela acima.
2. **Valida** o SHA-256 com `Get-FileHash`. Se o hash divergir do publicado, para com exit 4, sem rodar teste
   e sem gravar evidência.
3. **Executa exatamente** o comando da bateria R07e, restrito ao arquivo PA-03:
   `cd tools\hardhat ; node --test --test-reporter=tap --test-concurrency=1 test/PA03Closeout.test.js`,
   com `OTK_PA03_V1_ZKEY=<caminho da chave>`. O teste lê essa variável (H1R2 B3). Sem ela, usa o caminho padrão
   de sempre. O skip continua idêntico quando a chave está ausente.
4. **Grava** no diretório de saída:
   - `R07e_PA03_v1.tap.txt`: TAP do `node --test`, sanitizado;
   - `R07e_PA03_v1.stderr.txt`: stderr, sanitizado;
   - `evidence.json`: SHA do commit, arquivos rastreados alterados, versões de node, npm, SO e PowerShell,
     timestamps UTC, contagens TAP, resultado por teste, nome, tamanho e SHA-256 da chave
     (`content_saved: false`) e SHA-256 do teste e do `.wasm` v1;
   - `SHA256SUMS.txt`.

   A sanitização troca o caminho do repositório por `<REPO>`, o diretório da chave por `<ZKEY_DIR>` e o
   perfil por `<HOME>`, nos dois estilos de barra e na forma escapada em JSON. Nomes soltos de usuário ou de
   máquina não são trocados, porque isso poderia alterar os nomes dos testes que o `--pass-evidence` compara.
   Revise os arquivos antes de compartilhar.

**O conteúdo da chave nunca é lido pelo script, exibido, copiado, movido, linkado nem compactado.** Só o
caminho dela é passado ao teste, e só o hash vai para a evidência. O teste unitário
`test/unit/h1r2_pa03_windows_script.test.ts` verifica isso estaticamente.

Códigos de saída: 0 = os 2 testes passaram localmente; 1 = rodaram mas não passaram os 2; 2 = ambiente ou uso;
3 = chave não encontrada; 4 = hash divergente; 5 = dependências ou artifacts ausentes; 6 = timeout.

## Depois da execução

Mesmo com `local_result: LOCAL_RUN_PASSED`, o status no repositório **continua `pending_author_evidence`**.
Para mudar, o autor entrega `evidence.json` e `R07e_PA03_v1.tap.txt` ao integrador. O integrador regenera
`docs/academic_release/expected_outcomes.json` com:

```
node tools/academic_release/make_expected_outcomes.mjs --battery <dir> --commit <sha> --out docs/academic_release/expected_outcomes.json \
  --pass-evidence <dir_evidencia>/R07e_PA03_v1.tap.txt
```

## Limites

- A execução prova que os 2 testes passam **nesta máquina, neste commit, com a chave original**. Não é uma
  reprodução independente por terceiros, porque a chave continua não distribuída.
- O hash confere a identidade do arquivo com o artefato histórico. Ele não prova a cerimônia de setup v1.
- Com `-Compile` desligado, o script usa os artifacts que já existem em `tools\hardhat\artifacts`. Se eles
  forem de outro commit, rode com `-Compile`.
- O loop v3 (sem chave externa) é coberto por outros testes (`d1d8_a_registry_v3`). Este script só trata o
  legado v1.
