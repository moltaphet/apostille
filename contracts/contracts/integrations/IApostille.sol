// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IApostille
/// @notice The read surface a protocol needs to honour Apostille seals.
interface IApostille {
    /// @return active      Whether the wallet holds an unexpired seal.
    /// @return tier        Tier index (0 when inactive).
    /// @return discountBps Suggested fee discount for that tier, in basis points.
    function tierOf(address wallet) external view returns (bool active, uint8 tier, uint16 discountBps);
}
