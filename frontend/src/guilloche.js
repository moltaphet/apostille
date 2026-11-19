// Guilloche rosettes: the interlaced line patterns printed on banknotes and passports.
// Each seal's rosette is derived from its account hash, so no two seals look alike,
// the same way security printing makes a document hard to counterfeit.

const NS = "http://www.w3.org/2000/svg";

/** Deterministic PRNG (mulberry32) seeded from a hex string. */
function rng(seedHex) {
  let s = 0;
  for (let i = 2; i < seedHex.length; i += 8) s = (s ^ parseInt(seedHex.slice(i, i + 8) || "0", 16)) >>> 0;
  s ||= 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hypotrochoid / epitrochoid path centred at (cx, cy), scaled so its outer edge sits at `radius`. */
function trochoid({ R, r, d, radius, cx, cy, epi, steps = 2600, phase = 0 }) {
  const k = epi ? R + r : R - r;
  const ratio = k / r;
  const scale = radius / (k + d);
  const turns = r / gcd(Math.round(R), Math.round(r)); // closes the curve
  const end = Math.PI * 2 * turns;
  let out = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * end;
    const x = k * Math.cos(t) + (epi ? -1 : 1) * d * Math.cos(ratio * t);
    const y = k * Math.sin(t) - d * Math.sin(ratio * t);
    // rotate the whole curve by `phase`
    const xr = x * Math.cos(phase) - y * Math.sin(phase);
    const yr = x * Math.sin(phase) + y * Math.cos(phase);
    out += `${i ? "L" : "M"}${(cx + xr * scale).toFixed(2)} ${(cy + yr * scale).toFixed(2)}`;
  }
  return out;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

/**
 * Renders a rosette into `svg`.
 * @param {SVGSVGElement} svg
 * @param {object} o
 * @param {string} o.seed      hex string (account hash) or any fallback
 * @param {number} o.tier      0..n, adds density to the inner rosette
 * @param {string} o.microtext text repeated around the rim
 */
export function drawRosette(svg, { seed = "0x0", tier = 0, microtext = "" }) {
  const size = 600;
  const c = size / 2;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.replaceChildren();
  const rand = rng(seed);
  const pick = (a, b) => Math.round(a + rand() * (b - a));

  const defs = el("defs", {}, svg);
  const foil = el("linearGradient", { id: "foil", x1: "0", y1: "0", x2: "1", y2: "1" }, defs);
  [["0", "#7fb8a4"], ["0.35", "#b7a7d6"], ["0.65", "#e3c79a"], ["1", "#7fb8a4"]].forEach(([o, col]) =>
    el("stop", { offset: o, "stop-color": col }, foil)
  );
  el("path", { id: "rim", d: `M ${c} ${c} m -262 0 a 262 262 0 1 1 524 0 a 262 262 0 1 1 -524 0` }, defs);

  // Outer band: epitrochoid ring, a few rotated copies for density.
  const outer = el("g", { class: "g-outer" }, svg);
  const Ro = pick(36, 60), ro = pick(3, 6), dO = ro * (1.4 + rand() * 1.4);
  for (let i = 0; i < 3; i++) {
    el("path", { d: trochoid({ R: Ro, r: ro, d: dO, radius: 252, cx: c, cy: c, epi: true, phase: (i * Math.PI) / (Ro * 1.5) }) }, outer);
  }

  // Middle band: hypotrochoid lace.
  const mid = el("g", { class: "g-mid" }, svg);
  const Rm = pick(40, 64), rm = pick(7, 15), dM = rm * (1.6 + rand() * 1.4);
  for (let i = 0; i < 2; i++) {
    el("path", { d: trochoid({ R: Rm, r: rm, d: dM, radius: 196, cx: c, cy: c, phase: (i * Math.PI) / Rm }) }, mid);
  }

  // Inner rosette: one extra layer per tier, so higher seals look denser.
  const inner = el("g", { class: "g-inner" }, svg);
  const Ri = pick(30, 48), ri = pick(5, 11), dI = ri * (2 + rand() * 1.5);
  const layers = 1 + Math.min(tier, 4);
  for (let i = 0; i < layers; i++) {
    el("path", { d: trochoid({ R: Ri, r: ri, d: dI, radius: 150 - i * 6, cx: c, cy: c, phase: (i * Math.PI) / (Ri * 2) }) }, inner);
  }

  // Foil disc behind the tier mark.
  el("circle", { cx: c, cy: c, r: 92, class: "g-foil" }, svg);
  el("circle", { cx: c, cy: c, r: 92, class: "g-foil-ring" }, svg);

  // Microprinting around the rim.
  if (microtext) {
    const text = el("text", { class: "g-micro" }, svg);
    const tp = el("textPath", { href: "#rim" }, text);
    tp.textContent = (microtext + "   ").repeat(14);
  }
}
