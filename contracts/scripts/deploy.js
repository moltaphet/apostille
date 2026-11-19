const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const TIERS = require("../config/tiers");

// Primus zkTLS verifier (TransparentUpgradeableProxy) per chain, from
// github.com/primus-labs/zktls-contracts/tree/main/broadcast/PrimusZkTLS.s.sol
const PRIMUS_VERIFIER = {
  97: "0x4620362a803f82b7231b18e09abc5d400a7891fb", // BNB Smart Chain testnet
  56: "0xf3c20a5216d669c521ffe3724c1439ae0897ac33", // BNB Smart Chain mainnet
};

const MAX_ATTESTATION_AGE = 15 * 60; // a proof must be submitted within 15 minutes
const SEAL_VALIDITY = 30 * 24 * 60 * 60; // a seal lasts one 30-day volume window

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const { chainId } = await hre.ethers.provider.getNetwork();
  const primus = process.env.PRIMUS_VERIFIER || PRIMUS_VERIFIER[Number(chainId)];
  if (!primus) throw new Error(`No Primus verifier known for chain ${chainId}; set PRIMUS_VERIFIER`);

  const code = await hre.ethers.provider.getCode(primus);
  if (code === "0x") throw new Error(`Primus verifier ${primus} has no code on chain ${chainId}`);

  const owner = process.env.OWNER || deployer.address;
  console.log(`Deploying Apostille to chain ${chainId}`);
  console.log(`  deployer        ${deployer.address}`);
  console.log(`  owner           ${owner}`);
  console.log(`  primus verifier ${primus}`);

  const args = [owner, primus, MAX_ATTESTATION_AGE, SEAL_VALIDITY, TIERS];
  const apostille = await hre.ethers.deployContract("Apostille", args);
  await apostille.waitForDeployment();
  const address = await apostille.getAddress();
  console.log(`Apostille deployed at ${address}`);

  const out = path.join(__dirname, "..", "deployments", `${chainId}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        chainId: Number(chainId),
        address,
        primus,
        owner,
        args: args.map((a) => (Array.isArray(a) ? a.map((t) => ({ ...t, minFuturesVolume: t.minFuturesVolume.toString() })) : a)),
        tx: apostille.deploymentTransaction()?.hash,
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log(`Saved ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
