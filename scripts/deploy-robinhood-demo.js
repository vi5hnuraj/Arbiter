const hre = require("hardhat");

/**
 * All-in-one Robinhood Chain testnet run:
 *   1. Deploy ArbiterManager (fixed 1.0 price fallback — no feed on testnet)
 *   2. Deploy MockUSDC (testnet has no public testnet USDC yet; swap the address when it exists)
 *   3. Run the full escrow flow: approve -> settle(HELD) -> markDelivered -> approveDelivery(RELEASED)
 * Prints every tx hash for the deployment.
 */
const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const SERVICE_USD_CENTS = 100n; // $1.00

async function main() {
  const [consumer] = await hre.ethers.getSigners();
  console.log(`\n=== Arbiter on Robinhood Chain testnet ===`);
  console.log(`Deployer/consumer: ${consumer.address}`);

  const eth = await hre.ethers.provider.getBalance(consumer.address);
  console.log(`Gas ETH: ${hre.ethers.formatEther(eth)}`);
  if (eth === 0n) throw new Error("No gas — claim https://faucet.testnet.chain.robinhood.com/");

  // 1. Manager (fixed 1.0 fallback pricing)
  const M = await hre.ethers.getContractFactory("ArbiterManager");
  const manager = await M.deploy(hre.ethers.ZeroAddress, 6);
  await manager.waitForDeployment();
  const managerAddress = await manager.getAddress();
  console.log(`\n[1] Manager deployed:  ${managerAddress}`);
  console.log(`    ${EXPLORER}/address/${managerAddress}`);

  // 2. Mock USDC (placeholder until Robinhood ships a public testnet USDC)
  const T = await hre.ethers.getContractFactory("MockERC20");
  const usdc = await T.deploy();
  await usdc.waitForDeployment();
  const usdcAddress = await usdc.getAddress();
  console.log(`[2] Mock USDC deployed: ${usdcAddress}`);
  console.log(`    ${EXPLORER}/address/${usdcAddress}`);

  // 3. Full escrow flow — consumer already holds 1,000,000 mock USDC
  const amount = await (async () => (await manager.quoteUSD(SERVICE_USD_CENTS))[0])();
  console.log(`\n[3] $1.00 service = ${hre.ethers.formatUnits(amount, 6)} USDC (fixed 1.0 pricing)`);

  const maxAmount = amount + 1n;
  const approveTx = await (await usdc.connect(consumer).approve(managerAddress, maxAmount)).wait();
  console.log(`[4] approve            tx: ${approveTx.hash}`);

  const id = hre.ethers.id(`demo-rhc-${Date.now()}`);
  const invoiceRef = hre.ethers.id("arbiter-robinhood-demo");
  const termsHash = hre.ethers.id(JSON.stringify({ service: "demo-ocr", price: "$1.00", sla: "24h" }));
  const settleTx = await (await manager
    .connect(consumer)
    .settleInvoiceUSDEscrow(id, consumer.address, invoiceRef, usdcAddress, SERVICE_USD_CENTS, maxAmount, termsHash, 3600)).wait();
  console.log(`[5] settle (HELD)      tx: ${settleTx.hash}`);

  const deliverTx = await (await manager.connect(consumer).markDelivered(id, hre.ethers.id("service-output"))).wait();
  console.log(`[6] markDelivered      tx: ${deliverTx.hash}`);

  const approveTx2 = await (await manager.connect(consumer).approveDelivery(id)).wait();
  console.log(`[7] approveDelivery    tx: ${approveTx2.hash}`);

  const p = await manager.getPayment(id);
  console.log(`\nFinal: status=${p[1]} (1=HELD 2=RELEASED 3=CANCELLED) delivered=${p[10]}`);

  console.log("\n=== Submission proof ===");
  console.log(`manager:  ${EXPLORER}/address/${managerAddress}`);
  console.log(`settle:   ${EXPLORER}/tx/${settleTx.hash}`);
  console.log(`deliver:  ${EXPLORER}/tx/${deliverTx.hash}`);
  console.log(`approve:  ${EXPLORER}/tx/${approveTx2.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
