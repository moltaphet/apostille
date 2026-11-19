// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPrimusZKTLS, Attestation} from "../interfaces/IPrimusZKTLS.sol";

/// @dev Test double for the Primus verifier. Accepts every attestation unless told otherwise.
contract MockPrimusZKTLS is IPrimusZKTLS {
    bool public reject;

    function setReject(bool reject_) external {
        reject = reject_;
    }

    function verifyAttestation(Attestation calldata) external view {
        require(!reject, "Invalid signature");
    }
}
