const hre = require("hardhat");
require("dotenv").config();

/**
 * autoResolve demo — proves "silence is never a veto for either side" on-chain.
 *
 * Runs BOTH endings permissionlessly (anyone can call autoResolve after the
 * deadline — no trust in the buyer or provider required):
 *
 *   Invoice A: provider marks delivered, then both parties vanish.
 *              autoResolve(A) AFTER the deadline -> provider PAID.
 *              (A silent buyer can never withhold payment by ghosting.)
 *
 *   Invoice B: provider never delivers, then both parties vanish.
 *              autoResolve(B) AFTER the deadline -> buyer REFUNDED.
 *              (A silent provider can never trap funds by ghosting.)
 *
 * Uses a 20-second review window so the whole demo finishes in ~1 minute.
 * Settles in USDG when the network has it (Arbitrum One), otherwise the
 * network's configured USDC — pass MANAGER_ADDRESS + USDG_ADDRESS/USDC_ADDRESS.
 */
const EXPLORERS = {
  arbitrumSepolia: "https://sepolia.arbiscan.io",
  robinhoodTestnet: "https://explorer.testnet.chain.robinhood.com",
  arbitrumOne: "https://arbiscan.io",
  robinhoodMainnet: "https://robinhoodchain.blockscout.com",
};

const SERVICE_USD_CENTS = 100n; // $1.00
const REVIEW_WINDOW = 20; // seconds — short so the demo can cross the deadline
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const DEFAULT_USDG = {
  arbitrumOne: "0x004B506865409877C9fA29bfb1ebA929984B9bbC",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const net = hre.network.name;
  const explorer = EXPLORERS[net] || "(no explorer)";

  const managerAddress = process.env.MANAGER_ADDRESS;
  const tokenAddress = process.env.USDG_ADDRESS || DEFAULT_USDG[net] || process.env.USDC_ADDRESS;
  if (!managerAddress || !tokenAddress) {
    throw new Error("Set MANAGER_ADDRESS and USDG_ADDRESS (or USDC_ADDRESS) in .env");
  }

  const [consumer] = await hre.ethers.getSigners();
  let providerSigner = consumer;
  let providerAddress = process.env.PROVIDER_ADDRESS || consumer.address;
  if (process.env.PROVIDER_PRIVATE_KEY && process.env.PROVIDER_ADDRESS) {
    providerSigner = new hre.ethers.Wallet(process.env.PROVIDER_PRIVATE_KEY, hre.ethers.provider);
    providerAddress = process.env.PROVIDER_ADDRESS;
  }

  const manager = await hre.ethers.getContractAt("ArbiterManager", managerAddress, consumer);
  const managerAsProvider =
    providerSigner !== consumer
      ? await hre.ethers.getContractAt("ArbiterManager", managerAddress, providerSigner)
      : manager;
  const token = await hre.ethers.getContractAt(ERC20_ABI, tokenAddress, consumer);

  console.log(`\n=== Arbiter autoResolve demo on ${net} (review window: ${REVIEW_WINDOW}s) ===`);
  console.log(`Consumer (buyer agent):  ${consumer.address}`);
  console.log(`Provider (seller agent): ${providerAddress}`);

  const [symbol, dec] = await Promise.all([token.symbol(), token.decimals()]);
  const bal = await token.balanceOf(consumer.address);
  console.log(`Token: ${symbol} (${dec} decimals), buyer balance: ${hre.ethers.formatUnits(bal, dec)}`);
  if (bal < hre.ethers.parseUnits("3", Number(dec))) {
    throw new Error(`Need at least 3 ${symbol} (two $1 settlements + buffer)`);
  }

  // Shared approve for both invoices
  const maxAmount = hre.ethers.parseUnits("2", Number(dec)); // $1 + 100% headroom each
  const approveTx = await token.approve(managerAddress, maxAmount * 2n);
  await approveTx.wait();
  console.log(`\n[0] approve            tx: ${approveTx.hash}`);

  async function settle(label) {
    const id = hre.ethers.id(`auto-demo-${label}-${net}-${Date.now()}`);
    const termsHash = hre.ethers.id(JSON.stringify({ service: `demo-${label}`, price: "$1.00", sla: "instant-demo" }));
    const tx = await manager.settleInvoiceUSDEscrow(
      id, providerAddress, hre.ethers.id(`ref-${label}`), tokenAddress,
      SERVICE_USD_CENTS, maxAmount, termsHash, REVIEW_WINDOW
    );
    await tx.wait();
    console.log(`[${label}] settle (HELD)    tx: ${tx.hash}`);
    return { id, settleHash: tx.hash };
  }

  // ---- Invoice A: delivered -> must auto-pay the provider ----
  const { id: idA, settleHash: settleHashA } = await settle("A");
  const deliverTx = await managerAsProvider.markDelivered(idA, hre.ethers.id("auto-demo-output-A"));
  await deliverTx.wait();
  console.log(`[A] markDelivered      tx: ${deliverTx.hash}`);

  // ---- Invoice B: never delivered -> must auto-refund the buyer ----
  const { id: idB, settleHash: settleHashB } = await settle("B");

  console.log(`\nBoth parties now "go silent"... waiting ${REVIEW_WINDOW + 5}s for the deadline to pass`);
  await sleep((REVIEW_WINDOW + 5) * 1000);

  // ---- Permissionless resolution (could be called by ANYONE — that's the point) ----
  const resA = await manager.autoResolve(idA);
  await resA.wait();
  console.log(`\n[A] autoResolve        tx: ${resA.hash}  -> delivered work PAID to provider`);
  const resB = await manager.autoResolve(idB);
  await resB.wait();
  console.log(`[B] autoResolve        tx: ${resB.hash}  -> undelivered work REFUNDED to buyer`);

  // ---- Verdicts ----
  const a = await manager.getPayment(idA);
  const b = await manager.getPayment(idB);
  console.log(`\nInvoice A final: status=${a[1]} (2=RELEASED -> provider paid)`);
  console.log(`Invoice B final: status=${b[1]} (3=CANCELLED -> buyer refunded)`);
  if (a[1] !== 2n || b[1] !== 3n) throw new Error("Unexpected final states — investigate before submitting");

  console.log("\n=== Submission proof — autoResolve demo tx hashes ===");
  console.log(`A settle:       ${explorer}/tx/${settleHashA}`);
  console.log(`A deliver:      ${explorer}/tx/${deliverTx.hash}`);
  console.log(`A autoResolve:  ${explorer}/tx/${resA.hash}   (delivered -> PAID)`);
  console.log(`B settle:       ${explorer}/tx/${settleHashB}`);
  console.log(`B autoResolve:  ${explorer}/tx/${resB.hash}   (undelivered -> REFUNDED)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
