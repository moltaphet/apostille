// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DemoUSD
/// @notice Testnet-only collateral for DemoPerp. Anyone can mint a capped amount per call.
contract DemoUSD is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 100_000e18;

    constructor() ERC20("Apostille Demo USD", "dUSD") {}

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
