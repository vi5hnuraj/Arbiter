// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Local test helpers only — never deployed to real networks.

contract MockERC20 {
    string public name = "MockUSDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor() {
        balanceOf[msg.sender] = 1_000_000e6;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address t, uint256 a) external returns (bool) {
        return _m(msg.sender, t, a);
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allowance");
        allowance[f][msg.sender] -= a;
        return _m(f, t, a);
    }

    function _m(address f, address t, uint256 a) internal returns (bool) {
        require(balanceOf[f] >= a, "balance");
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

contract MockUSDG is MockERC20 {
    constructor() {
        name = "Global Dollar";
        symbol = "USDG";
    }
}

contract MockFeed {
    int256 public price = 1e8; // 1.00000000 USD per token

    function setPrice(int256 p) external {
        price = p;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, price, block.timestamp, block.timestamp, 1);
    }
}
