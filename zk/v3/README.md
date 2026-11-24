# zk/v3 — metering_v3, setup demonstrativo local

**Rótulo obrigatório:** setup demonstrativo local. Todas as contribuições (fase 1 e fase 2) foram feitas por um único executor (front A, sessão Claude Code, run 20260930-1625) numa única máquina. A confiança fica concentrada nesse executor. **Não é cerimônia** e não tem participantes ou instituições independentes. Não usar estas chaves para afirmar segurança "1-de-N honesto".

| Arquivo | O que é |
|---|---|
| `../circuits/metering_v3.circom` | circuito (enunciado e limites no cabeçalho) |
| `build/metering_v3.r1cs`, `.sym`, `metering_v3_js/` | circom 2.1.6 `--O1 -l zk/circuits` (1 168 restrições: 646 não lineares + 522 lineares) |
| `setup/pot11_demo_final.ptau` | fase 1 nova (bn128, 2^11), 1 contribuição local, `preparePhase2`; não é a Hermez nem o pot12 histórico |
| `setup/intermediate_ptau.sha256.json` | hashes dos acumuladores intermediários (dados públicos, arquivos descartados) |
| `keys/metering_v3_demo_0000.zkey` | `groth16 setup` (antes da contribuição) |
| `keys/metering_v3_demo_final.zkey` | chave de prova após 1 contribuição local |
| `keys/metering_v3_demo_vkey.json` | chave de verificação extraída do zkey |
| `../../tools/hardhat/contracts/v3/MeteringVerifierV3Demo.sol` | verifier Solidity gerado do zkey |
| `MANIFEST.json` | `circuitId`, ferramentas, hashes de todos os arquivos, log da preparação |

`circuitId = metering_v3@sha256:<sha256 do r1cs>`; o registro v3 guarda `keccak256(circuitId)` e recusa autorização de outro circuito.

## Reproduzir e verificar (cópia limpa)

```bash
npm ci
node scripts/zk/v3_verify_manifest.mjs                         # hashes, cadeia ptau, zkey×r1cs, vkey, verifier
CIRCOM=<circom 2.1.6> node scripts/zk/v3_verify_manifest.mjs   # + recompila e compara r1cs/wasm/sym
npx tsx --test test/zk/d1d8_a_circuit_v3.test.ts
cd tools/hardhat && npx hardhat compile && node --test test/d1d8_a_registry_v3.test.js
```

Refazer a preparação (`CIRCOM=… node scripts/zk/v3_demo_setup.mjs`) gera chaves **novas e diferentes**, também válidas; não se espera identidade binária de zkey/ptau entre execuções (contribuições aleatórias). A recompilação do circuito, sim, reproduz r1cs, wasm e sym byte a byte com o mesmo binário circom.

## Material secreto e limites

- A aleatoriedade de cada contribuição veio de `crypto.randomBytes` dentro do processo e nunca foi impressa, registrada ou gravada. O snarkjs a deriva em memória.
- Não há como provar, a partir dos arquivos, que esse material deixou de existir; apagar arquivos não prova eliminação de toxic waste. Quem controlou o processo poderia, em tese, forjar provas para estas chaves.
- A verificação da cadeia (`powersOfTau.verify`, `zKey.verifyFromR1cs`) mostra que os artefatos são consistentes entre si e com o circuito. Não identifica quem contribuiu.
- Artefatos v1/v2 (`zk/keys`, `zk/ceremony`, `zk/build`) são históricos, lidos e não alterados. A procedência deles está em `docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/A/REGISTRO_PROCEDENCIA.md`.
