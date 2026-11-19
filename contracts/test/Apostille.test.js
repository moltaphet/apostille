const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const TIERS = require("../config/tiers");

const SOURCE_URL =
  "https://www.binance.com/bapi/accounts/v1/private/vip/vip-portal/vip-fee/vip-fee-summary";
const MAX_AGE = 15 * 60; // 15 minutes
const VALIDITY = 30 * 24 * 60 * 60; // 30 days

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);

const FIELDS = [
  { keyName: "userId", parseType: "", parsePath: "$.data.userId" },
  { keyName: "vipLevel", parseType: "", parsePath: "$.data.vipLevel" },
  { keyName: "spot30dVol", parseType: "", parsePath: "$.data.spot30dVol" },
  { keyName: "futures30dVol", parseType: "", parsePath: "$.data.futures30dVol" },
];

async function attestation(recipient, overrides = {}) {
  const now = BigInt(await time.latest());
  const data = {
    userId: ACCOUNT_A,
    vipLevel: "0",
    spot30dVol: "0",
    futures30dVol: "0",
    ...(overrides.data || {}),
  };
  return {
    recipient,
    request: { url: overrides.url || SOURCE_URL, header: "", method: "GET", body: "" },
    reponseResolve: overrides.fields || FIELDS,
    data: overrides.rawData ?? JSON.stringify(data),
    attConditions: JSON.stringify([[{ field: "userId", op: "SHA256" }]]),
    timestamp: overrides.timestampMs ?? now * 1000n,
    additionParams: "",
    attestors: [{ attestorAddr: ethers.ZeroAddress, url: "https://primuslabs.xyz" }],
    signatures: ["0x" + "11".repeat(65)],
  };
}

async function deploy() {
  const [owner, alice, bob, mallory] = await ethers.getSigners();
  const primus = await ethers.deployContract("MockPrimusZKTLS");
  const apostille = await ethers.deployContract("Apostille", [
    owner.address,
    await primus.getAddress(),
    MAX_AGE,
    VALIDITY,
    TIERS,
  ]);
  return { apostille, primus, owner, alice, bob, mallory };
}

