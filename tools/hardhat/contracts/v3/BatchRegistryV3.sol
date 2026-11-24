// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./OtkSignerSet.sol";

/**
 * @title BatchRegistryV3
 * @notice Signed batch statement over a Merkle root of v3 authorization digests (D1 §5, R21).
 *
 * The operator signs (EIP-712) root, cardinality, declared member validation and epoch range;
 * the digest is recomputed here, so a signature for anything else (a single receipt, another
 * root or count) is refused. Inclusion is checked only against a registered root, for an index
 * below the registered cardinality, consuming exactly the given path.
 *
 * memberValidation (declared, checked OFF-CHAIN by the operator before building the root):
 *   1 = signature_each            every member's authorization signature
 *   2 = signature_and_proof_each  every member's signature and Groth16 proof
 * This contract verifies NO member proof. Registration here is not "N proofs verified".
 *
 * Merkle (TS: src/crypto/merkleV3.ts): leaf = keccak256(0x00 ‖ d), node = keccak256(0x01 ‖ l ‖ r),
 * last node of an odd level promoted unchanged.
 */
contract BatchRegistryV3 is OtkSignerSet {
    string public constant NAME = "OTK BatchRegistryV3";
    string public constant SCHEMA_VERSION = "otk.batch.v3";

    bytes32 public constant BATCH_TYPEHASH = keccak256(
        "BatchStatement(bytes32 root,uint64 cardinality,uint8 memberValidation,uint64 firstEpoch,uint64 lastEpoch)"
    );

    struct BatchStatement {
        bytes32 root;
        uint64 cardinality;
        uint8 memberValidation;
        uint64 firstEpoch;
        uint64 lastEpoch;
    }

    struct BatchRecord {
        uint64 cardinality;
        uint8 memberValidation;
        bytes32 digest;
    }

    mapping(bytes32 => BatchRecord) public batches;

    event BatchRegisteredV3(bytes32 indexed root, uint64 cardinality, uint8 memberValidation, uint64 firstEpoch, uint64 lastEpoch, bytes32 digest, address signer, address submitter);

    error EmptyBatch();
    error BadMemberValidation(uint8 level);
    error BadEpochRange();
    error RootAlreadyRegistered(bytes32 root);

    constructor(address _signer) OtkSignerSet(_signer) {}

    function domainSeparator() public view returns (bytes32) {
        return _domainSeparator(NAME, SCHEMA_VERSION);
    }

    function hashBatch(BatchStatement calldata st) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(BATCH_TYPEHASH, st.root, st.cardinality, st.memberValidation, st.firstEpoch, st.lastEpoch));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function registerBatch(BatchStatement calldata st, bytes calldata signature) external {
        bytes32 digest = hashBatch(st);
        address signer = _requireSigner(digest, signature);
        if (st.cardinality == 0) revert EmptyBatch();
        if (st.memberValidation != 1 && st.memberValidation != 2) revert BadMemberValidation(st.memberValidation);
        if (st.firstEpoch > st.lastEpoch) revert BadEpochRange();
        if (batches[st.root].cardinality != 0) revert RootAlreadyRegistered(st.root);
        batches[st.root] = BatchRecord(st.cardinality, st.memberValidation, digest);
        emit BatchRegisteredV3(st.root, st.cardinality, st.memberValidation, st.firstEpoch, st.lastEpoch, digest, signer, msg.sender);
    }

    /// @notice Root implied by (leaf digest, index, cardinality, path); bytes32(0) if the path does not fit.
    function computeRoot(bytes32 leafDigest, uint256 index, uint256 cardinality, bytes32[] calldata proof) public pure returns (bytes32) {
        if (cardinality == 0 || index >= cardinality) return bytes32(0);
        bytes32 h = keccak256(abi.encodePacked(bytes1(0x00), leafDigest));
        uint256 used = 0;
        uint256 i = index;
        uint256 n = cardinality;
        while (n > 1) {
            if (!(i == n - 1 && n % 2 == 1)) {
                if (used >= proof.length) return bytes32(0);
                bytes32 sib = proof[used++];
                h = i % 2 == 0
                    ? keccak256(abi.encodePacked(bytes1(0x01), h, sib))
                    : keccak256(abi.encodePacked(bytes1(0x01), sib, h));
            }
            i /= 2;
            n = (n + 1) / 2;
        }
        return used == proof.length ? h : bytes32(0);
    }

    /// @notice True only for a registered root, index < registered cardinality and an exact path.
    function verifyInclusion(bytes32 root, uint256 index, bytes32 leafDigest, bytes32[] calldata proof) external view returns (bool) {
        BatchRecord memory b = batches[root];
        if (b.cardinality == 0) return false;
        bytes32 got = computeRoot(leafDigest, index, b.cardinality, proof);
        return got != bytes32(0) && got == root;
    }
}
