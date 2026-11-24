# OTK metering_v2.circom — MPC Trusted Setup Ceremony

> **Circuit:** `metering_v2.circom` — Groth16 Phase 2 Ceremony
> **Security model:** "1 of N honest" — secure if ANY participant destroys their toxic waste
> **Phase 1 source:** Hermez Perpetual Powers of Tau (pot12, 176+ contributors)
> **Minimum Phase 2 contributors:** 2 (recommended: 5+ from geographically diverse institutions)

---

## Table of Contents

1. [Overview](#overview)
2. [Coordinator Setup](#coordinator-setup)
3. [Participant Guide](#participant-guide)
4. [Beacon Application](#beacon-application)
5. [Verification](#verification)
6. [Security Notes](#security-notes)
7. [Attestation Template](#attestation-template)

---

## Overview

This ceremony establishes the Phase 2 trusted setup for `metering_v2.circom`, a range-proof
circuit that proves `minUsageBucket ≤ usage ≤ maxUsageBucket` without revealing the exact usage.

**Why this matters:**
The current dev key (`zk/keys/metering_v2_final.zkey`) was generated with a single-party
ceremony. In Groth16, the entity generating the proving key knows the "toxic waste" — the secret
randomness that, if kept, could allow forging fake proofs. A multi-party ceremony means:

> **The key is only secure if EVERY participant conspired. If even ONE is honest, the system is safe.**

### Ceremony flow

```
Phase 1 (reused): Hermez pot12 — 176 global contributors — already done
                           ↓
Phase 2 Step 0: groth16 setup (contribution_0000.zkey) — coordinator only
                           ↓
Phase 2 Step 1: Participant 1 contributes → contribution_0001.zkey
Phase 2 Step 2: Participant 2 contributes → contribution_0002.zkey
Phase 2 Step N: Participant N contributes → contribution_000N.zkey
                           ↓
Final: Apply public beacon (Bitcoin/Ethereum block hash)
                           ↓
Output: metering_v2_final_mpc.zkey + metering_v2_vkey_mpc.json (production keys)
```

---

## Coordinator Setup

The coordinator runs this **once** at the start, then waits for each participant.

### Step 0: Get public Phase 1 ptau

```bash
# Downloads Hermez pot12 (~12MB) and verifies it
bash scripts/ceremony/00_use_public_ptau.sh
```

Expected output: `✅ ptau verified OK`

### Step 1: Initialize Phase 2

```bash
bash scripts/ceremony/01_phase2_init.sh
```

Creates `zk/ceremony/contribution_0000.zkey` — the initial key before any human contributions.
This contains **no** human entropy yet.

### Distribute to first participant

Send `zk/ceremony/contribution_0000.zkey` to Participant 1 via secure channel.

---

## Participant Guide

Each participant receives the **previous contribution zkey** and produces a new one.

### What you need

- This repository (clone it fresh, or verify git hash)
- Node.js 20+ and `snarkjs` installed: `npm install`
- The previous contribution zkey (e.g., `contribution_0000.zkey`)
- 30–60 minutes of time

### Step-by-step

#### 1. Verify what you received

```bash
# Verify the zkey you received is well-formed
npx snarkjs zkey verify \
  zk/build/metering_v2.r1cs \
  zk/keys/hermez_bn128_12_final.ptau \
  <received_zkey_file>
```

Expected: `ZKey Ok!`

#### 2. Prepare your entropy

Generate **strong, unpredictable entropy**. Multiple methods — use one or combine them:

```bash
# Method A: Cryptographic random (basic)
openssl rand -hex 64

# Method B: Multiple OS sources combined
cat /dev/urandom | head -c 64 | sha256sum
echo "$(date -u +%s%N)-$(uname -a)-$(hostname)" | sha256sum

# Method C: External entropy (best)
# - Visit https://www.random.org/strings/ and generate random strings
# - Combine with your own keystrokes or dice rolls
# - Hash together: echo "random_org_result + your_phrase" | sha256sum
```

**DO NOT use:**
- Passwords you reuse
- Predictable strings (your name, date, etc.)
- Values generated on a compromised machine

#### 3. Contribute

```bash
# Set your entropy (it will NOT be logged or stored)
read -s PARTICIPANT_ENTROPY
export PARTICIPANT_ENTROPY

# Run the contribution (replace N with your contribution number)
bash scripts/ceremony/02_participant.sh "YourName-Institution" N

# IMMEDIATELY clear your entropy after the script finishes
unset PARTICIPANT_ENTROPY
history -c   # also clear shell history
```

The script will:
- Generate your contribution zkey
- Verify the chain is intact
- Create an attestation document in `zk/ceremony/`
- Print your contribution hash (keep this!)

#### 4. Record your contribution hash

The script prints something like:
```
Contribution hash:
  e3b0c44298fc1c14 9afbf4c8996fb924
  27ae41e4649b934c a495991b7852b855
```

**Save this hash.** It's the cryptographic proof your contribution was included.

#### 5. Send back to coordinator

Send to the ceremony coordinator:
- `zk/ceremony/contribution_000N.zkey`
- `zk/ceremony/attestation_000N_YourName.txt`
- Your contribution hash (for independent verification)

#### 6. Destroy your toxic waste

After sending, you MUST destroy the entropy you used:

```bash
# If you wrote it to a file:
shred -u /path/to/entropy_file

# If you used a USB drive:
# Perform a secure erase or physical destruction

# Clear RAM (best effort):
unset PARTICIPANT_ENTROPY
history -c

# Reboot the machine (recommended) to clear any swap/memory residue
```

**Why this matters:** The entropy you generated IS the "toxic waste." If you keep it,
you can forge proofs. If you destroy it, even you cannot break the system.

Write a short attestation (email is fine) stating:
> "I contributed to the OTK metering_v2 MPC ceremony. I have securely deleted my randomness and cannot reconstruct it."

---

## Beacon Application

After all participants have contributed, the coordinator applies **public randomness** — a value
that nobody could predict before contributions closed.

### Good beacon sources

| Source | Where to get | Format |
|--------|-------------|--------|
| Bitcoin block hash | `bitcoin-cli getblockhash <height>` or mempool.space | 64 hex chars |
| Ethereum block hash | `cast block <number> --field hash` or etherscan | 66 hex chars (0x...) |
| NIST Randomness Beacon | `beacon.nist.gov/beacon/2.0/pulse/last` | `outputValue` field |
| Drand | `drand.cloudflare.com/public/latest` | `randomness` field |

Choose a block **AFTER** all contributions are submitted. The block number should be agreed
on in advance (e.g., "we will use the Ethereum block mined after ISO date 2026-03-01T00:00:00Z").

```bash
BEACON_HASH="0000000000000000abc123..." \
BEACON_SOURCE="Bitcoin block #900000" \
BEACON_URL="https://mempool.space/block/..." \
bash scripts/ceremony/03_beacon.sh
```

This generates:
- `zk/keys/metering_v2_final_mpc.zkey` — production proving key
- `zk/keys/metering_v2_vkey_mpc.json` — production verification key
- `tools/hardhat/contracts/MeteringVerifierV2_mpc.sol` — production Solidity verifier

---

## Verification

Anyone can verify the complete ceremony chain:

```bash
bash scripts/ceremony/04_verify.sh
```

Or using the TypeScript coordinator:

```bash
npx tsx scripts/ceremony/CeremonyCoordinator.ts status
npx tsx scripts/ceremony/CeremonyCoordinator.ts report
```

### Independent verification

```bash
# Verify any intermediate zkey
npx snarkjs zkey verify \
  zk/build/metering_v2.r1cs \
  zk/keys/hermez_bn128_12_final.ptau \
  zk/ceremony/contribution_000N.zkey

# Verify final key
npx snarkjs zkey verify \
  zk/build/metering_v2.r1cs \
  zk/keys/hermez_bn128_12_final.ptau \
  zk/keys/metering_v2_final_mpc.zkey

# Verify a proof
npx snarkjs groth16 verify \
  zk/keys/metering_v2_vkey_mpc.json \
  zk/build/public.json \
  zk/build/proof.json
```

---

## Security Notes

### Threat model

| Threat | Mitigation |
|--------|-----------|
| Coordinator forges toxic waste | Phase 1 reuses Hermez (176+ contributors); Phase 2 requires all N contributors to collude |
| Participant keeps entropy | "1 of N honest" — any honest participant breaks this attack |
| Malicious R1CS | R1CS compiled deterministically from audited circuit; hash published in `state.json` |
| Beacon predictable | Use block hash agreed upon AFTER contributions closed |
| Network interception | zkeys are public — verification hash protects integrity |

### What "1 of N honest" means

If Participants 1–5 contributed, and Participant 3 honestly destroys their entropy:
- An attacker would need to know Participant 3's entropy to forge proofs
- They cannot, because Participant 3 destroyed it
- The ceremony is secure regardless of what Participants 1, 2, 4, 5 do

### Minimum security levels

| Contributors | Security level |
|-------------|---------------|
| 0 | ❌ INSECURE (pre-ceremony) |
| 1 | ⚠️ MINIMAL (not recommended) |
| 2 | ⚠️ ACCEPTABLE (development) |
| 3–4 | ✅ GOOD |
| 5+ | ✅ PRODUCTION READY |

---

## Attestation Template

Each participant should provide a signed attestation. Template:

```
OTK metering_v2.circom MPC Ceremony — Contribution Attestation

Participant: [Full Name]
Institution: [Organization, if applicable]
Contribution #: [N]
Date (UTC): [YYYY-MM-DD HH:MM:SS UTC]
Contribution hash: [64-char hex from snarkjs]

Statement:
I, [Name], contributed to the OTK metering_v2.circom Phase 2 trusted setup ceremony.
My contribution was generated from fresh, cryptographically random entropy on [date].
I have securely destroyed my entropy and cannot reconstruct it.

Contact: [email for verification]
PGP fingerprint (optional): [if signing this attestation]

[Signature or PGP-signed block]
```

---

## Coordinator Reference

```bash
# Full ceremony workflow
npx tsx scripts/ceremony/CeremonyCoordinator.ts init
npx tsx scripts/ceremony/CeremonyCoordinator.ts add-contribution \
  contrib_alice.zkey "Alice-FGV" --institution="FGV EAESP"
npx tsx scripts/ceremony/CeremonyCoordinator.ts add-contribution \
  contrib_bob.zkey "Bob-IME" --institution="IME-USP"
npx tsx scripts/ceremony/CeremonyCoordinator.ts apply-beacon \
  "0000...abc" "Bitcoin block #900000" "https://mempool.space/block/..."
npx tsx scripts/ceremony/CeremonyCoordinator.ts report
```

---

*This document is part of the OTK zk-Metering project.*
*Circuit: `zk/circuits/metering_v2.circom` — 430 NL + 444 L constraints*
*Security model: Groth16 "1-of-N honest" MPC, Phase 1 via Hermez (176+ contributors)*
