# @apostille/sdk

read Apostille seals and price trading fees from them. ethers v6.

```js
import { JsonRpcProvider } from "ethers";
import { getTier, feeOn } from "@apostille/sdk";

const provider = new JsonRpcProvider("https://data-seed-prebsc-1-s1.bnbchain.org:8545");
const tier = await getTier(provider, trader, { chainId: 97 });

const { fee, ratePips } = feeOn(notional, 500n, tier, 5000); // 0.05% base, discount capped at 50%
```

- `getTier(runner, wallet, { chainId | address })`: `{ active, tier, discountBps }`. never throws: a failed read returns an inactive tier with `error`, so you fall back to base fees
- `getSeal(...)`: the full record, or `null` when the wallet was never sealed. concealed seals hold proven floors, not exact figures
- `getTiers(...)`: the live tier table
- `feeOn(notional, baseFeePips, tier, maxDiscountBps)`: same math as `ApostilleFees.feeOn` in Solidity

for on-chain integrations use `contracts/contracts/integrations/ApostilleFees.sol`, which fails open the same way.
