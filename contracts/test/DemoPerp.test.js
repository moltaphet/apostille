const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const TIERS = require("../config/tiers");
const SOURCES = require("../config/sources").map(({ templateId, ...s }) => s);

const E = (n) => ethers.parseEther(String(n));
const BASE_PIPS = 500n; // 0.05%

async function deploy() {
  const [owner, alice, bob, treasury] = await ethers.getSigners();
  const usd = await ethers.deployContract("DemoUSD");
  const mock = await ethers.deployContract("MockApostille");
  const perp = await ethers.deployContract("DemoPerp", [owner.address, await usd.getAddress(), await mock.getAddress(), treasury.address, BASE_PIPS, 5000]);
  for (const s of [alice, bob]) {
    await usd.connect(s).faucet();
    await usd.connect(s).approve(await perp.getAddress(), ethers.MaxUint256);
    await perp.connect(s).deposit(E(10_000));
  }
  return { owner, alice, bob, treasury, usd, mock, perp };
}

describe("DemoPerp + ApostilleFees", () => {
  it("charges the base fee without a seal", async () => {
    const { perp, alice, usd, treasury } = await loadFixture(deploy);
    // 0.05% of 1,000,000 = 500
    await expect(perp.connect(alice).trade(E(1_000_000)))
      .to.emit(perp, "Traded")
      .withArgs(alice.address, E(1_000_000), E(1_000_000), E(500), BASE_PIPS, 0);
    expect(await usd.balanceOf(treasury.address)).to.equal(E(500));
    expect(await perp.margin(alice.address)).to.equal(E(9_500));
  });

  it("discounts the fee by the sealed tier", async () => {
    const { perp, mock, alice } = await loadFixture(deploy);
    await mock.set(alice.address, true, 3, 3500); // Gold: 35% off
    const [fee, pips, tier] = await perp.quote(alice.address, E(1_000_000));
    expect([fee, pips, tier]).to.deep.equal([E(325), 325n, 3n]);
    await perp.connect(alice).trade(-E(1_000_000)); // shorts pay on |size| too
    expect(await perp.position(alice.address)).to.equal(-E(1_000_000));
    expect(await perp.margin(alice.address)).to.equal(E(10_000) - E(325));
  });

  it("caps the discount at the protocol's maximum", async () => {
    const { perp, mock, alice } = await loadFixture(deploy);
    await mock.set(alice.address, true, 9, 9000); // asks for 90%, protocol caps at 50%
    expect((await perp.quote(alice.address, E(1_000_000)))[0]).to.equal(E(250));
  });

  it("ignores inactive seals", async () => {
    const { perp, mock, alice } = await loadFixture(deploy);
    await mock.set(alice.address, false, 4, 5000);
    expect((await perp.quote(alice.address, E(1_000_000)))[0]).to.equal(E(500));
  });

  it("fails open when the registry is down", async () => {
    const { perp, mock, alice } = await loadFixture(deploy);
    await mock.set(alice.address, true, 3, 3500);
    await mock.setBroken(true);
    await expect(perp.connect(alice).trade(E(1_000))).to.not.be.reverted;
    expect((await perp.quote(alice.address, E(1_000_000)))[0]).to.equal(E(500));
  });

  it("reverts when margin can't cover the fee, and on zero size", async () => {
    const { perp, alice } = await loadFixture(deploy);
    await expect(perp.connect(alice).trade(E(100_000_000))).to.be.revertedWithCustomError(perp, "InsufficientMargin");
    await expect(perp.connect(alice).trade(0)).to.be.revertedWithCustomError(perp, "ZeroAmount");
    await perp.connect(alice).withdraw(E(10_000));
    await expect(perp.connect(alice).withdraw(1)).to.be.revertedWithCustomError(perp, "InsufficientMargin");
  });

  it("only lets the owner change fees, capped at 1%", async () => {
    const { perp, alice } = await loadFixture(deploy);
    await expect(perp.connect(alice).setFees(1, 1)).to.be.revertedWithCustomError(perp, "OwnableUnauthorizedAccount");
    await expect(perp.setFees(10_001, 0)).to.be.revertedWithCustomError(perp, "FeeTooHigh");
  });

  it("works end to end against a real Apostille seal", async () => {
    const [owner, , , treasury] = await ethers.getSigners();
    const trader = (await ethers.getSigners())[5];
    const primus = await ethers.deployContract("MockPrimusZKTLS");
    const apostille = await ethers.deployContract("Apostille", [owner.address, await primus.getAddress(), 900, 30 * 86400, TIERS, SOURCES]);
    const usd = await ethers.deployContract("DemoUSD");
    const perp = await ethers.deployContract("DemoPerp", [owner.address, await usd.getAddress(), await apostille.getAddress(), treasury.address, BASE_PIPS, 5000]);

    const now = BigInt(await time.latest());
    await apostille.connect(trader).seal({
      recipient: trader.address,
      request: { url: SOURCES[0].url, header: "", method: "GET", body: "" },
      reponseResolve: [
        { keyName: "userId", parseType: "", parsePath: "$.data.userId" },
        { keyName: "vipLevel", parseType: "", parsePath: "$.data.vipLevel" },
        { keyName: "spot30dVol", parseType: "", parsePath: "$.data.spot30dVol" },
        { keyName: "futures30dVol", parseType: "", parsePath: "$.data.futures30dVol" },
      ],
      data: JSON.stringify({ spot30dVol: "0", futures30dVol: "12000000.5", vipLevel: "1", "SHA256($.data.userId)": "d".repeat(64) }),
      attConditions: JSON.stringify([{ op: "SHA256", field: "$.data.userId", reveal_id: "userId" }]),
      timestamp: now * 1000n,
      additionParams: "",
      attestors: [],
      signatures: ["0x" + "11".repeat(65)],
    });
    // Silver: 20% off 0.05% => 0.04% => 400 on 1,000,000
    expect((await perp.quote(trader.address, E(1_000_000)))[0]).to.equal(E(400));
  });
});
