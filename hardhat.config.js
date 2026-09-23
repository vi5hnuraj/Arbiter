require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Use a harmless placeholder when no key is set so compile/test always work.
const PLACEHOLDER = "0x" + "11".repeat(32);
const PRIVATE_KEY = process.env.PRIVATE_KEY || PLACEHOLDER;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true, // needed for the wide getPayment return tuple
    },
  },
  networks: {
    // Arbitrum Sepolia testnet — required by the Buildathon rules.
    arbitrumSepolia: {
      url: process.env.ARB_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      // second account plays the provider role in the B2B demo (random test key)
      accounts: [PRIVATE_KEY, process.env.PROVIDER_KEY || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"],
    },
    // Robinhood Chain testnet (Arbitrum Orbit chain) — the reserved prize slot.
    robinhoodTestnet: {
      url: process.env.RHC_TESTNET_RPC || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts: [PRIVATE_KEY],
    },
    // Arbitrum One MAINNET — real funds. Only touches the chain when explicitly
    // invoked with --network arbitrumOne; the PLACEHOLDER key can never fire txs.
    arbitrumOne: {
      url: process.env.ARB_MAINNET_RPC || "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      accounts: [PRIVATE_KEY],
    },
    // Robinhood Chain MAINNET (Arbitrum Orbit) — USDG is native here and a real
    // Chainlink USDG/USD feed exists on mainnet. Same mainnet safety rules.
    robinhoodMainnet: {
      url: process.env.RHC_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: [PRIVATE_KEY],
    },
  },
};
