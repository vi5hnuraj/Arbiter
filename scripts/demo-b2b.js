/**
 * Live B2B engagement demo on Arbitrum Sepolia — Pact-style mutual commitment,
 * executed end to end against the deployed ArbiterManager:
 *
 *   ① PROPOSE  client commits exact terms (termsHash) and names the provider
 *   ② ACCEPT   provider signs the IDENTICAL terms hash — commitment is mutual
 *   ③ FUND     client's USDC enters review-window escrow at the live Chainlink rate
 *   ④ DELIVER  provider commits the deliverable's content fingerprint
 *   ⑤ APPROVE  client releases payment — portable reputation increments
 *
 * Run:  npm run demo:b2b
 * Env:  MANAGER_ADDRESS + USDC_ADDRESS in .env (set by scripts/deploy.js output)
 */
require("dotenv").config();
const hre = require("hardhat");

const EXPLORER = "https://sepolia.arbiscan.io";
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;

(async () => {
  const [client, provider] = await hre.ethers.getSigners();
  const managerAddress = process.env.MANAGER_ADDRESS;
  const usdcAddress = process.env.USDC_ADDRESS;
  if (!managerAddress || !usdcAddress) throw new Error("Set MANAGER_ADDRESS and USDC_ADDRESS in .env first (deploy prints them).");

  const manager = await hre.ethers.getContractAt("ArbiterManager", managerAddress);
  const usdc = await hre.ethers.getContractAt(
    ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    usdcAddress
  );

  console.log(`\n=== Arbiter B2B Engagement — live on Arbitrum Sepolia ===`);
  console.log(`contract : ${managerAddress}`);
  console.log(`client   : ${client.address}`);
  console.log(`provider : ${provider.address}`);

  // The engagement id and canonical terms (in production this JSON lives on
  // IPFS / an ENS text record; its hash is what the chain enforces).
  const engagementId = hre.ethers.id(`arbiter-b2b-${Date.now()}`);
  const terms = {
    service: "Website Redesign",
    scope: "Landing page + 3 subpages, desktop and mobile",
    acceptanceCriteria: "Design sign-off by client within the review window",
    priceUSD: 5.0,
    currency: "USDC",
    network: "Arbitrum Sepolia",
  };
  const termsHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(JSON.stringify(terms)));

  // ① PROPOSE — no money moves
  const p1 = await (await manager.connect(client).proposeEngagement(
    engagementId, provider.address, usdcAddress, 500 /* $5.00 */, 0, termsHash
  )).wait();
  console.log(`\n① PROPOSED  termsHash=${termsHash.slice(0, 14)}… tx ${short(p1.hash)}`);

  // ② ACCEPT — provider signs the identical hash
  const p2 = await (await manager.connect(provider).acceptEngagement(engagementId, termsHash)).wait();
  console.log(`② ACCEPTED  (mutual commitment) tx ${short(p2.hash)}`);

  // ③ FUND — Chainlink-priced USDC into review-window escrow
  await (await usdc.connect(client).approve(managerAddress, hre.ethers.MaxUint256)).wait();
  const p3 = await (await manager.connect(client).fundEngagement(engagementId, 100e6, 3600)).wait();
  const usdEv = p3.logs.map((l) => { try { return manager.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "USDSettled");
  console.log(`③ FUNDED    ${hre.ethers.formatUnits(usdEv.args.amount, 6)} USDC for $${(Number(usdEv.args.usdCents) / 100).toFixed(2)} @ Chainlink ${(Number(usdEv.args.price) / 1e8).toFixed(8)}  tx ${short(p3.hash)}`);

  // ④ DELIVER — provider commits the deliverable fingerprint
  const deliverableHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("deliverable: final design files v1"));
  const p4 = await (await manager.connect(provider).markDelivered(engagementId, deliverableHash)).wait();
  console.log(`④ DELIVERED evidence=${deliverableHash.slice(0, 14)}…  tx ${short(p4.hash)}`);

  // ⑤ APPROVE — client releases; reputation increments on-chain
  const p5 = await (await manager.connect(client).approveDelivery(engagementId)).wait();
  console.log(`⑤ APPROVED  provider paid  tx ${short(p5.hash)}`);

  const completed = await manager.engagementsCompleted(provider.address);
  const [, status] = await manager.getPayment(engagementId);
  console.log(`\nprovider on-chain track record: ${completed} completed engagement(s)`);
  console.log(`escrow status: ${status === 2n ? "RELEASED ✅" : status}`);

  console.log(`\n── Proof links ──`);
  for (const [label, r] of [["propose", p1], ["accept", p2], ["fund", p3], ["deliver", p4], ["approve", p5]]) {
    console.log(`${label.padEnd(8)} ${EXPLORER}/tx/${r.hash}`);
  }
  console.log(`\nEngagement ${engagementId}`);
})().catch((e) => { console.error("\n❌ DEMO ERROR:", e.message); process.exit(1); });
