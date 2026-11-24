// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReceiptRegistry
 * @notice On-chain receipt validation with anti-replay (ADR-0002, ADR-0003, ADR-0004).
 * @dev Verifies ECDSA signature (authenticity) + Groth16 proof (ZK) + nonce + commitment.
 *
 * Signature scheme:
 *   - rawHash is computed off-chain (keccak256 of canonical receipt fields)
 *   - Signed via EIP-191 personal sign: sign(keccak256("\x19Ethereum Signed Message:\n32" + rawHash))
 *   - On-chain: ecrecover with same EIP-191 prefix
 *   - Binding: trusted signer's signature proves rawHash authenticity
 *
 * Public signals (metering_v1.circom) — CANONICAL ORDER (Groth16: outputs first):
 *   - pubSignals[0] = commitment (Poseidon hash — circuit OUTPUT, comes first in Groth16)
 *   - pubSignals[1] = epoch     (public input)
 *   - pubSignals[2] = maxUsage  (public input)
 * Fixed: U4.1 (2026-02-19) — previously had wrong order [epoch, maxUsage, commitment]
 */

interface IGroth16Verifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[3] calldata _pubSignals
    ) external view returns (bool);
}

contract ReceiptRegistry {

    // --- Structs ---

    /// @notice Raw receipt data (subset needed for on-chain validation + events)
    struct RawReceiptData {
        uint256 userId;
        uint256 nonce;
        uint256 epoch;
        uint256 costUnits;
    }

    /// @notice Groth16 proof data
    struct ProofData {
        uint[2] a;
        uint[2][2] b;
        uint[2] c;
        uint[3] pubSignals; // [commitment, epoch, maxUsage] — canonical Groth16 order
    }

    // --- State ---

    IGroth16Verifier public immutable verifier;
    address public trustedSigner;

    /// @notice Per-submitter, per-userId expected nonce (ADR-0004)
    mapping(address => mapping(uint256 => uint256)) public nonces;

    /// @notice Commitment anti-replay (global)
    mapping(bytes32 => bool) public usedCommitments;

    // --- Events ---

    event ReceiptSubmitted(
        bytes32 indexed commitment,
        uint256 indexed userId,
        uint256 costUnits,
        uint256 epoch,
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
        verifier = IGroth16Verifier(_verifier);
        trustedSigner = _trustedSigner;
    }

    // --- Views ---

    /// @notice Query expected nonce for a submitter/userId pair (query-before-submit pattern)
    function getNonce(address submitter, uint256 userId) external view returns (uint256) {
        return nonces[submitter][userId];
    }

    // --- Core ---

    /**
     * @notice Submit a metering receipt with signature + ZK proof
     * @dev Validation order: signature → nonce → commitment → proof → epoch cross-check
     * @param raw Receipt data (userId, nonce, epoch, costUnits)
     * @param rawHash Canonical hash of full raw receipt (computed off-chain by SDK)
     * @param v ECDSA recovery id
     * @param r ECDSA signature component
     * @param s ECDSA signature component
     * @param proof Groth16 proof with public signals [epoch, maxUsage, commitment]
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
        //    TS signs via: signer.signMessage(getBytes(rawHash))
        //    which prefixes: "\x19Ethereum Signed Message:\n32" + rawHash
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

        // 3) Commitment anti-replay
        bytes32 commitment = bytes32(proof.pubSignals[0]); // commitment at index 0 (Groth16 output)
        if (usedCommitments[commitment]) {
            revert CommitmentAlreadyUsed(commitment);
        }
        usedCommitments[commitment] = true;

        // 4) ZK proof verification
        if (!verifier.verifyProof(proof.a, proof.b, proof.c, proof.pubSignals)) {
            revert InvalidProof();
        }

        // 5) Epoch cross-check (proof.pubSignals[1] must match raw.epoch)
        if (proof.pubSignals[1] != raw.epoch) {
            revert EpochMismatch(proof.pubSignals[1], raw.epoch);
        }

        // 6) Emit event
        emit ReceiptSubmitted(
            commitment,
            raw.userId,
            raw.costUnits,
            proof.pubSignals[1], // epoch from proof (index 1)
            msg.sender
        );
    }
}
