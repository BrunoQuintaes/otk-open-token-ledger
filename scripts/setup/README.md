# OTK Trusted Setup — Multi-Party Ceremony Pipeline

## Overview

This directory contains scripts for running the Groth16 trusted setup ceremony for `metering_v1.circom`.
The ceremony follows the Powers of Tau (Phase 1) + circuit-specific (Phase 2) model.

**Security guarantee:** As long as at least ONE participant destroys their randomness (`toxic waste`),
the setup is secure. For production, run with ≥ 3 independent participants.

## Current Status

The repository includes a pre-generated trusted setup in `zk/build/`:
- `pot12_final.ptau` — Phase 1 (single-participant, development only)
- `metering_v1_final.zkey` — Phase 2 (single-participant, development only)

**For dissertation/proof-of-concept:** Single-participant setup is sufficient (documented limitation §5.2).
**For production:** Run a multi-party ceremony following the steps below.

## Ceremony Steps

### Phase 1: Powers of Tau

```bash
# Step 1: Initialize (or skip if using public ptau from Hermez/Aztec)
bash scripts/setup/01_init_ceremony.sh 12 zk/ceremony/phase1

# Step 2: Each participant contributes (run once per participant)
PARTICIPANT_NAME="alice" \
PARTICIPANT_ENTROPY="$(head -c 64 /dev/urandom | base64)" \
bash scripts/setup/02_contribute.sh 12 zk/ceremony/phase1

PARTICIPANT_NAME="bob" \
PARTICIPANT_ENTROPY="$(head -c 64 /dev/urandom | base64)" \
bash scripts/setup/02_contribute.sh 12 zk/ceremony/phase1

# Step 3: Finalize Phase 1 + run Phase 2
CEREMONY_BEACON="<ethereum-block-hash-or-public-randomness>" \
bash scripts/setup/03_finalize.sh 12 zk/ceremony/phase1 zk/build
```

### Using a Public Phase 1 Ptau (Recommended)

The [Hermez Powers of Tau](https://github.com/iden3/snarkjs#7-prepare-phase-2) provides
public ceremony files with hundreds of participants. Use `powersOfTau28_hez_final_12.ptau`:

```bash
curl -O https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau
bash scripts/setup/03_finalize.sh 12 . zk/build
```

## Security Requirements

| Parameter | Development | Production |
|-----------|-------------|------------|
| Phase 1 participants | 1 (pre-generated) | ≥ 3 independent |
| Entropy source | /dev/urandom | HSM / air-gapped machine |
| Beacon source | Fixed hex | Ethereum block hash |
| Toxic waste | Destroyed automatically | Verified destroyed |
| Phase 2 participants | 1 | ≥ 2 independent |

## Audit Trail

Each ceremony step appends to `zk/ceremony/phase1/ceremony_log.txt` with:
- Participant name
- Timestamp
- SHA-256 of each ptau/zkey artifact

This log should be published alongside the final artifacts for public verification.

## ADR Reference

See `docs/architecture/adr/ADR-oracle-truth-model.md` §Ceremony for design rationale.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PARTICIPANT_NAME` | Contributor identifier | `anonymous_<timestamp>` |
| `PARTICIPANT_ENTROPY` | Random entropy (keep secret!) | Interactive prompt |
| `CEREMONY_BEACON` | Phase 1 randomness beacon (hex) | Fixed dev value |
| `PHASE2_ENTROPY` | Phase 2 contribution entropy | `/dev/urandom` |
