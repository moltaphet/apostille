import { PrimusZKTLS } from "@primuslabs/zktls-js-sdk";
import { BrowserProvider, Contract, JsonRpcProvider } from "ethers";
import { CONFIG, CHAIN, APOSTILLE_ABI, ERROR_TEXT } from "./config.js";

// ── State ───────────────────────────────────────────────────────────────
let account = "";
let tiers = [];
let primusReady = false;
let primusInitError = null;

// ── DOM refs (declared before any function that uses them) ─────────────
const $ = (id) => document.getElementById(id);
const btnConnect = $("btn-connect");
const btnProve = $("btn-prove");
const btnRelease = $("btn-release");
const notice = $("notice");
const steps = $("steps");
const cert = $("certificate");
const tierRows = $("tier-rows");

// ── Primus SDK: initialise once at load (production mode, no secret) ───
const primus = new PrimusZKTLS();
const primusInit = (async () => {
  if (!CONFIG.appId) throw new Error("VITE_PRIMUS_APP_ID is not set");
  const ua = navigator.userAgent.toLowerCase();
  const platform = ua.includes("android") ? "android" : ua.includes("iphone") ? "ios" : "pc";
  await primus.init(CONFIG.appId, "", { platform });
  primusReady = true;
})().catch((err) => {
  // Surface this only when the user actually tries to prove (see btnProve handler).
  primusInitError = err;
});

// ── Helpers ─────────────────────────────────────────────────────────────
const readProvider = new JsonRpcProvider(CHAIN.params.rpcUrls[0], CHAIN.chainId);
const readContract = () => new Contract(CONFIG.apostille, APOSTILLE_ABI, readProvider);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "-");
const usd = (v) =>
  "$" + Number(v).toLocaleString("en-US", { notation: Number(v) >= 1e6 ? "compact" : "standard", maximumFractionDigits: 1 });
const date = (secs) => new Date(Number(secs) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const roman = (n) => ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][n] ?? String(n);

function setStep(name, state) {
  const li = steps.querySelector(`[data-step="${name}"]`);
  if (li) li.dataset.state = state;
}
function resetSteps(fromWallet = false) {
  for (const li of steps.children) {
    if (fromWallet || li.dataset.step !== "wallet") delete li.dataset.state;
  }
}
function showNotice(text, kind = "error") {
  notice.hidden = !text;
  notice.textContent = text || "";
  notice.dataset.kind = kind;
}

function explain(err) {
  // Contract custom errors
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (data) {
    try {
      const parsed = readContract().interface.parseError(data);
      if (parsed) return ERROR_TEXT[parsed.name] || `Contract rejected the proof (${parsed.name}).`;
    } catch (_) {}
  }
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001) return "You rejected the request in your wallet.";
  if (err?.revert?.name) return ERROR_TEXT[err.revert.name] || `Contract rejected the proof (${err.revert.name}).`;
  // Primus SDK errors carry a code
  if (err?.code && String(err.code).startsWith("0")) return `Primus error ${err.code}: ${err.message || "see docs.primuslabs.xyz/enterprise/error-code"}`;
  return err?.shortMessage || err?.message || String(err);
}

// ── Chain ────────────────────────────────────────────────────────────────
async function ensureChain() {
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (current === CHAIN.hex) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hex }] });
  } catch (err) {
    if (err.code === 4902) {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [CHAIN.params] });
    } else throw err;
  }
}

// ── Read-only views ──────────────────────────────────────────────────────
async function loadTiers() {
  if (!CONFIG.apostille) {
    tierRows.innerHTML = `<tr><td colspan="4">Set VITE_APOSTILLE_ADDRESS to load the live tier table.</td></tr>`;
    return;
  }
  try {
    tiers = await readContract().tiers();
    renderTiers();
  } catch (err) {
    tierRows.innerHTML = `<tr><td colspan="4">Could not load tiers: ${explain(err)}</td></tr>`;
  }
}

function renderTiers(currentTier = -1) {
  tierRows.innerHTML = tiers
    .map(
      (t, i) => `<tr ${i === currentTier ? "data-current" : ""}>
        <td>${t.name}</td>
        <td>${i === 0 ? "-" : `VIP ${t.minVipLevel}+`}</td>
        <td>${i === 0 ? "-" : `${usd(t.minFuturesVolume)}+`}</td>
        <td>${Number(t.feeDiscountBps) / 100}%</td>
      </tr>`
    )
    .join("");
}

async function loadSeal() {
  if (!account || !CONFIG.apostille) return renderSeal(null);
  try {
    const c = readContract();
    const [seal, status] = await Promise.all([c.sealOf(account), c.tierOf(account)]);
    renderSeal(seal.accountHash === "0x" + "0".repeat(64) ? null : seal, status);
  } catch (err) {
    showNotice(`Could not read seal: ${explain(err)}`);
  }
}

