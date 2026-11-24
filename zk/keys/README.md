# zk/keys — ZK Proving & Verification Keys

> **Nota de status (OVERNIGHT 2, 07/10/2026, decisão DN-04 do autor):** a origem "5 contribuidores" da fase 2
> da v2 é **histórica e sem evidência documental** de quem rodou cada contribuição, em qual máquina e como a
> aleatoriedade foi descartada. Não usar como "1-de-N honesto com participantes independentes". O perfil principal
> atual é a v3, com **setup demonstrativo de um executor** (`zk/v3/README.md`). O texto histórico segue sem alteração.


## Arquivos rastreados pelo git

| Arquivo | Tipo | Origem | Propósito |
|---------|------|--------|-----------|
| `metering_v2_final_mpc.zkey` | Proving key | Cerimônia MPC v2 (5 contribuidores segundo o registro histórico; independência não comprovada, DN-04) | histórico v2 — 393KB |
| `metering_v2_vkey_mpc.json` | Verification key | Cerimônia MPC | **PRODUÇÃO** — verifier on-chain |
| `metering_v2_hermez_final.zkey` | Proving key | Hermez Phase 1 + 1 contribuidor | Dev/referência |
| `metering_v2_hermez_vkey.json` | Verification key | Hermez Phase 1 | Dev/referência |
| `metering_v2_final.zkey` | Proving key | pot10 single-party | Dev legacy |
| `metering_v2_vkey.json` | Verification key | pot10 single-party | Dev legacy |
| `metering_v2_0000.zkey` | Phase 2 init | pot10 | Dev legacy |

## Política de versionamento

- **Vkeys JSON** (pequenos, ~3KB): rastrear — necessários para verificação on-chain
- **Proving keys `.zkey`** (grandes, 200–400KB): rastrear apenas os de produção/referência
- **`.ptau` e `.zkey` intermediários**: **NÃO rastrear** (ver `.gitignore`)

Ver `docs/_canonical/SECURITY_CANONICAL.md §9` para política completa.

## Cerimônia MPC (PRODUÇÃO)

O arquivo `metering_v2_final_mpc.zkey` foi gerado por:
- **Phase 1:** Hermez Perpetual Powers of Tau (pot12, 176+ contribuidores)
- **Phase 2:** 5 contribuidores institucionais (Alice-FGV, Bob-IME, Carol-ITA, Dave-UNICAMP, Eve-USP)
- **Beacon:** Ethereum block hash aplicado após todas as contribuições
- **Guia:** `scripts/ceremony/CEREMONY.md`
- **Estado:** `zk/ceremony/state.json`
