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
import { ensureChain, WRONG_CHAIN_TEXT } from "./wallet.js";

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
let connecting = false;
const PENDING_TEXT = "Your wallet already has a connection request open. Approve or cancel it in the wallet window, then try again.";
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
const sealbox = $("sealbox");
const btnSeal = $("btn-seal");
let pending = null; // last verified proof, waiting for the optional seal
const cert = $("certificate");
const rosette = $("rosette");
const rungs = $("rungs");
const targetWrap = $("target-wrap");
const targetTier = $("target-tier");
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const mode = () => modeInputs.find((i) => i.checked)?.value || "revealed";
const qualifierInputs = [...document.querySelectorAll('input[name="qualifier"]')];
const qualifier = () => qualifierInputs.find((i) => i.checked)?.value || "volume";

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
// Several public BSC testnet nodes: one rate-limiting or timing out must not break the app.
const READ_RPCS = [
  "https://bsc-testnet-rpc.publicnode.com",
  CHAIN.params.rpcUrls[0],
  "https://data-seed-prebsc-2-s1.bnbchain.org:8545",
];
const readProviders = READ_RPCS.map((u) => new JsonRpcProvider(u, CHAIN.chainId, { staticNetwork: true, batchMaxCount: 1 }));
let readIndex = 0;
const readContract = () => new Contract(CONFIG.apostille, APOSTILLE_ABI, readProviders[readIndex]);
/** A contract revert is an answer; anything else (timeouts, rate limits, odd node errors) means
 *  "ask another node". */
const isRevert = (err) => err?.code === "CALL_EXCEPTION" || !!err?.revert || typeof err?.data === "string";
/** Cross-chain messaging fee for a seal. Zero for deployments without spokes or without the call. */
async function broadcastFee() {
  try {
    return await withRead((c) => new Contract(c.target, ["function quoteBroadcast() view returns (uint256)"], c.runner).quoteBroadcast());
  } catch (_) {
    return 0n;
  }
}
async function withRead(fn) {
  let last;
  for (let i = 0; i < readProviders.length; i++) {
    const idx = (readIndex + i) % readProviders.length;
    try {
      const out = await fn(new Contract(CONFIG.apostille, APOSTILLE_ABI, readProviders[idx]), readProviders[idx]);
      readIndex = idx;
      return out;
    } catch (err) {
      if (isRevert(err)) throw err;
      last = err;
    }
  }
  throw last;
}
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
  if (typeof sealbox !== "undefined" && sealbox) sealbox.hidden = true;
}
function showNotice(text, kind = "error") {
  notice.hidden = !text;
  notice.textContent = text || "";
  notice.dataset.kind = kind;
}

/** The innermost human message in an ethers / wallet / node error. Ethers wraps errors it can't
 *  classify as UNKNOWN_ERROR ("could not coalesce error"); the real cause is inside. */
function innerMessage(err) {
  const cands = [err?.info?.error?.message, err?.error?.message, err?.info?.error?.data?.message, err?.data?.message, err?.info?.payload && err?.error?.message, err?.message];
  return cands.find((m) => typeof m === "string" && m && !/could not coalesce/i.test(m)) || "";
}

function explain(err) {
  const inner = innerMessage(err);
  if (/insufficient funds|exceeds balance|not enough (balance|funds)|gas required exceeds/i.test(inner))
    return "This wallet doesn't have enough test BNB for gas. Sealing is optional: your proof is already verified. To seal, get free tBNB from the BNB Chain testnet faucet (testnet.bnbchain.org/faucet-smart) and try again.";
  if (/rate limit|too many requests|limit exceeded|429|timeout|timed out|failed to fetch|network error/i.test(inner))
    return "The BNB Chain testnet node didn't answer. Wait a few seconds and try again.";
  if (/user (rejected|denied)|rejected the request/i.test(inner)) return "You cancelled the request in your wallet.";
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (data && CONFIG.apostille) {
    try {
      const parsed = readContract().interface.parseError(data);
      if (parsed) return ERROR_TEXT[parsed.name] || `The contract rejected the proof (${parsed.name}).`;
    } catch (_) {}
  }
  if (err?.revert?.name) return ERROR_TEXT[err.revert.name] || `The contract rejected the proof (${err.revert.name}).`;
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001) return "You cancelled the request in your wallet.";
  if (String(err?.code) === "00104")
    return mode() === "concealed"
      ? "Your Binance account doesn't clear this tier's bar, so Primus won't attest it. Pick a lower tier, switch between volume and VIP, or use exact figures."
      : "Primus couldn't verify your Binance data. Check that you're logged in to Binance in this browser, then try again.";
  if (err?.code && /^\d+$/.test(String(err.code)))
    return `Primus returned error ${err.code}${err.message ? `: ${err.message}` : ""}. Check that you're logged in to Binance in this browser.`;
  if (err?.code === "UNKNOWN_ERROR" || /could not coalesce/i.test(err?.message || ""))
    return inner ? `Your wallet returned an error: ${inner}` : "Your wallet returned an error it didn't explain. Check that it's on BNB Smart Chain testnet and unlocked, then try again.";
  return err?.shortMessage || inner || err?.message || String(err);
}

