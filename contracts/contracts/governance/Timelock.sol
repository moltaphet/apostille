// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Re-exported so hardhat compiles OpenZeppelin's TimelockController into this project's
// artifacts (used by the governance script and tests). No changes to OZ's audited code.
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
