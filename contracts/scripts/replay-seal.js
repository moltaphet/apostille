// Replays a real seal() transaction from BSC testnet against the current Apostille build.
// The original attestation is submitted, from the same wallet, to fresh local deployments of the
// current AttestorVerifier and Apostille on a Hardhat chain set to the attestation's time, so the
// real attestor signature and the full decoding path are exercised.
//
//   HARDHAT_INITIAL_DATE=2020-01-01 REPLAY_TX=0x... npx hardhat run scripts/replay-seal.js
//
// Optional: BSC_TESTNET_RPC_URL, the RPC to read the transaction from (default https://bsc-testnet.drpc.org).
// Nothing is sent to the real chain.
const hre = require("hardhat");
const { ethers, network } = hre;

const RPC = process.env.BSC_TESTNET_RPC_URL || "https://bsc-testnet.drpc.org";
const TX = process.env.REPLAY_TX;

async function retry(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 6) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  if (!TX) throw new Error("Set REPLAY_TX to a seal() transaction hash");
  const remote = new ethers.JsonRpcProvider(RPC, 97, { staticNetwork: true, batchMaxCount: 1 });
  const tx = await retry(() => remote.getTransaction(TX));
  const rc = await retry(() => remote.getTransactionReceipt(TX));
  if (!tx || !rc) throw new Error(`Transaction ${TX} not found`);
  console.log(`original tx      ${TX}`);
  console.log(`  block ${tx.blockNumber}, from ${tx.from}, to ${tx.to}, status ${rc.status}`);

  const art = require("../artifacts/contracts/Apostille.sol/Apostille.json");
  const iface = new ethers.Interface(art.abi);
  const parsed = iface.parseTransaction({ data: tx.data });
  if (parsed?.name !== "seal") throw new Error(`Not a seal() call: ${parsed?.name}`);
  // A decoded Result is read-only; rebuild it as plain objects and arrays so it can be re-encoded.
  const plain = (v) => {
    if (!(v instanceof ethers.Result)) return v;
    let named = [];
    try {
      named = Object.keys(v.toObject()); // throws for arrays, whose entries have no names
    } catch {}
    if (named.length && !named[0].startsWith("_")) return Object.fromEntries(named.map((k) => [k, plain(v.getValue(k))]));
    return Array.from(v, plain);
  };
  const att = plain(parsed.args[0]);
  console.log(`  attestation at ${new Date(Number(att.timestamp)).toISOString()}`);
  console.log(`  data           ${att.data}`);
  console.log(`  conditions     ${att.attConditions}`);

  for (const log of rc.logs) {
    try {
      const ev = iface.parseLog(log);
      if (ev?.name === "Sealed") console.log(`  original result: ${ev.args.map(String).join(", ")}`);
    } catch {}
  }

  // Fresh local chain at the attestation's time, with the current builds of AttestorVerifier
  // (trusting the Primus SDK attestor, as on testnet) and Apostille. The attestor signature is
  // checked for real; nothing is mocked.
  const ATTESTOR = "0x5Ed3176045F68617B0958a61ac1868875C98C14d";
  const D = require("../../frontend/src/deploy/apostille.artifact.json").defaults;
  const [deployer] = await ethers.getSigners();
  const t0 = Math.floor(Number(att.timestamp) / 1000) + 30;
  await network.provider.send("evm_setNextBlockTimestamp", [t0]);
  const verifier = await ethers.deployContract("AttestorVerifier", [deployer.address, [ATTESTOR]]);
  await verifier.waitForDeployment();
  const apostille = await ethers.deployContract("Apostille", [
    deployer.address,
    await verifier.getAddress(),
    D.maxAttestationAge,
    D.sealValidity,
    D.tiers.map((t) => ({ ...t, minFuturesVolume: BigInt(t.minFuturesVolume) })),
    D.sources,
  ]);
  await apostille.waitForDeployment();
  console.log(`\nlocal chain at ${new Date(t0 * 1000).toISOString()}: current AttestorVerifier + Apostille deployed`);

  // Submit the same attestation from the same wallet.
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [tx.from] });
  await network.provider.send("hardhat_setBalance", [tx.from, "0x56BC75E2D63100000"]);
  const wallet = await ethers.getSigner(tx.from);
  await network.provider.send("evm_setNextBlockTimestamp", [t0 + 5]);
  try {
    const res = await (await apostille.connect(wallet).seal(att)).wait();
    console.log(`\nRESULT: seal() SUCCEEDED, gas used ${res.gasUsed}`);
    for (const log of res.logs) {
      try {
        const ev = apostille.interface.parseLog(log);
        if (ev) console.log(`  ${ev.name}: ${ev.args.map(String).join(", ")}`);
      } catch {}
    }
    const [active, tier, bps] = await apostille.tierOf(tx.from);
    console.log(`  tierOf(${tx.from}) = active ${active}, tier ${tier}, discount ${bps} bps`);
  } catch (e) {
    const data = e?.data ?? e?.error?.data;
    let reason = e.shortMessage || e.message;
    try {
      const err = apostille.interface.parseError(data);
      if (err) reason = `${err.name}(${err.args.map(String).join(", ")})`;
    } catch {}
    console.log(`\nRESULT: seal() REVERTED: ${reason}`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
