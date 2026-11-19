// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IApostille} from "./IApostille.sol";

/// @title ApostilleFees
/// @notice Drop-in helper for protocols: turn a base fee into a trader's discounted fee.
/// @dev Fails open: if the Apostille call reverts or returns garbage, the base fee applies.
///      A broken or paused registry must never block trading.
library ApostilleFees {
    uint256 internal constant BPS = 10_000;

    /// @notice Discounted fee rate for `trader`, in the same unit as `baseFeeRate`
    ///         (e.g. pips or bps), and the tier it came from.
    /// @param maxDiscountBps Cap the protocol is willing to grant, whatever Apostille suggests.
    function feeRate(IApostille apostille, address trader, uint256 baseFeeRate, uint16 maxDiscountBps)
        internal
        view
        returns (uint256 rate, uint8 tier)
    {
        if (address(apostille) == address(0)) return (baseFeeRate, 0);
        try apostille.tierOf(trader) returns (bool active, uint8 t, uint16 discountBps) {
            if (!active) return (baseFeeRate, 0);
            uint256 d = discountBps > maxDiscountBps ? maxDiscountBps : discountBps;
            if (d > BPS) d = BPS;
            return (baseFeeRate * (BPS - d) / BPS, t);
        } catch {
            return (baseFeeRate, 0);
        }
    }

    /// @notice Fee owed on `notional` at the trader's discounted rate, with the rate in pips
    ///         (1 pip = 0.0001%, so 500 pips = 0.05%).
    function feeOn(IApostille apostille, address trader, uint256 notional, uint256 baseFeePips, uint16 maxDiscountBps)
        internal
        view
        returns (uint256 fee, uint256 ratePips, uint8 tier)
    {
        (ratePips, tier) = feeRate(apostille, trader, baseFeePips, maxDiscountBps);
        fee = notional * ratePips / 1_000_000;
    }
}
