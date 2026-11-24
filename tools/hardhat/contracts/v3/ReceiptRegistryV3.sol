// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./OtkSignerSet.sol";

interface IGroth16VerifierV3 {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[4] calldata _pubSignals
    ) external view returns (bool);
}

/**
 * @title ReceiptRegistryV3
 * @notice Public registration of one metered operation for metering_v3 (D1/D2, run 20260930-1625).
 *
 * Accepts an authorization only if:
 *   1. an enabled operator key signed exactly these fields (EIP-712 digest recomputed here from the
 *      arguments, domain = chain id + this contract + schema version) — fixes R16;
 *   2. verifier, circuit id and bucket policy are the ones this registry was deployed with
 *      (a proof for another circuit/key/policy is refused);
 *   3. the public window is aligned and exactly `bucketWidth` wide (no per-receipt narrow window);
 *   4. operationRef and commitment were never registered here (replay → AlreadyRegistered);
 *   5. pubSignals == [commitment, epoch, minUsage, maxUsage] and the Groth16 proof verifies.
 *
 * Public data: commitment (hiding, randomized), epoch (hour), window, operationRef (hiding),
 * signer, submitter. No exact usage, user, tenant or operation id appears in calldata or events.
 *
 * What it does NOT establish: that the provider measured honestly, how usage was computed (no
 * tokenization or CU formula in the circuit), or any property of the operator beyond holding an
 * enabled key. v1/v2 registries are historical and unchanged.
 */
contract ReceiptRegistryV3 is OtkSignerSet {
    string public constant NAME = "OTK ReceiptRegistryV3";
    string public constant SCHEMA_VERSION = "otk.registry.v3";

    bytes32 public constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(bytes32 circuitId,address verifier,uint256 commitment,uint64 epoch,uint64 minUsage,uint64 maxUsage,bytes32 bucketPolicy,bytes32 operationRef)"
    );

    struct Authorization {
        bytes32 circuitId;
        address verifier;
        uint256 commitment;
        uint64 epoch;
        uint64 minUsage;
        uint64 maxUsage;
        bytes32 bucketPolicy;
        bytes32 operationRef;
    }

    struct ProofData {
        uint[2] a;
        uint[2][2] b;
        uint[2] c;
        /// @dev [commitment, epoch, minUsage, maxUsage] — snarkjs Groth16 order (output first)
        uint[4] pubSignals;
    }

    IGroth16VerifierV3 public immutable verifier;
    bytes32 public immutable circuitId;
    bytes32 public immutable bucketPolicy;
    uint64 public immutable bucketWidth;

    /// @notice operationRef → authorization digest that registered it (0 = not registered)
    mapping(bytes32 => bytes32) public registeredDigest;
    mapping(uint256 => bool) public usedCommitments;

    event ReceiptRegisteredV3(
        bytes32 indexed operationRef,
        uint256 indexed commitment,
        uint64 epoch,
        uint64 minUsage,
        uint64 maxUsage,
        bytes32 digest,
        address signer,
        address submitter
    );

    error WrongVerifier(address got);
    error WrongCircuit(bytes32 got);
    error WrongBucketPolicy(bytes32 got);
    error BadBucket(uint64 minUsage, uint64 maxUsage);
    error AlreadyRegistered(bytes32 operationRef, bytes32 registered);
    error CommitmentAlreadyUsed(uint256 commitment);
    error PublicSignalsMismatch(uint256 index);
    error InvalidProof();

    constructor(address _verifier, address _signer, bytes32 _circuitId, bytes32 _bucketPolicy, uint64 _bucketWidth)
        OtkSignerSet(_signer)
    {
        if (_verifier == address(0)) revert ZeroAddress();
        require(_bucketWidth > 0, "bucketWidth");
        verifier = IGroth16VerifierV3(_verifier);
        circuitId = _circuitId;
        bucketPolicy = _bucketPolicy;
        bucketWidth = _bucketWidth;
    }

    function domainSeparator() public view returns (bytes32) {
        return _domainSeparator(NAME, SCHEMA_VERSION);
    }

    /// @notice EIP-712 digest the operator signs; recomputed from the arguments (TS: authorizationDigest).
    function hashAuthorization(Authorization calldata a) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            AUTHORIZATION_TYPEHASH, a.circuitId, a.verifier, a.commitment, a.epoch, a.minUsage, a.maxUsage, a.bucketPolicy, a.operationRef
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function submitReceipt(Authorization calldata a, bytes calldata signature, ProofData calldata proof) external {
        bytes32 digest = hashAuthorization(a);
        address signer = _requireSigner(digest, signature);

        if (a.verifier != address(verifier)) revert WrongVerifier(a.verifier);
        if (a.circuitId != circuitId) revert WrongCircuit(a.circuitId);
        if (a.bucketPolicy != bucketPolicy) revert WrongBucketPolicy(a.bucketPolicy);
        if (a.minUsage % bucketWidth != 0 || uint256(a.maxUsage) != uint256(a.minUsage) + bucketWidth - 1) {
            revert BadBucket(a.minUsage, a.maxUsage);
        }

        bytes32 prior = registeredDigest[a.operationRef];
        if (prior != bytes32(0)) revert AlreadyRegistered(a.operationRef, prior);
        if (usedCommitments[a.commitment]) revert CommitmentAlreadyUsed(a.commitment);

        if (proof.pubSignals[0] != a.commitment) revert PublicSignalsMismatch(0);
        if (proof.pubSignals[1] != a.epoch) revert PublicSignalsMismatch(1);
        if (proof.pubSignals[2] != a.minUsage) revert PublicSignalsMismatch(2);
        if (proof.pubSignals[3] != a.maxUsage) revert PublicSignalsMismatch(3);
        if (!verifier.verifyProof(proof.a, proof.b, proof.c, proof.pubSignals)) revert InvalidProof();

        registeredDigest[a.operationRef] = digest;
        usedCommitments[a.commitment] = true;
        emit ReceiptRegisteredV3(a.operationRef, a.commitment, a.epoch, a.minUsage, a.maxUsage, digest, signer, msg.sender);
    }
}
