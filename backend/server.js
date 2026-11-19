// Apostille signing service.
//
// Primus's enterprise zkTLS SDK requires every attestation request to be signed with the
// app secret. That secret must never reach the browser, so the frontend builds the request,
// this service checks it is *exactly* the Apostille request, and only then signs it.
//
// Anything this service refuses to sign cannot become a valid Apostille seal, so the checks
// here are the off-chain half of the contract's guarantees (the contract re-checks the parts
// that end up inside the attestation).

import "dotenv/config";
import express from "express";
import cors from "cors";
import { isAddress } from "ethers";
import { PrimusZKTLS } from "@primuslabs/zktls-js-sdk";

const {
  PRIMUS_APP_ID,
  PRIMUS_APP_SECRET,
  PRIMUS_TEMPLATE_ID = "9e2dff87-3bfd-4a65-ad84-9eeb87d0f56e",
  ALLOWED_ORIGINS = "http://localhost:5173",
  PORT = "8787",
} = process.env;

if (!PRIMUS_APP_ID || !PRIMUS_APP_SECRET) {
  console.error("PRIMUS_APP_ID and PRIMUS_APP_SECRET must be set (see backend/.env.example).");
  process.exit(1);
}

// The only attestation condition Apostille accepts: hash the Binance user id.
const REQUIRED_CONDITIONS = JSON.stringify([[{ field: "userId", op: "SHA256" }]]);
const MAX_REQUEST_AGE_MS = 2 * 60 * 1000;

const primus = new PrimusZKTLS();
await primus.init(PRIMUS_APP_ID, PRIMUS_APP_SECRET);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use(
  cors({
    origin: ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
    methods: ["POST"],
  })
);

// Small fixed-window rate limit per IP. Each signature spends Primus proof quota.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now - e.start > WINDOW_MS) hits.delete(ip);
}, WINDOW_MS).unref();

/** Returns a reason string if the request is not an Apostille request, otherwise null. */
function rejectReason(req) {
  if (!req || typeof req !== "object") return "request must be a JSON object";
  if (req.appId !== PRIMUS_APP_ID) return "unexpected appId";
  if (req.attTemplateID !== PRIMUS_TEMPLATE_ID) return "unexpected template";
  if (!isAddress(req.userAddress)) return "userAddress must be an EVM address";
  if (JSON.stringify(req.attConditions) !== REQUIRED_CONDITIONS) return "userId must be hashed (SHA256)";
  if (req.attMode?.algorithmType !== "proxytls" || req.attMode?.resultType !== "plain") return "unexpected attMode";
  if (req.computeMode && req.computeMode !== "normal") return "unexpected computeMode";
  if (req.allJsonResponseFlag && req.allJsonResponseFlag !== "false") return "full responses are not allowed";
  if (req.backUrl) return "backUrl is not allowed";
  if (typeof req.timestamp !== "number" || Math.abs(Date.now() - req.timestamp) > MAX_REQUEST_AGE_MS)
    return "request timestamp out of range";
  return null;
}

app.get("/health", (_req, res) => res.json({ ok: true, template: PRIMUS_TEMPLATE_ID }));

app.post("/sign", async (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: "too many requests" });

  const { signParams } = req.body ?? {};
  if (typeof signParams !== "string") return res.status(400).json({ error: "signParams must be a string" });

  let parsed;
  try {
    parsed = JSON.parse(signParams);
  } catch {
    return res.status(400).json({ error: "signParams is not valid JSON" });
  }

  const reason = rejectReason(parsed);
  if (reason) return res.status(400).json({ error: reason });

  try {
    const signResult = await primus.sign(signParams);
    res.json({ signResult });
  } catch (err) {
    console.error("sign failed:", err);
    res.status(500).json({ error: "signing failed" });
  }
});

app.listen(Number(PORT), () => console.log(`apostille signer listening on :${PORT}`));
