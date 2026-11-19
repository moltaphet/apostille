const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const TIERS = require("../config/tiers");
const SOURCES = require("../config/sources").map(({ templateId, ...s }) => s);

const DELAY = 48 * 3600;
const FIELDS = [
  { keyName: "userId", parseType: "", parsePath: "$.data.userId" },
  { keyName: "vipLevel", parseType: "", parsePath: "$.data.vipLevel" },
  { keyName: "spot30dVol", parseType: "", parsePath: "$.data.spot30dVol" },
  { keyName: "futures30dVol", parseType: "", parsePath: "$.data.futures30dVol" },
];

// Same encoding as PrimusZKTLS / the SDK (see AttestorVerifier.test.js).
function encode(a) {
  const req = ethers.keccak256(ethers.solidityPacked(["string", "string", "string", "string"], [a.request.url, a.request.header, a.request.method, a.request.body]));
  let packed = "0x";
  for (const r of a.reponseResolve) packed = ethers.solidityPacked(["bytes", "string", "string", "string"], [packed, r.keyName, r.parseType, r.parsePath]);
  return ethers.keccak256(
    ethers.solidityPacked(
      ["address", "bytes32", "bytes32", "string", "string", "uint64", "string"],
      [a.recipient, req, ethers.keccak256(packed), a.data, a.attConditions, a.timestamp, a.additionParams]
    )
  );
}

async function deploy() {
  const [deployer, alice, guardian, mallory] = await ethers.getSigners();
  const attestor = ethers.Wallet.createRandom();
  const verifier = await ethers.deployContract("AttestorVerifier", [deployer.address, [attestor.address]]);
  const apostille = await ethers.deployContract("Apostille", [deployer.address, await verifier.getAddress(), 900, 30 * 86400, TIERS, SOURCES]);

  // deployer proposes/executes through a 48h timelock that owns both contracts
  const timelock = await ethers.deployContract("TimelockController", [DELAY, [deployer.address], [deployer.address], ethers.ZeroAddress]);
  await apostille.setGuardian(guardian.address);
  for (const c of [apostille, verifier]) await c.transferOwnership(await timelock.getAddress());

  const schedule = async (target, data, salt) => {
    const args = [await target.getAddress(), 0, data, ethers.ZeroHash, salt];
    await timelock.schedule(...args, DELAY);
    return () => timelock.execute(...args);
  };
  // accepting ownership itself goes through the delay
  const acceptA = await schedule(apostille, apostille.interface.encodeFunctionData("acceptOwnership"), ethers.id("a"));
  const acceptV = await schedule(verifier, verifier.interface.encodeFunctionData("acceptOwnership"), ethers.id("v"));
  await time.increase(DELAY);
  await acceptA();
  await acceptV();

  const signedAtt = async (recipient, data) => {
    const att = {
      recipient,
      request: { url: SOURCES[0].url, header: "", method: "GET", body: "" },
      reponseResolve: FIELDS,
      data,
      attConditions: JSON.stringify([{ op: "SHA256", field: "$.data.userId", reveal_id: "userId" }]),
      timestamp: BigInt(await time.latest()) * 1000n,
      additionParams: "",
      attestors: [{ attestorAddr: attestor.address, url: "" }],
      signatures: [],
    };
    att.signatures = [attestor.signingKey.sign(encode(att)).serialized];
    return att;
  };
  const okData = JSON.stringify({ spot30dVol: "0", futures30dVol: "12000000", vipLevel: "2", "SHA256($.data.userId)": "e".repeat(64) });
  return { deployer, alice, guardian, mallory, attestor, verifier, apostille, timelock, schedule, signedAtt, okData };
}

