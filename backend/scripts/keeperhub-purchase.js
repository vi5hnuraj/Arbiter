/**
 * Full purchase flow through the KeeperHub rail — end-to-end, in-process.
 *
 *   cd backend && node scripts/keeperhub-purchase.js
 *
 * Drives the exact production path (no mocks):
 *   createPrepaidIntent()   → Trust Engine + policy + session row (awaiting_payment)
 *   confirmPrepaidPurchase()→ dry-run settle → settleInvoice → dry-run release
 *                             → release → usage + invoice + credits
 * with EXECUTION_RAIL=keeperhub both settlements execute through KeeperHub
 * (Turnkey org wallet) on Base Sepolia.
 *
 * Entities are read live from the database: pick a consumer agent + service
 * via env, or the defaults below (real seeded demo data).
 */

import process from 'node:process';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const CONSUMER_AGENT_ID = process.env.PURCHASE_CONSUMER_AGENT || 'agt_3287b2ba3fdffde0'; // MarketPulse AI
const SERVICE_ID = process.env.PURCHASE_SERVICE_ID || 'srv_a91bcccfd6bc30e0';           // Document Analyzer (0.01/unit)
const QUANTITY = process.env.PURCHASE_QUANTITY || '1';

const { createPrepaidIntent, confirmPrepaidPurchase } = await import('../src/services/commerceService.js');

// src/config/supabaseClient.js runs dotenv.config({ override: true }) at import
// time, which clobbers inline env vars. Re-assert the manager after imports —
// settlement reads it at call time. (Best: set KEEPERHUB_MANAGER_ADDRESS in .env.)
if (process.env.FORCE_KEEPERHUB_MANAGER) {
  process.env.KEEPERHUB_MANAGER_ADDRESS = process.env.FORCE_KEEPERHUB_MANAGER;
}

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

console.log(`Full purchase via KeeperHub rail
  consumer: ${CONSUMER_AGENT_ID}
  service : ${SERVICE_ID}
  quantity: ${QUANTITY}\n`);

try {
  const agentRes = await pool.query('SELECT id, agent_id, agent_name, organization_id, developer_id FROM ai_agents WHERE agent_id = $1', [CONSUMER_AGENT_ID]);
  const consumer = agentRes.rows[0];
  if (!consumer) throw new Error(`Consumer agent ${CONSUMER_AGENT_ID} not found`);

  const svcRes = await pool.query('SELECT service_id, title, unit_price FROM ai_services WHERE service_id = $1 AND is_active = true', [SERVICE_ID]);
  const service = svcRes.rows[0];
  if (!service) throw new Error(`Service ${SERVICE_ID} not found or inactive`);

  console.log(`→ "${service.title}" @ ${service.unit_price}/unit, consumer: ${consumer.agent_name} (${consumer.agent_id})`);

  console.log('\n── 1. createPrepaidIntent (Trust Engine + policy + session) ──');
  const intent = await createPrepaidIntent({
    developerId: consumer.developer_id,
    organizationId: consumer.organization_id,
    consumerAgent: { id: consumer.id, agent_id: consumer.agent_id },
    service: { service_id: service.service_id },
    quantity: QUANTITY
  });
  const sessionId = intent.session.sessionId || intent.session.session_id;
  console.log(`✅ session ${sessionId} — awaiting_payment, estimated ${intent.session.estimatedCostBOT} ETH`);

  console.log('\n── 2. confirmPrepaidPurchase (KeeperHub settle + release) ──');
  const result = await confirmPrepaidPurchase({ sessionId, organizationId: consumer.organization_id });

  console.log('\n════════════════════════════════════════════════');
  if (result.failed) {
    console.error('❌ PURCHASE FAILED:', result.failureReason);
    process.exitCode = 1;
  } else {
    console.log('✅ PURCHASE SETTLED THROUGH KEEPERHUB');
    console.log('  session   :', sessionId);
    console.log('  status    :', result.session?.status);
    console.log('  rail      :', result.rail || 'keeperhub');
    console.log('  settle tx :', result.createTxHash || result.txHash);
    console.log('  release tx:', result.releaseTxHash || result.txHash);
    if (result.session?.credits_granted !== undefined) console.log('  credits   :', result.session.credits_granted);
    const settle = result.createTxHash || result.txHash;
    if (settle) console.log(`\n  https://sepolia.basescan.org/tx/${settle}`);
  }
} catch (err) {
  console.error('\n❌ FLOW ERROR:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
  process.exit(process.exitCode || 0);
}
