pragma circom 2.1.6;

/*
  metering_v3.circom — hiding usage commitment + fixed public range (D1/D2, run 20260930-1625)

  Replaces, for new registrations only, the v1/v2 statement whose commitment
  Poseidon(userId, usage, nonce, epoch) had no secret randomness: with userId/nonce/epoch public,
  the usage could be recovered by enumerating a small domain (N13). v1/v2 artifacts stay as they
  were and keep their historical meaning; nothing here is retroactive.

  STATEMENT (what a valid proof shows, and nothing more):
    "The prover knows (usage, blinding, userRef) such that
       commitment == Poseidon(TAG_V3, usage, blinding, userRef, epoch),
       usage, minUsage, maxUsage are integers in [0, 2^64), and
       minUsage <= usage <= maxUsage."

  It does NOT show how usage was obtained: no tokenization, no CU formula, no provider origin.
  usage is an input chosen by whoever holds the opening (the operator), see D1 trust map.

  PUBLIC SIGNALS (snarkjs Groth16 order — outputs first):
    [0] commitment
    [1] epoch
    [2] minUsage
    [3] maxUsage

  PRIVATE INPUTS:
    usage     exact private usage in circuit units (micro-CU, see src/zk/v3/opening.ts)
    blinding  secret, uniform in the BN254 scalar field, from a CSPRNG (never a nonce/date/id)
    userRef   pseudonymous user reference inside the tenant (field element)

  NUMERIC RANGE (D2 §3, N7): circomlib LessEqThan(64) is only sound when both operands are
  < 2^64; it does not enforce that by itself (v1 accepted usage = p − 5). Num2Bits(64) below
  enforces the range of usage, minUsage and maxUsage inside the R1CS, not only in the witness
  generator. epoch is not compared; the registry takes it as uint64.
*/

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

template MeteringReceiptV3() {
    // ASCII "otk.metering.v3" as a big-endian integer (15 bytes < field size): domain tag so a
    // v3 commitment never equals a v1/v2 Poseidon(4) commitment of related values.
    var TAG_V3 = 0x6f746b2e6d65746572696e672e7633;

    signal input usage;
    signal input blinding;
    signal input userRef;

    signal input epoch;
    signal input minUsage;
    signal input maxUsage;

    signal output commitment;

    component rUsage = Num2Bits(64);
    rUsage.in <== usage;
    component rMin = Num2Bits(64);
    rMin.in <== minUsage;
    component rMax = Num2Bits(64);
    rMax.in <== maxUsage;

    component geMin = LessEqThan(64);
    geMin.in[0] <== minUsage;
    geMin.in[1] <== usage;
    geMin.out === 1;

    component leMax = LessEqThan(64);
    leMax.in[0] <== usage;
    leMax.in[1] <== maxUsage;
    leMax.out === 1;

    component h = Poseidon(5);
    h.inputs[0] <== TAG_V3;
    h.inputs[1] <== usage;
    h.inputs[2] <== blinding;
    h.inputs[3] <== userRef;
    h.inputs[4] <== epoch;
    commitment <== h.out;
}

component main { public [epoch, minUsage, maxUsage] } = MeteringReceiptV3();
