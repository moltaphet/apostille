// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IApostille} from "../integrations/IApostille.sol";
import {ApostilleFees} from "../integrations/ApostilleFees.sol";

/// @title DemoPerp
/// @author moltaphet
/// @notice A deliberately small perp venue that shows how a protocol honours Apostille seals:
///         every trade's taker fee is discounted by the trader's sealed tier.
/// @dev Demo only. There is no price oracle, PnL, funding or liquidation; positions are tracked
///      as signed notional so the fee path is real and testable. Do not use with real funds.
contract DemoPerp is Ownable2Step {
    using SafeERC20 for IERC20;
    using ApostilleFees for IApostille;

    IERC20 public immutable collateral;
    IApostille public apostille;
    address public treasury;

    uint256 public baseFeePips; // 1 pip = 0.0001%, so 500 = 0.05%
    uint16 public maxDiscountBps; // cap on what Apostille can grant

    mapping(address => uint256) public margin;
    mapping(address => int256) public position; // signed notional, collateral units

    event Deposited(address indexed trader, uint256 amount);
    event Withdrawn(address indexed trader, uint256 amount);
    event Traded(address indexed trader, int256 sizeDelta, int256 position, uint256 fee, uint256 feePips, uint8 tier);
    event FeeConfigUpdated(uint256 baseFeePips, uint16 maxDiscountBps);
    event ApostilleUpdated(address apostille);

    error ZeroAmount();
    error InsufficientMargin(uint256 needed, uint256 available);
    error FeeTooHigh();
    error ZeroAddress();

    constructor(address owner_, IERC20 collateral_, IApostille apostille_, address treasury_, uint256 baseFeePips_, uint16 maxDiscountBps_)
        Ownable(owner_)
    {
        if (treasury_ == address(0)) revert ZeroAddress();
        collateral = collateral_;
        apostille = apostille_;
        treasury = treasury_;
        _setFees(baseFeePips_, maxDiscountBps_);
    }

    // ── trader actions ───────────────────────────────────────────────────

    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        margin[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 m = margin[msg.sender];
        if (amount > m) revert InsufficientMargin(amount, m);
        margin[msg.sender] = m - amount;
        collateral.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Opens, adds to, reduces or flips a position. The taker fee on |sizeDelta| is paid
    ///         from margin at the trader's Apostille-discounted rate.
    function trade(int256 sizeDelta) external returns (uint256 fee) {
        if (sizeDelta == 0) revert ZeroAmount();
        uint256 notional = sizeDelta > 0 ? uint256(sizeDelta) : uint256(-sizeDelta);
        (uint256 f, uint256 pips, uint8 tier) = apostille.feeOn(msg.sender, notional, baseFeePips, maxDiscountBps);
        uint256 m = margin[msg.sender];
        if (f > m) revert InsufficientMargin(f, m);
        margin[msg.sender] = m - f;
        position[msg.sender] += sizeDelta;
        if (f > 0) collateral.safeTransfer(treasury, f);
        emit Traded(msg.sender, sizeDelta, position[msg.sender], f, pips, tier);
        return f;
    }

    // ── views ────────────────────────────────────────────────────────────

    /// @notice What `trader` would pay on `notional`, and at which rate and tier.
    function quote(address trader, uint256 notional) external view returns (uint256 fee, uint256 feePips, uint8 tier) {
        return apostille.feeOn(trader, notional, baseFeePips, maxDiscountBps);
    }

    // ── admin ────────────────────────────────────────────────────────────

    function setFees(uint256 baseFeePips_, uint16 maxDiscountBps_) external onlyOwner {
        _setFees(baseFeePips_, maxDiscountBps_);
    }

    function setApostille(IApostille apostille_) external onlyOwner {
        apostille = apostille_;
        emit ApostilleUpdated(address(apostille_));
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
    }

    function _setFees(uint256 base, uint16 maxDisc) private {
        if (base > 10_000 || maxDisc > 10_000) revert FeeTooHigh(); // base capped at 1%
        baseFeePips = base;
        maxDiscountBps = maxDisc;
        emit FeeConfigUpdated(base, maxDisc);
    }
}
