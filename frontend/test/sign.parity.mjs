// Guards the hand-rolled signer in api/sign.js against drift from the Primus SDK.
import assert from "node:assert/strict";
import { PrimusZKTLS } from "@primuslabs/zktls-js-sdk";

const secret = "0x" + "ab".repeat(32);
process.env.PRIMUS_APP_ID = "app1";
process.env.PRIMUS_APP_SECRET = secret;
const { default: handler } = await import("../api/sign.js");

const params = JSON.stringify({
  appId: "app1", attTemplateID: "9e2dff87-3bfd-4a65-ad84-9eeb87d0f56e",
  userAddress: "0x000000000000000000000000000000000000dEaD", timestamp: Date.now(),
  attMode: { algorithmType: "proxytls", resultType: "plain" },
  attConditions: [[{ field: "userId", op: "SHA256" }]], computeMode: "normal", allJsonResponseFlag: "false", backUrl: "",
});

let out;
const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(o) { out = o; } };
await handler({ method: "POST", headers: {}, body: { signParams: params } }, res);
assert.equal(res.code, 200, JSON.stringify(out));

const sdk = new PrimusZKTLS();
await sdk.init("app1", secret);
assert.equal(out.signResult, await sdk.sign(params));
console.log("api/sign.js matches PrimusZKTLS.sign()");
