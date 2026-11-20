// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The subset of Hyperlane's Mailbox that Apostille uses.
/// @dev https://docs.hyperlane.xyz/docs/reference/messaging/send
interface IMailbox {
    function localDomain() external view returns (uint32);

    function dispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody)
        external
        payable
        returns (bytes32 messageId);

    function quoteDispatch(uint32 destinationDomain, bytes32 recipientAddress, bytes calldata messageBody)
        external
        view
        returns (uint256 fee);
}

/// @notice Implemented by contracts that receive Hyperlane messages.
interface IMessageRecipient {
    function handle(uint32 origin, bytes32 sender, bytes calldata message) external payable;
}
