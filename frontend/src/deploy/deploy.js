import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";
import "@fontsource/big-shoulders-display/700";
import "@fontsource/big-shoulders-display/900";
import "../style.css";
import "./deploy.css";
import { BrowserProvider, ContractFactory, formatEther } from "ethers";
import { CHAIN } from "../config.js";
import artifact from "./apostille.artifact.json";

const D = artifact.defaults;
const PRIMUS = D.primusVerifier[CHAIN.chainId];

// ── state & DOM ─────────────────────────────────────────────────────────
let account = "";
const $ = (id) => document.getElementById(id);
const btnConnect = $("btn-connect");
const btnDeploy = $("btn-deploy");
const notice = $("notice");

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (v) => (Number(v) >= 1e6 ? `$${Number(v) / 1e6}M` : `$${Number(v).toLocaleString("en-US")}`);
function showNotice(text, kind = "error") {
  notice.hidden = !text;
  notice.textContent = text || "";
  notice.dataset.kind = kind;
}

// ── static params ───────────────────────────────────────────────────────
$("p-primus").textContent = PRIMUS;
$("p-age").textContent = `${D.maxAttestationAge / 60} minutes`;
$("p-validity").textContent = `${D.sealValidity / 86400} days`;
$("p-tiers").textContent = D.tiers
  .slice(1)
  .map((t) => `${t.name}: VIP ${t.minVipLevel} or ${usd(t.minFuturesVolume)}, ${t.feeDiscountBps / 100}% off`)
  .join("\n");

async function ensureChain() {
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (current === CHAIN.hex) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hex }] });
  } catch (err) {
    if (err.code === 4902) await window.ethereum.request({ method: "wallet_addEthereumChain", params: [CHAIN.params] });
    else throw err;
  }
}

async function refresh() {
  btnConnect.textContent = account ? short(account) : "Connect wallet";
  $("p-owner").textContent = account || "Connect a wallet";
  btnDeploy.disabled = !account;
  if (!account) return ($("p-balance").textContent = "–");

  const provider = new BrowserProvider(window.ethereum);
  const [bal, code] = await Promise.all([provider.getBalance(account), provider.getCode(PRIMUS)]);
  $("p-balance").textContent = `${Number(formatEther(bal)).toFixed(4)} tBNB`;
  if (code === "0x") {
    btnDeploy.disabled = true;
    return showNotice("The Primus verifier has no code on this network. Make sure your wallet is on BNB Smart Chain testnet.");
  }
  if (bal === 0n) {
    btnDeploy.disabled = true;
    return showNotice("This wallet has no tBNB for gas. Get some from the BNB Chain testnet faucet, then reconnect.");
  }
  showNotice("");
}

btnConnect.addEventListener("click", async () => {
  if (!window.ethereum) return showNotice("No browser wallet found. Install MetaMask, OKX Wallet or Rabby.");
  try {
    const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureChain();
    account = a;
    await refresh();
  } catch (err) {
    showNotice(err?.shortMessage || err?.message || String(err));
  }
});

window.ethereum?.on?.("accountsChanged", (a) => {
  account = a[0] || "";
  refresh();
});
window.ethereum?.on?.("chainChanged", () => refresh());

btnDeploy.addEventListener("click", async () => {
  btnDeploy.disabled = true;
  btnDeploy.textContent = "Confirm in your wallet…";
  showNotice("");
  try {
    await ensureChain();
    const signer = await new BrowserProvider(window.ethereum).getSigner();
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
    const tiers = D.tiers.map((t) => ({ ...t, minFuturesVolume: BigInt(t.minFuturesVolume) }));
    const contract = await factory.deploy(account, PRIMUS, D.maxAttestationAge, D.sealValidity, tiers);
    btnDeploy.textContent = "Deploying…";
    showNotice(`Transaction sent: ${contract.deploymentTransaction().hash}`, "ok");
    await contract.waitForDeployment();
    const address = await contract.getAddress();

    $("addr").textContent = address;
    $("addr-link").href = `${CHAIN.explorer}/address/${address}`;
    $("result").hidden = false;
    showNotice("");
    btnDeploy.textContent = "Deployed";
  } catch (err) {
    console.error(err);
    showNotice(err?.code === "ACTION_REJECTED" ? "You cancelled the transaction." : err?.shortMessage || err?.message || String(err));
    btnDeploy.disabled = !account;
    btnDeploy.textContent = "Deploy Apostille";
  }
});

$("btn-copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("addr").textContent);
  $("btn-copy").textContent = "Copied";
});
