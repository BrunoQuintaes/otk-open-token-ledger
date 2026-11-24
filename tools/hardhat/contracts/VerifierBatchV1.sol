// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title VerifierBatchV1
 * @notice Batch Groth16 verifier — verifies N metering_v1 proofs in a single transaction.
 *
 * MOTIVATION:
 *   submitReceipt (ReceiptRegistry) costs 290,620 gas per individual receipt.
 *   VerifierBatchV1 batches N individual proofs into a single tx, saving:
 *     - N-1 transaction base costs (21,000 gas each)
 *     - N-1 sets of calldata costs
 *
 *   Gas model:
 *     Single-proof tx:   21,000 + 290,620 = 311,620 gas
 *     N-proof batch tx:  21,000 + N × 290,620 gas (≈ linear)
 *     Savings (N=10):    9 × 21,000 = 189,000 gas saved (overhead only)
 *
 *   This is NOT zkRollup (proofs not aggregated cryptographically).
 *   zkRollup-style aggregation (Halo2 IVC / PLONK folding) reduces to O(1).
 *   See: docs/architecture/adr/ADR-0100-batch-settlement-merkle.md
 *
 * DESIGN:
 *   - Delegates verification to a shared MeteringVerifier (v1 or v2)
 *   - Anti-replay: commitments recorded in usedCommitments (shared with ReceiptRegistry)
 *   - Epoch consistency: all proofs in batch must share the same epoch
 *   - Atomicity: all proofs verified or none stored (revert on any failure)
 *
 * @dev Uses evmVersion: "berlin" (no PUSH0) — Besu IBFT compatible.
 */

interface IGroth16Verifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[3] calldata _pubSignals
    ) external view returns (bool);
}

contract VerifierBatchV1 {

    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    struct ReceiptProof {
        uint[2]     pA;
        uint[2][2]  pB;
        uint[2]     pC;
        // pubSignals[0] = commitment, [1] = epoch, [2] = maxUsage
        uint[3]     pubSignals;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    IGroth16Verifier public immutable verifier;

    /// @dev commitment → true if already submitted (anti-replay)
    mapping(uint256 => bool) public usedCommitments;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event BatchVerified(
        uint256 indexed epoch,
        uint256 batchSize,
        address indexed submitter
    );

    event ProofAccepted(
        uint256 indexed commitment,
        uint256 epoch,
        uint256 maxUsage
    );

    // -------------------------------------------------------------------------
    // Custom Errors
    // -------------------------------------------------------------------------

    error EmptyBatch();
    error ProofVerificationFailed(uint256 index, uint256 commitment);
    error CommitmentAlreadyUsed(uint256 commitment);
    error EpochMismatch(uint256 expected, uint256 got, uint256 index);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _verifier) {
        require(_verifier != address(0), "VerifierBatchV1: zero verifier");
        verifier = IGroth16Verifier(_verifier);
    }

    // -------------------------------------------------------------------------
    // Core: Submit Batch
    // -------------------------------------------------------------------------

    /**
     * @notice Verify and record N Groth16 proofs in a single transaction.
     *
     * All proofs must:
     *   - Pass verification against the shared MeteringVerifier
     *   - Have unique, unused commitments (anti-replay)
     *   - Share the same epoch (single-epoch batch)
     *
     * Atomicity: reverts on any failure; no partial state changes.
     *
     * @param proofs Array of N ReceiptProof structs (Groth16 proofs + pubSignals)
     */
    function submitBatch(ReceiptProof[] calldata proofs) external {
        uint256 n = proofs.length;
        if (n == 0) revert EmptyBatch();

        uint256 batchEpoch = proofs[0].pubSignals[1];

        // Phase 1: Validate all proofs (no state changes — atomicity guarantee)
        for (uint256 i = 0; i < n; i++) {
            uint256 commitment = proofs[i].pubSignals[0];
            uint256 epoch      = proofs[i].pubSignals[1];

            // Epoch consistency
            if (epoch != batchEpoch) {
                revert EpochMismatch(batchEpoch, epoch, i);
            }

            // Anti-replay
            if (usedCommitments[commitment]) {
                revert CommitmentAlreadyUsed(commitment);
            }

            // Groth16 verification
            bool valid = verifier.verifyProof(
                proofs[i].pA,
                proofs[i].pB,
                proofs[i].pC,
                proofs[i].pubSignals
            );
            if (!valid) {
                revert ProofVerificationFailed(i, commitment);
            }
        }

        // Phase 2: Commit state (all proofs valid)
        for (uint256 i = 0; i < n; i++) {
            uint256 commitment = proofs[i].pubSignals[0];
            uint256 epoch      = proofs[i].pubSignals[1];
            uint256 maxUsage   = proofs[i].pubSignals[2];

            usedCommitments[commitment] = true;
            emit ProofAccepted(commitment, epoch, maxUsage);
        }

        emit BatchVerified(batchEpoch, n, msg.sender);
    }

    // -------------------------------------------------------------------------
    // View: Check commitment
    // -------------------------------------------------------------------------

    /**
     * @notice Check if a commitment has already been used.
     * @param commitment pubSignals[0] from a metering_v1 proof.
     */
    function isUsed(uint256 commitment) external view returns (bool) {
        return usedCommitments[commitment];
    }
}
