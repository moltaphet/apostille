import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";
import "@fontsource/big-shoulders-display/700";
import "@fontsource/big-shoulders-display/900";
import "../style.css";
import "./deploy.css";
import { BrowserProvider, Contract, ContractFactory, JsonRpcProvider, formatEther, isAddress } from "ethers";
import { ensureChain, WRONG_CHAIN_TEXT } from "../wallet.js";
import { CHAIN, CHAINS } from "../config.js";
import artifact from "./apostille.artifact.json";

const D = artifact.defaults;
const ATTESTOR = D.enterpriseAttestor;
const read = new JsonRpcProvider(CHAIN.params.rpcUrls[0], CHAIN.chainId, { staticNetwork: true });

// ── state & DOM ─────────────────────────────────────────────────────────
let account = "";
let connecting = false;
const PENDING_TEXT = "Your wallet already has a connection request open. Approve or cancel it in the wallet window, then try again.";
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
$("p-attestor").textContent = ATTESTOR;
$("p-age").textContent = `${D.maxAttestationAge / 60} minutes`;
$("p-validity").textContent = `${D.sealValidity / 86400} days`;
$("p-tiers").textContent = D.tiers
  .slice(1)
  .map((t) => `${t.name}: VIP ${t.minVipLevel} or ${usd(t.minFuturesVolume)}, ${t.feeDiscountBps / 100}% off`)
  .join("\n");


async function refresh() {
  mcRefresh?.();
  btnConnect.textContent = account ? short(account) : "Connect wallet";
  $("p-owner").textContent = account || "Connect a wallet";
  btnDeploy.disabled = !account;
  if (!account) return ($("p-balance").textContent = "–");

  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId?.toLowerCase() !== CHAIN.hex) {
    btnDeploy.disabled = true;
    return showNotice(WRONG_CHAIN_TEXT);
  }
  const provider = new BrowserProvider(window.ethereum);
  const bal = await provider.getBalance(account);
  $("p-balance").textContent = `${Number(formatEther(bal)).toFixed(4)} tBNB`;
  if (bal === 0n) {
    btnDeploy.disabled = true;
    return showNotice("This wallet has no tBNB for gas. Get some from the BNB Chain testnet faucet, then reconnect.");
  }
  showNotice("");
}