describe("governance", () => {
  it("puts both contracts behind the timelock", async () => {
    const { apostille, verifier, timelock } = await loadFixture(deploy);
    expect(await apostille.owner()).to.equal(await timelock.getAddress());
    expect(await verifier.owner()).to.equal(await timelock.getAddress());
  });

  it("blocks direct admin calls once the timelock owns the contracts", async () => {
    const { apostille, verifier, deployer, mallory } = await loadFixture(deploy);
    await expect(apostille.connect(deployer).setPrimus(mallory.address)).to.be.revertedWithCustomError(apostille, "OwnableUnauthorizedAccount");
    await expect(verifier.connect(deployer).addAttestor(mallory.address)).to.be.revertedWithCustomError(verifier, "OwnableUnauthorizedAccount");
  });

  it("only applies a verifier swap after the delay", async () => {
    const { apostille, timelock, schedule, mallory } = await loadFixture(deploy);
    const run = await schedule(apostille, apostille.interface.encodeFunctionData("setPrimus", [mallory.address]), ethers.id("swap"));
    await expect(run()).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
    await time.increase(DELAY);
    await run();
    expect(await apostille.primus()).to.equal(mallory.address);
  });

  it("lets anyone watch, and the proposer cancel, a queued change", async () => {
    const { apostille, timelock, mallory } = await loadFixture(deploy);
    const data = apostille.interface.encodeFunctionData("setPrimus", [mallory.address]);
    const args = [await apostille.getAddress(), 0, data, ethers.ZeroHash, ethers.id("evil")];
    await expect(timelock.schedule(...args, DELAY)).to.emit(timelock, "CallScheduled");
    const id = await timelock.hashOperation(...args);
    await timelock.cancel(id);
    await time.increase(DELAY);
    await expect(timelock.execute(...args)).to.be.revertedWithCustomError(timelock, "TimelockUnexpectedOperationState");
  });

  it("lets the guardian pause sealing and disable a source, but not undo either", async () => {
    const { apostille, guardian, alice, signedAtt, okData } = await loadFixture(deploy);
    await expect(apostille.connect(guardian).pause()).to.emit(apostille, "Paused").withArgs(guardian.address);
    await expect(apostille.connect(alice).seal(await signedAtt(alice.address, okData))).to.be.revertedWithCustomError(apostille, "SealingPaused");
    await expect(apostille.connect(guardian).unpause()).to.be.revertedWithCustomError(apostille, "OwnableUnauthorizedAccount");
    await apostille.connect(guardian).disableSource(0);
    expect((await apostille.sources())[0].enabled).to.equal(false);
    await expect(apostille.connect(guardian).setSourceEnabled(0, true)).to.be.revertedWithCustomError(apostille, "OwnableUnauthorizedAccount");
  });

  it("keeps existing seals readable while paused", async () => {
    const { apostille, guardian, alice, signedAtt, okData } = await loadFixture(deploy);
    await apostille.connect(alice).seal(await signedAtt(alice.address, okData));
    await apostille.connect(guardian).pause();
    expect(await apostille.tierOf(alice.address)).to.deep.equal([true, 2n, 2000n]);
  });

  it("rejects strangers on guardian actions", async () => {
    const { apostille, mallory } = await loadFixture(deploy);
    await expect(apostille.connect(mallory).pause()).to.be.revertedWithCustomError(apostille, "NotGuardian");
    await expect(apostille.connect(mallory).disableSource(0)).to.be.revertedWithCustomError(apostille, "NotGuardian");
  });

  describe("payload shape (encodePacked boundary shifts)", () => {
    it("rejects bytes shifted from data into the conditions, even with a valid signature", async () => {
      const { apostille, verifier, alice, signedAtt, okData } = await loadFixture(deploy);
      const att = await signedAtt(alice.address, okData);
      // Move the closing brace of data to the front of attConditions: same packed bytes,
      // so the attestor signature still verifies...
      const shifted = { ...att, data: att.data.slice(0, -1), attConditions: "}" + att.attConditions };
      await verifier.verifyAttestation(shifted);
      // ...but Apostille refuses the shape.
      await expect(apostille.connect(alice).seal(shifted)).to.be.revertedWithCustomError(apostille, "MalformedPayload");
    });

    it("rejects conditions that aren't a single array", async () => {
      const { apostille, alice, signedAtt, okData } = await loadFixture(deploy);
      const att = await signedAtt(alice.address, okData);
      const shifted = { ...att, data: att.data + "[", attConditions: att.attConditions.slice(1) };
      await expect(apostille.connect(alice).seal(shifted)).to.be.revertedWithCustomError(apostille, "MalformedPayload");
    });

    it("still accepts the untouched attestation", async () => {
      const { apostille, alice, signedAtt, okData } = await loadFixture(deploy);
      await apostille.connect(alice).seal(await signedAtt(alice.address, okData));
      expect(await apostille.isActive(alice.address)).to.equal(true);
    });
  });
});
