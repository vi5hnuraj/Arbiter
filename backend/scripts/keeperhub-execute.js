/**
 * KeeperHub REAL USDC execution — the submission-proof script (USDC edition).
 *
 *   cd backend && node scripts/keeperhub-execute.js
 *
 * Broadcasts (for real, no simulate), all through KeeperHub (Turnkey wallet):
 *   1. USDC.approve(manager, amount)         — Circle USDC on Base Sepolia
 *   2. PaymentManager.settleInvoiceToken(id, receiver, ref, USDC, amount)
 *   3. waits for mining
 *   4. PaymentManager.releaseToken(id)
 *
 * Prints tx hashes, execution IDs, and explorer links — the "transaction
 * executed through KeeperHub" required by the submission form.
 * Amount defaults to 1 USDC; override with AMOUNT_USDC.
 */

import process from 'node:process';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const {
  dryRunContractCall,
  executeContractCall,
  probeConnection,
  MANAGER_ABI,
  ERC20_ABI,
  USDC_BASE_SEPOLIA,
  KEEPERHUB_CHAIN_ID
} = await import('../src/services/keeperHubService.js');

const MANAGER = process.env.KEEPERHUB_MANAGER_ADDRESS || '0x68320dD1dA703ad3fd975fb3628E84867e389e66';
const USDC = process.env.KEEPERHUB_USDC_ADDRESS || USDC_BASE_SEPOLIA;
const PROVIDER = process.env.SMOKE_PROVIDER_ADDRESS || '0xD25F8736C3Efc19a7cb7A3D15f2aF22c2980E317'; // demo provider (treasury)
const AMOUNT_USDC = process.env.AMOUNT_USDC || '1';

const amountUnits = ethers.parseUnits(AMOUNT_USDC, 6).toString();
const sessionId = `usdc-${Date.now()}`;
const paymentId = ethers.keccak256(ethers.toUtf8Bytes(`arbiter:purchase:${sessionId}`));
const invoiceRef = ethers.keccak256(ethers.toUtf8Bytes(`arbiter:invoice:${sessionId}`));

const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
const explorer = (tx) => `https://sepolia.basescan.org/tx/${tx}`;
const erc20 = new ethers.Contract(USDC, [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)'
], provider);

const approveCall = {
  label: 'USDC.approve',
  contractAddress: USDC,
  abi: ERC20_ABI,
  abiFunction: 'approve',
  args: [MANAGER, amountUnits],
  valueEther: '0'
};
const settleCall = {
  label: 'settleInvoiceToken',
  contractAddress: MANAGER,
  abi: MANAGER_ABI,
  abiFunction: 'settleInvoiceToken',
  args: [paymentId, PROVIDER, invoiceRef, USDC, amountUnits],
  valueEther: '0'
};
const releaseCall = {
  label: 'releaseToken',
  contractAddress: MANAGER,
  abi: MANAGER_ABI,
  abiFunction: 'releaseToken',
  args: [paymentId],
  valueEther: '0'
};

console.log(`REAL USDC EXECUTION via KeeperHub — chain ${KEEPERHUB_CHAIN_ID()}`);
console.log(`  manager : ${MANAGER}`);
console.log(`  usdc    : ${USDC}`);
console.log(`  provider: ${PROVIDER}`);
console.log(`  amount  : ${AMOUNT_USDC} USDC (${amountUnits} base units)`);
console.log(`  session : ${sessionId}\n`);

const balBefore = await erc20.balanceOf(PROVIDER);
console.log(`provider USDC balance before: ${ethers.formatUnits(balBefore, 6)}`);

try {
  console.log('── 0. Handshake + auth ──');
  await probeConnection();
  console.log('✅ connected');

  console.log('\n── 1. Dry run approve (gate) ──');
  const dryA = await dryRunContractCall(approveCall);
  if (dryA.wouldRevert === true) throw new Error('Approve dry run would revert — aborting.');
  console.log('✅ wouldRevert: false, gas:', dryA.gasEstimate);
  const approve = await executeContractCall(approveCall, { idempotencyKey: `keeperhub:approve:${sessionId}` });
  console.log('✅ approve tx:', approve.txHash);

  console.log('\n── 2. Dry run settleInvoiceToken (gate) ──');
  const dryS = await dryRunContractCall(settleCall);
  if (dryS.wouldRevert === true) throw new Error('Settle dry run would revert — aborting before broadcast.');
  console.log('✅ wouldRevert: false, gas:', dryS.gasEstimate);
  const settle = await executeContractCall(settleCall, { idempotencyKey: `keeperhub:settle:${sessionId}` });
  console.log('✅ settle tx:', settle.txHash);
  console.log('   ', explorer(settle.txHash));

  console.log('\n── 3. Waiting for settle to mine ──');
  const receipt = await provider.waitForTransaction(settle.txHash, 1, 120_000);
  if (!receipt || receipt.status !== 1) throw new Error(`Settle tx failed on-chain: ${settle.txHash}`);
  console.log(`✅ mined in block ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);

  console.log('\n── 4. Dry run releaseToken (gate) ──');
  const dryR = await dryRunContractCall(releaseCall);
  if (dryR.wouldRevert === true) throw new Error('Release dry run would revert — aborting before broadcast.');
  console.log('✅ wouldRevert: false, gas:', dryR.gasEstimate);
  const release = await executeContractCall(releaseCall, { idempotencyKey: `keeperhub:release:${sessionId}` });
  console.log('✅ release tx:', release.txHash);
  console.log('   ', explorer(release.txHash));

  console.log('\n── 5. Waiting for release to mine ──');
  const r2 = await provider.waitForTransaction(release.txHash, 1, 120_000);
  if (!r2 || r2.status !== 1) throw new Error(`Release tx failed on-chain: ${release.txHash}`);
  console.log(`✅ mined in block ${r2.blockNumber}, gas used ${r2.gasUsed}`);

  const balAfter = await erc20.balanceOf(PROVIDER);
  console.log(`provider USDC balance after : ${ethers.formatUnits(balAfter, 6)} (Δ ${ethers.formatUnits(balAfter - balBefore, 6)})`);

  console.log('\n════════════════════════════════════════════════');
  console.log('✅ USDC SETTLEMENT EXECUTED THROUGH KEEPERHUB');
  console.log('────────────────────────────────────────────────');
  console.log('approve           :', approve.txHash);
  console.log('settleInvoiceToken:', settle.txHash);
  console.log('releaseToken      :', release.txHash);
  console.log('paymentId         :', paymentId);
  console.log('session           :', sessionId);
  console.log('────────────────────────────────────────────────');
  console.log('Audit trail: app.keeperhub.com → Executions (direct executions)');
  console.log('Use the releaseToken tx hash in the DoraHacks submission form.');
} catch (err) {
  console.error('\n❌ EXECUTION FAILED:', err.message);
  if (err.keeperhubText) console.error('   detail:', err.keeperhubText.slice(0, 400));
  process.exit(1);
}
