import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";
import "@fontsource/big-shoulders-display/700";
import "@fontsource/big-shoulders-display/900";
import "./style.css";
import { PrimusZKTLS } from "@primuslabs/zktls-js-sdk";
import { BrowserProvider, Contract, JsonRpcProvider } from "ethers";
import { CONFIG, CHAIN, APOSTILLE_ABI, ERROR_TEXT } from "./config.js";
import { drawRosette } from "./guilloche.js";

// Shown before the contract is reachable, so the page still explains itself.
const FALLBACK_TIERS = [
  { name: "Standard", minVipLevel: 0, minFuturesVolume: 0n, feeDiscountBps: 0 },
  { name: "Bronze", minVipLevel: 1, minFuturesVolume: 1_000_000n, feeDiscountBps: 1000 },
  { name: "Silver", minVipLevel: 2, minFuturesVolume: 10_000_000n, feeDiscountBps: 2000 },
  { name: "Gold", minVipLevel: 4, minFuturesVolume: 50_000_000n, feeDiscountBps: 3500 },
  { name: "Sovereign", minVipLevel: 7, minFuturesVolume: 250_000_000n, feeDiscountBps: 5000 },
];
const ZERO_HASH = "0x" + "0".repeat(64);

// ── State ───────────────────────────────────────────────────────────────
let account = "";
let tiers = FALLBACK_TIERS;
let primusReady = false;
let primusInitError = null;
let ladderState = { seal: null, tier: -1 };

// ── DOM refs (declared before any function that uses them) ─────────────
const $ = (id) => document.getElementById(id);
const btnConnect = $("btn-connect");
const btnProve = $("btn-prove");
const btnRelease = $("btn-release");
const flow = $("flow");
const hint = $("hint");
const notice = $("notice");
const steps = $("steps");
const cert = $("certificate");
const rosette = $("rosette");
const rungs = $("rungs");

// ── Primus SDK: initialise once at load (production mode, no secret) ───
const primus = new PrimusZKTLS();
const primusInit = (async () => {
  if (!CONFIG.appId) throw new Error("This deployment is missing its Primus app ID (VITE_PRIMUS_APP_ID).");
  const ua = navigator.userAgent.toLowerCase();
  const platform = ua.includes("android") ? "android" : ua.includes("iphone") ? "ios" : "pc";
  await primus.init(CONFIG.appId, "", { platform });
  primusReady = true;
})().catch((err) => {
  primusInitError = err; // surfaced only when the user tries to prove
});

// ── Formatting ───────────────────────────────────────────────────────────
const readProvider = new JsonRpcProvider(CHAIN.params.rpcUrls[0], CHAIN.chainId, { staticNetwork: true });
const readContract = () => new Contract(CONFIG.apostille, APOSTILLE_ABI, readProvider);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "–");
const usd = (v) => {
  const n = Number(v);
  if (n >= 1e9) return `$${+(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${+(n / 1e3).toFixed(1)}K`;
  return `$${n.toLocaleString("en-US")}`;
};
const date = (secs) => new Date(Number(secs) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const roman = (n) => ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][n] ?? String(n);
const pct = (bps) => `${Number(bps) / 100}%`;

function setStep(name, state) {
  const li = steps.querySelector(`[data-step="${name}"]`);
  if (!li) return;
  if (state) li.dataset.state = state;
  else delete li.dataset.state;
}
function resetSteps() {
  for (const li of steps.children) delete li.dataset.state;
}
function showNotice(text, kind = "error") {
  notice.hidden = !text;
  notice.textContent = text || "";
  notice.dataset.kind = kind;
}

function explain(err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (data && CONFIG.apostille) {
    try {
      const parsed = readContract().interface.parseError(data);
      if (parsed) return ERROR_TEXT[parsed.name] || `The contract rejected the proof (${parsed.name}).`;
    } catch (_) {}
  }
  if (err?.revert?.name) return ERROR_TEXT[err.revert.name] || `The contract rejected the proof (${err.revert.name}).`;
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001) return "You cancelled the request in your wallet.";
  if (err?.code && /^\d+$/.test(String(err.code)))
    return `Primus returned error ${err.code}${err.message ? `: ${err.message}` : ""}. Check that you're logged in to Binance in this browser.`;
  return err?.shortMessage || err?.message || String(err);
}

