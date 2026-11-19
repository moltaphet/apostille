// Copies the compiled Apostille ABI + bytecode into the frontend so /deploy can deploy
// exactly what the tests ran against. Run after `npm run build`.
const fs = require("fs");
const path = require("path");
const TIERS = require("../config/tiers");
const SOURCES = require("../config/sources").map(({ templateId, ...s }) => s);

const art = require("../artifacts/contracts/Apostille.sol/Apostille.json");
const verifier = require("../artifacts/contracts/AttestorVerifier.sol/AttestorVerifier.json");
const out = path.join(__dirname, "..", "..", "frontend", "src", "deploy", "apostille.artifact.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      contractName: art.contractName,
      compiler: "solc 0.8.24, optimizer 500 runs, viaIR",
      abi: art.abi,
      bytecode: art.bytecode,
      verifier: { abi: verifier.abi, bytecode: verifier.bytecode },
      defaults: {
        maxAttestationAge: 15 * 60,
        sealValidity: 30 * 24 * 60 * 60,
        tiers: TIERS.map((t) => ({ ...t, minFuturesVolume: t.minFuturesVolume.toString() })),
        sources: SOURCES,
        primusVerifier: { 97: "0x4620362a803f82b7231b18e09abc5d400a7891fb" },
        // Signs attestations from @primuslabs/zktls-js-sdk (PADOADDRESSMAP.production).
        enterpriseAttestor: "0x5Ed3176045F68617B0958a61ac1868875C98C14d",
        // AttestorVerifier already deployed on BSC testnet; reused when it accepts the SDK attestor.
        existingVerifier: { 97: "0x9a68DC84482f7cbd9EC8167a7CbFB666eADB8059" },
      },
    },
    null,
    2
  ) + "\n"
);
console.log(`wrote ${path.relative(process.cwd(), out)}`);
