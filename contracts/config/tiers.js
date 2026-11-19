// Default tier table. A wallet lands in the highest tier where EITHER its Binance VIP level
// OR its 30-day futures volume (USD) meets the bar. Discounts are in basis points and are a
// suggestion to integrating protocols — Apostille itself never moves funds.
module.exports = [
  { name: "Standard", minVipLevel: 0, minFuturesVolume: 0n, feeDiscountBps: 0 },
  { name: "Bronze", minVipLevel: 1, minFuturesVolume: 1_000_000n, feeDiscountBps: 1000 },
  { name: "Silver", minVipLevel: 2, minFuturesVolume: 10_000_000n, feeDiscountBps: 2000 },
  { name: "Gold", minVipLevel: 4, minFuturesVolume: 50_000_000n, feeDiscountBps: 3500 },
  { name: "Sovereign", minVipLevel: 7, minFuturesVolume: 250_000_000n, feeDiscountBps: 5000 },
];
