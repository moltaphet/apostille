import "@fontsource/public-sans/400.css";
import "@fontsource/public-sans/600.css";
import "@fontsource/public-sans/700.css";
import "@fontsource/big-shoulders-display/700";
import "@fontsource/big-shoulders-display/900";
import "../style.css";
import "./perp.css";
import { Contract, JsonRpcProvider } from "ethers";
import { CONFIG, CHAIN, APOSTILLE_ABI } from "../config.js";
import { ensureChain } from "../wallet.js";

// Demo venue parameters, mirroring DemoPerp's defaults.
const BASE_FEE_PIPS = 500n; // 0.05%
const MAX_DISCOUNT_BPS = 5000;
const FALLBACK_TIERS = [
  { name: "Standard", feeDiscountBps: 0 },
  { name: "Bronze", feeDiscountBps: 1000 },
  { name: "Silver", feeDiscountBps: 2000 },
  { name: "Gold", feeDiscountBps: 3500 },
  { name: "Sovereign", feeDiscountBps: 5000 },
];

// ── state & DOM ─────────────────────────────────────────────────────────
let tiers = FALLBACK_TIERS;
let mine = null; // { active, tier, discountBps } for the connected wallet
let account = "";
let connecting = false;
const $ = (id) => document.getElementById(id);
const size = $("size");
const asTier = $("as-tier");
const btnConnect = $("btn-connect");
const read = new Contract(CONFIG.apostille, APOSTILLE_ABI, new JsonRpcProvider(CHAIN.params.rpcUrls[0], CHAIN.chainId, { staticNetwork: true }));

/** Same math as ApostilleFees.feeOn / @apostille/sdk feeOn. */
function feeOn(notional, discountBps) {
  const d = BigInt(Math.min(discountBps, MAX_DISCOUNT_BPS, 10_000));
  const ratePips = (BASE_FEE_PIPS * (10_000n - d)) / 10_000n;
  return { fee: (notional * ratePips) / 1_000_000n, ratePips };
}

const money = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (pips) => `${(Number(pips) / 10_000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`;
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function notional() {
  const v = BigInt(size.value.replace(/[^\d]/g, "") || "0");
  return v;
}

function selectedDiscount() {
  if (asTier.value === "mine") return mine?.active ? mine.discountBps : 0;
  return tiers[Number(asTier.value)]?.feeDiscountBps ?? 0;
}
function selectedName() {
  if (asTier.value === "mine") return mine?.active ? `${tiers[mine.tier]?.name ?? `Tier ${mine.tier}`} (your seal)` : "Standard (no active seal)";
  return tiers[Number(asTier.value)]?.name ?? "Standard";
}

function renderOptions() {
  const keep = asTier.value;
  asTier.innerHTML =
    (account ? `<option value="mine">My seal (${short(account)})</option>` : "") +
    tiers.map((t, i) => `<option value="${i}">${esc(t.name)}, ${Number(t.feeDiscountBps) / 100}% off</option>`).join("");
  asTier.value = account ? "mine" : [...asTier.options].some((o) => o.value === keep) ? keep : "0";
}

function render() {
  const n = notional();
  const base = feeOn(n, 0);
  const disc = selectedDiscount();
  const q = feeOn(n, disc);
  $("q-tier").textContent = selectedName();
  $("q-disc").textContent = `${Math.min(disc, MAX_DISCOUNT_BPS) / 100}%`;
  $("q-fee").textContent = money(q.fee);
  $("q-rate").textContent = `at ${pct(q.ratePips)}`;
  $("q-save").textContent = money(base.fee - q.fee);
  $("monthly").textContent = money((base.fee - q.fee) * 30n);

  const myIdx = asTier.value === "mine" ? (mine?.active ? mine.tier : 0) : Number(asTier.value);
  $("compare-rows").innerHTML = tiers
    .map((t, i) => {
      const r = feeOn(n, Number(t.feeDiscountBps));
      return `<tr ${i === myIdx ? "data-current" : ""}><td>${esc(t.name)}</td><td>${pct(r.ratePips)}</td><td>${money(r.fee)}</td><td>${money(base.fee - r.fee)}</td></tr>`;
    })
    .join("");
}

// ── events ──────────────────────────────────────────────────────────────
size.addEventListener("input", () => {
  const digits = size.value.replace(/[^\d]/g, "").slice(0, 13);
  size.value = digits ? Number(digits).toLocaleString("en-US") : "";
  render();
});
$("presets").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (!v) return;
  size.value = Number(v).toLocaleString("en-US");
  render();
});
asTier.addEventListener("change", render);

btnConnect.addEventListener("click", async () => {
  if (connecting) return;
  if (!window.ethereum) return ($("size-hint").textContent = "No browser wallet found. You can still preview any tier.");
  connecting = true;
  btnConnect.disabled = true;
  try {
    const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
    account = a;
    btnConnect.textContent = short(a);
    try { await ensureChain(); } catch (_) {}
    const [active, tier, discountBps] = await read.tierOf(a);
    mine = { active, tier: Number(tier), discountBps: Number(discountBps) };
    $("size-hint").textContent = active
      ? "Priced from your live Apostille seal on BNB Smart Chain testnet."
      : "This wallet has no active seal, so it pays the base fee. Get sealed on the home page.";
    renderOptions();
    render();
  } catch (err) {
    $("size-hint").textContent = /already (processing|pending)/i.test(err?.message || "") || err?.code === -32002
      ? "Your wallet already has a connection request open. Approve or cancel it in the wallet window."
      : err?.shortMessage || err?.message || String(err);
  } finally {
    connecting = false;
    btnConnect.disabled = false;
  }
});

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => {
    account = "";
    mine = null;
    btnConnect.textContent = "Connect wallet";
    $("size-hint").textContent = "Wallet changed. Connect again to price from its seal.";
    renderOptions();
    render();
  });
}

// ── boot ────────────────────────────────────────────────────────────────
(async () => {
  try {
    const live = await read.tiers();
    if (live.length) tiers = live.map((t) => ({ name: t.name, feeDiscountBps: Number(t.feeDiscountBps) }));
  } catch (_) {}
  renderOptions();
  render();
})();
renderOptions();
render();
