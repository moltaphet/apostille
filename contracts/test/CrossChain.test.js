const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const TIERS = require("../config/tiers");
const SOURCES = require("../config/sources").map(({ templateId, ...s }) => s);

const SOURCE_URL =
  "https://www.binance.com/bapi/accounts/v1/private/vip/vip-portal/vip-fee/vip-fee-summary";
const HUB_DOMAIN = 97;
const BASE = 84532;
const ARB = 421614;
const FEE = ethers.parseEther("0.001");
const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const acct = (hash) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bytes32"], [0, "0x" + hash]));

async function attestation(recipient, { userId = ACCOUNT_A, vipLevel = "0", futures = "0" } = {}) {
  const now = BigInt(await time.latest());
  return {
    recipient,
    request: { url: SOURCE_URL, header: "", method: "GET", body: "" },
    reponseResolve: [
      { keyName: "userId", parseType: "", parsePath: "$.data.userId" },
      { keyName: "vipLevel", parseType: "", parsePath: "$.data.vipLevel" },
      { keyName: "spot30dVol", parseType: "", parsePath: "$.data.spot30dVol" },
      { keyName: "futures30dVol", parseType: "", parsePath: "$.data.futures30dVol" },
    ],
    data: JSON.stringify({ spot30dVol: "0", futures30dVol: futures, vipLevel, "SHA256($.data.userId)": userId }),
    attConditions: JSON.stringify([{ op: "SHA256", field: "$.data.userId", reveal_id: "userId" }]),
    timestamp: now * 1000n,
    additionParams: "",
    attestors: [{ attestorAddr: ethers.ZeroAddress, url: "https://primuslabs.xyz" }],
    signatures: ["0x" + "11".repeat(65)],
  };
}

async function deploy() {
  const [owner, alice, bob, mallory] = await ethers.getSigners();
  const primus = await ethers.deployContract("MockPrimusZKTLS");
  const mailbox = await ethers.deployContract("MockMailbox", [HUB_DOMAIN, FEE]);
  const hub = await ethers.deployContract("Apostille", [owner.address, await primus.getAddress(), 900, 30 * 86400, TIERS, SOURCES]);
  // Both spokes share the mock mailbox; it delivers messages as if they came from the hub's domain.
  const base = await ethers.deployContract("ApostilleSpoke", [owner.address, await mailbox.getAddress(), HUB_DOMAIN, await hub.getAddress()]);
  const arb = await ethers.deployContract("ApostilleSpoke", [owner.address, await mailbox.getAddress(), HUB_DOMAIN, await hub.getAddress()]);
  await hub.setMailbox(await mailbox.getAddress());
  await hub.addSpoke(BASE, await base.getAddress());
  await hub.addSpoke(ARB, await arb.getAddress());
  return { hub, base, arb, mailbox, owner, alice, bob, mallory };
}

async function deliverAll(mailbox) {
  const n = await mailbox.count();
  for (let i = 0n; i < n; i++) {
    const m = await mailbox.messages(i);
    if (!m.delivered) await mailbox.deliver(i, HUB_DOMAIN);
  }
}