// ── Chain ────────────────────────────────────────────────────────────────
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

// ── Certificate ──────────────────────────────────────────────────────────
function renderCertificate(seal, status, { animate = false } = {}) {
  const has = !!seal;
  const active = has && status?.active;
  const tier = has ? Number(active ? status.tier : seal.tier) : 0;
  cert.dataset.state = active ? "active" : has ? "expired" : "empty";

  const seed = has ? seal.accountHash : account || ZERO_HASH;
  const name = has ? tiers[tier]?.name ?? `Tier ${tier}` : "Specimen";
  const micro = has
    ? `APOSTILLE ${name.toUpperCase()} SEAL  VIP ${seal.vipLevel}  ${seal.accountHash.slice(2, 18).toUpperCase()}`
    : "APOSTILLE  NOT VALID UNTIL SEALED  BNB SMART CHAIN";
  drawRosette(rosette, { seed, tier, microtext: micro });

  $("tier-numeral").textContent = has ? roman(tier) : "–";
  $("cert-title").textContent = has ? `${name} seal` : "Unsealed";

  $("cert-status").textContent = !account
    ? "Connect a wallet to see its seal."
    : !has
      ? "This wallet has no seal yet."
      : active
        ? `Active. Issued ${date(seal.issuedAt)} for ${short(account)}.`
        : `Expired on ${date(seal.expiresAt)}. Prove again to renew it.`;

  $("cert-vip").textContent = has ? `VIP ${seal.vipLevel}` : "–";
  $("cert-futures").textContent = has ? usd(seal.futures30dVolume) : "–";
  $("cert-spot").textContent = has ? usd(seal.spot30dVolume) : "–";
  $("cert-discount").textContent = active ? pct(status.discountBps) : "–";
  $("cert-expiry").textContent = has ? date(seal.expiresAt) : "–";
  $("cert-account").textContent = has ? short(seal.accountHash) : "–";
  btnRelease.hidden = !has;

  if (animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    cert.dataset.drawing = "";
    setTimeout(() => delete cert.dataset.drawing, 3200);
  }
  renderLadder(has ? seal : null, active ? tier : -1);
}

// ── Tier ladder ──────────────────────────────────────────────────────────
function renderLadder(seal = ladderState.seal, currentTier = ladderState.tier) {
  ladderState = { seal, tier: currentTier };
  if (!tiers.length) {
    rungs.innerHTML = `<li class="rungs-empty">The tier table could not be loaded.</li>`;
    return;
  }
  // log scale from $100K to 4x the top threshold
  const top = Number(tiers[tiers.length - 1].minFuturesVolume) * 4;
  const lo = 1e5;
  const pos = (v) => Math.max(0, Math.min(100, ((Math.log10(Math.max(Number(v), lo)) - Math.log10(lo)) / (Math.log10(top) - Math.log10(lo))) * 100));
  const mine = seal ? pos(seal.futures30dVolume) : null;

  rungs.innerHTML = tiers
    .map((t, i) => {
      const floor = i === 0;
      const vip = floor ? "Everyone" : `VIP ${t.minVipLevel} or`;
      const fill = floor ? 0 : pos(t.minFuturesVolume);
      const label = floor ? "No minimum" : `${usd(t.minFuturesVolume)} futures, 30 days`;
      const mark =
        mine === null
          ? ""
          : `<span class="rung-mark" style="left:${mine}%"></span>` +
            (i === Math.max(currentTier, 0) ? `<span class="rung-you" style="left:${Math.min(mine, 88)}%">You: ${usd(seal.futures30dVolume)}</span>` : "");
      return `<li class="rung" ${i === currentTier ? "data-current" : ""}>
        <span class="rung-name">${t.name}</span>
        <span class="rung-vip">${vip}</span>
        <span class="rung-bar" role="img" aria-label="${label}">
          <span class="rung-fill" style="width:${fill}%"></span>${mark}
          <span class="rung-label" style="left:${floor ? 0 : Math.min(fill, 78)}%">${label}</span>
        </span>
        <span class="rung-off">${pct(t.feeDiscountBps)} off</span>
      </li>`;
    })
    .join("");
}

