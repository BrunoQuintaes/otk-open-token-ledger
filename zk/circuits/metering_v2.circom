pragma circom 2.1.6;

/*
  metering_v2.circom — ZK metering receipt com Range Proof de bucket (ADR-0101)

  DIFERENÇA vs v1:
    v1: prova usage <= maxUsage (1 constraint de intervalo, bound superior)
    v2: prova minUsageBucket <= usage <= maxUsageBucket
        (2 constraints de intervalo = bucket range proof)

  SEMÂNTICA:
    O provador demonstra que o consumo (usage) cai dentro de um bucket
    pré-definido [minUsageBucket, maxUsageBucket], sem revelar o valor exato.
    O bucket é determinado off-chain pela política de quantização (ADR-0101,
    src/privacy/bucketing.ts: quantizeToBucket + bucketBounds).

  EXEMPLOS DE BUCKET (step=300):
    Bucket "small":  [0,     300]   → minUsageBucket=0,   maxUsageBucket=300
    Bucket "medium": [301,   900]   → minUsageBucket=301, maxUsageBucket=900
    Bucket "large":  [901,  2700]   → minUsageBucket=901, maxUsageBucket=2700

  PUBLIC SIGNALS (Groth16 pubSignals order — outputs primeiro):
    pubSignals[0] = commitment      (output — Poseidon hash dos inputs privados)
    pubSignals[1] = epoch           (input público)
    pubSignals[2] = minUsageBucket  (input público — lower bound do bucket)
    pubSignals[3] = maxUsageBucket  (input público — upper bound do bucket)

  PRIVATE INPUTS:
    userId, usage, nonce

  CONSTRAINTS (~280 total):
    ~240 Poseidon(4)          — commitment hash
    ~20  LessEqThan(64)       — usage <= maxUsageBucket
    ~20  GreaterEqThan(64)    — usage >= minUsageBucket
    -----
    ~280 restrições totais (vs ~240 no v1, +17% por 2 range checks)

  COMPATIBILIDADE:
    - Circom 2.1.6 + Groth16 (BN254) — mesmo esquema do v1
    - Trusted setup: requer nova cerimônia (Powers of Tau > 2^9 suficiente)
    - Verifier Solidity: gerar com `snarkjs zkey export solidityverifier`
    - PublicSignalsSpec.md: atualizar para 4 sinais públicos

  ADR: docs/architecture/adr/ADR-0101-privacy-bucketing-rangeproof.md
*/

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template MeteringReceiptV2() {
    // -------------------------------------------------------------------------
    // Private inputs (não revelados ao verifier on-chain)
    // -------------------------------------------------------------------------
    signal input userId;           // ID do usuário (hashed off-chain antes de entrar)
    signal input usage;            // Consumo real em CU (privado — apenas o bucket é público)
    signal input nonce;            // Anti-replay nonce (monotônico por userId)

    // -------------------------------------------------------------------------
    // Public inputs (visíveis no pubSignals on-chain)
    // -------------------------------------------------------------------------
    signal input epoch;            // Janela de tempo (ex.: Unix hour)
    signal input minUsageBucket;   // Limite inferior do bucket (inclusive)
    signal input maxUsageBucket;   // Limite superior do bucket (inclusive)

    // -------------------------------------------------------------------------
    // Public output (Groth16: outputs aparecem antes dos inputs em pubSignals)
    // -------------------------------------------------------------------------
    signal output commitment;      // Poseidon(userId, usage, nonce, epoch)

    // -------------------------------------------------------------------------
    // Constraint 1: Commitment = Poseidon(userId, usage, nonce, epoch)
    // Mantém os mesmos 4 inputs do v1 — o commitment é backward-compatible.
    // -------------------------------------------------------------------------
    component h = Poseidon(4);
    h.inputs[0] <== userId;
    h.inputs[1] <== usage;
    h.inputs[2] <== nonce;
    h.inputs[3] <== epoch;
    commitment <== h.out;

    // -------------------------------------------------------------------------
    // Constraint 2: usage <= maxUsageBucket  (upper bound do bucket)
    // LessEqThan(64): verifica a[0] <= a[1] em representação de 64 bits.
    // -------------------------------------------------------------------------
    component leMax = LessEqThan(64);
    leMax.in[0] <== usage;
    leMax.in[1] <== maxUsageBucket;
    leMax.out === 1;

    // -------------------------------------------------------------------------
    // Constraint 3: usage >= minUsageBucket  (lower bound do bucket)
    // GreaterEqThan(64): verifica a[0] >= a[1] em representação de 64 bits.
    // -------------------------------------------------------------------------
    component geMin = GreaterEqThan(64);
    geMin.in[0] <== usage;
    geMin.in[1] <== minUsageBucket;
    geMin.out === 1;
}

/*
  Groth16 component main:
    - Sinais públicos explícitos: epoch, minUsageBucket, maxUsageBucket
    - commitment é signal output → automaticamente público (aparece primeiro em pubSignals)

  pubSignals order:
    [0] commitment      (output — primeiro por convenção Groth16/snarkjs)
    [1] epoch
    [2] minUsageBucket
    [3] maxUsageBucket
*/
component main { public [epoch, minUsageBucket, maxUsageBucket] } = MeteringReceiptV2();
