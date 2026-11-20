require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the solc-js build pinned in package.json instead of downloading a compiler at build
// time. Keeps builds reproducible and working in sandboxed / offline CI.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async ({ solcVersion }, _hre, runSuper) => {
  const solc = require("solc");
  if (solc.version().startsWith(solcVersion)) {
    return {
      compilerPath: require.resolve("solc/soljson.js"),
      isSolcJs: true,
      version: solcVersion,
      longVersion: solc.version(),
    };
  }
  return runSuper();
});

const { DEPLOYER_PRIVATE_KEY, BSC_TESTNET_RPC_URL, BSCSCAN_API_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 500 }, viaIR: true },
  },
  networks: {
    baseSepolia: { url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org", chainId: 84532, accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [] },
    arbitrumSepolia: { url: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc", chainId: 421614, accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [] },
    bscTestnet: {
      url: BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: { bscTestnet: BSCSCAN_API_KEY || "" },
  },
  gasReporter: { enabled: !!process.env.REPORT_GAS },
};
