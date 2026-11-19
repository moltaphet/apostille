const hre = require("hardhat");
const TIERS = require("../config/tiers");
const SOURCES = require("../config/sources").map(({ templateId, ...s }) => s);

async function main() {
  const { chainId } = await hre.ethers.provider.getNetwork();
  const d = require(`../deployments/${chainId}.json`);
  await hre.run("verify:verify", {
    address: d.address,
    constructorArguments: [d.owner, d.primus, d.args[2], d.args[3], TIERS, SOURCES],
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
