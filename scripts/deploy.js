const hre = require("hardhat");
require("dotenv").config();

/**
 * Verified token + feed addresses (see README "USDG integration" section for sources):
 *  - USDG (Global Dollar, Paxos) on Arbitrum One: 0x004B506865409877C9fA29bfb1ebA929984B9bbC
 *    (verified proxy on Arbiscan; Paxos docs list USDG as supported on Arbitrum One + Robinhood Chain)
 *  - Chainlink USDC/USD on Arbitrum One: 0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3
 *    (Chainlink Reference Data Directory — same address mainnet-price.js already reads)
 *  - No USDG/USD feed exists on Arbitrum One, so mainnet deployments for USDG settle
 *    with the contract's fixed 1 token = 1.00 USD fallback (USDG is a USD stablecoin).
 *    On Robinhood Chain MAINNET a USDG/USD feed exists — set RHC_MAINNET_PRICE_FEED
 *    after verifying it on data.chain.link, and the deploy wires it automatically.
 */

const NETWORKS = {
  arbitrumSepolia: {
    testnet: true,
    // Circle native testnet USDC on Arbitrum Sepolia.
    usdc: process.env.ARB_USDC || "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    // Chainlink USDC/USD feed on Arbitrum Sepolia — official Chainlink Reference Data Directory.
    // Heartbeat is 24h, so the contract's staleness window is raised to 25h after deploy.
    priceFeed: process.env.ARB_PRICE_FEED || "0x0153002d20B96532C639313c2d54c3dA09109309",
    maxFeedAgeSeconds: 25 * 60 * 60,
    tokenDecimals: 6,
    explorer: "https://sepolia.arbiscan.io",
    faucets: [
      "ETH: https://arbitrum.faucet.dev/ or https://faucet.quicknode.com/arbitrum/sepolia",
      "USDC: https://faucet.circle.com/",
    ],
  },
  robinhoodTestnet: {
    testnet: true,
    usdc: process.env.RHC_USDC || "", // mock USDC for demos; swap when a public testnet USDC ships
    priceFeed: process.env.RHC_PRICE_FEED || "", // no Chainlink feeds on Robinhood testnet -> fixed fallback
    maxFeedAgeSeconds: 60 * 60,
    tokenDecimals: 6,
    explorer: "https://explorer.testnet.chain.robinhood.com",
    faucets: ["ETH: https://faucet.testnet.chain.robinhood.com/"],
  },
  arbitrumOne: {
    testnet: false,
    // USDG (Global Dollar) proxy on Arbitrum One — verified on Arbiscan.
    usdc: process.env.ARB_MAINNET_USDG || "0x004B506865409877C9fA29bfb1ebA929984B9bbC",
    // No USDG/USD Chainlink feed on Arbitrum One -> fixed 1.0 fallback (USDG = $1 by design).
    // If a feed ships later, call setPriceFeed() — no redeploy needed.
    priceFeed: process.env.ARB_MAINNET_PRICE_FEED || "",
    maxFeedAgeSeconds: 25 * 60 * 60,
    tokenDecimals: 6,
    explorer: "https://arbiscan.io",
    faucets: [],
  },
  robinhoodMainnet: {
    testnet: false,
    // Robinhood publishes token addresses in its docs / registry; set after verifying
    // on the official Blockscout explorer (robinhoodchain.blockscout.com).
    usdc: process.env.RHC_MAINNET_USDG || "",
    // USDG/USD feed exists on Robinhood Chain mainnet (Chainlink changelog); verify the
    // address on data.chain.link before setting — it is wired in this deploy when present.
    priceFeed: process.env.RHC_MAINNET_PRICE_FEED || "",
    maxFeedAgeSeconds: 25 * 60 * 60,
    tokenDecimals: 6,
    explorer: "https://robinhoodchain.blockscout.com",
    faucets: [],
  },
};

async function main() {
  const net = hre.network.name;
  const cfg = NETWORKS[net];
  if (!cfg) throw new Error(`No deploy config for network ${net}`);

  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nDeploying ArbiterManager on ${net}`);
  console.log(`Deployer: ${deployer.address}`);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`ETH balance: ${hre.ethers.formatEther(balance)} ETH`);

  if (cfg.testnet) {
    if (balance === 0n) {
      console.log("\n⚠️  No gas funds! Claim testnet ETH first:");
      cfg.faucets.forEach((f) => console.log(`   ${f}`));
      throw new Error("Faucet needed");
    }
  } else {
    // ---- MAINNET SAFETY GATE ----
    // Require an explicit typed confirmation so no real deployment can happen
    // accidentally (CI, stray `npm run deploy:arbitrum:one`, etc.).
    if (process.env.MAINNET_CONFIRM !== `deploy-${net}`) {
      throw new Error(
        `\nMAINNET deployment requested but not confirmed.\n` +
        `Add this line to your .env first (costs nothing, just a brake):\n` +
        `  MAINNET_CONFIRM=deploy-${net}\n`
      );
    }
    if (balance * hre.ethers.parseEther("0.0000001") < hre.ethers.parseEther("0.0005")) {
      console.log("\n⚠️  Balance under 0.0005 ETH — mainnet deploy may run out of gas. Aborting.");
      throw new Error("Insufficient mainnet gas");
    }
  }

  const feedArg = cfg.priceFeed && cfg.priceFeed.length > 0 ? cfg.priceFeed : hre.ethers.ZeroAddress;
  if (feedArg === hre.ethers.ZeroAddress) {
    console.log("Price feed: (none) — using fixed 1 token = 1.00 USD fallback");
  } else {
    console.log(`Price feed: ${feedArg}`);
  }

  const Factory = await hre.ethers.getContractFactory("ArbiterManager");
  const manager = await Factory.deploy(feedArg, cfg.tokenDecimals);
  await manager.waitForDeployment();

  if (feedArg !== hre.ethers.ZeroAddress) {
    const setAge = await manager.setMaxFeedAge(cfg.maxFeedAgeSeconds);
    await setAge.wait();
    console.log(`maxFeedAge set to ${cfg.maxFeedAgeSeconds}s (feed heartbeat allowance)`);
  }

  const address = await manager.getAddress();
  console.log(`\n✅ ArbiterManager deployed: ${address}`);
  console.log(`   Explorer: ${cfg.explorer}/address/${address}`);
  console.log(`   ${cfg.usdc ? `Settlement token for demo scripts: ${cfg.usdc}` : "SET the settlement token (RHC_MAINNET_USDG) in .env"}`);

  console.log("\nAdd to your .env / backend config:");
  console.log(`ARBITER_${net.toUpperCase()}_MANAGER_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