// ── Reads ────────────────────────────────────────────────────────────────
async function loadTiers() {
  if (!CONFIG.apostille) return;
  try {
    const live = await readContract().tiers();
    if (live.length) tiers = live;
  } catch (_) {
    /* keep fallback table */
  }
}

async function loadSeal(opts) {
  if (!account || !CONFIG.apostille) return renderCertificate(null);
  try {
    const c = readContract();
    const [seal, status] = await Promise.all([c.sealOf(account), c.tierOf(account)]);
    renderCertificate(seal.accountHash === ZERO_HASH ? null : seal, status, opts);
  } catch (err) {
    renderCertificate(null);
    showNotice(`Couldn't read this wallet's seal: ${explain(err)}`);
  }
}

// ── Wallet ───────────────────────────────────────────────────────────────
function setAccount(a) {
  account = a || "";
  btnConnect.textContent = account ? short(account) : "Connect wallet";
  btnConnect.setAttribute("aria-label", account ? `Connected as ${account}. Disconnect` : "Connect wallet");
  btnProve.disabled = !account;
  hint.textContent = account
    ? "You'll approve one request, prove on Binance, then confirm one transaction."
    : "Connect a wallet on BNB Smart Chain testnet to start.";
  flow.dataset.open = "false";
  resetSteps();
  showNotice("");
  loadSeal();
}

btnConnect.addEventListener("click", async () => {
  showNotice("");
  if (account) return setAccount("");
  if (!window.ethereum) return showNotice("No browser wallet found. Install MetaMask, OKX Wallet or Rabby, then reload.");
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
  flow.dataset.open = "true";
  btnProve.disabled = true;
  btnProve.textContent = "Proving…";
  let stage = "sign";
  try {
    if (!CONFIG.apostille) throw new Error("This deployment isn't connected to a contract yet (VITE_APOSTILLE_ADDRESS).");
    await primusInit;
    if (!primusReady) throw primusInitError || new Error("The Primus SDK didn't start.");

    // 1. Build the exact request the signer accepts, and get it signed.
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
    if (!res.ok) throw new Error(`The signer refused the request: ${body.error || `HTTP ${res.status}`}.`);
    setStep("sign", "done");

    // 2. zkTLS session against Binance via the Primus extension.
    stage = "prove";
    setStep("prove", "active");
    const attestation = await primus.startAttestation(body.signResult);
    if (!(await primus.verifyAttestation(attestation))) throw new Error("The attestation signature didn't verify.");
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
    showNotice("Transaction sent. Waiting for confirmation…", "ok");
    await tx.wait();
    setStep("seal", "done");
    showNotice("Sealed. Protocols can now read your tier.", "ok");
    await loadSeal({ animate: true });
  } catch (err) {
    console.error(err);
    setStep(stage, "error");
    showNotice(explain(err));
  } finally {
    btnProve.disabled = !account;
    btnProve.textContent = "Prove my Binance tier";
  }
});

btnRelease.addEventListener("click", async () => {
  showNotice("");
  try {
    await ensureChain();
    const signer = await new BrowserProvider(window.ethereum).getSigner();
    const tx = await new Contract(CONFIG.apostille, APOSTILLE_ABI, signer).release();
    await tx.wait();
    showNotice("Seal released. Your Binance account can now back another wallet.", "ok");
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
renderCertificate(null);
loadTiers().then(() => renderLadder());


// Dev-only preview of a sealed certificate: append ?preview=gold (or bronze, silver, sovereign).
if (import.meta.env.DEV) {
  const p = new URLSearchParams(location.search).get("preview");
  const i = tiers.findIndex((t) => t.name.toLowerCase() === p);
  if (i > 0) {
    account = "0x8a3f00000000000000000000000000000000c41e";
    const now = Math.floor(Date.now() / 1000);
    renderCertificate(
      {
        accountHash: "0x5be1c0a9d33f7e18a4b6f2c9017e3d84c5a6b9f0e21d47c8a93b5e6f708c1d2e",
        vipLevel: tiers[i].minVipLevel,
        tier: i,
        issuedAt: now,
        expiresAt: now + 30 * 86400,
        spot30dVolume: 8_421_337n,
        futures30dVolume: tiers[i].minFuturesVolume * 3n / 2n,
      },
      { active: true, tier: i, discountBps: tiers[i].feeDiscountBps },
      { animate: false }
    );
  }
}
