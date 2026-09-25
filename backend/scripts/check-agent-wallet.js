/* One-off diagnostic — check an agent's wallet wiring vs on-chain funding.
 *   node scripts/check-agent-wallet.js [agentIdOrSlug] [fundedAddress]
 */
import 'dotenv/config';
import pg from 'pg';

const agentKey = process.argv[2] || 'agt_d0c866e05cde1ce3';
const funded = (process.argv[3] || 'ac191f7ba325e6cac7b3d46c356458391b14be98').toLowerCase();

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL,
});

const a = await pool.query(
  'SELECT * FROM ai_agents WHERE agent_id = $1 OR id::text = $1 LIMIT 1',
  [agentKey]
);
if (!a.rows[0]) {
  console.log('NO AGENT FOUND for', agentKey);
  const guess = await pool.query(
    "SELECT id, agent_id, agent_name, wallet_address FROM ai_agents ORDER BY created_at DESC LIMIT 5"
  );
  console.log('Recent agents:', JSON.stringify(guess.rows, null, 2));
  await pool.end();
  process.exit(0);
}
const agent = a.rows[0];
console.log('AGENT:', JSON.stringify({
  id: agent.id, agent_id: agent.agent_id, agent_name: agent.agent_name,
  wallet_address: agent.wallet_address,
  wallet_provider: agent.wallet_provider,
  internal_wallet_address: agent.internal_wallet_address,
}, null, 2));

const addr = (agent.wallet_address || agent.internal_wallet_address || '').toLowerCase();
console.log('\nagent record address:', addr || '(none)');
console.log('funded address:      0x' + funded);
console.log('MATCH:', addr === '0x' + funded ? 'YES ✅' : 'NO ❌');

const w = await pool.query(
  'SELECT * FROM mpc_wallets WHERE lower(address) = $1 LIMIT 2', // address
  ['0x' + funded]
);
console.log('\nmpc_wallets row for funded addr:', JSON.stringify(w.rows, null, 2));

const owned = await pool.query(
  'SELECT id, address, provider FROM mpc_wallets WHERE owner_id::text = $1 OR agent_id::text = $1 LIMIT 5',
  [agent.id]
);
console.log('\nmpc_wallets owned by agent:', JSON.stringify(owned.rows, null, 2));

await pool.end();
