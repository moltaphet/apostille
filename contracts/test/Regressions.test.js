const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const TIERS = require("../config/tiers");
const SOURCES = require("../config/sources").map(({ templateId, ...s }) => s);
const URL = SOURCES[0].url;
const FIELDS = [
  { keyName: "userId", parseType: "", parsePath: "$.data.userId" },
  { keyName: "vipLevel", parseType: "", parsePath: "$.data.vipLevel" },
  { keyName: "spot30dVol", parseType: "", parsePath: "$.data.spot30dVol" },
  { keyName: "futures30dVol", parseType: "", parsePath: "$.data.futures30dVol" },
];
const H = "a".repeat(64);
async function att(recipient, { conds, data, fields = FIELDS }) {
  const now = BigInt(await time.latest());
  return {
    recipient, request: { url: URL, header: "", method: "GET", body: "" }, reponseResolve: fields,
    data: typeof data === "string" ? data : JSON.stringify(data), attConditions: JSON.stringify(conds),
    timestamp: now * 1000n, additionParams: "", attestors: [], signatures: ["0x" + "11".repeat(65)],
  };
}
async function deploy() {
  const [owner, alice] = await ethers.getSigners();
  const primus = await ethers.deployContract("MockPrimusZKTLS");
  const apostille = await ethers.deployContract("Apostille", [owner.address, await primus.getAddress(), 900, 30 * 86400, TIERS, SOURCES]);
  return { apostille, owner, alice };
}
const id = { op: "SHA256", field: "$.data.userId", reveal_id: "userId" };
describe("regressions: key collisions and fail-open fees", () => {
  it("shared reveal_id lifts a true vip>=0 result onto a futures>=250M condition", async () => {
    const { apostille, alice } = await loadFixture(deploy);
    const conds = [id,
      { op: ">=", field: "$.data.vipLevel", value: "0", reveal_id: "x" },
      { op: ">=", field: "$.data.spot30dVol", value: "0", reveal_id: "s" },
      { op: ">=", field: "$.data.futures30dVol", value: "250000000", reveal_id: "x" }];
    // attestor writes both results under "x": vip first (true), futures second (false)
    const data = `{"x":"true","s":"true","x":"false","SHA256($.data.userId)":"${H}"}`;
    await expect(apostille.connect(alice).seal(await att(alice.address, { conds, data })))
      .to.be.revertedWithCustomError(apostille, "AmbiguousKey").withArgs("x");
  });
  it("reveal_id pointing at a revealed field's value '1'", async () => {
    const { apostille, alice } = await loadFixture(deploy);
    const conds = [id, { op: ">=", field: "$.data.futures30dVol", value: "250000000", reveal_id: "vipLevel" }];
    // VIP1 user, attestor dedups keys -> vipLevel holds the plain value "1"
    const data = { vipLevel: "1", spot30dVol: "0", "SHA256($.data.userId)": H };
    await expect(apostille.connect(alice).seal(await att(alice.address, { conds, data })))
      .to.be.revertedWithCustomError(apostille, "AmbiguousKey").withArgs("vipLevel");
  });
  it("ApostilleFees with an EOA / codeless registry", async () => {
    const [owner, alice] = await ethers.getSigners();
    const usd = await ethers.deployContract("DemoUSD");
    const perp = await ethers.deployContract("DemoPerp", [owner.address, await usd.getAddress(), owner.address, owner.address, 500, 5000]);
    // owner.address has no code: the base fee must apply instead of a revert
    expect(await perp.quote(alice.address, 1_000_000n)).to.deep.equal([500n, 500n, 0n]);
  });
  it("rejects a duplicated key even when the figures use distinct keys", async () => {
    const { apostille, alice } = await loadFixture(deploy);
    const conds = [id];
    const data = `{"vipLevel":"0","vipLevel":"9","spot30dVol":"0","futures30dVol":"0","SHA256($.data.userId)":"${H}"}`;
    await expect(apostille.connect(alice).seal(await att(alice.address, { conds, data })))
      .to.be.revertedWithCustomError(apostille, "MalformedPayload");
  });
  it("rejects an extra key in the data", async () => {
    const { apostille, alice } = await loadFixture(deploy);
    const data = { vipLevel: "0", spot30dVol: "0", futures30dVol: "0", extra: "true", "SHA256($.data.userId)": H };
    await expect(apostille.connect(alice).seal(await att(alice.address, { conds: [id], data })))
      .to.be.revertedWithCustomError(apostille, "MalformedPayload");
  });
  it("still accepts whitespace-formatted data", async () => {
    const { apostille, alice } = await loadFixture(deploy);
    const data = `{ "vipLevel" : "2", "spot30dVol" : "1", "futures30dVol" : "5", "SHA256($.data.userId)" : "${H}" }`;
    await apostille.connect(alice).seal(await att(alice.address, { conds: [id], data }));
    expect((await apostille.sealOf(alice.address)).tier).to.equal(2);
  });
});