// ── Chain ────────────────────────────────────────────────────────────────

// ── Certificate ──────────────────────────────────────────────────────────
function renderCertificate(seal, status, { animate = false, preview = false } = {}) {
  const has = !!seal;
  const active = has && status?.active;
  const tier = has ? Number(active ? status.tier : seal.tier) : 0;
  cert.dataset.state = preview ? "preview" : active ? "active" : has ? "expired" : "empty";

  const seed = has ? seal.account : account || ZERO_HASH;
  const name = has ? tiers[tier]?.name ?? `Tier ${tier}` : "Specimen";
  const micro = has
    ? `APOSTILLE ${name.toUpperCase()} SEAL VIP ${seal.vipLevel} ${seal.account.slice(2, 18).toUpperCase()}`
    : "APOSTILLE SPECIMEN NOT VALID UNTIL SEALED";
  drawRosette(rosette, { seed, tier, microtext: micro });

  $("tier-numeral").textContent = has ? roman(tier) : "";
  $("tier-numeral").hidden = !has;
  $("cert-title").textContent = has ? `${name} seal` : "Specimen";

  $("cert-status").textContent = preview
    ? "Verified by the contract. Not sealed yet: sealing is optional."
    : !account
    ? "Connect a wallet to see its seal."
    : !has
      ? "This wallet has no seal yet."
      : active
        ? `Active. Issued ${date(seal.issuedAt)} for ${short(account)}${seal.concealed ? ", figures kept private" : ""}.`
        : `Expired on ${date(seal.expiresAt)}. Prove again to renew it.`;

  // Concealed seals store proven floors, not real figures.
  const floor = (v, fmt) => (Number(v) > 0 ? `≥ ${fmt(v)}` : "Private");
  $("cert-vip").textContent = !has ? "–" : seal.concealed ? floor(seal.vipLevel, (v) => `VIP ${v}`) : `VIP ${seal.vipLevel}`;
  $("cert-futures").textContent = !has ? "–" : seal.concealed ? floor(seal.futures30dVolume, usd) : usd(seal.futures30dVolume);
  $("cert-spot").textContent = !has ? "–" : seal.concealed ? "Private" : usd(seal.spot30dVolume);
  $("cert-discount").textContent = active ? pct(status.discountBps) : "–";
  $("cert-expiry").textContent = has ? date(seal.expiresAt) : "–";
  $("cert-account").textContent = has ? short(seal.account) : "–";
  btnRelease.hidden = !has || preview;

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
  const mine = seal && !seal.concealed ? pos(seal.futures30dVolume) : null;

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
    const live = await withRead((c) => c.tiers());
    if (live.length) tiers = live;
  } catch (_) {
    /* keep fallback table */
  }
}

