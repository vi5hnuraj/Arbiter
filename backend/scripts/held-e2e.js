/**
 * End-to-end test of Held-mode x402 (escrow-by-substitution) — runs the real
 * service functions in-process against the LIVE ArbiterManager on
 * Arbitrum Sepolia. No mocks.
 *
 * Covers Held's thesis:
 *   1. The 402 challenge names the ESCROW CONTRACT as payTo (not the seller).
 *   2. The buyer settles into escrow; the deliverable returns IMMEDIATELY.
 *   3. approve  → seller paid                    (ending 1)
 *   4. reject   → buyer refunded                 (ending 2, before deadline)
 *   5. silence  → auto-resolve after the deadline (permissionless)
 *
 * Run: cd backend && node scripts/held-e2e.js
 */
import process from 'node:process';
import dotenv from 'dotenv';
import assert from 'node:assert';
import { ethers } from 'ethers';

dotenv.config({ override: true });
process.env.X402_HELD_ENABLED = "true";
process.env.MANAGER_ADDRESS = process.env.MANAGER_ADDRESS || process.env.ARBITER_MANAGER_ADDRESS;
process.env.X402_HELD_REVIEW_SECONDS = '60'; // short window so the auto test is quick

const USDC_ADDR = process.env.USDC_CONTRACT_ADDRESS || '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const MANAGER_ADDR = process.env.MANAGER_ADDRESS || process.env.ARBITER_MANAGER_ADDRESS;
if (!MANAGER_ADDR) throw new Error('MANAGER_ADDRESS not set — deploy first.');
if (!process.env.RELAYER_PRIVATE_KEY) throw new Error('RELAYER_PRIVATE_KEY not set.');

const RPC = process.env.ARC_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc';
const provider = new ethers.JsonRpcProvider(RPC);
const buyer = new ethers.Wallet(process.env.PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY, provider);
const seller = new ethers.Wallet(process.env.PROVIDER_KEY || process.env.RELAYER_PRIVATE_KEY, provider);
const usdc = new ethers.Contract(USDC_ADDR, [
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
], buyer);
const manager = new ethers.Contract(MANAGER_ADDR, [
  'function settleInvoiceUSDEscrow(bytes32,address,bytes32,address,uint256,uint256,bytes32,uint256)',
  'function quoteUSD(uint256) view returns (uint256,int256)',
], buyer);

const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
let passed = 0;
const ok = (label) => { passed += 1; console.log(`✅ ${label}`); };

const bal = (addr) => usdc.connect(provider).balanceOf(addr);

