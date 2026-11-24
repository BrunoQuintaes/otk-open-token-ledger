pragma circom 2.1.6;

/*
  metering_v1.circom — ZK metering receipt (MVP)
  Statement:
   - public: (epoch, maxUsage, commitment)
   - private: (userId, usage, nonce)
   - constraints:
       commitment == Poseidon(userId, usage, nonce, epoch)
       usage <= maxUsage   (64-bit)
*/

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template MeteringReceipt() {
    signal input userId;
    signal input usage;
    signal input nonce;

    // public inputs
    signal input epoch;
    signal input maxUsage;

    // public output
    signal output commitment;

    // Poseidon(4) commitment
    component h = Poseidon(4);
    h.inputs[0] <== userId;
    h.inputs[1] <== usage;
    h.inputs[2] <== nonce;
    h.inputs[3] <== epoch;
    commitment <== h.out;

    // Range: usage <= maxUsage (64 bits)
    component le = LessEqThan(64);
    le.in[0] <== usage;
    le.in[1] <== maxUsage;
    le.out === 1;
}

// Groth16 public ordering matters (outputs are automatically public):
component main { public [epoch, maxUsage] } = MeteringReceipt();
