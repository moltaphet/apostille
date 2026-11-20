// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPrimusZKTLS, Attestation, AttNetworkResponseResolve} from "./interfaces/IPrimusZKTLS.sol";
import {FlatJson} from "./libraries/FlatJson.sol";
import {IMailbox} from "./interfaces/IMailbox.sol";

/// @title Apostille
/// @author moltaphet
/// @notice Carries a trader's centralized-exchange standing on-chain.
///
///         A user proves, with a Primus zkTLS attestation, what an exchange reports about their
///         account: VIP level and 30-day spot / futures volume. Apostille checks the proof, binds
///         it to the caller's wallet and issues a time-boxed seal that maps to a fee tier any
///         protocol can read with one call.
///
///         Two disclosure modes, chosen per proof through Primus attestation conditions:
///         - revealed: the exact numbers are attested and stored.
///         - concealed: only "value >= threshold" is attested, so the exact numbers never leave
///           the user's browser. The stored figures are the proven floors, not the real values.
///
///         The exchange user id never reaches the chain: Primus SHA256-hashes it inside the
///         attestation. Hashed per source, it is a nullifier: one exchange account backs one
///         wallet at a time.
///
///         Multi-chain: this contract is the hub. It alone verifies proofs and holds nullifiers.
///         Every seal and release is also sent through Hyperlane to registered spokes
///         (ApostilleSpoke) on other chains, which mirror the seals for integrators there. Because
///         the nullifier lives only here, one exchange account backs one wallet across all chains.
contract Apostille is Ownable2Step {
    using FlatJson for string;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice A fee tier. A seal qualifies if EITHER condition holds.
    struct Tier {
        string name;
        uint8 minVipLevel;
        uint128 minFuturesVolume; // 30-day futures volume, USD, integer
        uint16 feeDiscountBps;
    }

    /// @notice An exchange endpoint Apostille accepts, and where each field lives in its response.
    struct Source {
        string name;
        string url; // exact endpoint; a query string is allowed, a path suffix is not
        string idPath; // jsonPath of the account id, which must be SHA256-hashed
        string vipPath;
        string spotPath;
        string futuresPath;
        bool enabled;
    }

    struct Seal {
        bytes32 account; // nullifier: keccak256(sourceId, SHA256(exchange user id))
        uint8 source;
        uint8 vipLevel; // exact, or the proven floor when concealed
        uint8 tier;
        bool concealed;
        uint64 issuedAt;
        uint64 expiresAt;
        uint128 spot30dVolume; // exact, or the proven floor when concealed
        uint128 futures30dVolume; // exact, or the proven floor when concealed
    }

    // ---------------------------------------------------------------------
    // Constants & storage
    // ---------------------------------------------------------------------

    uint256 public constant MAX_TIERS = 16;
    uint256 public constant MAX_SOURCES = 32;
    uint256 private constant MAX_CLOCK_DRIFT = 5 minutes;
    uint256 public constant MAX_SPOKES = 8;

    /// @notice Message kinds sent to spokes.
    uint8 public constant MSG_SEAL = 1;
    uint8 public constant MSG_REVOKE = 2;

    bytes32 private constant OP_REVEAL = keccak256("REVEAL_STRING");
    bytes32 private constant OP_SHA256 = keccak256("SHA256");
    bytes32 private constant OP_GTE = keccak256(">=");
    bytes32 private constant OP_GT = keccak256(">");

    IPrimusZKTLS public primus;

    /// @notice May only stop things (pause sealing, disable a source), never start or change them.
    ///         Meant to be a fast-acting key while the owner sits behind a timelock.
    address public guardian;
    bool public paused;
    uint64 public maxAttestationAge;
    uint64 public sealValidity;

    Tier[] private _tiers;
    Source[] private _sources;

    mapping(address wallet => Seal) private _seals;
    mapping(bytes32 account => address wallet) public walletOf;
    mapping(bytes32 account => uint64 timestampMs) public lastAttestationAt;

    /// @notice A mirror of the registry on another chain.
    struct Spoke {
        uint32 domain; // Hyperlane domain id (equal to the chain id on the chains used here)
        address spoke;
    }

    IMailbox public mailbox;
    Spoke[] private _spokes;
    /// @notice Increases with every message, so spokes can drop anything delivered out of order.
    uint64 public syncNonce;

    // ---------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------

    event Sealed(
        address indexed wallet,
        bytes32 indexed account,
        uint8 indexed source,
        uint8 tier,
        bool concealed,
        uint8 vipLevel,
        uint128 futures30dVolume,
        uint128 spot30dVolume,
        uint64 expiresAt
    );
    event Released(address indexed wallet, bytes32 indexed account);
    event TiersUpdated(uint256 count);
    event SourceAdded(uint8 indexed id, string name, string url);
    event SourceEnabled(uint8 indexed id, bool enabled);
    event PrimusUpdated(address primus);
    event WindowsUpdated(uint64 maxAttestationAge, uint64 sealValidity);
    event GuardianUpdated(address guardian);
    event Paused(address by);
    event Unpaused(address by);
    event MailboxUpdated(address mailbox);
    event SpokeAdded(uint32 indexed domain, address spoke);
    event SpokeRemoved(uint32 indexed domain, address spoke);
    event Broadcast(address indexed wallet, uint8 kind, uint64 nonce, uint256 fee);

    error RecipientMismatch(address recipient, address caller);
    error UnexpectedSource(string url);
    error UnexpectedField(string parsePath);
    error MissingField(string parsePath);
    error UnsupportedCondition(string op, string parsePath);
    error IdNotHashed(string parsePath);
    error StaleAttestation(uint64 timestampMs);
    error AttestationFromFuture(uint64 timestampMs);
    error ReplayedAttestation(uint64 timestampMs, uint64 lastTimestampMs);
    error AccountBoundElsewhere(address wallet);
    error NoActiveSeal(address wallet);
    error InvalidTiers();
    error InvalidSource();
    error InvalidWindow();
    error ZeroAddress();
    error NotGuardian(address caller);
    error SealingPaused();
    error MalformedPayload();
    error InsufficientFee(uint256 required, uint256 provided);
    error InvalidSpoke();
    error RefundFailed();

    // ---------------------------------------------------------------------
    // Construction & admin
    // ---------------------------------------------------------------------

    constructor(
        address owner_,
        IPrimusZKTLS primus_,
        uint64 maxAttestationAge_,
        uint64 sealValidity_,
        Tier[] memory tiers_,
        Source[] memory sources_
    ) Ownable(owner_) {
        _setPrimus(primus_);
        _setWindows(maxAttestationAge_, sealValidity_);
        _setTiers(tiers_);
        for (uint256 i; i < sources_.length; ++i) _addSource(sources_[i]);
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

    /// @notice Registers a new exchange endpoint. Sources are append-only so ids stay stable.
    function addSource(Source calldata source) external onlyOwner returns (uint8 id) {
        return _addSource(source);
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianUpdated(guardian_);
    }

    /// @notice Stops new seals. Existing seals keep working for integrators until they expire.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian(msg.sender);
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Emergency brake for a single source, e.g. if an exchange changes its endpoint.
    function disableSource(uint8 id) external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian(msg.sender);
        if (id >= _sources.length) revert InvalidSource();
        _sources[id].enabled = false;
        emit SourceEnabled(id, false);
    }

    function setSourceEnabled(uint8 id, bool enabled) external onlyOwner {
        if (id >= _sources.length) revert InvalidSource();
        _sources[id].enabled = enabled;
        emit SourceEnabled(id, enabled);
    }

    /// @notice Hyperlane mailbox on this chain. Zero turns broadcasting off.
    function setMailbox(IMailbox mailbox_) external onlyOwner {
        mailbox = mailbox_;
        emit MailboxUpdated(address(mailbox_));
    }

    function addSpoke(uint32 domain, address spoke) external onlyOwner {
        if (spoke == address(0) || _spokes.length >= MAX_SPOKES) revert InvalidSpoke();
        for (uint256 i; i < _spokes.length; ++i) if (_spokes[i].domain == domain) revert InvalidSpoke();
        _spokes.push(Spoke(domain, spoke));
        emit SpokeAdded(domain, spoke);
    }

    function removeSpoke(uint32 domain) external onlyOwner {
        uint256 n = _spokes.length;
        for (uint256 i; i < n; ++i) {
            if (_spokes[i].domain == domain) {
                emit SpokeRemoved(domain, _spokes[i].spoke);
                _spokes[i] = _spokes[n - 1];
                _spokes.pop();
                return;
            }
        }
        revert InvalidSpoke();
    }

    // ---------------------------------------------------------------------
    // Core
    // ---------------------------------------------------------------------

    /// @notice Verifies a Primus attestation of the caller's exchange standing and issues
    ///         (or renews) the caller's seal. When spokes are registered, send
    ///         `quoteBroadcast()` as value to mirror the seal to them; any excess is refunded.
    function seal(Attestation calldata att) external payable returns (Seal memory s) {
        if (paused) revert SealingPaused();

        // 1. Signature from a trusted attestor (reverts on failure).
        primus.verifyAttestation(att);

        // Primus signs abi.encodePacked over consecutive strings, so field boundaries are not
        // part of the signature. Pin the shapes that delimit them (data is one object, the
        // conditions one array) so bytes can't be shifted from one field into its neighbour.
        _checkShape(att.data, att.attConditions);

        // 2. Bound to the caller, so a proof can't be lifted from the mempool.
        if (att.recipient != msg.sender) revert RecipientMismatch(att.recipient, msg.sender);

        // 3. From a registered endpoint, every field from that source's json paths.
        uint8 sourceId = _matchSource(att.request.url);
        Source storage src = _sources[sourceId];
        _checkFields(att.reponseResolve, src);

        // 4. Fresh, and newer than anything this account has used before.
        uint64 issuedAt = _checkFreshness(att.timestamp);

        // 5. Decode. Each figure is either revealed exactly or proven against a threshold.
        string[] memory conds = att.attConditions.objects();
        bytes32 account = keccak256(abi.encode(sourceId, _hashedId(att.data, conds, src.idPath)));

        (uint256 vip, bool c1) = _readFloor(att, conds, src.vipPath);
        (uint256 spot, bool c2) = _readFloor(att, conds, src.spotPath);
        (uint256 futures, bool c3) = _readFloor(att, conds, src.futuresPath);

        uint64 last = lastAttestationAt[account];
        if (att.timestamp <= last) revert ReplayedAttestation(att.timestamp, last);
        lastAttestationAt[account] = att.timestamp;

        // 6. One exchange account <-> one wallet. A lapsed binding may be reclaimed.
        _bind(account, msg.sender);

        s.account = account;
        s.source = sourceId;
        s.vipLevel = uint8(vip > type(uint8).max ? type(uint8).max : vip);
        s.concealed = c1 || c2 || c3;
        s.issuedAt = issuedAt;
        s.expiresAt = issuedAt + sealValidity;
        s.spot30dVolume = _toU128(spot);
        s.futures30dVolume = _toU128(futures);
        s.tier = _resolveTier(s.vipLevel, s.futures30dVolume);
        _seals[msg.sender] = s;

        emit Sealed(msg.sender, account, sourceId, s.tier, s.concealed, s.vipLevel, s.futures30dVolume, s.spot30dVolume, s.expiresAt);
        _broadcast(MSG_SEAL, msg.sender, s);
    }

    /// @notice Drops the caller's seal and frees their exchange account for another wallet.
    ///         Send `quoteBroadcast()` as value so the spokes drop it too.
    function release() external payable {
        Seal memory s = _seals[msg.sender];
        if (s.account == bytes32(0)) revert NoActiveSeal(msg.sender);
        delete walletOf[s.account];
        delete _seals[msg.sender];
        emit Released(msg.sender, s.account);
        _broadcast(MSG_REVOKE, msg.sender, s);
    }

    /// @notice Re-sends a wallet's current seal to every spoke, e.g. after a spoke is added or a
    ///         message failed. Anyone may pay for it; it only repeats what the hub already holds.
    function sync(address wallet) external payable {
        Seal memory s = _seals[wallet];
        if (s.account == bytes32(0)) revert NoActiveSeal(wallet);
        _broadcast(MSG_SEAL, wallet, s);
    }

    /// @notice Total messaging fee for one seal, release or sync. Zero when no spokes are set.
    function quoteBroadcast() external view returns (uint256 fee) {
        if (address(mailbox) == address(0)) return 0;
        Seal memory empty;
        bytes memory body = abi.encode(MSG_SEAL, uint64(0), address(0), empty, uint16(0));
        for (uint256 i; i < _spokes.length; ++i) {
            fee += mailbox.quoteDispatch(_spokes[i].domain, _toBytes32(_spokes[i].spoke), body);
        }
    }

    function spokes() external view returns (Spoke[] memory) {
        return _spokes;
    }

    // ---------------------------------------------------------------------
    // Views for integrating protocols
    // ---------------------------------------------------------------------

    /// @notice The one call a protocol needs: the wallet's active tier and its fee discount.
    function tierOf(address wallet) external view returns (bool active, uint8 tier, uint16 discountBps) {
        Seal storage s = _seals[wallet];
        if (s.account == bytes32(0) || block.timestamp > s.expiresAt) return (false, 0, 0);
        tier = s.tier < _tiers.length ? s.tier : uint8(_tiers.length - 1);
        return (true, tier, _tiers[tier].feeDiscountBps);
    }

    function sealOf(address wallet) external view returns (Seal memory) {
        return _seals[wallet];
    }

    function isActive(address wallet) public view returns (bool) {
        Seal storage s = _seals[wallet];
        return s.account != bytes32(0) && block.timestamp <= s.expiresAt;
    }

    function tiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    function sources() external view returns (Source[] memory) {
        return _sources;
    }

    /// @notice The nullifier a given exchange account maps to.
    function accountOf(uint8 sourceId, bytes32 hashedId) external pure returns (bytes32) {
        return keccak256(abi.encode(sourceId, hashedId));
    }

    function previewTier(uint8 vipLevel, uint128 futures30dVolume) external view returns (uint8) {
        return _resolveTier(vipLevel, futures30dVolume);
    }

    // ---------------------------------------------------------------------
    // Internals: decoding
    // ---------------------------------------------------------------------

    /// @dev Primus reports a hashed field under "SHA256(<jsonPath>)". Requiring that key means a
    ///      proof that revealed the raw id can never be accepted.
    function _hashedId(string calldata data, string[] memory conds, string storage idPath)
        private
        view
        returns (bytes32)
    {
        (bool found, string memory op,,) = _condition(conds, idPath);
        if (found && keccak256(bytes(op)) != OP_SHA256) revert IdNotHashed(idPath);
        (bool ok, string memory v) = data.tryGet(string.concat("SHA256(", idPath, ")"));
        if (!ok) revert IdNotHashed(idPath);
        return v.toBytes32();
    }

    /// @dev Returns the figure at `path` and whether it was concealed behind a threshold.
    ///      Revealed: the exact value, keyed by the template's keyName.
    ///      ">=" / ">": the threshold if the attested condition is true, else 0.
    function _readFloor(Attestation calldata att, string[] memory conds, string storage path)
        private
        view
        returns (uint256 value, bool concealed)
    {
        (bool found, string memory op, string memory threshold, string memory revealId) = _condition(conds, path);
        bytes32 h = keccak256(bytes(op));

        if (!found || h == OP_REVEAL) {
            return (att.data.get(_keyNameFor(att.reponseResolve, path)).toUintFloor(), false);
        }
        if (h == OP_GTE || h == OP_GT) {
            (bool ok, string memory result) = att.data.tryGet(revealId);
            if (!ok) (ok, result) = att.data.tryGet(string.concat(op, "(", path, ")"));
            if (!ok) revert MissingField(path);
            return (result.isTrue() ? threshold.toUintFloor() : 0, true);
        }
        revert UnsupportedCondition(op, path);
    }

    /// @dev Finds the condition object for `path`, if any.
    function _condition(string[] memory conds, string memory path)
        private
        pure
        returns (bool found, string memory op, string memory value, string memory revealId)
    {
        bytes32 target = keccak256(bytes(path));
        for (uint256 i; i < conds.length; ++i) {
            (bool hasField, string memory field) = conds[i].tryGet("field");
            if (!hasField || keccak256(bytes(field)) != target) continue;
            (, op) = conds[i].tryGet("op");
            (, value) = conds[i].tryGet("value");
            (, revealId) = conds[i].tryGet("reveal_id");
            return (true, op, value, revealId);
        }
    }

    function _keyNameFor(AttNetworkResponseResolve[] calldata fields, string storage path)
        private
        view
        returns (string memory)
    {
        bytes32 target = keccak256(bytes(path));
        for (uint256 i; i < fields.length; ++i) {
            if (keccak256(bytes(fields[i].parsePath)) == target) return fields[i].keyName;
        }
        revert MissingField(path);
    }

    // ---------------------------------------------------------------------
    // Internals: checks
    // ---------------------------------------------------------------------

    function _matchSource(string calldata url) private view returns (uint8) {
        for (uint256 i; i < _sources.length; ++i) {
            if (_sources[i].enabled && _isEndpoint(url, _sources[i].url)) return uint8(i);
        }
        revert UnexpectedSource(url);
    }

    /// @dev Every revealed field must come from one of the source's json paths, so a template
    ///      can't map `futures30dVol` onto a different number in the same response.
    function _checkFields(AttNetworkResponseResolve[] calldata fields, Source storage src) private view {
        bytes32 id = keccak256(bytes(src.idPath));
        bytes32 vip = keccak256(bytes(src.vipPath));
        bytes32 spot = keccak256(bytes(src.spotPath));
        bytes32 fut = keccak256(bytes(src.futuresPath));
        for (uint256 i; i < fields.length; ++i) {
            bytes32 p = keccak256(bytes(fields[i].parsePath));
            if (p != id && p != vip && p != spot && p != fut) revert UnexpectedField(fields[i].parsePath);
        }
    }

    function _checkShape(string calldata data, string calldata conds) private pure {
        bytes calldata d = bytes(data);
        if (d.length < 2 || d[0] != "{" || d[d.length - 1] != "}") revert MalformedPayload();
        bytes calldata c = bytes(conds);
        if (c.length != 0 && (c.length < 2 || c[0] != "[" || c[c.length - 1] != "]")) revert MalformedPayload();
    }

    function _checkFreshness(uint64 timestampMs) private view returns (uint64 issuedAt) {
        issuedAt = timestampMs / 1000;
        if (issuedAt > block.timestamp + MAX_CLOCK_DRIFT) revert AttestationFromFuture(timestampMs);
        if (block.timestamp > issuedAt + maxAttestationAge) revert StaleAttestation(timestampMs);
    }

    function _bind(bytes32 account, address wallet) private {
        address current = walletOf[account];
        if (current != address(0) && current != wallet) {
            if (isActive(current)) revert AccountBoundElsewhere(current);
            delete _seals[current];
            emit Released(current, account);
        }
        bytes32 previous = _seals[wallet].account;
        if (previous != bytes32(0) && previous != account) {
            delete walletOf[previous];
            emit Released(wallet, previous);
        }
        walletOf[account] = wallet;
    }

    function _resolveTier(uint8 vipLevel, uint128 futuresVolume) private view returns (uint8 best) {
        uint256 n = _tiers.length;
        for (uint256 i = 1; i < n; ++i) {
            Tier storage t = _tiers[i];
            if (vipLevel >= t.minVipLevel || futuresVolume >= t.minFuturesVolume) best = uint8(i);
        }
    }

    // ---------------------------------------------------------------------
    // Internals: config
    // ---------------------------------------------------------------------

    function _addSource(Source memory s) private returns (uint8 id) {
        if (_sources.length >= MAX_SOURCES) revert InvalidSource();
        if (
            bytes(s.url).length == 0 || bytes(s.idPath).length == 0 || bytes(s.vipPath).length == 0
                || bytes(s.spotPath).length == 0 || bytes(s.futuresPath).length == 0
        ) revert InvalidSource();
        id = uint8(_sources.length);
        _sources.push(s);
        emit SourceAdded(id, s.name, s.url);
    }

    function _setTiers(Tier[] memory tiers_) private {
        uint256 n = tiers_.length;
        if (n == 0 || n > MAX_TIERS) revert InvalidTiers();
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

    // ---------------------------------------------------------------------
    // Internals: messaging
    // ---------------------------------------------------------------------

    /// @dev Sends one message per spoke and refunds what is left of msg.value. Message bodies have
    ///      a fixed size (static abi types only), so quoteBroadcast() is exact.
    function _broadcast(uint8 kind, address wallet, Seal memory s) private {
        uint256 n = _spokes.length;
        uint256 spent;
        if (n != 0 && address(mailbox) != address(0)) {
            uint64 nonce = ++syncNonce;
            uint16 discount = kind == MSG_SEAL ? _discountOf(s.tier) : 0;
            bytes memory body = abi.encode(kind, nonce, wallet, s, discount);
            for (uint256 i; i < n; ++i) {
                bytes32 to = _toBytes32(_spokes[i].spoke);
                uint256 fee = mailbox.quoteDispatch(_spokes[i].domain, to, body);
                if (spent + fee > msg.value) revert InsufficientFee(spent + fee, msg.value);
                spent += fee;
                mailbox.dispatch{value: fee}(_spokes[i].domain, to, body);
            }
            emit Broadcast(wallet, kind, nonce, spent);
        }
        if (msg.value > spent) {
            (bool ok,) = msg.sender.call{value: msg.value - spent}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _discountOf(uint8 tier) private view returns (uint16) {
        uint256 t = tier < _tiers.length ? tier : _tiers.length - 1;
        return _tiers[t].feeDiscountBps;
    }

    function _toBytes32(address a) private pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _toU128(uint256 v) private pure returns (uint128) {
        return v > type(uint128).max ? type(uint128).max : uint128(v);
    }

    function _isEndpoint(string calldata url, string memory endpoint) private pure returns (bool) {
        bytes calldata s = bytes(url);
        bytes memory p = bytes(endpoint);
        if (s.length < p.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (s[i] != p[i]) return false;
        }
        return s.length == p.length || s[p.length] == "?";
    }
}