(async () => {
  const {
    buildHeldChallenge, openHeldJob, approveHeldJob, rejectHeldJob,
    autoResolveHeldJob, heldStats,
  } = await import('../src/services/heldService.js');

  // ── 1. The 402 challenge ──────────────────────────────────────────────
  const challenge = await buildHeldChallenge({ endpoint: '/api/x402/held/work' });
  assert(challenge.payTo.toLowerCase() === MANAGER_ADDR.toLowerCase(), 'payTo must be the escrow contract');
  assert((challenge.extensions?.held?.releasePolicy || '').length > 20, 'release policy advertised');
  console.log(`\n402 challenge: payTo=${challenge.payTo}`);
  console.log(`               amount=${Number(challenge.amount) / 1e6} USDC ($${(challenge.usdCents / 100).toFixed(2)})`);
  ok('1. 402 names the ESCROW CONTRACT as payTo (substitution, not the seller)');

  // ── 2. Buyer settles into escrow, deliverable returns immediately ─────
  const escrowId = challenge.escrowId;
  await (await usdc.approve(MANAGER_ADDR, ethers.MaxUint256)).wait();
  const settleTx = await (await manager.settleInvoiceUSDEscrow(
    escrowId, seller.address, ethers.id('held-terms'), USDC_ADDR,
    challenge.usdCents, ethers.MaxUint256, ethers.id('terms-json'), 60
  )).wait();
  assert(settleTx.status === 1);
  console.log(`settle: https://sepolia.arbiscan.io/tx/${settleTx.hash}`);

  const opened = await openHeldJob({
    escrowId, payer: buyer.address, txHash: settleTx.hash,
    endpoint: '/api/x402/held/work',
    deliverable: { answer: 'The deliverable the buyer reads before deciding.', confidence: 0.9 },
  });
  assert(opened.status === 'DELIVERED_AWAITING_REVIEW');
  assert((opened.deliverable.answer || '').length > 10, 'deliverable present');
  console.log(`deliverable returned with the payment receipt: "${opened.deliverable.answer}"`);
  ok('2. Pay → escrow HELD → deliverable returned in the SAME response');

  // ── 3. Ending: approve → seller paid ──────────────────────────────────
  const sellerBefore = await bal(seller.address);
  const approved = await approveHeldJob(escrowId);
  assert(approved.status === 2 /* RELEASED */);
  const sellerAfter = await bal(seller.address);
  assert(sellerAfter > sellerBefore, 'seller balance increased');
  console.log(`approve: https://sepolia.arbiscan.io/tx/${approved.txHash} → seller +${Number(sellerAfter - sellerBefore) / 1e6} USDC`);
  ok('3. APPROVE → seller paid on-chain');

  // ── 4. Ending: reject → buyer refunded ────────────────────────────────
  const escrow2 = ethers.keccak256(ethers.toUtf8Bytes(`held-reject-${Date.now()}`));
  await (await manager.settleInvoiceUSDEscrow(
    escrow2, seller.address, ethers.id('t2'), USDC_ADDR, 100, ethers.MaxUint256, ethers.id('terms'), 3600
  )).wait();
  const buyerBefore = await bal(buyer.address);
  const rejected = await rejectHeldJob(escrow2);
  assert(rejected.status === 3 /* CANCELLED */);
  const buyerAfter = await bal(buyer.address);
  assert(buyerAfter > buyerBefore, 'buyer refunded');
  console.log(`reject: https://sepolia.arbiscan.io/tx/${rejected.txHash} → buyer refunded`);
  ok('4. REJECT (before deadline) → buyer refunded');

  // ── 5. Ending: silence → auto-resolve after the deadline ──────────────
  const escrow3 = ethers.keccak256(ethers.toUtf8Bytes(`held-auto-${Date.now()}`));
  const managerAsSeller = manager.connect(seller);
  await (await usdc.connect(seller).approve(MANAGER_ADDR, ethers.MaxUint256)).wait();
  await (await managerAsSeller.settleInvoiceUSDEscrow(
    escrow3, seller.address, ethers.id('t3'), USDC_ADDR, 100, ethers.MaxUint256, ethers.id('terms'), 60
  )).wait();
  console.log('nobody acts… waiting 65s past the 60s deadline');
  await new Promise((r) => setTimeout(r, 65_000));
  const sellerBefore3 = await bal(seller.address);
  const auto = await autoResolveHeldJob(escrow3); // permissionless — anyone fires it
  assert([2, 3].includes(auto.status));
  const sellerAfter3 = await bal(seller.address);
  const paid = auto.status === 2;
  if (paid) assert(sellerAfter3 > sellerBefore3, 'seller paid by auto-resolve');
  console.log(`auto: https://sepolia.arbiscan.io/tx/${auto.txHash} → ${paid ? 'seller paid (delivered)' : 'buyer refunded (undelivered)'}`);
  ok('5. SILENCE → permissionless auto-resolve at the deadline');

  const stats = heldStats();
  console.log(`\n════ HELD E2E: ${passed}/5 PASSED ════`);
  console.log(`manager: ${stats.manager} · price $${(stats.priceUsdCents / 100).toFixed(2)} · review ${stats.reviewSeconds}s`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ E2E ERROR:', e.message); process.exit(1); });
