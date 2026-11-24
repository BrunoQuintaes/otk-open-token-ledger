# Circuits Roadmap

**Status:** Planejamento (metering_v1 em produção; v2+ TODO)

---

## metering_v1.circom (atual — em produção)

**Localização:** `zk/circuits/metering_v1.circom`

```
Entradas públicas:  commitment, epoch, maxUsage
Entradas privadas:  userId, usage (costUnits), nonce

Provas:
  (1) commitment == Poseidon(userId, usage, nonce, epoch)
  (2) usage ≤ maxUsage
```

**Constraints:** ~240 (BN254 / Groth16)
**Gas:** ~250.000 (verificação Groth16 on-chain)
**Evidência:** `zk/build/public.json` — confirmado 2026-02-18 (U2.3)

---

## metering_v2.circom — Range Proof (TODO)

**ADR:** `docs/architecture/adr/ADR-0101-privacy-bucketing-rangeproof.md`
**Fase:** U8.7.2

```
Entradas públicas:  commitment, epoch, maxUsage, CU_bucket_lower, CU_bucket_upper
Entradas privadas:  userId, CU_real, nonce

Provas adicionais:
  (3) CU_real ∈ [CU_bucket_lower, CU_bucket_upper]
  (4) commitment == Poseidon(userId, CU_real, nonce, epoch)  [CU_real, não bucket]
```

**Constraints adicionais:** ~2 por bound check → total ~244
**Impacto gas:** mínimo (constraints adicionais negligíveis no custo de pairing)

**TODO:**
- `zk/circuits/metering_v2.circom` — adicionar constraints range
- Novos public signals: `[commitment, epoch, maxUsage, CU_lower, CU_upper]`
- Atualizar `MeteringVerifier.sol` (auto-gerado via snarkjs)
- Testes: range proof válido/inválido

---

## metering_v3.circom — Merkle Batch (TODO)

**ADR:** `docs/architecture/adr/ADR-0100-batch-settlement-merkle.md`
**Fase:** U12.3

```
Entradas públicas:  batchRoot, epoch, totalCUBucket
Entradas privadas:  receipts[N], nonces[N], userIds[N]

Provas:
  (1) batchRoot == MerkleRoot(receipts)
  (2) totalCUBucket == sum(bucketize(receipt.usage) for receipt in receipts)
  (3) Para cada receipt: usage_i ≤ maxUsage_i
```

**Nota:** Complexidade O(N × constraints_v1) — batch de 100 receipts → ~24.000 constraints.
Alternativa: PLONK/FFLONK elimina trusted setup + constraints mais eficientes.

**TODO:**
- Avaliar PLONK (SnarkJS) vs FFLONK vs Halo2 para batch
- Benchmark: trusted setup size + prova time + gas

---

## Decisão de Framework (Futuro)

| Framework | Trusted Setup | Prova (N=100) | Gas | Status |
|-----------|--------------|---------------|-----|--------|
| Groth16 (atual) | Necessário | ~27s estimado | ~250K | ✅ Em produção |
| PLONK | Não (SRS) | TBD | TBD | TODO (U12+) |
| Halo2 | Não | TBD | TBD | TODO (pesquisa) |
