// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title OtkSignerSet
 * @notice Operator signing keys accepted by a v3 registry (D1 §3): an owner enables and revokes
 *         addresses. Rotation = enable the new key, then revoke the old one. On-chain there is only
 *         "accepted now"; retired-vs-revoked for historical off-chain verification lives in the
 *         TypeScript KeyRing.
 * @dev EIP-712 signature recovery with low-s and v ∈ {27, 28} (no malleable duplicates).
 */
abstract contract OtkSignerSet {
    address public owner;
    mapping(address => bool) public isSigner;

    event SignerSet(address indexed signer, bool enabled);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();
    error BadSignature();
    error UnauthorizedSigner(address recovered);

    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    constructor(address initialSigner) {
        if (initialSigner == address(0)) revert ZeroAddress();
        owner = msg.sender;
        isSigner[initialSigner] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit SignerSet(initialSigner, true);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setSigner(address signer, bool enabled) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        isSigner[signer] = enabled;
        emit SignerSet(signer, enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @dev Recovers the signer of an EIP-712 digest from a 65-byte (r, s, v) signature and
    ///      requires it to be an enabled signer.
    function _requireSigner(bytes32 digest, bytes calldata signature) internal view returns (address signer) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        if (!isSigner[signer]) revert UnauthorizedSigner(signer);
    }

    function _domainSeparator(string memory name, string memory version) internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)),
            keccak256(bytes(version)),
            block.chainid,
            address(this)
        ));
    }
}
