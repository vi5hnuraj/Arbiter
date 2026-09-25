/**
 * KeeperHub rail probe — run this BEFORE attempting a real settlement.
 *
 *   cd backend
 *   KEEPERHUB_API_KEY=kh_... node scripts/keeperhub-probe.js
 *
 * Verifies, in order:
 *   1. API key authenticates against the hosted MCP endpoint
 *   2. The exact execute_contract_call argument schema (so the settle flow
 *      uses the right field names — see MCP_ARG_FIELD in keeperHubService)
 *   3. That Base Sepolia (84532) is available in the org's action schemas
 *   4. The org's Turnkey wallet is provisioned (get_wallet_integration)
 *
 * Exit code 0 = ready to route a purchase through the KeeperHub rail.
 */

import process from 'node:process';
import dotenv from 'dotenv';

// Auto-load backend/.env so the API key never has to appear in a shell command.
dotenv.config();

const BASE_URL = (process.env.KEEPERHUB_BASE_URL || 'https://app.keeperhub.com').replace(/\/+$/, '');
const API_KEY = process.env.KEEPERHUB_API_KEY || '';

if (!API_KEY.startsWith('kh_')) {
  console.error('❌ KEEPERHUB_API_KEY missing or malformed (expected kh_...).');
  process.exit(1);
}

let requestId = 0;
let sessionId = null;

const post = async (body) => {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${API_KEY}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
    },
    body: JSON.stringify(body)
  });
  return res;
};

const parse = async (res) => {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const raw = await res.text();
    let payload = null;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { payload = JSON.parse(line.slice(5).trim()); } catch { /* partial */ }
    }
    return payload;
  }
  if (res.status === 202) return null;
  return res.json().catch(() => null);
};

// MCP Streamable-HTTP handshake: initialize → notifications/initialized.
// KeeperHub rejects tools/call before this (error -32003).
const initSession = async () => {
  const res = await post({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'keeperhub-probe', version: '1.0.0' }
    }
  });
  if (res.status === 401) throw new Error('401 — API key rejected');
  const payload = await parse(res);
  if (payload?.error) throw new Error(`initialize failed: ${JSON.stringify(payload.error).slice(0, 200)}`);
  sessionId = res.headers.get('mcp-session-id');
  console.log(`✅ Handshake OK (session ${sessionId ? sessionId.slice(0, 8) + '…' : 'stateless'})`);
  const nres = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  if (nres.status !== 202 && nres.status !== 200) throw new Error(`initialized notification -> HTTP ${nres.status}`);
};

const mcpCall = async (tool, args = {}) => {
  const res = await post({
    jsonrpc: '2.0',
    id: ++requestId,
    method: 'tools/call',
    params: { name: tool, arguments: args }
  });
  if (!res.ok && res.status !== 202) {
    const text = await res.text().catch(() => '');
    throw new Error(`MCP ${tool} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const payload = await parse(res);
  if (payload?.error) throw new Error(`MCP ${tool} -> JSON-RPC error: ${JSON.stringify(payload.error).slice(0, 300)}`);
  const result = payload?.result;
  const text = Array.isArray(result?.content)
    ? result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    : '';
  if (result?.isError) throw new Error(`MCP ${tool} -> tool error: ${text.slice(0, 300)}`);
  return { text, structured: result?.structuredContent ?? null };
};

const pickJson = (text) => {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try { return JSON.parse(text.slice(start)); } catch {
    // Fall back to the whole text as JSON.
    try { return JSON.parse(text); } catch { return null; }
  }
};

const section = (title) => console.log(`\n──── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);

try {
  await initSession();

  section('1. API key authentication');
  const limits = await mcpCall('get_spending_limits', {});
  console.log('✅ Authenticated. get_spending_limits:');
  console.log((limits.structured ? JSON.stringify(limits.structured, null, 2) : limits.text).slice(0, 600));

  section('2. execute_contract_call argument schema');
  const schemas = await mcpCall('list_action_schemas', { category: 'web3' });
  const parsed = schemas.structured || pickJson(schemas.text) || null;
  const dumped = JSON.stringify(parsed, null, 2);
  const match = dumped.match(/\{[^{}]*"execute_contract_call"[\s\S]{0,1200}/);
  if (match) {
    console.log(match[0].slice(0, 1200));
    const fieldGuess = ['args', 'arguments', 'callData', 'calldata', 'data', 'params'].find((f) => dumped.includes(`"${f}"`));
    console.log(`\n→ Likely positional-args field name: "${fieldGuess || '(not found — inspect above)'}"`);
    console.log('→ If it is not "args", set KEEPERHUB_MCP_ARG_FIELD in backend .env accordingly.');
  } else {
    console.log('Could not isolate the execute_contract_call schema — full dump follows.');
    console.log(dumped.slice(0, 2500));
  }

  section('3. Base Sepolia (84532) availability');
  const hasBase = dumped.includes('84532') || dumped.toLowerCase().includes('base sepolia');
  console.log(hasBase
    ? '✅ Base Sepolia appears in the action schemas.'
    : '⚠️  Base Sepolia NOT found in the dumped schemas — verify at GET /api/chains.');

  section('4. Wallet integration');
  try {
    const wallet = await mcpCall('get_wallet_integration', {});
    console.log('✅ Wallet integration present:');
    console.log((wallet.structured ? JSON.stringify(wallet.structured, null, 2) : wallet.text).slice(0, 600));
  } catch (err) {
    console.log(`⚠️  get_wallet_integration: ${err.message}`);
    console.log('   (Writes require the org wallet — provision it in app.keeperhub.com if missing.)');
  }

  section('RESULT');
  console.log('✅ Probe complete. If sections 1–4 look right, set in backend .env:\n');
  console.log('   KEEPERHUB_API_KEY=kh_...');
  console.log('   EXECUTION_RAIL=keeperhub');
  console.log('   KEEPERHUB_CHAIN_ID=84532');
  console.log('   ARBITER_MANAGER_ADDRESS=<Base Sepolia deployment of ArbiterPaymentManager>');
  console.log('   # Only if step 2 showed a different field name:');
  console.log('   # KEEPERHUB_MCP_ARG_FIELD=<field>');
  process.exit(0);
} catch (err) {
  console.error(`\n❌ Probe failed: ${err.message}`);
  process.exit(1);
}
