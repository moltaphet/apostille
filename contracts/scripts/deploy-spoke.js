// Deploys an ApostilleSpoke on the current network, pointed at the hub on BSC testnet.
//   HUB=0x… npx hardhat run scripts/deploy-spoke.js --network baseSepolia
// Then register it on the hub (as owner): hub.addSpoke(<chain id>, <spoke address>).
const { ethers, network } = require("hardhat");

// Hyperlane mailboxes (hyperlane-registry). Domain ids equal chain ids here.
const MAILBOX = {
  84532: "0x6966b0E55883d49BFB24539356a2f8A673E02039",
  421614: "0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8",
};
const HUB_DOMAIN = 97;

async function main() {
  const hub = process.env.HUB;
  if (!ethers.isAddress(hub)) throw new Error("Set HUB to the Apostille address on BSC testnet");
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const mailbox = MAILBOX[chainId];
  if (!mailbox) throw new Error(`No Hyperlane mailbox known for chain ${chainId}`);
  const [deployer] = await ethers.getSigners();
  const spoke = await ethers.deployContract("ApostilleSpoke", [deployer.address, mailbox, HUB_DOMAIN, hub]);
  await spoke.waitForDeployment();
  console.log(`ApostilleSpoke on ${network.name} (${chainId}): ${await spoke.getAddress()}`);
  console.log(`register on the hub: addSpoke(${chainId}, ${await spoke.getAddress()})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