function renderSeal(seal, status) {
  $("cert-holder").textContent = short(account);
  btnRelease.hidden = !seal;
  if (!seal) {
    cert.dataset.state = "empty";
    $("wax-tier").textContent = "-";
    $("cert-tier").textContent = "No seal yet";
    $("cert-sub").textContent = account ? "This wallet has not been sealed." : "Connect a wallet to look up its seal.";
    for (const id of ["cert-vip", "cert-discount", "cert-futures", "cert-spot", "cert-expiry", "cert-account"]) $(id).textContent = "-";
    renderTiers();
    return;
  }
  const active = status?.active;
  const tier = Number(active ? status.tier : seal.tier);
  cert.dataset.state = active ? "active" : "expired";
  $("wax-tier").textContent = roman(tier);
  $("cert-tier").textContent = `${tiers[tier]?.name ?? `Tier ${tier}`} Seal`;
  $("cert-sub").textContent = active ? `Issued ${date(seal.issuedAt)} from a Primus zkTLS attestation` : "Expired. Renew with a fresh proof.";
  $("cert-vip").textContent = `VIP ${seal.vipLevel}`;
  $("cert-discount").textContent = active ? `${Number(status.discountBps) / 100}%` : "-";
  $("cert-futures").textContent = usd(seal.futures30dVolume);
  $("cert-spot").textContent = usd(seal.spot30dVolume);
  $("cert-expiry").textContent = date(seal.expiresAt);
  $("cert-account").textContent = short(seal.accountHash);
  renderTiers(active ? tier : -1);
}

// ── Wallet ───────────────────────────────────────────────────────────────
function setAccount(a) {
  account = a || "";
  btnConnect.textContent = account ? short(account) : "Connect wallet";
  btnProve.disabled = !account;
  setStep("wallet", account ? "done" : undefined);
  resetSteps();
  loadSeal();
}

btnConnect.addEventListener("click", async () => {
  showNotice("");
  if (!window.ethereum) return showNotice("No browser wallet found. Install MetaMask, OKX Wallet or similar.");
  if (account) return setAccount(""); // toggle = disconnect (local only)
  try {
    const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
    await ensureChain();
    setAccount(a);
  } catch (err) {
    showNotice(explain(err));
  }
});

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", (accs) => setAccount(accs[0]));
  window.ethereum.on?.("chainChanged", () => loadSeal());
}

// ── Prove → seal ─────────────────────────────────────────────────────────
btnProve.addEventListener("click", async () => {
  showNotice("");
  resetSteps();
  btnProve.disabled = true;
  let stage = "sign";
  try {
    if (!CONFIG.apostille) throw new Error("VITE_APOSTILLE_ADDRESS is not set");
    await primusInit;
    if (!primusReady) throw new Error(primusInitError?.message || "Primus SDK is not ready");

    // 1. Build the exact request the signer will accept.
    setStep("sign", "active");
    const request = primus.generateRequestParams(CONFIG.templateId, account);
    request.setAttMode({ algorithmType: "proxytls" });
    request.setAttConditions([[{ field: "userId", op: "SHA256" }]]);
    const res = await fetch(`${CONFIG.signerUrl}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signParams: request.toJsonString() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Signer refused: ${body.error || res.status}`);
    setStep("sign", "done");

    // 2. zkTLS session against Binance via the Primus extension.
    stage = "prove";
    setStep("prove", "active");
    const attestation = await primus.startAttestation(body.signResult);
    if (!(await primus.verifyAttestation(attestation))) throw new Error("Attestation signature did not verify.");
    setStep("prove", "done");

    // 3. Submit to Apostille.
    stage = "seal";
    setStep("seal", "active");
    await ensureChain();
    const signer = await new BrowserProvider(window.ethereum).getSigner();
    const apostille = new Contract(CONFIG.apostille, APOSTILLE_ABI, signer);
    const att = toStruct(attestation);
    await apostille.seal.staticCall(att); // surface a revert reason before asking for gas
    const tx = await apostille.seal(att);
    showNotice(`Transaction sent: ${tx.hash.slice(0, 10)}…`, "ok");
    await tx.wait();
    setStep("seal", "done");
    showNotice("Sealed. Your tier is now readable on-chain.", "ok");
    await loadSeal();
  } catch (err) {
    console.error(err);
    setStep(stage, "error");
    showNotice(explain(err));
  } finally {
    btnProve.disabled = !account;
  }
});

btnRelease.addEventListener("click", async () => {
  showNotice("");
  try {
    await ensureChain();
    const signer = await new BrowserProvider(window.ethereum).getSigner();
    const tx = await new Contract(CONFIG.apostille, APOSTILLE_ABI, signer).release();
    await tx.wait();
    showNotice("Seal released. Your Binance account is free to back another wallet.", "ok");
    await loadSeal();
  } catch (err) {
    showNotice(explain(err));
  }
});

/** Normalises the SDK's attestation object to the contract's struct shape. */
function toStruct(a) {
  return {
    recipient: a.recipient,
    request: { url: a.request.url, header: a.request.header ?? "", method: a.request.method, body: a.request.body ?? "" },
    reponseResolve: (a.reponseResolve || []).map((r) => ({ keyName: r.keyName, parseType: r.parseType ?? "", parsePath: r.parsePath })),
    data: a.data,
    attConditions: a.attConditions ?? "",
    timestamp: BigInt(a.timestamp),
    additionParams: a.additionParams ?? "",
    attestors: (a.attestors || []).map((x) => ({ attestorAddr: x.attestorAddr, url: x.url ?? "" })),
    signatures: a.signatures,
  };
}

// ── Boot ─────────────────────────────────────────────────────────────────
if (CONFIG.apostille) $("contract-link").href = `${CHAIN.explorer}/address/${CONFIG.apostille}`;
loadTiers();