btnConnect.addEventListener("click", async () => {
  if (connecting) return; // a wallet popup is already open
  if (!window.ethereum) return showNotice("No browser wallet found. Install MetaMask, OKX Wallet or Rabby.");
  try {
    connecting = true;
    btnConnect.disabled = true;
    btnConnect.textContent = "Check your wallet…";
    const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
    account = a;
    try {
      await ensureChain();
    } catch (err) {
      showNotice(WRONG_CHAIN_TEXT);
      btnDeploy.disabled = true;
      btnConnect.textContent = short(account);
      $("p-owner").textContent = account;
      return;
    }
    await refresh();
    if (addrInput.value) check();
  } catch (err) {
    showNotice((err?.code === -32002 || /already (processing|pending)/i.test(err?.message || "")) ? PENDING_TEXT : err?.shortMessage || err?.message || String(err));
    if (!account) btnConnect.textContent = "Connect wallet";
  } finally {
    connecting = false;
    btnConnect.disabled = false;
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
    // Reuse an existing verifier when it already trusts the SDK attestor: one transaction instead of two.
    const known = D.existingVerifier?.[CHAIN.chainId];
    const verifier = known && (await acceptsSdk(known)) ? known : await deployVerifier(signer);
    btnDeploy.textContent = "Confirm the Apostille deployment…";
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
    const tiers = D.tiers.map((t) => ({ ...t, minFuturesVolume: BigInt(t.minFuturesVolume) }));
    const contract = await factory.deploy(account, verifier, D.maxAttestationAge, D.sealValidity, tiers, D.sources);
    btnDeploy.textContent = "Deploying Apostille…";
    showNotice(`Transaction sent: ${contract.deploymentTransaction().hash}`, "ok");
    await contract.waitForDeployment();
    const address = await contract.getAddress();

    $("addr").textContent = address;
    hubInput.value = address;
    mcRefresh();
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

// ── verifier ────────────────────────────────────────────────────────────
async function deployVerifier(signer) {
  const f = new ContractFactory(artifact.verifier.abi, artifact.verifier.bytecode, signer);
  const v = await f.deploy(account, [ATTESTOR]);
  showNotice(`Verifier transaction sent: ${v.deploymentTransaction().hash}`, "ok");
  await v.waitForDeployment();
  return v.getAddress();
}

const OWNER_ABI = ["function owner() view returns (address)", "function primus() view returns (address)", "function setPrimus(address)"];
const btnCheck = $("btn-check");
const btnSwitch = $("btn-switch");
const addrInput = $("existing-addr");
addrInput.value = new URLSearchParams(location.search).get("apostille") || import.meta.env.VITE_APOSTILLE_ADDRESS || "0x7EDa50410744a3e2B10a82016d8767f911cFD0B2";

/** Does `verifier` accept signatures from the SDK's attestor? Works for both our
 *  AttestorVerifier (isAttestor) and Primus's PrimusZKTLS (_attestors list). */
async function acceptsSdk(verifier) {
  const v = new Contract(verifier, ["function isAttestor(address) view returns (bool)", "function _attestors(uint256) view returns (address,string)"], read);
  try {
    return await v.isAttestor(ATTESTOR);
  } catch (_) {}
  for (let i = 0; i < 32; i++) {
    try {
      const [a] = await v._attestors(i);
      if (a.toLowerCase() === ATTESTOR.toLowerCase()) return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

async function check() {
  btnSwitch.hidden = true;
  const addr = addrInput.value.trim();
  if (!isAddress(addr)) return showNotice("Enter a valid contract address.");
  btnCheck.disabled = true;
  btnCheck.textContent = "Checking…";
  try {
    const c = new Contract(addr, OWNER_ABI, read);
    const [owner, verifier] = await Promise.all([c.owner(), c.primus()]);
    const ok = await acceptsSdk(verifier);
    $("check-out").hidden = false;
    $("c-owner").textContent = owner;
    $("c-verifier").textContent = verifier;
    $("c-accepts").innerHTML = ok
      ? '<span class="yes">Yes. Proofs from the Primus SDK will verify.</span>'
      : '<span class="no">No. Seal transactions will fail with "Invalid signature".</span>';
    const isOwner = account && owner.toLowerCase() === account.toLowerCase();
    btnSwitch.hidden = ok;
    btnSwitch.disabled = !isOwner;
    if (!ok && !isOwner) showNotice(account ? "Only the contract owner can switch its verifier. Connect the owner wallet." : "Connect the owner wallet to fix this.");
    else showNotice("");
  } catch (err) {
    showNotice(`That address doesn't look like an Apostille contract on BSC testnet. (${err?.shortMessage || err?.message})`);
  } finally {
    btnCheck.disabled = false;
    btnCheck.textContent = "Check";
  }
}

btnCheck.addEventListener("click", check);

btnSwitch.addEventListener("click", async () => {
  btnSwitch.disabled = true;
  try {
    await ensureChain();
    const signer = await new BrowserProvider(window.ethereum).getSigner();
    btnSwitch.textContent = "Confirm the verifier deployment…";
    const verifier = await deployVerifier(signer);
    btnSwitch.textContent = "Confirm the switch…";
    const tx = await new Contract(addrInput.value.trim(), OWNER_ABI, signer).setPrimus(verifier);
    showNotice(`Switching: ${tx.hash}`, "ok");
    await tx.wait();
    showNotice(`Done. Apostille now verifies with ${verifier}.`, "ok");
    btnSwitch.textContent = "Deploy verifier and switch";
    await check();
  } catch (err) {
    console.error(err);
    showNotice(err?.code === "ACTION_REJECTED" ? "You cancelled the transaction." : err?.shortMessage || err?.message || String(err));
    btnSwitch.textContent = "Deploy verifier and switch";
    btnSwitch.disabled = false;
  }
});

if (addrInput.value) check();

// ── multi-chain: mailbox, spokes, registration ──────────────────────────
const HUB_ABI = [
  "function owner() view returns (address)",
  "function mailbox() view returns (address)",
  "function setMailbox(address)",
  "function spokes() view returns ((uint32 domain,address spoke)[])",
  "function addSpoke(uint32 domain,address spoke)",
];
const SPOKE_CHAINS = [84532, 421614];
const hubInput = $("hub-addr");
hubInput.value = new URLSearchParams(location.search).get("hub") || "";
const savedSpokes = (() => {
  try {
    return JSON.parse(localStorage.getItem("apostille:spokes") || "{}");
  } catch (_) {
    return {};
  }
})();
const saveSpokes = () => {
  try {
    localStorage.setItem("apostille:spokes", JSON.stringify(savedSpokes));
  } catch (_) {}
};
const link = (chain, addr) => `<a href="${chain.explorer}/address/${addr}" target="_blank" rel="noopener">${addr}</a>`;
const fail = (err) => showNotice(err?.code === "ACTION_REJECTED" ? "You cancelled the transaction." : err?.shortMessage || err?.message || String(err));

async function mcRefresh() {
  const hub = hubInput.value.trim();
  const hubKey = hub.toLowerCase();
  const ready = account && isAddress(hub);
  $("btn-mailbox").disabled = !ready;
  document.querySelectorAll(".btn-spoke").forEach((b) => (b.disabled = !ready));
  $("btn-register").disabled = !ready;
  if (!isAddress(hub)) return;
  try {
    const c = new Contract(hub, HUB_ABI, read);
    const [mb, registered] = await Promise.all([c.mailbox(), c.spokes()]);
    const mbOk = mb.toLowerCase() === CHAINS[97].mailbox.toLowerCase();
    $("mc-mailbox").textContent = mbOk ? `On (${mb})` : mb === "0x0000000000000000000000000000000000000000" ? "Off" : `Unexpected mailbox ${mb}`;
    $("mc-mailbox").parentElement.toggleAttribute("data-done", mbOk);
    const reg = new Map(registered.map((r) => [Number(r.domain), r.spoke]));
    for (const id of SPOKE_CHAINS) {
      const chain = CHAINS[id];
      const addr = reg.get(id) || savedSpokes[hubKey]?.[id];
      $(`mc-${id}`).innerHTML = addr ? link(chain, addr) : "Not deployed";
      $(`mc-${id}`).parentElement.toggleAttribute("data-done", !!addr);
    }
    const pending = SPOKE_CHAINS.filter((id) => savedSpokes[hubKey]?.[id] && !reg.has(id));
    $("mc-register").textContent = reg.size
      ? `Registered: ${[...reg.keys()].map((id) => CHAINS[id]?.name || id).join(", ")}${pending.length ? `. Waiting: ${pending.map((id) => CHAINS[id].name).join(", ")}` : ""}`
      : pending.length ? `Ready to register: ${pending.map((id) => CHAINS[id].name).join(", ")}` : "Nothing to register yet";
    $("mc-register").parentElement.toggleAttribute("data-done", reg.size > 0 && !pending.length);
  } catch (err) {
    $("mc-mailbox").textContent = "That address isn't a multi-chain Apostille hub on BSC testnet (deploy a new one above).";
  }
}
hubInput.addEventListener("change", mcRefresh);

$("btn-mailbox").addEventListener("click", async () => {
  try {
    await ensureChain();
    const signer = await new BrowserProvider(window.ethereum).getSigner();
    const tx = await new Contract(hubInput.value.trim(), HUB_ABI, signer).setMailbox(CHAINS[97].mailbox);
    showNotice(`Setting the mailbox: ${tx.hash}`, "ok");
    await tx.wait();
    showNotice("");
    mcRefresh();
  } catch (err) {
    fail(err);
  }
});

document.querySelectorAll(".btn-spoke").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const id = Number(btn.dataset.spoke);
    const chain = CHAINS[id];
    const hub = hubInput.value.trim();
    btn.disabled = true;
    try {
      await ensureChain(window.ethereum, chain);
      const signer = await new BrowserProvider(window.ethereum).getSigner();
      const f = new ContractFactory(artifact.spoke.abi, artifact.spoke.bytecode, signer);
      const c = await f.deploy(account, chain.mailbox, 97, hub);
      showNotice(`Deploying on ${chain.name}: ${c.deploymentTransaction().hash}`, "ok");
      await c.waitForDeployment();
      const addr = await c.getAddress();
      (savedSpokes[hub.toLowerCase()] ||= {})[id] = addr;
      saveSpokes();
      showNotice(`Spoke on ${chain.name}: ${addr}. Add it to Vercel as VITE_SPOKE_${id === 84532 ? "BASE_SEPOLIA" : "ARBITRUM_SEPOLIA"}.`, "ok");
    } catch (err) {
      fail(err);
    } finally {
      btn.disabled = false;
      try {
        await ensureChain();
      } catch (_) {}
      mcRefresh();
    }
  })
);

$("btn-register").addEventListener("click", async () => {
  const hub = hubInput.value.trim();
  try {
    await ensureChain();
    const signer = await new BrowserProvider(window.ethereum).getSigner();
    const c = new Contract(hub, HUB_ABI, signer);
    const reg = new Set((await new Contract(hub, HUB_ABI, read).spokes()).map((r) => Number(r.domain)));
    const todo = SPOKE_CHAINS.filter((id) => savedSpokes[hub.toLowerCase()]?.[id] && !reg.has(id));
    if (!todo.length) return showNotice("Nothing new to register. Deploy a spoke first.");
    for (const id of todo) {
      const tx = await c.addSpoke(id, savedSpokes[hub.toLowerCase()][id]);
      showNotice(`Registering ${CHAINS[id].name}: ${tx.hash}`, "ok");
      await tx.wait();
    }
    showNotice("Spokes registered. New seals now reach every chain.", "ok");
    mcRefresh();
  } catch (err) {
    fail(err);
  }
});
if (hubInput.value) mcRefresh();
