# security

apostille is unaudited testnet software. this file says what it defends against, what it trusts, and how to report a problem.

## reporting

open a [private security advisory](https://github.com/moltaphet/apostille/security/advisories/new) on this repository. please don't file public issues for vulnerabilities.

## what a seal claims

"a Primus attestor saw Binance's `vip-fee-summary` endpoint return these figures (or figures at least this high) for some account, within the last 15 minutes, and the caller's wallet was named in the proof." nothing more. it doesn't claim the account belongs to a particular person, or that the volume was organic.

## trust assumptions

| you trust | because | if it fails |
|---|---|---|
| the Primus attestor(s) registered in `AttestorVerifier` | they run the zkTLS session and sign the result | a dishonest attestor can sign any figures. mitigation: attestors are owner-managed behind the timelock and visible on-chain |
| Binance's endpoint | the figures are Binance's own | a changed endpoint breaks proofs. the guardian can disable the source instantly |
| the owner (a timelock) | it can change verifier, tiers, windows, sources | every change is queued publicly for the delay (48h by default) and can be watched or cancelled before it lands |
| the guardian | it can pause sealing and disable a source | it can only stop things, never start or change them. existing seals keep working |
| the signing service (`frontend/api/sign.js`) | it spends the Primus app quota | a leaked app secret lets someone burn quota, not forge seals: the contract re-checks everything that matters |

## threat model

| threat | defence | test |
|---|---|---|
| forged figures | attestor ECDSA signature over the full attestation (`AttestorVerifier`) | `rejects an unregistered signer`, `rejects any tampering with the signed payload` |
| reusing someone else's proof (mempool copy) | `recipient == msg.sender` | `rejects a proof issued to another wallet` |
| proving a different endpoint or field | exact source url (query string allowed, no path suffix); every field must come from the source's json paths | `rejects any other endpoint…`, `rejects a field mapped from an unexpected json path` |
| encodePacked boundary shift (Slither `encode-packed-collision`) | data must be one `{…}` object, conditions one `[…]` array | `rejects bytes shifted from data into the conditions, even with a valid signature` |
| old or replayed proofs | max age 15 min, 5 min clock drift, strictly increasing timestamp per account | `rejects stale…`, `…dated in the future`, `rejects replaying…` |
| one exchange account farming many wallets | nullifier `keccak256(sourceId, SHA256(uid))` binds one account to one wallet while its seal is active | `binds one exchange account to one wallet` |
| leaking the exchange uid | the contract only accepts the id under `SHA256(<idPath>)` | `rejects a proof that reveals the raw user id…` |
| unsupported Primus conditions | only `REVEAL_STRING`, `SHA256` (id), `>=`, `>` | `rejects unsupported condition operators` |
| registry outage hurting integrators | `ApostilleFees` fails open to the base fee | `fails open when the registry is down` |
| malicious admin change | 48h timelock; guardian can only pause / disable | `only applies a verifier swap after the delay`, `lets the guardian pause…` |

## known limitations

- **attestor centralisation.** the enterprise SDK's attestor is a single Primus key. moving to the Primus Network SDK (decentralised attestors) when it supports BNB Chain removes this.
- **concealed floors are floors.** a concealed seal stores the proven threshold, not the real volume. integrators should treat it as "at least".
- **figures are point-in-time.** a seal reflects the 30-day window when it was proven and lasts 30 days.
- **testnet only, unaudited.**

## static analysis

[Slither](https://github.com/crytic/slither) 0.11, run with `slither . --hardhat-ignore-compile --filter-paths "node_modules|mocks" --exclude-informational --exclude-optimization`:

| detector | result |
|---|---|
| `encode-packed-collision` (AttestorVerifier) | real but fixed by format: the encoding must match Primus's signing scheme, so Apostille pins payload shape instead (see threat model) |
| `missing-zero-check` | `setGuardian(0)` is intentional (removes the guardian). DemoPerp already reverts on zero; Slither doesn't follow custom-error checks |
| `uninitialized-local`, `unused-return`, `timestamp` | false positives / intended: zero defaults, absent keys read as empty, second-level time is enough for 15-minute windows |
