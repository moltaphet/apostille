// Shared request policy for the Apostille signer. Used by the Vercel function
// (frontend/api/sign.js) and the standalone Express service (backend/server.js).
//
// Primus's enterprise zkTLS SDK requires every attestation request to be signed with the
// app secret. The frontend builds the request; the signer checks it is *exactly* the
// Apostille request and only then signs it. Anything the signer refuses cannot become a
// valid seal, so these checks are the off-chain half of the contract's guarantees.

import { isAddress } from "ethers";

export const DEFAULT_TEMPLATE_ID = "9e2dff87-3bfd-4a65-ad84-9eeb87d0f56e";

// The only attestation condition Apostille accepts: hash the Binance user id.
const REQUIRED_CONDITIONS = JSON.stringify([[{ field: "userId", op: "SHA256" }]]);
const MAX_REQUEST_AGE_MS = 2 * 60 * 1000;

/** Returns a reason string if `req` is not an Apostille request, otherwise null. */
export function rejectReason(req, { appId, templateId }) {
  if (!req || typeof req !== "object") return "request must be a JSON object";
  if (req.appId !== appId) return "unexpected appId";
  if (req.attTemplateID !== templateId) return "unexpected template";
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

/** Fixed-window per-key rate limiter. Each signature spends Primus proof quota. */
export function createRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const hits = new Map();
  return function limited(key) {
    const now = Date.now();
    if (hits.size > 10_000) for (const [k, e] of hits) if (now - e.start > windowMs) hits.delete(k);
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
}

/** Validates a raw `signParams` string. Returns { error, status } or { parsed }. */
export function checkSignParams(signParams, policy) {
  if (typeof signParams !== "string") return { status: 400, error: "signParams must be a string" };
  if (signParams.length > 8_000) return { status: 413, error: "signParams too large" };
  let parsed;
  try {
    parsed = JSON.parse(signParams);
  } catch {
    return { status: 400, error: "signParams is not valid JSON" };
  }
  const reason = rejectReason(parsed, policy);
  return reason ? { status: 400, error: reason } : { parsed };
}
