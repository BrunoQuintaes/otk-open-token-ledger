# scripts/zk — ZK Pipeline Scripts

Scripts padronizados para o pipeline ZK do metering_v1 (Groth16/circom).

## Fluxo completo

```
zk_build.sh → zk_prove.sh → zk_verify.sh
```

Para limpar artefatos intermediários: `zk_clean.sh`

---

## Scripts

| Script | Função | Pré-requisito |
|--------|--------|---------------|
| `zk_build.sh` | Compila `metering_v1.circom` → R1CS + WASM + SYM | `circom` global |
| `zk_prove.sh [input.json]` | Gera witness + prova Groth16 | Build completo + `snarkjs` |
| `zk_verify.sh [vkey] [pub] [proof]` | Verifica prova Groth16 | `snarkjs` |
| `zk_clean.sh [--all]` | Remove artefatos temporários | — |
| `generate_witness.cjs` | Gera witness (ESM-safe wrapper) | Node.js |
| `verify_binding.sh [input.json]` | Valida binding SDK ↔ Circuit (U8.4.2) | Build completo |

---

## Variáveis relevantes

```
REPO_ROOT/zk/build/
  metering_v1.r1cs          ← R1CS (gerado por zk_build.sh)
  metering_v1_js/           ← WASM + witness calculator
  metering_v1_final.zkey    ← ZKey final (cerimônia — NÃO regenerar sem motivo)
  pot12_final.ptau           ← Powers of tau (NÃO commitar — gitignore)
  proof.json                 ← Última prova gerada
  public.json                ← Public signals da última prova
  verification_key.json      ← Exportado do zkey via zk_verify.sh (auto)
```

## pubSignals order (metering_v1 — Groth16)

```
pubSignals[0] = commitment  (Poseidon hash — OUTPUT do circuito vem primeiro)
pubSignals[1] = epoch
pubSignals[2] = maxUsage
```

Evidência: `zk/build/public.json` + `docs/architecture/PublicSignalsSpec.md`

## Referências

- Spec canônica: [docs/architecture/PublicSignalsSpec.md](../../docs/architecture/PublicSignalsSpec.md)
- Circuito: [zk/circuits/metering_v1.circom](../../zk/circuits/metering_v1.circom)
- ADR: [docs/architecture/adr/ADR-0002](../../docs/architecture/adr/ADR-0002-receipt-registry-anti-replay.md)
- Alias paths: [docs/_meta/PATH_ALIASES.md](../../docs/_meta/PATH_ALIASES.md)
