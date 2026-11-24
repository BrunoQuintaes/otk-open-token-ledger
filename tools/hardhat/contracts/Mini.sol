// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Mini {
    uint256 public x;
    event Set(uint256 v);

    function set(uint256 v) external {
        x = v;
        emit Set(v);
    }
}
