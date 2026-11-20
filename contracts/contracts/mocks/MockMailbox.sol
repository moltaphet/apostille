// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMailbox, IMessageRecipient} from "../interfaces/IMailbox.sol";

/// @notice Test double for a Hyperlane mailbox. Messages queue up and are delivered on demand,
///         in any order, to recipients on the same chain.
contract MockMailbox is IMailbox {
    struct Message {
        uint32 destination;
        bytes32 sender;
        bytes32 recipient;
        bytes body;
        bool delivered;
    }

    uint32 public immutable localDomain;
    uint256 public fee;
    Message[] public messages;

    constructor(uint32 localDomain_, uint256 fee_) {
        localDomain = localDomain_;
        fee = fee_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function quoteDispatch(uint32, bytes32, bytes calldata) external view returns (uint256) {
        return fee;
    }

    function dispatch(uint32 destination, bytes32 recipient, bytes calldata body) external payable returns (bytes32) {
        require(msg.value >= fee, "fee");
        messages.push(Message(destination, bytes32(uint256(uint160(msg.sender))), recipient, body, false));
        return keccak256(abi.encode(messages.length));
    }

    function count() external view returns (uint256) {
        return messages.length;
    }

    /// @notice Delivers message `i` as if it came from domain `origin`.
    function deliver(uint256 i, uint32 origin) external {
        Message storage m = messages[i];
        m.delivered = true;
        IMessageRecipient(address(uint160(uint256(m.recipient)))).handle(origin, m.sender, m.body);
    }

    /// @notice Delivers a forged message, to test that recipients check the sender.
    function deliverRaw(address recipient, uint32 origin, bytes32 sender, bytes calldata body) external {
        IMessageRecipient(recipient).handle(origin, sender, body);
    }
}
