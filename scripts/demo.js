const hre = require("hardhat");
require("dotenv").config();

/**
 * Full agent-commerce escrow demo on one chain:
 *   1. Quote a $1.00 service at the live Chainlink rate
 *   2. Consumer approves USDC
 *   3. settleInvoiceUSDEscrow — funds move into review-window escrow (HELD)
 *   4. Provider marks the service delivered (DELIVERED)
 *   5. Buyer approves delivery -> provider paid (RELEASED) + reputation event
 * Prints every tx hash + explorer link — these are your submission proofs.
 *
 * Env needed: PRIVATE_KEY, MANAGER_ADDRESS, USDC_ADDRESS
 * Optional:   PROVIDER_ADDRESS + PROVIDER_PRIVATE_KEY (makes the demo two-wallet real)
 *             Without them, one wallet plays both roles (flow still proves the contract).
 */
const EXPLORERS = {
  arbitrumSepolia: "https://sepolia.arbiscan.io",
  robinhoodTestnet: "https://explorer.testnet.chain.robinhood.com",
};

const SERVICE_USD_CENTS = 100n; // $1.00
const SLIPPAGE_BUFFER = 1.02; // accept up to 2% feed movement
const REVIEW_WINDOW = 3600; // 1 hour buyer review window

async function main() {
  const net = hre.network.name;
  const explorer = EXPLORERS[net] || "(no explorer)";
  const managerAddress = process.env.MANAGER_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  if (!managerAddress || !usdcAddress) {
    throw new Error("Set MANAGER_ADDRESS and USDC_ADDRESS in .env (deploy prints them)");
  }

  const [consumer] = await hre.ethers.getSigners();

  // Optional second wallet so provider != buyer on-chain
  let providerSigner = consumer;
  let providerAddress = process.env.PROVIDER_ADDRESS || consumer.address;
  if (process.env.PROVIDER_PRIVATE_KEY && process.env.PROVIDER_ADDRESS) {
    providerSigner = new hre.ethers.Wallet(process.env.PROVIDER_PRIVATE_KEY, hre.ethers.provider);
    providerAddress = process.env.PROVIDER_ADDRESS;
    console.log(`Provider wallet funded (gas) check: ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(providerAddress))} ETH`);
  }

  const manager = await hre.ethers.getContractAt("ArbiterManager", managerAddress, consumer);
  const managerAsProvider = managerAddress && providerSigner !== consumer
    ? await hre.ethers.getContractAt("ArbiterManager", managerAddress, providerSigner)
    : manager;
  const usdc = await hre.ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)"],
    usdcAddress,
    consumer
  );

  console.log(`\n=== Arbiter escrow demo on ${net} ===`);
  console.log(`Consumer (buyer agent):  ${consumer.address}`);
  console.log(`Provider (seller agent): ${providerAddress}`);
  console.log(`Manager:                 ${managerAddress}`);

  // 0. sanity checks
  const eth = await hre.ethers.provider.getBalance(consumer.address);
  console.log(`\nGas ETH:  ${hre.ethers.formatEther(eth)}`);
  if (eth === 0n) throw new Error("No gas ETH — claim from the faucet first");
  const usdcBal = await usdc.balanceOf(consumer.address);
  const dec = await usdc.decimals();
  console.log(`USDC:     ${hre.ethers.formatUnits(usdcBal, dec)}`);
  if (usdcBal === 0n) throw new Error("No USDC — claim from https://faucet.circle.com/ (Arbitrum Sepolia)");

  // 1. quote the $1.00 service at the live feed
  const feed = await manager.priceFeed();
  console.log(`\n[1] Price feed: ${feed} ${feed === hre.ethers.ZeroAddress ? "(fixed 1.0 fallback)" : "(live Chainlink)"}`);
  const [amount, price] = await manager.quoteUSD(SERVICE_USD_CENTS);
  console.log(`    Feed: $${Number(hre.ethers.formatUnits(price, 8))} per token -> $${Number(SERVICE_USD_CENTS) / 100} service = ${hre.ethers.formatUnits(amount, dec)} USDC`);

  const maxAmount = (amount * BigInt(Math.round(SLIPPAGE_BUFFER * 1e6))) / 1_000_000n + 1n;

  // 2. approve
  const approveTx = await usdc.approve(managerAddress, maxAmount);
  await approveTx.wait();
  console.log(`\n[2] approve            tx: ${approveTx.hash}`);

  // 3. settle into review-window escrow
  const id = hre.ethers.id(`demo-${net}-${Date.now()}`);
  const invoiceRef = hre.ethers.id("arbiter-arbitrum-demo");
  const termsHash = hre.ethers.id(JSON.stringify({ service: "demo-ocr", price: "$1.00", sla: "24h" }));
  const settleTx = await manager.settleInvoiceUSDEscrow(
    id, providerAddress, invoiceRef, usdcAddress, SERVICE_USD_CENTS, maxAmount, termsHash, REVIEW_WINDOW
  );
  const settleRc = await settleTx.wait();
  console.log(`[3] settle (HELD)      tx: ${settleTx.hash}`);
  const settled = settleRc.logs.map((l) => { try { return manager.interface.parseLog(l); } catch { return null; } }).filter(Boolean).find((e) => e.name === "USDSettled");
  if (settled) console.log(`    USDSettled: usdCents=${settled.args.usdCents} feedPrice=${Number(hre.ethers.formatUnits(settled.args.price, 8))} amount=${hre.ethers.formatUnits(settled.args.amount, dec)}`);

  // 4. provider marks delivered with a content fingerprint (evidence hash)
  const evidenceHash = hre.ethers.id("demo-service-output-" + id.slice(0, 10));
  const deliverTx = await managerAsProvider.markDelivered(id, evidenceHash);
  await deliverTx.wait();
  console.log(`[4] markDelivered      tx: ${deliverTx.hash}`);
  console.log(`    evidence: ${evidenceHash} (keccak of service output, committed on-chain)`);

  // 5. buyer approves -> provider paid + reputation event
  const approveTx2 = await manager.approveDelivery(id);
  const approveRc2 = await approveTx2.wait();
  console.log(`[5] approveDelivery    tx: ${approveTx2.hash}`);
  const rep = approveRc2.logs.map((l) => { try { return manager.interface.parseLog(l); } catch { return null; } }).filter(Boolean).find((e) => e.name === "SettlementCompleted");
  if (rep) console.log(`    SettlementCompleted: outcome=${rep.args.outcome} amount=${hre.ethers.formatUnits(rep.args.amount, dec)} -> provider reputation indexed on-chain`);

  // 6. final state
  const p = await manager.getPayment(id);
  console.log(`\nFinal: status=${p[1]} (1=HELD 2=RELEASED 3=CANCELLED)  delivered=${p[10]}`);
  console.log(`Provider USDC: ${hre.ethers.formatUnits(await usdc.balanceOf(providerAddress), dec)}`);

  console.log("\n=== Submission proof — tx hashes ===");
  console.log(`settle:   ${explorer}/tx/${settleTx.hash}`);
  console.log(`deliver:  ${explorer}/tx/${deliverTx.hash}`);
  console.log(`approve:  ${explorer}/tx/${approveTx2.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
