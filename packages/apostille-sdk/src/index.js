// @apostille/sdk: read Apostille seals and price fees from them.
// Works with ethers v6 (any Provider or Signer as the runner).

import { Contract } from "ethers";

export const APOSTILLE_ABI = [
  "function tierOf(address wallet) view returns (bool active, uint8 tier, uint16 discountBps)",
  "function sealOf(address wallet) view returns ((bytes32 account,uint8 source,uint8 vipLevel,uint8 tier,bool concealed,uint64 issuedAt,uint64 expiresAt,uint128 spot30dVolume,uint128 futures30dVolume))",
  "function tiers() view returns ((string name,uint8 minVipLevel,uint128 minFuturesVolume,uint16 feeDiscountBps)[])",
  "function isActive(address wallet) view returns (bool)",
  "event Sealed(address indexed wallet, bytes32 indexed account, uint8 indexed source, uint8 tier, bool concealed, uint8 vipLevel, uint128 futures30dVolume, uint128 spot30dVolume, uint64 expiresAt)",
];

/** Known deployments by chain id. Pass `address` explicitly to use another one. */
export const DEPLOYMENTS = {
  97: {
    name: "BNB Smart Chain testnet",
    apostille: "0x2d4a5728Ee2d43da19167aC33D0F047A877e9728",
    verifier: "0x9a68DC84482f7cbd9EC8167a7CbFB666eADB8059",
  },
};

const BPS = 10_000n;
const PIPS = 1_000_000n;

function contractFor(runner, { address, chainId } = {}) {
  const addr = address ?? DEPLOYMENTS[chainId]?.apostille;
  if (!addr) throw new Error(`No Apostille deployment known for chain ${chainId}; pass { address }`);
  return new Contract(addr, APOSTILLE_ABI, runner);
}

/**
 * A wallet's tier. Never throws on a failed read: returns an inactive result with `error`,
 * so callers can fall back to base fees (the same fail-open rule as ApostilleFees.sol).
 */
export async function getTier(runner, wallet, opts) {
  try {
    const [active, tier, discountBps] = await contractFor(runner, opts).tierOf(wallet);
    return { active, tier: Number(tier), discountBps: Number(discountBps) };
  } catch (error) {
    return { active: false, tier: 0, discountBps: 0, error };
  }
}

/** The full seal record, or null when the wallet was never sealed. */
export async function getSeal(runner, wallet, opts) {
  const s = await contractFor(runner, opts).sealOf(wallet);
  if (s.account === "0x" + "0".repeat(64)) return null;
  return {
    account: s.account,
    source: Number(s.source),
    vipLevel: Number(s.vipLevel),
    tier: Number(s.tier),
    concealed: s.concealed,
    issuedAt: new Date(Number(s.issuedAt) * 1000),
    expiresAt: new Date(Number(s.expiresAt) * 1000),
    spot30dVolume: s.spot30dVolume,
    futures30dVolume: s.futures30dVolume,
  };
}

export async function getTiers(runner, opts) {
  const t = await contractFor(runner, opts).tiers();
  return t.map((x) => ({
    name: x.name,
    minVipLevel: Number(x.minVipLevel),
    minFuturesVolume: x.minFuturesVolume,
    feeDiscountBps: Number(x.feeDiscountBps),
  }));
}

/**
 * Discounted fee, mirroring ApostilleFees.feeOn in Solidity.
 * @param {bigint} notional      trade size in token units
 * @param {bigint} baseFeePips   base rate, 1 pip = 0.0001% (500n = 0.05%)
 * @param {{active:boolean, discountBps:number}} tier  from getTier()
 * @param {number} maxDiscountBps cap the protocol grants regardless of the tier
 */
export function feeOn(notional, baseFeePips, tier, maxDiscountBps = 10_000) {
  let d = tier?.active ? BigInt(Math.min(tier.discountBps, maxDiscountBps, 10_000)) : 0n;
  const ratePips = (BigInt(baseFeePips) * (BPS - d)) / BPS;
  return { fee: (BigInt(notional) * ratePips) / PIPS, ratePips };
}