describe("Apostille", () => {
  describe("sealing", () => {
    it("issues a seal from a valid attestation", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      const att = await attestation(alice.address, {
        data: { vipLevel: "2", spot30dVol: "8421337.55", futures30dVol: "12500000.01" },
      });

      await expect(apostille.connect(alice).seal(att))
        .to.emit(apostille, "Sealed")
        .withArgs(alice.address, "0x" + ACCOUNT_A, 2, 2, 12_500_000n, 8_421_337n, (v) => v > 0n);

      const s = await apostille.sealOf(alice.address);
      expect(s.vipLevel).to.equal(2);
      expect(s.tier).to.equal(2);
      expect(s.futures30dVolume).to.equal(12_500_000n);
      expect(s.spot30dVolume).to.equal(8_421_337n);

      const [active, tier, bps] = await apostille.tierOf(alice.address);
      expect(active).to.equal(true);
      expect(tier).to.equal(2);
      expect(bps).to.equal(2000);
    });

    it("qualifies on volume alone when VIP level is lower", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address, { data: { futures30dVol: "75000000" } }));
      expect((await apostille.sealOf(alice.address)).tier).to.equal(3);
    });

    it("qualifies on VIP level alone when volume is lower", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address, { data: { vipLevel: "7" } }));
      expect((await apostille.sealOf(alice.address)).tier).to.equal(4);
    });

    it("parses scientific-notation volumes", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address, { data: { futures30dVol: "1.5E7" } }));
      expect((await apostille.sealOf(alice.address)).futures30dVolume).to.equal(15_000_000n);
    });

    it("accepts bare (unquoted) numeric values and a 0x-prefixed hash", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      const rawData = `{"userId":"0x${ACCOUNT_A}","vipLevel":1,"spot30dVol":0,"futures30dVol":2000000}`;
      await apostille.connect(alice).seal(await attestation(alice.address, { rawData }));
      const s = await apostille.sealOf(alice.address);
      expect(s.tier).to.equal(1);
      expect(s.accountHash).to.equal("0x" + ACCOUNT_A);
    });
  });

  describe("verification", () => {
    it("reverts when Primus rejects the signature", async () => {
      const { apostille, primus, alice } = await loadFixture(deploy);
      await primus.setReject(true);
      await expect(apostille.connect(alice).seal(await attestation(alice.address))).to.be.revertedWith(
        "Invalid signature"
      );
    });

    it("rejects a proof issued to another wallet", async () => {
      const { apostille, alice, mallory } = await loadFixture(deploy);
      const att = await attestation(alice.address);
      await expect(apostille.connect(mallory).seal(att))
        .to.be.revertedWithCustomError(apostille, "RecipientMismatch")
        .withArgs(alice.address, mallory.address);
    });

    it("rejects any other endpoint, including path suffixes", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      for (const url of [
        "https://www.binance.com/bapi/accounts/v1/private/vip/vip-portal/vip-fee/vip-programs-and-fees",
        SOURCE_URL + "-evil",
        "https://evil.example/" + SOURCE_URL,
      ]) {
        await expect(apostille.connect(alice).seal(await attestation(alice.address, { url }))).to.be.revertedWithCustomError(
          apostille,
          "UnexpectedSource"
        );
      }
    });

    it("allows a query string on the source endpoint", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address, { url: SOURCE_URL + "?lang=en" }));
      expect(await apostille.isActive(alice.address)).to.equal(true);
    });

    it("rejects a field mapped from an unexpected json path", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      const fields = FIELDS.map((f) =>
        f.keyName === "futures30dVol" ? { ...f, parsePath: "$.data.bnbBalance" } : f
      );
      await expect(apostille.connect(alice).seal(await attestation(alice.address, { fields })))
        .to.be.revertedWithCustomError(apostille, "UnexpectedField")
        .withArgs("futures30dVol");
    });

    it("rejects a raw (unhashed) Binance user id", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await expect(
        apostille.connect(alice).seal(await attestation(alice.address, { data: { userId: "254280126" } }))
      ).to.be.revertedWithCustomError(apostille, "InvalidHex");
    });

    it("rejects stale attestations", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      const att = await attestation(alice.address);
      await time.increase(MAX_AGE + 1);
      await expect(apostille.connect(alice).seal(att)).to.be.revertedWithCustomError(apostille, "StaleAttestation");
    });

    it("rejects attestations dated in the future", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      const now = BigInt(await time.latest());
      const att = await attestation(alice.address, { timestampMs: (now + 3600n) * 1000n });
      await expect(apostille.connect(alice).seal(att)).to.be.revertedWithCustomError(apostille, "AttestationFromFuture");
    });

    it("rejects replaying the same attestation", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      const att = await attestation(alice.address);
      await apostille.connect(alice).seal(att);
      await expect(apostille.connect(alice).seal(att)).to.be.revertedWithCustomError(apostille, "ReplayedAttestation");
    });
  });

  describe("account binding", () => {
    it("binds one exchange account to one wallet", async () => {
      const { apostille, alice, bob } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address));
      await time.increase(1);
      await expect(apostille.connect(bob).seal(await attestation(bob.address)))
        .to.be.revertedWithCustomError(apostille, "AccountBoundElsewhere")
        .withArgs(alice.address);
      expect(await apostille.walletOf("0x" + ACCOUNT_A)).to.equal(alice.address);
    });

    it("lets another wallet reclaim the account after the seal lapses", async () => {
      const { apostille, alice, bob } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address));
      await time.increase(VALIDITY + 1);
      await expect(apostille.connect(bob).seal(await attestation(bob.address)))
        .to.emit(apostille, "Released")
        .withArgs(alice.address, "0x" + ACCOUNT_A);
      expect(await apostille.walletOf("0x" + ACCOUNT_A)).to.equal(bob.address);
      expect(await apostille.isActive(alice.address)).to.equal(false);
    });

    it("lets the holder release and move the account voluntarily", async () => {
      const { apostille, alice, bob } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address));
      await apostille.connect(alice).release();
      await time.increase(1);
      await apostille.connect(bob).seal(await attestation(bob.address));
      expect(await apostille.walletOf("0x" + ACCOUNT_A)).to.equal(bob.address);
    });

    it("frees the previous account when a wallet switches accounts", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address));
      await time.increase(1);
      await apostille.connect(alice).seal(await attestation(alice.address, { data: { userId: ACCOUNT_B } }));
      expect(await apostille.walletOf("0x" + ACCOUNT_A)).to.equal(ethers.ZeroAddress);
      expect(await apostille.walletOf("0x" + ACCOUNT_B)).to.equal(alice.address);
    });

    it("renews a seal with a newer attestation", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address));
      await time.increase(60);
      await apostille.connect(alice).seal(await attestation(alice.address, { data: { vipLevel: "4" } }));
      expect((await apostille.sealOf(alice.address)).tier).to.equal(3);
    });

    it("reports an expired seal as inactive", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address, { data: { vipLevel: "2" } }));
      await time.increase(VALIDITY + 1);
      expect(await apostille.tierOf(alice.address)).to.deep.equal([false, 0n, 0n]);
    });

    it("reverts release without a seal", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await expect(apostille.connect(alice).release()).to.be.revertedWithCustomError(apostille, "NoActiveSeal");
    });
  });

  describe("administration", () => {
    it("restricts configuration to the owner", async () => {
      const { apostille, mallory } = await loadFixture(deploy);
      await expect(apostille.connect(mallory).setWindows(60, 60)).to.be.revertedWithCustomError(
        apostille,
        "OwnableUnauthorizedAccount"
      );
      await expect(apostille.connect(mallory).setTiers(TIERS)).to.be.revertedWithCustomError(
        apostille,
        "OwnableUnauthorizedAccount"
      );
      await expect(apostille.connect(mallory).setPrimus(mallory.address)).to.be.revertedWithCustomError(
        apostille,
        "OwnableUnauthorizedAccount"
      );
    });

    it("validates the tier table", async () => {
      const { apostille } = await loadFixture(deploy);
      await expect(apostille.setTiers([])).to.be.revertedWithCustomError(apostille, "InvalidTiers");
      await expect(apostille.setTiers([TIERS[1]])).to.be.revertedWithCustomError(apostille, "InvalidTiers");
      await expect(apostille.setTiers([TIERS[0], TIERS[2], TIERS[1]])).to.be.revertedWithCustomError(
        apostille,
        "InvalidTiers"
      );
      await expect(
        apostille.setTiers([TIERS[0], { ...TIERS[1], feeDiscountBps: 10_001 }])
      ).to.be.revertedWithCustomError(apostille, "InvalidTiers");
    });

    it("validates time windows", async () => {
      const { apostille } = await loadFixture(deploy);
      await expect(apostille.setWindows(0, VALIDITY)).to.be.revertedWithCustomError(apostille, "InvalidWindow");
      await expect(apostille.setWindows(MAX_AGE, 91 * 24 * 3600)).to.be.revertedWithCustomError(
        apostille,
        "InvalidWindow"
      );
    });

    it("previews tiers and exposes the table", async () => {
      const { apostille } = await loadFixture(deploy);
      expect(await apostille.previewTier(0, 0)).to.equal(0);
      expect(await apostille.previewTier(0, 10_000_000)).to.equal(2);
      expect(await apostille.previewTier(9, 0)).to.equal(4);
      const table = await apostille.tiers();
      expect(table.map((t) => t.name)).to.deep.equal(TIERS.map((t) => t.name));
    });

    it("clamps stored tiers if the table shrinks", async () => {
      const { apostille, alice } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await attestation(alice.address, { data: { vipLevel: "9" } }));
      await apostille.setTiers(TIERS.slice(0, 2));
      expect(await apostille.tierOf(alice.address)).to.deep.equal([true, 1n, 1000n]);
    });
  });
});
