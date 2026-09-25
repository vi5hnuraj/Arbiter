const hre = require("hardhat");
require("dotenv").config();

/**
 * USDG settlement demo — the Paxos bonus-criteria run.
 *
 * Same lifecycle as demo.js, but the settlement token is USDG (Global Dollar):
 *   1. Verify the token is the real USDG (symbol + decimals sanity check)
 *   2. Quote a $1.00 service (fixed 1.0 fallback where no feed exists)
 *   3. approve + settleInvoiceUSDEscrow -> funds HELD in review-window escrow
 *   4. provider markDelivered with an evidence hash
 *   5. buyer approveDelivery -> provider paid in USDG + SettlementCompleted event
 *
 * Every step prints a tx hash + explorer link — paste these into the submission.
 *
 * Env needed:
 *   PRIVATE_KEY            funded wallet (gas + USDG)
 *   MANAGER_ADDRESS        deployed ArbiterManager on the target network
 *   USDG_ADDRESS           USDG token address (Arbitrum One default below)
 * Optional:
 *   PROVIDER_ADDRESS / PROVIDER_PRIVATE_KEY — two-wallet demo (recommended for mainnet)
 *   MAINNET_CONFIRM=deploy-arbitrumOne — not required here; demo txs are small,
 *   but this script refuses to run on a mainnet network name unless
 *   USDG_DEMO_CONFIRM=yes is set, mirroring the deploy safety gate.
 */
const EXPLORERS = {
  arbitrumSepolia: "https://sepolia.arbiscan.io",
  robinhoodTestnet: "https://explorer.testnet.chain.robinhood.com",
  arbitrumOne: "https://arbiscan.io",
  robinhoodMainnet: "https://robinhoodchain.blockscout.com",
};

// Verified USDG proxy on Arbitrum One (Arbiscan). Override with USDG_ADDRESS for
// other chains — the symbol check below is what actually protects you.
const DEFAULT_USDG = {
  arbitrumOne: "0x004B506865409877C9fA29bfb1ebA929984B9bbC",
};

const SERVICE_USD_CENTS = 100n; // $1.00
const SLIPPAGE_BUFFER = 1.02; // accept up to 2% feed movement
const REVIEW_WINDOW = 3600; // 1 hour buyer review window
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address,address) view returns (uint256)",
];

