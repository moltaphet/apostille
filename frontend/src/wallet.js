import { CHAIN } from "./config.js";

/** True when a wallet error means "this chain isn't added yet". Wallets disagree on the code:
 *  MetaMask sends 4902, Rabby sends -32603 with "Unrecognized chain ID", some nest it. */
function isUnknownChain(err) {
  const code = err?.code ?? err?.data?.originalError?.code;
  const msg = `${err?.message || ""} ${err?.data?.originalError?.message || ""}`;
  return code === 4902 || /unrecognized chain|unknown chain|not been added|add.*chain/i.test(msg);
}

/** Switches the wallet to `chain` (BNB Smart Chain testnet by default), adding it first if needed. */
export async function ensureChain(provider = window.ethereum, chain = CHAIN) {
  const current = await provider.request({ method: "eth_chainId" });
  if (current?.toLowerCase() === chain.hex) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.hex }] });
  } catch (err) {
    if (!isUnknownChain(err)) throw err;
    await provider.request({ method: "wallet_addEthereumChain", params: [chain.params] });
    // Some wallets add without switching.
    const after = await provider.request({ method: "eth_chainId" });
    if (after?.toLowerCase() !== chain.hex)
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.hex }] });
  }
}

export const WRONG_CHAIN_TEXT =
  "Connected, but your wallet isn't on BNB Smart Chain testnet. Approve the network switch in your wallet, or switch to it manually (chain ID 97), then try again.";
