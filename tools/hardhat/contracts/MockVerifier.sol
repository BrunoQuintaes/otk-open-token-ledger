// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockVerifier
 * @notice Test-only mock for IGroth16Verifier. Returns configurable result.
 */
contract MockVerifier {
    bool public shouldVerify = true;

    function setVerify(bool _val) external {
        shouldVerify = _val;
    }

    function verifyProof(
        uint[2] calldata,
        uint[2][2] calldata,
        uint[2] calldata,
        uint[3] calldata
    ) external view returns (bool) {
        return shouldVerify;
    }
}