async function main() {
  const net = hre.network.name;
  const explorer = EXPLORERS[net] || "(no explorer)";
  const isMainnet = net === "arbitrumOne" || net === "robinhoodMainnet";
  if (isMainnet && process.env.USDG_DEMO_CONFIRM !== "yes") {
    throw new Error(
      `\nThis targets ${net} (MAINNET). Re-run with USDG_DEMO_CONFIRM=yes in .env to proceed.`
    );
  }

  const managerAddress = process.env.MANAGER_ADDRESS;
  const usdgAddress = process.env.USDG_ADDRESS || DEFAULT_USDG[net];
  if (!managerAddress || !usdgAddress) {
    throw new Error("Set MANAGER_ADDRESS and USDG_ADDRESS in .env (deploy prints the manager)");
  }

  const [consumer] = await hre.ethers.getSigners();

  // Optional second wallet so provider != buyer on-chain
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
  const usdg = await hre.ethers.getContractAt(ERC20_ABI, usdgAddress, consumer);

  console.log(`\n=== Arbiter USDG settlement demo on ${net} ===`);
  console.log(`Consumer (buyer agent):  ${consumer.address}`);
  console.log(`Provider (seller agent): ${providerAddress}`);
  console.log(`Manager:                 ${managerAddress}`);

  // 0. sanity: token must be the real USDG before any money moves
  const [symbol, dec] = await Promise.all([usdg.symbol(), usdg.decimals()]);
  if (symbol !== "USDG") throw new Error(`Token symbol is "${symbol}", expected "USDG" — wrong address? Aborting.`);
  if (dec !== 6n) throw new Error(`USDG decimals is ${dec}, expected 6 — wrong address? Aborting.`);
  console.log(`\nToken check: ${symbol} ✓ (${dec} decimals) at ${usdgAddress}`);

  const eth = await hre.ethers.provider.getBalance(consumer.address);
  console.log(`Gas ETH:  ${hre.ethers.formatEther(eth)}`);
  const usdgBal = await usdg.balanceOf(consumer.address);
  console.log(`USDG:     ${hre.ethers.formatUnits(usdgBal, dec)}`);
  if (usdgBal < hre.ethers.parseUnits("2", 6)) {
    throw new Error("Need at least 2 USDG (settle amount + buffer). Get some, then re-run.");
  }

  // 1. quote the $1.00 service
  const feed = await manager.priceFeed();
  console.log(`\n[1] Price feed: ${feed} ${feed === hre.ethers.ZeroAddress ? "(fixed 1.0 fallback — USDG = $1 by design)" : "(live Chainlink)"}`);
  const [amount, price] = await manager.quoteUSD(SERVICE_USD_CENTS);
  console.log(`    Feed: $${Number(hre.ethers.formatUnits(price, 8))} per token -> $${Number(SERVICE_USD_CENTS) / 100} service = ${hre.ethers.formatUnits(amount, dec)} USDG`);

  const maxAmount = (amount * BigInt(Math.round(SLIPPAGE_BUFFER * 1e6))) / 1_000_000n + 1n;

  // 2. approve
  const approveTx = await usdg.approve(managerAddress, maxAmount);
  await approveTx.wait();
  console.log(`\n[2] approve            tx: ${approveTx.hash}`);

  // 3. settle into review-window escrow
  const id = hre.ethers.id(`usdg-demo-${net}-${Date.now()}`);
  const invoiceRef = hre.ethers.id("arbiter-usdg-demo");
  const termsHash = hre.ethers.id(JSON.stringify({ service: "demo-ocr", price: "$1.00", sla: "24h", settlement: "USDG" }));
  const settleTx = await manager.settleInvoiceUSDEscrow(
    id, providerAddress, invoiceRef, usdgAddress, SERVICE_USD_CENTS, maxAmount, termsHash, REVIEW_WINDOW
  );
  const settleRc = await settleTx.wait();
  console.log(`[3] settle (HELD)      tx: ${settleTx.hash}`);
  const settled = settleRc.logs
    .map((l) => { try { return manager.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean)
    .find((e) => e.name === "USDSettled");
  if (settled) console.log(`    USDSettled: usdCents=${settled.args.usdCents} feedPrice=${Number(hre.ethers.formatUnits(settled.args.price, 8))} amount=${hre.ethers.formatUnits(settled.args.amount, dec)} USDG`);

  // 4. provider marks delivered with a content fingerprint
  const evidenceHash = hre.ethers.id("usdg-demo-output-" + id.slice(0, 10));
  const deliverTx = await managerAsProvider.markDelivered(id, evidenceHash);
  await deliverTx.wait();
  console.log(`[4] markDelivered      tx: ${deliverTx.hash}`);
  console.log(`    evidence: ${evidenceHash} (keccak of service output, committed on-chain)`);

  // 5. buyer approves -> provider paid in USDG + reputation event
  const approveTx2 = await manager.approveDelivery(id);
  const approveRc2 = await approveTx2.wait();
  console.log(`[5] approveDelivery    tx: ${approveTx2.hash}`);
  const rep = approveRc2.logs
    .map((l) => { try { return manager.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean)
    .find((e) => e.name === "SettlementCompleted");
  if (rep) console.log(`    SettlementCompleted: outcome=${rep.args.outcome} amount=${hre.ethers.formatUnits(rep.args.amount, dec)} USDG -> provider reputation indexed on-chain`);

  // 6. final state
  const p = await manager.getPayment(id);
  console.log(`\nFinal: status=${p[1]} (1=HELD 2=RELEASED 3=CANCELLED)  delivered=${p[10]}`);
  console.log(`Provider USDG balance: ${hre.ethers.formatUnits(await usdg.balanceOf(providerAddress), dec)}`);

  console.log("\n=== Submission proof — USDG demo tx hashes ===");
  console.log(`settle:   ${explorer}/tx/${settleTx.hash}`);
  console.log(`deliver:  ${explorer}/tx/${deliverTx.hash}`);
  console.log(`approve:  ${explorer}/tx/${approveTx2.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
