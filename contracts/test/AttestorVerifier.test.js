const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const TIERS = require("../config/tiers");
const SOURCES = require("../config/sources").map(({ templateId, ...s }) => s);

const SOURCE_URL =
  "https://www.binance.com/bapi/accounts/v1/private/vip/vip-portal/vip-fee/vip-fee-summary";
const FIELDS = [
  { keyName: "userId", parseType: "", parsePath: "$.data.userId" },
  { keyName: "vipLevel", parseType: "", parsePath: "$.data.vipLevel" },
  { keyName: "spot30dVol", parseType: "", parsePath: "$.data.spot30dVol" },
  { keyName: "futures30dVol", parseType: "", parsePath: "$.data.futures30dVol" },
];

// Off-chain encoding, written exactly as @primuslabs/zktls-js-sdk's encodeAttestation.
function encodeAttestation(a) {
  const req = ethers.keccak256(
    ethers.solidityPacked(["string", "string", "string", "string"], [a.request.url, a.request.header, a.request.method, a.request.body])
  );
  let packed = "0x";
  for (const r of a.reponseResolve) {
    packed = ethers.solidityPacked(["bytes", "string", "string", "string"], [packed, r.keyName, r.parseType, r.parsePath]);
  }
  const res = ethers.keccak256(packed);
  return ethers.keccak256(
    ethers.solidityPacked(
      ["address", "bytes32", "bytes32", "string", "string", "uint64", "string"],
      [a.recipient, req, res, a.data, a.attConditions, a.timestamp, a.additionParams]
    )
  );
}

async function signed(attestorKey, recipient, data) {
  const now = BigInt(await time.latest());
  const att = {
    recipient,
    request: { url: SOURCE_URL, header: "", method: "GET", body: "" },
    reponseResolve: FIELDS,
    data: JSON.stringify({ spot30dVol: "100.00000000", futures30dVol: "12000000.00000000", vipLevel: "2", "SHA256($.data.userId)": "c".repeat(64), ...data }),
    attConditions: JSON.stringify([{ op: "SHA256", field: "$.data.userId", reveal_id: "userId" }]),
    timestamp: now * 1000n,
    additionParams: JSON.stringify({ algorithmType: "proxytls" }),
    attestors: [{ attestorAddr: attestorKey.address, url: "https://primuslabs.xyz" }],
    signatures: [],
  };
  att.signatures = [attestorKey.signingKey.sign(encodeAttestation(att)).serialized];
  return att;
}

async function deploy() {
  const [owner, alice, mallory] = await ethers.getSigners();
  const attestor = ethers.Wallet.createRandom();
  const verifier = await ethers.deployContract("AttestorVerifier", [owner.address, [attestor.address]]);
  const apostille = await ethers.deployContract("Apostille", [owner.address, await verifier.getAddress(), 900, 30 * 86400, TIERS, SOURCES]);
  return { owner, alice, mallory, attestor, verifier, apostille };
}

describe("AttestorVerifier", () => {
  it("matches the SDK encoding byte for byte", async () => {
    const { verifier, attestor, alice } = await loadFixture(deploy);
    const att = await signed(attestor, alice.address);
    expect(await verifier.encodeAttestation(att)).to.equal(encodeAttestation(att));
  });

  it("accepts a real signature from a registered attestor", async () => {
    const { verifier, attestor, alice } = await loadFixture(deploy);
    await verifier.verifyAttestation(await signed(attestor, alice.address));
  });

  it("rejects an unregistered signer", async () => {
    const { verifier, alice } = await loadFixture(deploy);
    const stranger = ethers.Wallet.createRandom();
    await expect(verifier.verifyAttestation(await signed(stranger, alice.address)))
      .to.be.revertedWithCustomError(verifier, "UnknownAttestor")
      .withArgs(stranger.address);
  });

  it("rejects any tampering with the signed payload", async () => {
    const { verifier, attestor, alice } = await loadFixture(deploy);
    const att = await signed(attestor, alice.address);
    const tampered = { ...att, data: att.data.replace('"futures30dVol":"12000000.00000000"', '"futures30dVol":"999000000.00000000"') };
    await expect(verifier.verifyAttestation(tampered)).to.be.revertedWithCustomError(verifier, "UnknownAttestor");
  });

  it("rejects malformed signature sets", async () => {
    const { verifier, attestor, alice } = await loadFixture(deploy);
    const att = await signed(attestor, alice.address);
    await expect(verifier.verifyAttestation({ ...att, signatures: [] })).to.be.revertedWithCustomError(verifier, "InvalidSignatureCount");
    await expect(verifier.verifyAttestation({ ...att, signatures: ["0x1234"] })).to.be.revertedWithCustomError(verifier, "InvalidSignatureLength");
  });

  it("lets only the owner manage attestors", async () => {
    const { verifier, attestor, mallory, alice } = await loadFixture(deploy);
    await expect(verifier.connect(mallory).addAttestor(mallory.address)).to.be.revertedWithCustomError(verifier, "OwnableUnauthorizedAccount");
    await verifier.removeAttestor(attestor.address);
    expect(await verifier.attestors()).to.deep.equal([]);
    await expect(verifier.verifyAttestation(await signed(attestor, alice.address))).to.be.revertedWithCustomError(verifier, "UnknownAttestor");
  });

  it("seals end to end with a genuinely signed attestation", async () => {
    const { apostille, attestor, alice } = await loadFixture(deploy);
    await apostille.connect(alice).seal(await signed(attestor, alice.address));
    expect(await apostille.tierOf(alice.address)).to.deep.equal([true, 2n, 2000n]);
  });

  it("lets an existing Apostille switch to this verifier", async () => {
    const { owner, alice, attestor, verifier } = await loadFixture(deploy);
    const mock = await ethers.deployContract("MockPrimusZKTLS");
    const apostille = await ethers.deployContract("Apostille", [owner.address, await mock.getAddress(), 900, 30 * 86400, TIERS, SOURCES]);
    await apostille.setPrimus(await verifier.getAddress());
    const forged = await signed(ethers.Wallet.createRandom(), alice.address);
    await expect(apostille.connect(alice).seal(forged)).to.be.revertedWithCustomError(verifier, "UnknownAttestor");
    await apostille.connect(alice).seal(await signed(attestor, alice.address));
    expect(await apostille.isActive(alice.address)).to.equal(true);
  });
});
