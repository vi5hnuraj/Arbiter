const { ethers } = require("ethers");
require("dotenv").config();

/**
 * Reads the OFFICIAL Chainlink USDC/USD feed on Arbitrum ONE mainnet — live, read-only, zero gas.
 *
 * This is the "mainnet price, testnet execution" pattern:
 *   - Testnet deployments settle with the on-chain feed where one exists
 *     (Arbitrum Sepolia: 0x0153002d20B96532C639313c2d54c3dA09109309)
 *   - Where no testnet feed exists (Robinhood Chain), the contract's fixed 1.0
 *     fallback runs on-chain, and THIS script proves what the live mainnet
 *     oracle reports — the exact value setPriceFeed() consumes at mainnet launch.
 *
 * Feed address sourced from Chainlink's Reference Data Directory:
 *   https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-arbitrum-1.json
 */
const MAINNET_USDC_FEED = process.env.ARB_MAINNET_PRICE_FEED || "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3";

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.ARB_MAINNET_RPC || "https://arb1.arbitrum.io/rpc");
  const net = await provider.getNetwork();
  if (net.chainId !== 42161n) throw new Error(`Expected Arbitrum One (42161), got ${net.chainId}`);

  const feed = new ethers.Contract(
    MAINNET_USDC_FEED,
    ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
     "function decimals() view returns (uint8)",
     "function description() view returns (string)"],
    provider
  );

  const [ , answer, , updatedAt ] = await feed.latestRoundData();
  const decimals = await feed.decimals();
  let description = "";
  try { description = await feed.description(); } catch { /* some feeds don't expose it */ }

  const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);
  const price = Number(ethers.formatUnits(answer, decimals));

  console.log("=== Live Chainlink oracle — Arbitrum One MAINNET (read-only) ===");
  console.log(`Feed:       ${MAINNET_USDC_FEED}`);
  console.log(`Pair:       ${description || "USDC / USD"}`);
  console.log(`Price:      $${price} per USDC`);
  console.log(`Updated:    ${ageSeconds}s ago`);
  console.log(`$1.00 invoice settles as: ${(1 / price).toFixed(6)} USDC`);

  if (ageSeconds > 86400) {
    console.log("\n⚠️  Price older than 24h — check feed health before relying on it.");
  } else {
    console.log("\n✅ Feed healthy. At mainnet launch: manager.setPriceFeed(this address) — one tx, no redeploy.");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
