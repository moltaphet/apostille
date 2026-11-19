// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FlatJson
/// @notice Minimal, allocation-light reader for the flat `{"key":"value",...}` objects
///         Primus places in `Attestation.data`. Values may be quoted or bare.
/// @dev Not a general JSON parser: it expects a single-level object whose keys are
///      unique, which is exactly what a Primus template with plain jsonPath items emits.
library FlatJson {
    error KeyNotFound(string key);
    error InvalidNumber(string value);
    error InvalidHex(string value);

    /// @notice Returns the raw (unquoted) value for `key`. Reverts if absent.
    function get(string memory json, string memory key) internal pure returns (string memory) {
        (bool found, string memory value) = tryGet(json, key);
        if (!found) revert KeyNotFound(key);
        return value;
    }

    /// @notice Splits a top-level array of flat objects, `[{...},{...}]`, into the objects.
    /// @dev Values must not contain braces, which holds for Primus condition lists.
    function objects(string memory json) internal pure returns (string[] memory out) {
        bytes memory j = bytes(json);
        uint256 count;
        for (uint256 i; i < j.length; ++i) if (j[i] == "{") ++count;
        out = new string[](count);
        uint256 k;
        for (uint256 i; i < j.length; ++i) {
            if (j[i] != "{") continue;
            uint256 end = i;
            while (end < j.length && j[end] != "}") ++end;
            out[k++] = string(_slice(j, i, end < j.length ? end + 1 : end));
            i = end;
        }
    }

    /// @notice Like `get`, but returns `found = false` instead of reverting.
    function tryGet(string memory json, string memory key) internal pure returns (bool found, string memory value) {
        bytes memory j = bytes(json);
        bytes memory needle = abi.encodePacked('"', key, '"');
        uint256 n = j.length;
        uint256 m = needle.length;
        if (m > n) return (false, "");

        for (uint256 i; i + m <= n; ++i) {
            if (!_matchAt(j, needle, i)) continue;

            uint256 p = i + m;
            while (p < n && _isSpace(j[p])) ++p;
            if (p >= n || j[p] != ":") continue; // matched a value, not a key
            ++p;
            while (p < n && _isSpace(j[p])) ++p;

            uint256 start;
            uint256 end;
            if (p < n && j[p] == '"') {
                start = p + 1;
                end = start;
                while (end < n && j[end] != '"') ++end;
            } else {
                start = p;
                end = p;
                while (end < n && j[end] != "," && j[end] != "}" && !_isSpace(j[end])) ++end;
            }
            return (true, string(_slice(j, start, end)));
        }
        return (false, "");
    }

    /// @notice True for "true" or "1", the forms Primus uses for a satisfied condition.
    function isTrue(string memory value) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(value));
        return h == keccak256("true") || h == keccak256("1");
    }

    /// @notice Parses a non-negative decimal (optionally with fraction and e/E exponent)
    ///         and returns its integer part, truncating toward zero.
    /// @dev "12345.67" -> 12345, "1.5E7" -> 15000000, "0" -> 0.
    function toUintFloor(string memory value) internal pure returns (uint256) {
        bytes memory b = bytes(value);
        uint256 n = b.length;
        if (n == 0) revert InvalidNumber(value);

        uint256 i;
        uint256 mantissa;
        uint256 fracDigits;
        bool seenDigit;
        bool inFraction;

        for (; i < n; ++i) {
            bytes1 c = b[i];
            if (c >= "0" && c <= "9") {
                mantissa = mantissa * 10 + (uint8(c) - 48);
                if (inFraction) ++fracDigits;
                seenDigit = true;
            } else if (c == "." && !inFraction) {
                inFraction = true;
            } else {
                break;
            }
        }
        if (!seenDigit) revert InvalidNumber(value);

        int256 exp;
        if (i < n) {
            if (b[i] != "e" && b[i] != "E") revert InvalidNumber(value);
            ++i;
            bool neg;
            if (i < n && (b[i] == "+" || b[i] == "-")) {
                neg = b[i] == "-";
                ++i;
            }
            if (i == n) revert InvalidNumber(value);
            int256 e;
            for (; i < n; ++i) {
                bytes1 c = b[i];
                if (c < "0" || c > "9") revert InvalidNumber(value);
                e = e * 10 + int256(uint256(uint8(c) - 48));
                if (e > 77) revert InvalidNumber(value);
            }
            exp = neg ? -e : e;
        }

        int256 shift = exp - int256(fracDigits);
        if (shift >= 0) {
            if (shift > 77) revert InvalidNumber(value);
            return mantissa * (10 ** uint256(shift));
        }
        uint256 down = uint256(-shift);
        if (down > 77) return 0;
        return mantissa / (10 ** down);
    }

    /// @notice Parses a 32-byte hex string (with or without 0x prefix) into bytes32.
    function toBytes32(string memory value) internal pure returns (bytes32 out) {
        bytes memory b = bytes(value);
        uint256 offset;
        if (b.length == 66 && b[0] == "0" && (b[1] == "x" || b[1] == "X")) offset = 2;
        else if (b.length != 64) revert InvalidHex(value);

        uint256 acc;
        for (uint256 i = offset; i < b.length; ++i) {
            acc = (acc << 4) | _hexNibble(b[i], value);
        }
        out = bytes32(acc);
    }

    function _hexNibble(bytes1 c, string memory value) private pure returns (uint256) {
        if (c >= "0" && c <= "9") return uint8(c) - 48;
        if (c >= "a" && c <= "f") return uint8(c) - 87;
        if (c >= "A" && c <= "F") return uint8(c) - 55;
        revert InvalidHex(value);
    }

    function _matchAt(bytes memory hay, bytes memory needle, uint256 at) private pure returns (bool) {
        for (uint256 k; k < needle.length; ++k) {
            if (hay[at + k] != needle[k]) return false;
        }
        return true;
    }

    function _slice(bytes memory b, uint256 start, uint256 end) private pure returns (bytes memory out) {
        out = new bytes(end - start);
        for (uint256 k; k < out.length; ++k) out[k] = b[start + k];
    }

    function _isSpace(bytes1 c) private pure returns (bool) {
        return c == " " || c == "\n" || c == "\r" || c == "\t";
    }
}
