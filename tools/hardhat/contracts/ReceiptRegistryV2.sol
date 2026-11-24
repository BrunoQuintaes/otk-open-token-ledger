// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReceiptRegistryV2
 * @notice On-chain receipt validation for metering_v2.circom (range proof circuit).
 * @dev Same validation pipeline as ReceiptRegistry but uses 4-signal verifier interface:
 *      pubSignals[0] = commitment  (Poseidon hash — Groth16 OUTPUT, comes first)
 *      pubSignals[1] = epoch       (public input)
 *      pubSignals[2] = minUsageBucket (public input — lower bound, inclusive)
 *      pubSignals[3] = maxUsageBucket (public input — upper bound, inclusive)
 *
 * Privacy model: exact usage is hidden; only bucket membership is revealed on-chain.
 * MPC keys: metering_v2_final_mpc.zkey (5 contributors + Hermez Phase 1, beacon applied)
 *
 */

interface IGroth16VerifierV2 {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[4] calldata _pubSignals
    ) external view returns (bool);
}

contract ReceiptRegistryV2 {

    // --- Structs ---

    /// @notice Raw receipt data (subset needed for on-chain validation)
    struct RawReceiptData {
        uint256 userId;
        uint256 nonce;
        uint256 epoch;
        uint256 costUnits;
    }

    /// @notice Groth16 v2 proof data (4 public signals)
    struct ProofData {
        uint[2] a;
        uint[2][2] b;
        uint[2] c;
        /// @dev [commitment, epoch, minUsageBucket, maxUsageBucket] — Groth16 output-first order
        uint[4] pubSignals;
    }

    // --- State ---

    IGroth16VerifierV2 public immutable verifier;
    address public trustedSigner;

    /// @notice Per-submitter, per-userId expected nonce (ADR-0004)
    mapping(address => mapping(uint256 => uint256)) public nonces;

    /// @notice Commitment anti-replay (global)
    mapping(bytes32 => bool) public usedCommitments;

    // --- Events ---

    event ReceiptSubmittedV2(
        bytes32 indexed commitment,
        uint256 indexed userId,
        uint256 costUnits,
        uint256 epoch,
        uint256 minUsageBucket,
        uint256 maxUsageBucket,
        address submitter
    );

    // --- Custom Errors ---

    error InvalidSignature();
    error InvalidNonce(uint256 expected, uint256 provided);
    error CommitmentAlreadyUsed(bytes32 commitment);
    error InvalidProof();
    error EpochMismatch(uint256 proofEpoch, uint256 receiptEpoch);

    // --- Constructor ---

    constructor(address _verifier, address _trustedSigner) {
        verifier = IGroth16VerifierV2(_verifier);
        trustedSigner = _trustedSigner;
    }

    // --- Views ---

    /// @notice Query expected nonce for a submitter/userId pair
    function getNonce(address submitter, uint256 userId) external view returns (uint256) {
        return nonces[submitter][userId];
    }

    // --- Core ---

    /**
     * @notice Submit a v2 metering receipt with signature + range-proof ZK proof
     * @dev Validation order: signature → nonce → commitment → proof → epoch cross-check
     *
     * pubSignals order (canonical Groth16 output-first):
     *   [0] commitment       (Poseidon(userId, usage, nonce, epoch) — circuit OUTPUT)
     *   [1] epoch            (public input)
     *   [2] minUsageBucket   (public input — lower range bound)
     *   [3] maxUsageBucket   (public input — upper range bound)
     *
     * @param raw     Receipt data (userId, nonce, epoch, costUnits)
     * @param rawHash Canonical hash of full raw receipt (keccak256, computed off-chain)
     * @param v       ECDSA recovery id
     * @param r       ECDSA signature component
     * @param s       ECDSA signature component
     * @param proof   Groth16 v2 proof with 4 public signals
     */
    function submitReceipt(
        RawReceiptData calldata raw,
        bytes32 rawHash,
        uint8 v,
        bytes32 r,
        bytes32 s,
        ProofData calldata proof
    ) external {
        // 1) Signature verification (EIP-191 personal sign)
        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", rawHash)
        );
        address recovered = ecrecover(ethSignedHash, v, r, s);
        if (recovered == address(0) || recovered != trustedSigner) {
            revert InvalidSignature();
        }

        // 2) Nonce monotonic enforcement (ADR-0004)
        uint256 expectedNonce = nonces[msg.sender][raw.userId];
        if (raw.nonce != expectedNonce) {
            revert InvalidNonce(expectedNonce, raw.nonce);
        }
        nonces[msg.sender][raw.userId] = expectedNonce + 1;

        // 3) Commitment anti-replay (index 0 = Groth16 output = commitment)
        bytes32 commitment = bytes32(proof.pubSignals[0]);
        if (usedCommitments[commitment]) {
            revert CommitmentAlreadyUsed(commitment);
        }
        usedCommitments[commitment] = true;

        // 4) ZK proof verification (range proof: usage ∈ [minUsageBucket, maxUsageBucket])
        if (!verifier.verifyProof(proof.a, proof.b, proof.c, proof.pubSignals)) {
            revert InvalidProof();
        }

        // 5) Epoch cross-check (proof.pubSignals[1] = epoch must match raw.epoch)
        if (proof.pubSignals[1] != raw.epoch) {
            revert EpochMismatch(proof.pubSignals[1], raw.epoch);
        }

        // 6) Emit v2 event (includes bucket bounds for indexers)
        emit ReceiptSubmittedV2(
            commitment,
            raw.userId,
            raw.costUnits,
            proof.pubSignals[1],  // epoch
            proof.pubSignals[2],  // minUsageBucket
            proof.pubSignals[3],  // maxUsageBucket
            msg.sender
        );
    }
}
