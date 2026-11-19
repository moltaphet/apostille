// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IApostille} from "../integrations/IApostille.sol";

/// @dev Test double: returns a configured tier, or reverts / returns garbage on demand.
contract MockApostille is IApostille {
    struct T {
        bool active;
        uint8 tier;
        uint16 bps;
    }

    mapping(address => T) public t;
    bool public broken;

    function set(address w, bool active, uint8 tier, uint16 bps) external {
        t[w] = T(active, tier, bps);
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function tierOf(address w) external view returns (bool, uint8, uint16) {
        require(!broken, "registry down");
        T memory x = t[w];
        return (x.active, x.tier, x.bps);
    }
}
