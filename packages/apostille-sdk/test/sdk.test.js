import { test } from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, Interface } from "ethers";
import { APOSTILLE_ABI, feeOn, getTier, getSeal } from "../src/index.js";

const iface = new Interface(APOSTILLE_ABI);
const ADDR = "0x7EDa50410744a3e2B10a82016d8767f911cFD0B2";

/** Minimal ethers v6 runner that answers eth_call from a table. */
function fakeRunner(answers) {
  return {
    provider: null,
    async call(tx) {
      const { name } = iface.parseTransaction({ data: tx.data });
      if (answers[name] instanceof Error) throw answers[name];
      return iface.encodeFunctionResult(name, answers[name]);
    },
  };
}

test("feeOn mirrors ApostilleFees.feeOn", () => {
  const E = (n) => BigInt(n) * 10n ** 18n;
  assert.deepEqual(feeOn(E(1_000_000), 500n, { active: false, discountBps: 3500 }), { fee: E(500), ratePips: 500n });
  assert.deepEqual(feeOn(E(1_000_000), 500n, { active: true, discountBps: 3500 }), { fee: E(325), ratePips: 325n });
  assert.equal(feeOn(E(1_000_000), 500n, { active: true, discountBps: 9000 }, 5000).fee, E(250));
});

test("getTier decodes tierOf", async () => {
  const t = await getTier(fakeRunner({ tierOf: [true, 3, 3500] }), ADDR, { address: ADDR });
  assert.deepEqual(t, { active: true, tier: 3, discountBps: 3500 });
});

test("getTier fails open", async () => {
  const t = await getTier(fakeRunner({ tierOf: new Error("rpc down") }), ADDR, { address: ADDR });
  assert.equal(t.active, false);
  assert.equal(t.discountBps, 0);
  assert.ok(t.error);
});

test("getTier resolves known deployments by chain id", async () => {
  const t = await getTier(fakeRunner({ tierOf: [false, 0, 0] }), ADDR, { chainId: 97 });
  assert.equal(t.active, false);
  assert.equal(t.error, undefined);
});

test("getSeal returns null for unsealed wallets and decodes sealed ones", async () => {
  const zero = ["0x" + "0".repeat(64), 0, 0, 0, false, 0, 0, 0, 0];
  assert.equal(await getSeal(fakeRunner({ sealOf: [zero] }), ADDR, { address: ADDR }), null);
  const acct = "0x" + "ab".repeat(32);
  const s = await getSeal(fakeRunner({ sealOf: [[acct, 0, 2, 2, true, 1795000000, 1797592000, 0, 10_000_000]] }), ADDR, { address: ADDR });
  assert.equal(s.tier, 2);
  assert.equal(s.concealed, true);
  assert.equal(s.futures30dVolume, 10_000_000n);
  assert.ok(s.expiresAt instanceof Date);
});

test("ABI matches the compiled contract", async () => {
  const fs = await import("node:fs");
  const path = new URL("../../../contracts/artifacts/contracts/Apostille.sol/Apostille.json", import.meta.url);
  if (!fs.existsSync(path)) return; // contracts not compiled in this checkout
  const real = new Interface(JSON.parse(fs.readFileSync(path)).abi);
  for (const f of ["tierOf", "sealOf", "tiers", "isActive"]) {
    assert.equal(iface.getFunction(f).format(), real.getFunction(f).format(), f);
  }
  assert.equal(iface.getEvent("Sealed").topicHash, real.getEvent("Sealed").topicHash);
  void AbiCoder;
});
