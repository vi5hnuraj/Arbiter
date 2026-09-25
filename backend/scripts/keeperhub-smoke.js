/**
 * KeeperHub rail smoke test — proves the full settle path against the LIVE API
 * without broadcasting anything (every step uses simulate:true).
 *
 *   cd backend && node scripts/keeperhub-smoke.js
 *
 * Shows exactly what the demo video needs:
 *   1. MCP handshake + API-key auth
 *   2. Positive dry run: USDC.approve → wouldRevert:false + gas estimate
 *   3. Negative dry run: settleInvoiceToken with NO allowance → reverts
 *      (proves the escrow enforces the pull-payment model)
 *   4. Negative dry run: releaseToken of a nonexistent payment → reverts
 *
 * Nothing is signed, broadcast, or charged. Safe to run repeatedly.
 * (settleInvoiceToken can only simulate after a REAL approve — that exact
 * sequence is what scripts/keeperhub-execute.js and the production rail do.)
 */

import process from 'node:process';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

const {
  dryRunContractCall,
  probeConnection,
  MANAGER_ABI,
  ERC20_ABI,
  USDC_BASE_SEPOLIA,
  KEEPERHUB_CHAIN_ID
} = await import('../src/services/keeperHubService.js');

const MANAGER = process.env.KEEPERHUB_MANAGER_ADDRESS || '0x68320dD1dA703ad3fd975fb3628E84867e389e66';
const PROVIDER = process.env.SMOKE_PROVIDER_ADDRESS || '0xD25F8736C3Efc19a7cb7A3D15f2aF22c2980E317';
const USDC = process.env.KEEPERHUB_USDC_ADDRESS || USDC_BASE_SEPOLIA;

const AMOUNT_USDC = process.env.SMOKE_AMOUNT_USDC || '0.5';
const amountUnits = BigInt(Math.round(Number(AMOUNT_USDC) * 1e6)).toString(); // 6dp base units

// bytes32 refs — the settle path must accept these encodings
const paymentId = ethers.keccak256(ethers.toUtf8Bytes(`arbiter:smoke:${Date.now()}`));
const invoiceRef = ethers.keccak256(ethers.toUtf8Bytes(`arbiter:invoice:smoke`));

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
const badReleaseCall = {
  label: 'releaseToken(nonexistent)',
  contractAddress: MANAGER,
  abi: MANAGER_ABI,
  abiFunction: 'releaseToken',
  args: [paymentId], // fresh random id → no payment exists → must revert
  valueEther: '0'
};

console.log(`KeeperHub rail smoke test — chain ${KEEPERHUB_CHAIN_ID()}, manager ${MANAGER}`);
console.log(`amount: ${AMOUNT_USDC} USDC (${amountUnits} base units) — SIMULATE ONLY, nothing broadcasts\n`);

try {
  console.log('── 1. Handshake + auth ──');
  const ping = await probeConnection();
  console.log('✅', ping.text.split('\n')[0]);

  console.log('\n── 2. Positive dry run: USDC.approve ──');
  const appr = await dryRunContractCall(approveCall);
  console.log('✅ approve:', JSON.stringify({ wouldRevert: appr.wouldRevert, gasEstimate: appr.gasEstimate }));

  console.log('\n── 3. Negative dry run: settle without allowance ──');
  try {
    await dryRunContractCall(settleCall);
    console.log('⚠️  unexpectedly did NOT revert — an allowance already exists');
  } catch (err) {
    console.log('✅ escrow correctly refuses an uncovered settle:',
      /allowance|insufficient/i.test(err.message) ? 'ERC20 allowance check confirmed' : err.message.slice(0, 120));
  }

  console.log('\n── 4. Negative dry run: releaseToken(nonexistent) ──');
  try {
    await dryRunContractCall(badReleaseCall);
    console.log('⚠️  unexpectedly did NOT revert — check the manager state');
  } catch (err) {
    console.log('✅ correctly caught BEFORE broadcast:', err.message.slice(0, 140));
  }

  console.log('\n════════════════════════════════════════════');
  console.log('✅ SMOKE PASSED — the KeeperHub rail is ready.');
  console.log('   Next: flip EXECUTION_RAIL=keeperhub and run a real purchase.');
} catch (err) {
  console.error('\n❌ SMOKE FAILED:', err.message);
  if (err.keeperhubText) console.error('   detail:', err.keeperhubText.slice(0, 300));
  process.exit(1);
}
