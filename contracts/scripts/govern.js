// Moves Apostille and its AttestorVerifier behind an OpenZeppelin TimelockController.
//
//   APOSTILLE=0x… VERIFIER=0x… GUARDIAN=0x… DELAY_HOURS=48 \
//   npx hardhat run scripts/govern.js --network bscTestnet
//
// Step 1 (this script): deploy the timelock, set the guardian, start the two-step ownership
// transfer of both contracts and schedule their acceptOwnership() through the timelock.
// Step 2 (after DELAY_HOURS): run with EXECUTE=1 to execute the two scheduled acceptances.
//
// From then on every admin change (verifier, tiers, windows, sources) is queued publicly and
// can only execute after the delay. The guardian can still pause sealing and disable a source
// immediately, but can't undo either.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const { APOSTILLE, VERIFIER, GUARDIAN, DELAY_HOURS = "48", EXECUTE } = process.env;
const SALT_A = hre.ethers.id("apostille.acceptOwnership");
const SALT_V = hre.ethers.id("verifier.acceptOwnership");

async function main() {
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const file = path.join(__dirname, "..", "deployments", `${chainId}.governance.json`);
  const apostille = await ethers.getContractAt("Apostille", APOSTILLE);
  const verifier = await ethers.getContractAt("AttestorVerifier", VERIFIER);
  const accept = apostille.interface.encodeFunctionData("acceptOwnership");

  if (EXECUTE) {
    const { timelock } = JSON.parse(fs.readFileSync(file, "utf8"));
    const tl = await ethers.getContractAt("TimelockController", timelock);
    await (await tl.execute(APOSTILLE, 0, accept, ethers.ZeroHash, SALT_A)).wait();
    await (await tl.execute(VERIFIER, 0, accept, ethers.ZeroHash, SALT_V)).wait();
    console.log(`owner(apostille) = ${await apostille.owner()}`);
    console.log(`owner(verifier)  = ${await verifier.owner()}`);
    return;
  }

  const delay = Number(DELAY_HOURS) * 3600;
  const tl = await ethers.deployContract("TimelockController", [delay, [signer.address], [signer.address], ethers.ZeroAddress]);
  await tl.waitForDeployment();
  const timelock = await tl.getAddress();
  console.log(`TimelockController ${timelock} (delay ${DELAY_HOURS}h, proposer/executor ${signer.address})`);

  if (GUARDIAN) await (await apostille.setGuardian(GUARDIAN)).wait();
  await (await apostille.transferOwnership(timelock)).wait();
  await (await verifier.transferOwnership(timelock)).wait();
  await (await tl.schedule(APOSTILLE, 0, accept, ethers.ZeroHash, SALT_A, delay)).wait();
  await (await tl.schedule(VERIFIER, 0, accept, ethers.ZeroHash, SALT_V, delay)).wait();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ chainId: Number(chainId), timelock, delayHours: Number(DELAY_HOURS), guardian: GUARDIAN || null, apostille: APOSTILLE, verifier: VERIFIER, scheduledAt: new Date().toISOString() }, null, 2));
  console.log(`Scheduled acceptOwnership for both contracts. Run again with EXECUTE=1 after ${DELAY_HOURS}h.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
