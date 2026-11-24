// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BatchReceiptRegistry
 * @notice On-chain batch settlement via Merkle root (ADR-0100).
 *
 * Reduces settlement cost from O(N) to O(1) per batch.
 * Individual receipts remain verifiable off-chain via Merkle proofs.
 *
 * Gas model:
 *   submitBatch: ~80,000 gas (signature check + storage + event)
 *   vs submitReceipt: 290,620 gas × N
 *   Break-even: N=1 receipt (any batch is cheaper than individual Groth16)
 *
 * Trust model:
 *   - trustedSigner signs the batch header (same signer as ReceiptRegistry)
 *   - On-chain verifies EIP-191 signature over encoded header
 *   - Anti-replay: batchRoot is unique per batch (keccak256 of N receipts)
 *   - Epoch enforcement: all receipts in batch share the same epoch
 *
 * Inclusion proof verification:
 *   - Off-chain: MerkleTree.verify(encodedReceipt, proof, root) in TypeScript
 *   - On-chain: verifyInclusion(leafHash, proof, root) in this contract
 *
 * @dev Hashing scheme: positional (not OZ sorted-pair).
 *   hashLeaf(data) = keccak256(data)
 *   hashNode(left, right) = keccak256(abi.encodePacked(left, right))
 *   Compatible with src/crypto/merkle.ts
 */
contract BatchReceiptRegistry {

    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    struct BatchHeader {
        bytes32 root;           // Merkle root of all N receipts
        uint256 count;          // Number of receipts in the batch
        uint256 totalCUBucket;  // Sum of bucketed CU (privacy-preserving)
        string  policyId;       // Bucket policy identifier
        uint256 epoch;          // Epoch shared by all receipts in the batch
        uint256 createdAt;      // Batch creation timestamp (Unix ms)
    }

    struct Signature {
        bytes32 rawHash;  // keccak256 of encoded BatchHeader (pre EIP-191)
        uint8   v;
        bytes32 r;
        bytes32 s;
        address signer;
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    address public immutable trustedSigner;

    /// @dev batchRoot → true if submitted (anti-replay)
    mapping(bytes32 => bool) public usedRoots;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event BatchSubmitted(
        bytes32 indexed batchRoot,
        uint256 count,
        uint256 totalCUBucket,
        uint256 epoch,
        address indexed submitter
    );

    // -------------------------------------------------------------------------
    // Custom Errors
    // -------------------------------------------------------------------------

    error InvalidBatchSignature();
    error BatchRootAlreadyUsed(bytes32 root);
    error EmptyBatch();
    error InvalidProofLength();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _trustedSigner) {
        require(_trustedSigner != address(0), "BatchReceiptRegistry: zero signer");
        trustedSigner = _trustedSigner;
    }

    // -------------------------------------------------------------------------
    // Core: Submit Batch
    // -------------------------------------------------------------------------

    /**
     * @notice Submit a batch of receipts via Merkle root.
     *
     * @param header - Batch header (root, count, totalCUBucket, epoch, ...)
     * @param sig    - EIP-191 signature over the encoded header by trustedSigner
     *
     * Requirements:
     *   - sig.signer == trustedSigner (ECDSA verification)
     *   - header.root not previously submitted (anti-replay)
     *   - header.count > 0
     */
    function submitBatch(
        BatchHeader calldata header,
        Signature calldata sig
    ) external {
        if (header.count == 0) revert EmptyBatch();
        if (usedRoots[header.root]) revert BatchRootAlreadyUsed(header.root);

        // EIP-191: verify signature over the raw hash
        bytes32 ethSigned = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", sig.rawHash)
        );
        address recovered = ecrecover(ethSigned, sig.v, sig.r, sig.s);
        if (recovered == address(0) || recovered != trustedSigner) {
            revert InvalidBatchSignature();
        }

        // Mark root as used (anti-replay)
        usedRoots[header.root] = true;

        emit BatchSubmitted(
            header.root,
            header.count,
            header.totalCUBucket,
            header.epoch,
            msg.sender
        );
    }

    // -------------------------------------------------------------------------
    // Inclusion Proof Verification
    // -------------------------------------------------------------------------

    /**
     * @notice Verify that a leaf is included in a submitted batch.
     *
     * Hashing scheme (positional):
     *   hashLeaf = keccak256(leafData)
     *   hashNode = keccak256(abi.encodePacked(left, right))
     *
     * @param leafHash    - keccak256(encodedReceipt) — use hashLeaf() off-chain
     * @param proof       - Sibling hashes from leaf to root (bottom-up)
     * @param leafIndex   - Original index of the leaf in the batch
     * @param batchRoot   - Root of the submitted batch (must be in usedRoots)
     *
     * @return true if the leaf is proven to be included in the batch
     */
    function verifyInclusion(
        bytes32 leafHash,
        bytes32[] calldata proof,
        uint256 leafIndex,
        bytes32 batchRoot
    ) external pure returns (bool) {
        if (proof.length == 0) revert InvalidProofLength();

        bytes32 computed = leafHash;
        uint256 index = leafIndex;

        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            if (index % 2 == 0) {
                // current is left child
                computed = keccak256(abi.encodePacked(computed, sibling));
            } else {
                // current is right child
                computed = keccak256(abi.encodePacked(sibling, computed));
            }
            index /= 2;
        }

        return computed == batchRoot;
    }

    /**
     * @notice Helper: compute leaf hash from raw receipt bytes (off-chain use).
     * @dev Convenience — same as keccak256(data).
     */
    function hashLeaf(bytes calldata data) external pure returns (bytes32) {
        return keccak256(data);
    }
}
