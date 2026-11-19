// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {
    IPrimusZKTLS,
    Attestation,
    AttNetworkRequest,
    AttNetworkResponseResolve
} from "./interfaces/IPrimusZKTLS.sol";

/// @title AttestorVerifier
/// @author moltaphet
/// @notice A drop-in `IPrimusZKTLS` verifier with an owner-managed attestor set.
///
///         Primus's shared verifier on a given chain only accepts the attestors registered there.
///         Attestations from the enterprise zkTLS SDK are signed by Primus's enterprise attestor,
///         which is not registered on every chain. This contract verifies attestations with
///         exactly the same encoding as `PrimusZKTLS.encodeAttestation` (and the SDK's
///         `encodeAttestation`), against an attestor set this contract's owner controls.
///
/// @dev Signature scheme matches Primus: raw `ecrecover` over the keccak256 of the packed
///      attestation, no EIP-191 prefix, exactly one 65-byte signature.
contract AttestorVerifier is IPrimusZKTLS, Ownable2Step {
    mapping(address => bool) public isAttestor;
    address[] private _attestorList;

    event AttestorAdded(address indexed attestor);
    event AttestorRemoved(address indexed attestor);

    error InvalidSignatureCount();
    error InvalidSignatureLength();
    error InvalidSignatureV();
    error UnknownAttestor(address recovered);
    error ZeroAddress();

    constructor(address owner_, address[] memory attestors_) Ownable(owner_) {
        for (uint256 i; i < attestors_.length; ++i) _add(attestors_[i]);
    }

    function addAttestor(address attestor) external onlyOwner {
        _add(attestor);
    }

    function removeAttestor(address attestor) external onlyOwner {
        if (!isAttestor[attestor]) return;
        isAttestor[attestor] = false;
        uint256 n = _attestorList.length;
        for (uint256 i; i < n; ++i) {
            if (_attestorList[i] == attestor) {
                _attestorList[i] = _attestorList[n - 1];
                _attestorList.pop();
                break;
            }
        }
        emit AttestorRemoved(attestor);
    }

    function attestors() external view returns (address[] memory) {
        return _attestorList;
    }

    /// @inheritdoc IPrimusZKTLS
    function verifyAttestation(Attestation calldata attestation) external view {
        if (attestation.signatures.length != 1) revert InvalidSignatureCount();
        bytes calldata sig = attestation.signatures[0];
        if (sig.length != 65) revert InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 0x20))
            v := byte(0, calldataload(add(sig.offset, 0x40)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignatureV();

        address recovered = ecrecover(encodeAttestation(attestation), v, r, s);
        if (recovered == address(0) || !isAttestor[recovered]) revert UnknownAttestor(recovered);
    }

    /// @notice Identical to `PrimusZKTLS.encodeAttestation`.
    function encodeAttestation(Attestation calldata a) public pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                a.recipient,
                encodeRequest(a.request),
                encodeResponse(a.reponseResolve),
                a.data,
                a.attConditions,
                a.timestamp,
                a.additionParams
            )
        );
    }

    function encodeRequest(AttNetworkRequest calldata q) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(q.url, q.header, q.method, q.body));
    }

    function encodeResponse(AttNetworkResponseResolve[] calldata rs) public pure returns (bytes32) {
        bytes memory packed;
        for (uint256 i; i < rs.length; ++i) {
            packed = abi.encodePacked(packed, rs[i].keyName, rs[i].parseType, rs[i].parsePath);
        }
        return keccak256(packed);
    }

    function _add(address attestor) private {
        if (attestor == address(0)) revert ZeroAddress();
        if (isAttestor[attestor]) return;
        isAttestor[attestor] = true;
        _attestorList.push(attestor);
        emit AttestorAdded(attestor);
    }
}