async function loadSeal(opts) {
  if (!account || !CONFIG.apostille) return renderCertificate(null);
  try {
    const [seal, status] = await withRead((c) => Promise.all([c.sealOf(account), c.tierOf(account)]));
    renderCertificate(seal.account === ZERO_HASH ? null : seal, status, opts);
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
    ? "You'll approve one request and prove on Binance. Free: sealing on-chain afterwards is optional."
    : "Connect a wallet on BNB Smart Chain testnet to start.";
  flow.dataset.open = "false";
  resetSteps();
  showNotice("");
  loadSeal();
}

btnConnect.addEventListener("click", async () => {
  if (connecting) return; // a wallet popup is already open
  showNotice("");
  if (account) return setAccount("");
  if (!window.ethereum) return showNotice("No browser wallet found. Install MetaMask, OKX Wallet or Rabby, then reload.");
  try {
    connecting = true;
    btnConnect.disabled = true;
    btnConnect.textContent = "Check your wallet…";
    const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
    setAccount(a);
    try {
      await ensureChain();
    } catch (err) {
      showNotice(err?.code === 4001 ? WRONG_CHAIN_TEXT : `${WRONG_CHAIN_TEXT} (${explain(err)})`);
    }
  } catch (err) {
    showNotice((err?.code === -32002 || /already (processing|pending)/i.test(err?.message || "")) ? PENDING_TEXT : explain(err));
    if (!account) btnConnect.textContent = "Connect wallet";
  } finally {
    connecting = false;
    btnConnect.disabled = false;
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
    request.setAttConditions(conditionsFor(mode()));
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
    // Kept for support/debugging: holds only the hashed UID and the attested tier numbers.
    window.__apostille = { attestation };
    console.info("apostille: attestation data", attestation.data, "conditions", attestation.attConditions);

    // 3. Run the contract's own checks as a free simulation (eth_call): no transaction, no gas.
    stage = "check";
    setStep("check", "active");
    const att = toStruct(attestation);
    const preview = await withRead((c) => c.seal.staticCall(att, { from: account }));
    setStep("check", "done");
    pending = { att, at: Date.now(), for: account };
    const t = Number(preview.tier);
    renderCertificate(preview, { active: true, tier: t, discountBps: tiers[t]?.feeDiscountBps ?? 0 }, { animate: true, preview: true });
    sealbox.hidden = false;
    $("sealbox-text").textContent = `Your proof passed every check: ${tiers[t]?.name ?? `tier ${t}`} tier. Sealing is optional. It stores the result on-chain so any protocol can read your tier.`;
    $("sealbox-hint").textContent = "One transaction on BNB Smart Chain testnet. The proof stays valid for 15 minutes.";
    showNotice("");
  } catch (err) {
    console.error(err);
    setStep(stage, "error");
    showNotice(explain(err));
  } finally {
    btnProve.disabled = !account;
    btnProve.textContent = "Prove my Binance tier";
  }
});

// ── Optional: seal on-chain ──────────────────────────────────────────────
btnSeal.addEventListener("click", async () => {
  if (!pending || pending.for !== account) return showNotice("Prove your tier first.");
  if (Date.now() - pending.at > 14 * 60 * 1000) {
    sealbox.hidden = true;
    return showNotice("This proof is older than 15 minutes, so the contract won't accept it. Prove again, then seal.");
  }
  showNotice("");
  btnSeal.disabled = true;
  setStep("seal", "active");
  try {
    await ensureChain();
    const value = await broadcastFee();
    // Gas and balance come from a public node, so a wallet's own RPC quirks can't break the estimate.
    const [gas, feeData, balance] = await withRead(async (c, p) =>
      Promise.all([c.seal.estimateGas(pending.att, { from: account, value }), p.getFeeData(), p.getBalance(account)])
    );
    const gasLimit = (gas * 12n) / 10n;
    const cost = gasLimit * (feeData.gasPrice ?? 1_000_000_000n) + value;
    if (balance < cost)
      throw Object.assign(new Error("insufficient funds"), { info: { error: { message: "insufficient funds for gas" } } });

    const signer = await new BrowserProvider(window.ethereum).getSigner();
    const apostille = new Contract(CONFIG.apostille, APOSTILLE_ABI, signer);
    showNotice("Confirm the transaction in your wallet.", "ok");
    const tx = await withWalletTimeout(apostille.seal(pending.att, { value, gasLimit }));
    showNotice("Transaction sent. Waiting for confirmation…", "ok");
    await tx.wait();
    setStep("seal", "done");
    pending = null;
    sealbox.hidden = true;
    showNotice("Sealed. Protocols can now read your tier.", "ok");
    await loadSeal({ animate: true });
  } catch (err) {
    console.error(err);
    setStep("seal", "error");
    showNotice(explain(err));
  } finally {
    btnSeal.disabled = false;
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

/**
 * Primus conditions: always hash the user id. In concealed mode every figure becomes ">=".
 * Primus refuses to attest when any condition is false (error 00104), so only the chosen
 * qualifier carries the tier's bar; the other figures use ">= 0", which always holds and
 * hides the real value.
 */
function conditionsFor(m) {
  const id = { field: "userId", op: "SHA256" };
  if (m !== "concealed") return [[id]];
  const t = tiers[Number(targetTier.value)] || tiers[1];
  const byVip = qualifier() === "vip";
  return [[
    id,
    { field: "vipLevel", op: ">=", value: byVip ? String(t.minVipLevel) : "0" },
    { field: "spot30dVol", op: ">=", value: "0" },
    { field: "futures30dVol", op: ">=", value: byVip ? "0" : String(t.minFuturesVolume) },
  ]];
}

/** Rejects if the wallet never answers, so the page doesn't wait forever. */
function withWalletTimeout(promise, ms = 3 * 60 * 1000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Your wallet didn't respond. Open it from the browser toolbar, clear any pending requests, then try again.")), ms)
    ),
  ]);
}

function renderTargets() {
  targetTier.innerHTML = tiers
    .slice(1)
    .map((t, i) => `<option value="${i + 1}">${t.name}: VIP ${t.minVipLevel}+ or ${usd(t.minFuturesVolume)}+ futures</option>`)
    .join("");
}
modeInputs.forEach((i) => i.addEventListener("change", () => (targetWrap.hidden = mode() !== "concealed")));

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
renderTargets();
loadTiers().then(() => {
  renderLadder();
  renderTargets();
});


// Dev-only preview of a sealed certificate: append ?preview=gold (or bronze, silver, sovereign).
if (import.meta.env.DEV) {
  const p = new URLSearchParams(location.search).get("preview");
  const i = tiers.findIndex((t) => t.name.toLowerCase() === p);
  if (i > 0) {
    account = "0x8a3f00000000000000000000000000000000c41e";
    const now = Math.floor(Date.now() / 1000);
    renderCertificate(
      {
        account: "0x5be1c0a9d33f7e18a4b6f2c9017e3d84c5a6b9f0e21d47c8a93b5e6f708c1d2e",
        source: 0,
        concealed: new URLSearchParams(location.search).has("private"),
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
