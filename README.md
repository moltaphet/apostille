# apostille

**carry your exchange tier on-chain.**

[live app](https://apostille-two.vercel.app) · [deploy page](https://apostille-two.vercel.app/deploy) · [contract on BscScan](https://testnet.bscscan.com/address/0x13dC1B1dC6888746Fca76E0d15FFF7f49b4AAc45)

apostille lets a trader prove their Binance VIP level and 30-day trading volume with a [Primus](https://primuslabs.xyz) zkTLS attestation, and turns it into an on-chain seal any protocol can read in one call. the Binance user id never reaches the chain: it is SHA256-hashed inside the proof and used as a nullifier, so one exchange account backs exactly one wallet.

> an apostille is the certificate that makes a document issued in one country valid in another. this one makes your standing on a centralized exchange valid on-chain.

---

## why

new perp DEXs, launchpads and exchanges all run "VIP matching" campaigns to win over high-volume traders. today that means screenshots, support tickets and days of manual review. screenshots are trivial to fake, and the reviewer sees far more of the trader's account than they need.

apostille replaces the screenshot with a cryptographic proof of the exact numbers Binance's own API returns, verified by a smart contract, with nothing extra revealed.

| | screenshot + ticket | apostille |
|---|---|---|
| forgeable | yes | no: signed by a Primus zkTLS attestor over Binance's TLS session |
| time to tier | days | one transaction |
| data revealed | whole account page | VIP level, 30d spot/futures volume, a hash of the uid |
| one account → many wallets | hard to catch | blocked on-chain by the uid nullifier |
| integration | manual allow-list | `tierOf(address)` |

## how it works

```
 browser                         apostille signer            Primus attestor          BNB Smart Chain
 ───────                         ────────────────            ───────────────          ───────────────
 build request (template,
 wallet, sha256(userId)) ───────▶ check it is exactly the
                                  apostille request, sign
                         ◀─────── with app secret
 Primus extension opens
 binance.com, runs zkTLS ───────────────────────────────────▶ attests vip-fee-summary
                         ◀─────────────────────────────────── signed attestation
 seal(attestation) ──────────────────────────────────────────────────────────────────▶ Apostille.sol
                                                                                        ├ primus.verifyAttestation
                                                                                        ├ recipient == msg.sender
                                                                                        ├ endpoint + json paths
                                                                                        ├ fresh (≤ 15 min), not replayed
                                                                                        ├ uid hash ↔ one wallet
                                                                                        └ store seal, emit Sealed
```

the attestation covers one Binance endpoint:

```
GET https://www.binance.com/bapi/accounts/v1/private/vip/vip-portal/vip-fee/vip-fee-summary
```

using the public Primus template [`9e2dff87-3bfd-4a65-ad84-9eeb87d0f56e`](https://dev.primuslabs.xyz) with four fields:

| field | json path | revealed as |
|---|---|---|
| `userId` | `$.data.userId` | SHA256 hash (attestation condition) |
| `vipLevel` | `$.data.vipLevel` | plain |
| `spot30dVol` | `$.data.spot30dVol` | plain |
| `futures30dVol` | `$.data.futures30dVol` | plain |

## two disclosure modes

each proof picks what goes on-chain, through Primus attestation conditions:

| mode | what the attestation says | what's stored |
|---|---|---|
| exact figures | `vipLevel = 2`, `futures30dVol = 12500000.34`, … | the real numbers |
| only my tier | `vipLevel >= 2: true`, `futures30dVol >= 10000000: true`, `spot30dVol >= 0: true` | the proven floors, flagged `concealed` |

in both modes the user id is reported only as `SHA256($.data.userId)`; the contract requires that key, so a proof that revealed the raw id can't be sealed.

## sources

the contract is a registry of exchange endpoints (`addSource`, append-only, owner-gated). a source names the endpoint and the json paths of the id, VIP level, spot and futures volume. nullifiers are `keccak256(sourceId, SHA256(userId))`, so the same id on two exchanges is two accounts. Binance is source `0`; adding OKX, Bybit or Bitget means capturing their fee endpoint as a Primus template and registering it, with no new contract code (see `contracts/config/sources.js`).

## tiers

a wallet lands in the highest tier where its VIP level **or** its 30-day futures volume clears the bar. the table lives on-chain and the owner can change it; discounts are a suggestion to integrators. apostille never moves funds.

| tier | VIP level | or futures volume (30d) | suggested discount |
|---|---|---|---|
| standard | - | - | 0% |
| bronze | 1+ | $1M+ | 10% |
| silver | 2+ | $10M+ | 20% |
| gold | 4+ | $50M+ | 35% |
| sovereign | 7+ | $250M+ | 50% |

a seal lasts 30 days (one volume window) and can be renewed anytime with a fresh proof.

## integrate

### see it

[`/perp`](https://apostille-two.vercel.app/perp) is an order ticket priced the way a perp DEX would after integrating: it reads your live seal and shows your taker fee next to every other tier.

### solidity

```solidity
interface IApostille {
    function tierOf(address wallet)
        external view returns (bool active, uint8 tier, uint16 discountBps);
}

(bool active, , uint16 discountBps) = IApostille(APOSTILLE).tierOf(trader);
uint256 fee = active ? baseFee * (10_000 - discountBps) / 10_000 : baseFee;
```

or use the helper library, which caps the discount and fails open (a revert or a missing registry falls back to the base fee, so trading never depends on Apostille being up):

```solidity
import {IApostille} from "apostille/contracts/integrations/IApostille.sol";
import {ApostilleFees} from "apostille/contracts/integrations/ApostilleFees.sol";

using ApostilleFees for IApostille;
(uint256 fee, uint256 ratePips, uint8 tier) = apostille.feeOn(trader, notional, 500, 5000); // 0.05% base, max 50% off
```

`contracts/examples/DemoPerp.sol` is a complete (demo-only) venue built this way: margin, signed positions, discounted taker fees to a treasury.

### javascript

```js
import { getTier, feeOn } from "@apostille/sdk"; // packages/apostille-sdk
const tier = await getTier(provider, trader, { chainId: 97 });
const { fee } = feeOn(notional, 500n, tier, 5000);
```

also available: `sealOf(address)` for the full record (VIP level, volumes, expiry, uid hash), `tiers()`, `previewTier(vip, volume)`, and the `Sealed` / `Released` events for indexers.

## security model

what the contract enforces, on top of Primus's attestor-signature check (which, by itself, does not check freshness, source or recipient):

- **attestor signature**: `IPrimusZKTLS.verifyAttestation`. Primus's shared verifier on BSC testnet doesn't list the enterprise SDK's attestor (`0x5Ed3…c14d`), so apostille ships `AttestorVerifier`: same encoding as `PrimusZKTLS`, same raw-ECDSA scheme, owner-managed attestor set. it is tested against real signatures, and an existing apostille can switch to it with `setPrimus`.
- **recipient binding**: `attestation.recipient` must equal `msg.sender`, so a proof seen in the mempool is useless to anyone else.
- **source pinning**: the request url must be the `vip-fee-summary` endpoint (exact match or with a query string; no path suffixes).
- **field pinning**: every revealed field must come from its expected json path, so a template can't map `futures30dVol` onto a different number in the same response.
- **hashed identity**: `userId` must be a 32-byte hash. a raw uid fails to parse and the transaction reverts.
- **freshness**: the attestation must be at most 15 minutes old and not from the future (5 min clock drift).
- **replay protection**: each uid hash only accepts attestations newer than the last one it used.
- **one account, one wallet**: a uid hash bound to a wallet with an active seal can't be used by another wallet. it frees up when the seal expires or the holder calls `release()`.

the signer (`frontend/api/sign.js`) is the off-chain half: it only signs requests for the apostille template, with the `userId` SHA256 condition, plain `proxytls` mode, a valid wallet address and a fresh timestamp, and it rate-limits per IP. the app secret never reaches the browser.

**trust assumptions.** you trust the Primus attestor(s) registered on the verifier contract, and that Binance's endpoint reports what it claims. the contract owner can change tiers, time windows and the verifier address (`Ownable2Step`); seals already issued keep their stored tier until renewed.

## repository

```
contracts/            Apostille.sol, AttestorVerifier.sol, integrations/ (IApostille, ApostilleFees), examples/DemoPerp.sol, tests + deploy scripts
frontend/             vite dapp: connect, prove, seal, certificate view, live tier table
frontend/api/sign.js  vercel function that holds the Primus app secret and signs requests
frontend/lib/         signer policy shared by the function and local dev
```

## run it

prerequisites: node 18+, the [Primus extension](https://chromewebstore.google.com/detail/primus/oeiomhmbaapihbilkfkhmlajkeegnjhe), a browser wallet with some tBNB ([faucet](https://www.bnbchain.org/en/testnet-faucet)), and a Primus project (`appId` / `appSecret`) from [dev.primuslabs.xyz](https://dev.primuslabs.xyz).

**1. contracts**

easiest: open `/deploy` on the running site, connect a wallet on BSC testnet and sign one transaction. no private key needed. or from the command line:

```bash
cd contracts
npm install
npm test                      # 52 tests
cp .env.example .env          # add DEPLOYER_PRIVATE_KEY
npm run deploy:bsc-testnet    # writes deployments/97.json
npm run export:frontend       # refresh the bytecode used by /deploy after contract changes
```

**2. app (frontend + signer)**

```bash
cd frontend
npm install
cp .env.example .env.local    # VITE_PRIMUS_APP_ID, VITE_APOSTILLE_ADDRESS, PRIMUS_APP_ID, PRIMUS_APP_SECRET
npm run dev                   # :5173, serves /api/sign locally too
```

**3. deploy to vercel**

import the repo on [vercel.com/new](https://vercel.com/new), set **root directory** to `frontend`, and add the environment variables from `frontend/.env.example`. `PRIMUS_APP_SECRET` is only read by `api/sign.js` and is never bundled into the site.

## deployments

| network | apostille | verifier |
|---|---|---|
| BNB Smart Chain testnet (97) | [`0x13dC…Ac45`](https://testnet.bscscan.com/address/0x13dC1B1dC6888746Fca76E0d15FFF7f49b4AAc45) | [`AttestorVerifier` 0x9a68…8059](https://testnet.bscscan.com/address/0x9a68DC84482f7cbd9EC8167a7CbFB666eADB8059) |

## roadmap

- register OKX, Bybit and Bitget as sources (templates for their spot volume exist; futures/VIP endpoints still need capturing).
- Primus Network SDK path for fully decentralized attestation once it is available on BNB Chain.

## license

MIT © moltaphet
