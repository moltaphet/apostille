// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPrimusZKTLS, Attestation, AttNetworkResponseResolve} from "./interfaces/IPrimusZKTLS.sol";
import {FlatJson} from "./libraries/FlatJson.sol";

/// @title Apostille
/// @author moltaphet
/// @notice Carries a trader's centralized-exchange standing on-chain.
///
///         A user proves, with a Primus zkTLS attestation, the VIP level and 30-day
///         spot / futures volume Binance reports for their account. Apostille checks the
///         proof, binds it to the caller's wallet, and issues a time-boxed "seal" that maps
///         to a fee tier any protocol can read with a single call.
///
///         The Binance user ID never touches the chain: the template hashes it (SHA256) inside
///         the attestation, and the hash is used as a nullifier so one exchange account can
///         back exactly one wallet at a time.
contract Apostille is Ownable2Step {
    using FlatJson for string;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice A fee tier. A seal qualifies for a tier if EITHER condition holds.
    struct Tier {
        string name;
        uint8 minVipLevel; // Binance VIP level that qualifies on its own
        uint128 minFuturesVolume; // 30-day futures volume (USD, integer) that qualifies on its own
        uint16 feeDiscountBps; // discount a consuming protocol should apply, in basis points
    }

    struct Seal {
        bytes32 accountHash; // SHA256(Binance userId) as produced by the attestation
        uint8 vipLevel;
        uint8 tier;
        uint64 issuedAt; // attestation timestamp, seconds
        uint64 expiresAt;
        uint128 spot30dVolume;
        uint128 futures30dVolume;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice The only Binance endpoint whose response Apostille accepts.
    string public constant SOURCE_URL =
        "https://www.binance.com/bapi/accounts/v1/private/vip/vip-portal/vip-fee/vip-fee-summary";

    uint256 public constant MAX_TIERS = 16;
    uint256 private constant MAX_CLOCK_DRIFT = 5 minutes;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IPrimusZKTLS public primus;

    /// @notice How old an attestation may be when it is submitted.
    uint64 public maxAttestationAge;

    /// @notice How long a seal stays valid after its attestation was produced.
    uint64 public sealValidity;

    Tier[] private _tiers;

    mapping(address wallet => Seal) private _seals;
    mapping(bytes32 accountHash => address wallet) public walletOf;
    mapping(bytes32 accountHash => uint64 timestampMs) public lastAttestationAt;

    // ---------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------

    event Sealed(
        address indexed wallet,
        bytes32 indexed accountHash,
        uint8 tier,
        uint8 vipLevel,
        uint128 futures30dVolume,
        uint128 spot30dVolume,
        uint64 expiresAt
    );
    event Released(address indexed wallet, bytes32 indexed accountHash);
    event TiersUpdated(uint256 count);
    event PrimusUpdated(address primus);
    event WindowsUpdated(uint64 maxAttestationAge, uint64 sealValidity);

    error RecipientMismatch(address recipient, address caller);
    error UnexpectedSource(string url);
    error UnexpectedField(string keyName);
    error StaleAttestation(uint64 timestampMs);
    error AttestationFromFuture(uint64 timestampMs);
    error ReplayedAttestation(uint64 timestampMs, uint64 lastTimestampMs);
    error AccountBoundElsewhere(address wallet);
    error NoActiveSeal(address wallet);
    error InvalidTiers();
    error InvalidWindow();
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Construction & admin
    // ---------------------------------------------------------------------

    constructor(
        address owner_,
        IPrimusZKTLS primus_,
        uint64 maxAttestationAge_,
        uint64 sealValidity_,
        Tier[] memory tiers_
    ) Ownable(owner_) {
        _setPrimus(primus_);
        _setWindows(maxAttestationAge_, sealValidity_);
        _setTiers(tiers_);
    }

    function setPrimus(IPrimusZKTLS primus_) external onlyOwner {
        _setPrimus(primus_);
    }

    function setWindows(uint64 maxAttestationAge_, uint64 sealValidity_) external onlyOwner {
        _setWindows(maxAttestationAge_, sealValidity_);
    }

    /// @notice Replaces the tier table. Existing seals keep their stored tier until renewed.
    function setTiers(Tier[] calldata tiers_) external onlyOwner {
        _setTiers(tiers_);
    }

    // ---------------------------------------------------------------------
    // Core
    // ---------------------------------------------------------------------

    /// @notice Verifies a Primus attestation of the caller's Binance standing and issues
    ///         (or renews) the caller's seal.
    /// @param att The attestation returned by `PrimusZKTLS.startAttestation`, produced with
    ///            the Apostille template and `recipient` set to the caller.
    function seal(Attestation calldata att) external returns (Seal memory s) {
        // 1. Signature from a Primus attestor (reverts on failure).
        primus.verifyAttestation(att);

        // 2. Bound to the caller, so a proof can't be lifted from the mempool.
        if (att.recipient != msg.sender) revert RecipientMismatch(att.recipient, msg.sender);

        // 3. From the right endpoint, extracted from the right JSON paths.
        _checkSource(att);

        // 4. Fresh, and newer than anything this account has used before.
        uint64 issuedAt = _checkFreshness(att.timestamp);

        // 5. Decode the verified payload.
        string memory data = att.data;
        bytes32 accountHash = data.get("userId").toBytes32();
        uint256 vip = data.get("vipLevel").toUintFloor();
        uint256 spot = data.get("spot30dVol").toUintFloor();
        uint256 futures = data.get("futures30dVol").toUintFloor();

        uint64 last = lastAttestationAt[accountHash];
        if (att.timestamp <= last) revert ReplayedAttestation(att.timestamp, last);
        lastAttestationAt[accountHash] = att.timestamp;

        // 6. One exchange account <-> one wallet. A lapsed binding may be reclaimed.
        _bind(accountHash, msg.sender);

        s = Seal({
            accountHash: accountHash,
            vipLevel: uint8(vip > type(uint8).max ? type(uint8).max : vip),
            tier: 0,
            issuedAt: issuedAt,
            expiresAt: issuedAt + sealValidity,
            spot30dVolume: _toU128(spot),
            futures30dVolume: _toU128(futures)
        });
        s.tier = _resolveTier(s.vipLevel, s.futures30dVolume);
        _seals[msg.sender] = s;

        emit Sealed(msg.sender, accountHash, s.tier, s.vipLevel, s.futures30dVolume, s.spot30dVolume, s.expiresAt);
    }

    /// @notice Drops the caller's seal and frees their exchange account for another wallet.
    function release() external {
        Seal storage s = _seals[msg.sender];
        bytes32 accountHash = s.accountHash;
        if (accountHash == bytes32(0)) revert NoActiveSeal(msg.sender);
        delete walletOf[accountHash];
        delete _seals[msg.sender];
        emit Released(msg.sender, accountHash);
    }

    // ---------------------------------------------------------------------
    // Views for integrating protocols
    // ---------------------------------------------------------------------

    /// @notice The one call a protocol needs: the wallet's active tier and its fee discount.
    /// @return active   Whether the wallet holds an unexpired seal.
    /// @return tier     Tier index (0 when inactive).
    /// @return discountBps Fee discount for that tier, in basis points (0 when inactive).
    function tierOf(address wallet) external view returns (bool active, uint8 tier, uint16 discountBps) {
        Seal storage s = _seals[wallet];
        if (s.accountHash == bytes32(0) || block.timestamp > s.expiresAt) return (false, 0, 0);
        tier = s.tier < _tiers.length ? s.tier : uint8(_tiers.length - 1);
        return (true, tier, _tiers[tier].feeDiscountBps);
    }

    function sealOf(address wallet) external view returns (Seal memory) {
        return _seals[wallet];
    }

    function isActive(address wallet) public view returns (bool) {
        Seal storage s = _seals[wallet];
        return s.accountHash != bytes32(0) && block.timestamp <= s.expiresAt;
    }

    function tiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    /// @notice Which tier a given standing would land in under the current table.
    function previewTier(uint8 vipLevel, uint128 futures30dVolume) external view returns (uint8) {
        return _resolveTier(vipLevel, futures30dVolume);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _checkSource(Attestation calldata att) private pure {
        if (!_startsWith(att.request.url, SOURCE_URL)) revert UnexpectedSource(att.request.url);

        // Every revealed field must come from the expected jsonPath. This stops a template
        // that, say, maps `futures30dVol` onto a different number in the same response.
        AttNetworkResponseResolve[] calldata fields = att.reponseResolve;
        for (uint256 i; i < fields.length; ++i) {
            bytes32 key = keccak256(bytes(fields[i].keyName));
            bytes32 path = keccak256(bytes(fields[i].parsePath));
            bool ok = (key == keccak256("userId") && path == keccak256("$.data.userId"))
                || (key == keccak256("vipLevel") && path == keccak256("$.data.vipLevel"))
                || (key == keccak256("spot30dVol") && path == keccak256("$.data.spot30dVol"))
                || (key == keccak256("futures30dVol") && path == keccak256("$.data.futures30dVol"));
            if (!ok) revert UnexpectedField(fields[i].keyName);
        }
    }

    function _checkFreshness(uint64 timestampMs) private view returns (uint64 issuedAt) {
        issuedAt = timestampMs / 1000;
        if (issuedAt > block.timestamp + MAX_CLOCK_DRIFT) revert AttestationFromFuture(timestampMs);
        if (block.timestamp > issuedAt + maxAttestationAge) revert StaleAttestation(timestampMs);
    }

    function _bind(bytes32 accountHash, address wallet) private {
        address current = walletOf[accountHash];
        if (current != address(0) && current != wallet) {
            if (isActive(current)) revert AccountBoundElsewhere(current);
            // Lapsed binding: retire the old wallet's seal.
            delete _seals[current];
            emit Released(current, accountHash);
        }

        // If this wallet was previously backed by a different account, free that account.
        bytes32 previous = _seals[wallet].accountHash;
        if (previous != bytes32(0) && previous != accountHash) {
            delete walletOf[previous];
            emit Released(wallet, previous);
        }

        walletOf[accountHash] = wallet;
    }

    function _resolveTier(uint8 vipLevel, uint128 futuresVolume) private view returns (uint8 best) {
        uint256 n = _tiers.length;
        for (uint256 i = 1; i < n; ++i) {
            Tier storage t = _tiers[i];
            if (vipLevel >= t.minVipLevel || futuresVolume >= t.minFuturesVolume) best = uint8(i);
        }
    }

    function _setTiers(Tier[] memory tiers_) private {
        uint256 n = tiers_.length;
        if (n == 0 || n > MAX_TIERS) revert InvalidTiers();
        // Tier 0 is the floor everyone qualifies for; higher tiers must be strictly harder.
        if (tiers_[0].minVipLevel != 0 || tiers_[0].minFuturesVolume != 0) revert InvalidTiers();
        for (uint256 i = 1; i < n; ++i) {
            if (
                tiers_[i].minVipLevel <= tiers_[i - 1].minVipLevel
                    || tiers_[i].minFuturesVolume <= tiers_[i - 1].minFuturesVolume
                    || tiers_[i].feeDiscountBps < tiers_[i - 1].feeDiscountBps
            ) revert InvalidTiers();
        }
        if (tiers_[n - 1].feeDiscountBps > 10_000) revert InvalidTiers();

        delete _tiers;
        for (uint256 i; i < n; ++i) _tiers.push(tiers_[i]);
        emit TiersUpdated(n);
    }

    function _setPrimus(IPrimusZKTLS primus_) private {
        if (address(primus_) == address(0)) revert ZeroAddress();
        primus = primus_;
        emit PrimusUpdated(address(primus_));
    }

    function _setWindows(uint64 maxAge, uint64 validity) private {
        if (maxAge == 0 || maxAge > 1 days || validity == 0 || validity > 90 days) revert InvalidWindow();
        maxAttestationAge = maxAge;
        sealValidity = validity;
        emit WindowsUpdated(maxAge, validity);
    }

    function _toU128(uint256 v) private pure returns (uint128) {
        return v > type(uint128).max ? type(uint128).max : uint128(v);
    }

    function _startsWith(string calldata str, string memory prefix) private pure returns (bool) {
        bytes calldata s = bytes(str);
        bytes memory p = bytes(prefix);
        if (s.length < p.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (s[i] != p[i]) return false;
        }
        // Allow an exact match or a query string, nothing else (no path suffix tricks).
        return s.length == p.length || s[p.length] == "?";
    }
}
