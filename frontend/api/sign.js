// Vercel serverless function: POST /api/sign
// Holds the Primus app secret server-side and signs only the exact Apostille request.
// Set PRIMUS_APP_ID and PRIMUS_APP_SECRET in the Vercel project's environment variables.

import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { checkSignParams, createRateLimiter, DEFAULT_TEMPLATE_ID } from "../lib/signer.js";

const {
  PRIMUS_APP_ID = "0x97d782bfe1870c4ee29099bfcc8ebdda400e93eb", // public; must match the frontend
  PRIMUS_APP_SECRET,
  PRIMUS_TEMPLATE_ID = DEFAULT_TEMPLATE_ID,
} = process.env;

// Per-instance limit; warm instances are reused, so this caps bursts from one client.
const limited = createRateLimiter({ windowMs: 60_000, max: 10 });

// Byte-for-byte equivalent of PrimusZKTLS.sign() from @primuslabs/zktls-js-sdk:
// EIP-191 signature over keccak256(utf8(signParams)) with the app secret. Implemented
// directly because the SDK's Node dependency tree (rpc-websockets/uuid) fails to load
// in Vercel's runtime, and the server only needs this one operation.
let wallet;
async function sign(signParams) {
  wallet ??= new Wallet(PRIMUS_APP_SECRET);
  const appSignature = await wallet.signMessage(keccak256(toUtf8Bytes(signParams)));
  return JSON.stringify({ attRequest: JSON.parse(signParams), appSignature });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  if (!PRIMUS_APP_ID || !PRIMUS_APP_SECRET) {
    return res.status(503).json({ error: "signer is not configured" });
  }

  // Vercel sets x-real-ip itself; the first x-forwarded-for entry can be supplied by the client.
  const ip = req.headers["x-real-ip"] || (req.headers["x-forwarded-for"] || "").split(",").pop().trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "too many requests" });

  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  const check = checkSignParams(body?.signParams, { appId: PRIMUS_APP_ID, templateId: PRIMUS_TEMPLATE_ID });
  if (check.error) return res.status(check.status).json({ error: check.error });

  try {
    const signResult = await sign(body.signParams);
    return res.status(200).json({ signResult });
  } catch (err) {
    console.error("sign failed:", err);
    return res.status(500).json({ error: "signing failed" });
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
