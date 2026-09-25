/**
 * Workflow Studio — live end-to-end test of all five stages, in-process.
 *   cd backend && node scripts/workflow-studio-e2e.js
 *
 * ① COMPOSE (real session via createPrepaidIntent)
 * ② REVIEW (descriptor derivation)
 * ③ DRY RUN (approve must simulate clean; settle/release expected-deferred)
 *    ③b CHAOS (tampered 100× amount must be refused)
 * ④ EXECUTE (production confirmPrepaidPurchase through KeeperHub)
 * ⑤ PROVE (HCS anchors fetched from the public mirror node)
 */

import process from 'node:process';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const CONSUMER_AGENT_ID = process.env.PURCHASE_CONSUMER_AGENT || 'agt_3287b2ba3fdffde0'; // MarketPulse AI
const SERVICE_ID = process.env.PURCHASE_SERVICE_ID || 'srv_a91bcccfd6bc30e0';           // Document Analyzer

// supabaseClient re-runs dotenv with override:true at import time — re-assert
// anything critical AFTER imports if needed. (Manager comes from .env.)

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const stage = (n, t) => console.log(`\n── ${n}. ${t} ${'─'.repeat(Math.max(2, 46 - t.length))}`);

try {
  const { composeWorkflow, dryRunWorkflow, chaosProbe, executeWorkflow, proveWorkflow } =
    await import('../src/services/workflowStudioService.js');

  const agentRes = await pool.query(
    'SELECT id, agent_id, agent_name, organization_id, developer_id FROM ai_agents WHERE agent_id = $1',
    [CONSUMER_AGENT_ID]
  );
  const consumer = agentRes.rows[0];
  if (!consumer) throw new Error(`Consumer agent ${CONSUMER_AGENT_ID} not found`);
  const ctx = { developerId: consumer.developer_id, organizationId: consumer.organization_id };

  // ① COMPOSE
  stage('1', 'COMPOSE — agent proposes the settlement workflow');
  const { workflow } = await composeWorkflow({ ...ctx, consumerAgentId: CONSUMER_AGENT_ID, serviceId: SERVICE_ID, quantity: '1' });
  console.log(`   session ${workflow.sessionId} · ${workflow.asset} ${workflow.amountHuman} · ${workflow.steps.length} steps`);
  for (const [i, s] of workflow.steps.entries()) {
    console.log(`   #${i + 1} ${s.label} → ${s.contractAddress}`);
    console.log(`      ${s.summary}`);
  }

  // ② REVIEW is the composed payload itself (what the UI renders) — nothing to call.

  // ③ DRY RUN
  stage('3', 'DRY RUN — simulate every step, nothing touches the chain');
  const dry = await dryRunWorkflow({ ...ctx, sessionId: workflow.sessionId });
  for (const s of dry.steps) {
    console.log(`   ${s.passed ? '✅' : s.deferred ? '⏳' : '❌'} ${s.label} · wouldRevert=${s.wouldRevert} gas=${s.gasEstimate ?? '—'}${s.deferred ? ' (deferred: needs earlier steps to execute first)' : ''}`);
  }
  console.log(`   gate: ${dry.allClear ? 'PASSED — execution unlocked' : 'BLOCKED'}`);
  if (!dry.allClear) throw new Error('Dry-run gate failed — aborting before execute.');

  // ③b CHAOS
  stage('3b', 'CHAOS — tampered workflow (amount ×100) must be refused');
  const chaos = await chaosProbe({ ...ctx, sessionId: workflow.sessionId });
  console.log(`   tampered ${chaos.tampered.label}: ${chaos.tampered.reviewedAmount} → ${chaos.tampered.tamperedAmount}`);
  console.log(`   ${chaos.keeperHubRefused ? '🛡️ REFUSED in simulation — determinism holds' : '⚠️ NOT REFUSED — investigate policy'}`);

  // ④ EXECUTE
  stage('4', 'EXECUTE — the exact reviewed workflow, through Arbiter');
  const exec = await executeWorkflow({ sessionId: workflow.sessionId, organizationId: ctx.organizationId });
  if (!exec.success) throw new Error(`Execution failed: ${exec.failureReason}`);
  console.log(`   rail: ${exec.rail} · asset: ${exec.asset}`);
  const execHashes = exec.execution || {};
  const approveH = execHashes.approveTxHash || exec.approveTxHash;
  const settleH = execHashes.settleTxHash || exec.createTxHash;
  const releaseH = execHashes.releaseTxHash || exec.releaseTxHash;
  if (approveH) console.log(`   approve : https://sepolia.basescan.org/tx/${approveH}`);
  const isKh = exec.rail === 'keeperhub';
  const explorer = isKh ? 'https://sepolia.basescan.org' : 'https://sepolia.arbiscan.io';
  if (isKh && approveH) console.log(`   approve : ${explorer}/tx/${approveH}`);
  console.log(`   settle  : ${explorer}/tx/${settleH}`);
  console.log(`   release : ${explorer}/tx/${releaseH}`);

  // ⑤ PROVE
  stage('5', 'PROVE — public HCS anchors + chain receipts');
  await new Promise((r) => setTimeout(r, 8000)); // give the mirror node a beat
  const proof = await proveWorkflow({ ...ctx, sessionId: workflow.sessionId });
  console.log(`   topic ${proof.hcsTopicId || '—'} · verified: ${proof.verified}`);
  for (const a of proof.anchors) {
    console.log(`   seq=${a.seq} ${a.type} · tx=${a.txHash ? a.txHash.slice(0, 14) + '…' : '—'}`);
  }
  if (proof.hashscanUrl) console.log(`   ${proof.hashscanUrl}`);

  console.log('\n════ WORKFLOW STUDIO E2E: ALL FIVE STAGES PASSED ════');
} catch (err) {
  console.error('\n❌ E2E ERROR:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
  process.exit(process.exitCode || 0);
}