describe("cross-chain (hub and spokes)", () => {
  it("quotes one fee per spoke", async () => {
    const { hub } = await loadFixture(deploy);
    expect(await hub.quoteBroadcast()).to.equal(FEE * 2n);
  });

  it("mirrors a seal to every spoke, with the same tier and discount", async () => {
    const { hub, base, arb, mailbox, alice } = await loadFixture(deploy);
    await hub.connect(alice).seal(await attestation(alice.address, { vipLevel: "4" }), { value: FEE * 2n });
    expect(await mailbox.count()).to.equal(2n);
    await deliverAll(mailbox);

    const want = await hub.tierOf(alice.address);
    expect(want.active).to.equal(true);
    for (const spoke of [base, arb]) {
      const got = await spoke.tierOf(alice.address);
      expect([got.active, got.tier, got.discountBps]).to.deep.equal([want.active, want.tier, want.discountBps]);
      expect((await spoke.sealOf(alice.address)).account).to.equal(acct(ACCOUNT_A));
    }
  });

  it("refuses a seal that underpays the messaging fee, and refunds overpayment", async () => {
    const { hub, alice } = await loadFixture(deploy);
    await expect(hub.connect(alice).seal(await attestation(alice.address), { value: FEE }))
      .to.be.revertedWithCustomError(hub, "InsufficientFee");
    const att = await attestation(alice.address);
    await expect(hub.connect(alice).seal(att, { value: FEE * 5n })).to.changeEtherBalance(alice, -(FEE * 2n));
  });

  it("works without spokes, and refunds any value sent", async () => {
    const { hub, alice } = await loadFixture(deploy);
    await hub.removeSpoke(BASE);
    await hub.removeSpoke(ARB);
    expect(await hub.quoteBroadcast()).to.equal(0n);
    await expect(hub.connect(alice).seal(await attestation(alice.address), { value: FEE })).to.changeEtherBalance(alice, 0);
  });

  it("drops the mirrored seal when the holder releases on the hub", async () => {
    const { hub, base, mailbox, alice } = await loadFixture(deploy);
    await hub.connect(alice).seal(await attestation(alice.address), { value: FEE * 2n });
    await deliverAll(mailbox);
    await hub.connect(alice).release({ value: FEE * 2n });
    await deliverAll(mailbox);
    expect(await base.isActive(alice.address)).to.equal(false);
    expect(await base.walletOf(acct(ACCOUNT_A))).to.equal(ethers.ZeroAddress);
  });

  it("keeps one account = one wallet across chains when the account moves", async () => {
    const { hub, base, mailbox, alice, bob } = await loadFixture(deploy);
    await hub.connect(alice).seal(await attestation(alice.address), { value: FEE * 2n });
    await deliverAll(mailbox);
    await hub.connect(alice).release({ value: FEE * 2n });
    await time.increase(1);
    await hub.connect(bob).seal(await attestation(bob.address), { value: FEE * 2n });
    await deliverAll(mailbox);
    expect(await base.isActive(alice.address)).to.equal(false);
    expect(await base.isActive(bob.address)).to.equal(true);
    expect(await base.walletOf(acct(ACCOUNT_A))).to.equal(bob.address);
  });

  it("converges on the hub's latest state when messages arrive out of order", async () => {
    const { hub, base, mailbox, alice } = await loadFixture(deploy);
    // messages: 0,1 seal A · 2,3 release · 4,5 seal again
    await hub.connect(alice).seal(await attestation(alice.address), { value: FEE * 2n });
    await hub.connect(alice).release({ value: FEE * 2n });
    await time.increase(1);
    await hub.connect(alice).seal(await attestation(alice.address, { vipLevel: "2" }), { value: FEE * 2n });
    // the spoke at index 0 (base) gets its messages newest first
    await mailbox.deliver(4, HUB_DOMAIN);
    await mailbox.deliver(2, HUB_DOMAIN);
    await mailbox.deliver(0, HUB_DOMAIN);
    const t = await base.tierOf(alice.address);
    expect(t.active).to.equal(true);
    expect(t.tier).to.equal(2);
  });

  it("does not let a stale message for an old account overwrite a wallet's newer account", async () => {
    const { hub, base, mailbox, alice } = await loadFixture(deploy);
    await hub.connect(alice).seal(await attestation(alice.address, { userId: ACCOUNT_A }), { value: FEE * 2n }); // 0,1
    await time.increase(1);
    await hub.connect(alice).seal(await attestation(alice.address, { userId: ACCOUNT_B }), { value: FEE * 2n }); // 2,3
    await mailbox.deliver(2, HUB_DOMAIN);
    await mailbox.deliver(0, HUB_DOMAIN);
    expect((await base.sealOf(alice.address)).account).to.equal(acct(ACCOUNT_B));
    expect(await base.walletOf(acct(ACCOUNT_A))).to.equal(ethers.ZeroAddress);
  });

  it("accepts messages only from its mailbox and only from the hub", async () => {
    const { hub, base, mailbox, mallory } = await loadFixture(deploy);
    const body = "0x";
    await expect(base.connect(mallory).handle(HUB_DOMAIN, ethers.zeroPadValue(await hub.getAddress(), 32), body))
      .to.be.revertedWithCustomError(base, "NotMailbox");
    await expect(mailbox.deliverRaw(await base.getAddress(), HUB_DOMAIN, ethers.zeroPadValue(mallory.address, 32), body))
      .to.be.revertedWithCustomError(base, "NotHub");
    await expect(mailbox.deliverRaw(await base.getAddress(), 1, ethers.zeroPadValue(await hub.getAddress(), 32), body))
      .to.be.revertedWithCustomError(base, "NotHub");
  });

  it("lets anyone re-sync a wallet to the spokes", async () => {
    const { hub, base, mailbox, alice, bob } = await loadFixture(deploy);
    await hub.connect(alice).seal(await attestation(alice.address), { value: FEE * 2n });
    // messages 0,1 lost; a re-sync paid by someone else repairs the mirror
    await hub.connect(bob).sync(alice.address, { value: FEE * 2n });
    await mailbox.deliver(2, HUB_DOMAIN);
    expect(await base.isActive(alice.address)).to.equal(true);
    await expect(hub.sync(bob.address, { value: FEE * 2n })).to.be.revertedWithCustomError(hub, "NoActiveSeal");
  });

  it("expires on the spoke at the same time as on the hub", async () => {
    const { hub, base, mailbox, alice } = await loadFixture(deploy);
    await hub.connect(alice).seal(await attestation(alice.address), { value: FEE * 2n });
    await deliverAll(mailbox);
    await time.increase(30 * 86400 + 1);
    expect(await hub.isActive(alice.address)).to.equal(false);
    expect(await base.isActive(alice.address)).to.equal(false);
  });

  it("restricts spoke management to the owner", async () => {
    const { hub, base, mallory } = await loadFixture(deploy);
    await expect(hub.connect(mallory).addSpoke(1, mallory.address)).to.be.revertedWithCustomError(hub, "OwnableUnauthorizedAccount");
    await expect(hub.addSpoke(BASE, mallory.address)).to.be.revertedWithCustomError(hub, "InvalidSpoke");
    await expect(base.connect(mallory).setHub(mallory.address)).to.be.revertedWithCustomError(base, "OwnableUnauthorizedAccount");
  });
});
