// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IMessageRecipient} from "./interfaces/IMailbox.sol";
import {Apostille} from "./Apostille.sol";

/// @title ApostilleSpoke
/// @author moltaphet
/// @notice A read-only mirror of the Apostille hub on another chain.
///
///         Seals are created and released only on the hub, which checks the Primus proof and owns
///         the nullifiers. The hub sends every change here through Hyperlane; this contract accepts
///         messages only from that hub, via its mailbox, and exposes the same `tierOf` / `sealOf`
///         / `isActive` views, so an integration written for the hub works unchanged.
///
///         Messages can arrive out of order. Each carries the hub's increasing nonce, and anything
///         older than what a wallet or an account has already seen is dropped, so the mirror always
///         converges on the hub's latest state. Old messages are dropped quietly rather than
///         reverted, so a relayer never retries them forever.
contract ApostilleSpoke is IMessageRecipient, Ownable2Step {
    address public immutable mailbox;
    uint32 public immutable hubDomain;
    /// @notice The hub contract on `hubDomain`. Changeable by the owner (a timelock) in case the
    ///         hub is redeployed.
    bytes32 public hub;

    mapping(address wallet => Apostille.Seal) private _seals;
    mapping(address wallet => uint16) public discountOf;
    mapping(bytes32 account => address wallet) public walletOf;
    mapping(bytes32 account => uint64) public accountNonce;
    mapping(address wallet => uint64) public walletNonce;

    event Mirrored(address indexed wallet, bytes32 indexed account, uint8 kind, uint64 nonce);
    event Dropped(address indexed wallet, bytes32 indexed account, uint64 nonce);
    event HubUpdated(bytes32 hub);

    error NotMailbox(address caller);
    error NotHub(uint32 origin, bytes32 sender);
    error UnknownMessage(uint8 kind);
    error ZeroAddress();

    constructor(address owner_, address mailbox_, uint32 hubDomain_, address hub_) Ownable(owner_) {
        if (mailbox_ == address(0) || hub_ == address(0)) revert ZeroAddress();
        mailbox = mailbox_;
        hubDomain = hubDomain_;
        hub = bytes32(uint256(uint160(hub_)));
    }

    function setHub(address hub_) external onlyOwner {
        if (hub_ == address(0)) revert ZeroAddress();
        hub = bytes32(uint256(uint160(hub_)));
        emit HubUpdated(hub);
    }

    /// @inheritdoc IMessageRecipient
    function handle(uint32 origin, bytes32 sender, bytes calldata message) external payable {
        if (msg.sender != mailbox) revert NotMailbox(msg.sender);
        if (origin != hubDomain || sender != hub) revert NotHub(origin, sender);

        (uint8 kind, uint64 nonce, address wallet, Apostille.Seal memory s, uint16 discount) =
            abi.decode(message, (uint8, uint64, address, Apostille.Seal, uint16));

        if (nonce <= accountNonce[s.account] || nonce <= walletNonce[wallet]) {
            emit Dropped(wallet, s.account, nonce);
            return;
        }
        accountNonce[s.account] = nonce;
        walletNonce[wallet] = nonce;

        if (kind == 1) {
            // The account moved to this wallet: drop the copy held by its previous wallet.
            address current = walletOf[s.account];
            if (current != address(0) && current != wallet && _seals[current].account == s.account) {
                delete _seals[current];
                delete discountOf[current];
            }
            // This wallet moved to a new account: free the old one.
            bytes32 previous = _seals[wallet].account;
            if (previous != bytes32(0) && previous != s.account && walletOf[previous] == wallet) {
                delete walletOf[previous];
            }
            walletOf[s.account] = wallet;
            _seals[wallet] = s;
            discountOf[wallet] = discount;
        } else if (kind == 2) {
            if (walletOf[s.account] == wallet) delete walletOf[s.account];
            if (_seals[wallet].account == s.account) {
                delete _seals[wallet];
                delete discountOf[wallet];
            }
        } else {
            revert UnknownMessage(kind);
        }
        emit Mirrored(wallet, s.account, kind, nonce);
    }

    // ---------------------------------------------------------------------
    // Same views as the hub
    // ---------------------------------------------------------------------

    function tierOf(address wallet) external view returns (bool active, uint8 tier, uint16 discountBps) {
        if (!isActive(wallet)) return (false, 0, 0);
        return (true, _seals[wallet].tier, discountOf[wallet]);
    }

    function sealOf(address wallet) external view returns (Apostille.Seal memory) {
        return _seals[wallet];
    }

    function isActive(address wallet) public view returns (bool) {
        Apostille.Seal storage s = _seals[wallet];
        return s.account != bytes32(0) && block.timestamp <= s.expiresAt;
    }
}
