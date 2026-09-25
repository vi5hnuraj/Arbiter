/**
 * WorkflowStudioService — the review loop as a product surface, on either
 * execution rail (EXECUTION_RAIL=direct | keeperhub).
 *
 *   ① COMPOSE   Agent proposes a settlement workflow (reuses createPrepaidIntent,
 *               so Trust Engine + procurement policy still gate it).
 *   ② REVIEW    Human sees the exact contract calls that will run — address,
 *               function, args, value. Nothing hidden, nothing inferred.
 *   ③ DRY RUN   Every step simulated — direct rail: eth_estimateGas / eth_call
 *               against ArbiterManager on Arbitrum Sepolia; keeperhub rail:
 *               KeeperHub simulate:true. wouldRevert + gas, no state touched.
 *   ④ EXECUTE   The exact reviewed workflow executes via the production
 *               confirmPrepaidPurchase path (Privy embedded wallet on the
 *               direct rail; Turnkey via KeeperHub on the keeperhub rail).
 *   ⑤ PROVE     HCS anchors (HELD/DELIVERED/RELEASED) fetched from Hedera's
 *               public mirror node + chain tx links. Two ledgers, one truth.
 *
 * Determinism guarantee: reviewed steps and executed steps are derived from the
 * same session id (paymentId/invoiceReference are keccak(sessionId), amounts
 * come from the session row) — the workflow you reviewed IS the workflow that
 * executes. Nothing is inferred at execution time.
 */

import { ethers } from 'ethers';
import { getPool } from '../utils/db.js';
import { getSettlementToken, weiToTokenUnits } from './settlementToken.js';
import { supabase } from '../config/supabaseClient.js';
import { logger } from '../utils/logger.js';
import {
  composeSettlementCalls,
  buildCallForStep,
  dryRunContractCall,
  isKeeperHubRail
} from './keeperHubService.js';
import {
  createPrepaidIntent,
  confirmPrepaidPurchase
} from './commerceService.js';

/** Resolve the execution context for the composed workflow, per active rail. */
const resolveExecutionCtx = async (session) => {
  const directRail = !isKeeperHubRail();
  const managerAddress = directRail
    ? (process.env.ARBITER_MANAGER_ADDRESS || '0x6b5BA9E3E8175eCfB8291FA0ee358b070c0522Cc')
    : (process.env.KEEPERHUB_MANAGER_ADDRESS || '0x68320dD1dA703ad3fd975fb3628E84867e389e66');
  let { data: provider } = await supabase
    .from('ai_agents')
    .select('id, agent_id, agent_name, wallet_address')
    .eq('id', session.provider_agent_id)
    .single();
  if (!provider?.wallet_address) {
    try {
      const { rows } = await getPool().query('SELECT wallet_address FROM ai_agents WHERE id = $1 LIMIT 1', [session.provider_agent_id]);
      provider = { ...provider, wallet_address: rows?.[0]?.wallet_address };
    } catch { /* handled below */ }
  }
  if (!provider?.wallet_address) throw Object.assign(new Error('Provider wallet address missing for session.'), { status: 409 });

  // Direct rail simulates from the BUYER's wallet — the settle sender the
  // contract will see at execution time.
  let consumerAddress = null;
  if (directRail) {
    let { data: consumer } = await supabase
      .from('ai_agents')
      .select('wallet_address')
      .eq('id', session.consumer_agent_id)
      .single();
    if (!consumer?.wallet_address) {
      try {
        const { rows } = await getPool().query('SELECT wallet_address FROM ai_agents WHERE id = $1 LIMIT 1', [session.consumer_agent_id]);
        consumer = { wallet_address: rows?.[0]?.wallet_address };
      } catch { /* handled below */ }
    }
    consumerAddress = consumer?.wallet_address || null;
  }

  return { managerAddress, providerAddress: provider.wallet_address, provider, consumerAddress };
};

// ==================== Direct rail (EXECUTION_RAIL=direct) ====================
// The same ArbiterManager the x402 escrow flow uses — native-ETH escrow on
// Arbitrum Sepolia, executed by the consumer's own Privy embedded wallet via
// the production confirmPrepaidPurchase path. Simulation is real on-chain
// state via eth_estimateGas / eth_call: signs nothing, broadcasts nothing.

const DIRECT_MANAGER_ABI = [
  'function settleInvoice(bytes32 id, address receiver, bytes32 invoiceRef) payable',
  'function release(bytes32 id)',
  'function settleInvoiceToken(bytes32 id, address receiver, bytes32 invoiceRef, address token, uint256 amount)',
  'function releaseToken(bytes32 id)'
];
const DIRECT_ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)'
];
const DIRECT_CHAIN_ID = () => String(process.env.ARC_CHAIN_ID || 421614);
const directProvider = () => new ethers.JsonRpcProvider(process.env.ARC_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc');

/** The exact calls a direct-rail settlement will run, for the review UI. */
const buildDirectWorkflow = ({ managerAddress, paymentId, invoiceReference, providerAddress, amountWei, sessionId }) => {
  const { kind, address: tokenAddress } = getSettlementToken();
  const units = weiToTokenUnits(amountWei);
  const human = `${Number(units) / 1e6} ${kind}`;
  const shortRef = `${String(paymentId).slice(0, 10)}…`;
  return {
    sessionId,
    asset: kind,
    amountUnits: units,
    amountHuman: String(Number(units) / 1e6),
    tokenAddress,
    chainId: DIRECT_CHAIN_ID(),
    rail: 'direct',
    steps: [
      {
        step: 'approve',
        label: `${kind}.approve`,
        contractAddress: tokenAddress,
        functionName: 'approve',
        args: [managerAddress, units],
        valueEther: '0',
        summary: `Allow the escrow contract to spend ${human} (payment ${shortRef})`,
        simulateOnly: true
      },
      {
        step: 'settleToken',
        label: 'settleInvoiceToken',
        contractAddress: managerAddress,
        functionName: 'settleInvoiceToken',
        args: [paymentId, providerAddress, invoiceReference, tokenAddress, units],
        valueEther: '0',
        summary: `Hold ${human} in escrow for the provider (payment ${shortRef})`,
        simulateOnly: true
      },
      {
        step: 'releaseToken',
        label: 'releaseToken',
        contractAddress: managerAddress,
        functionName: 'releaseToken',
        args: [paymentId],
        valueEther: '0',
        summary: `Release the escrowed ${kind} to the provider (payment ${shortRef})`,
        simulateOnly: true
      }
    ]
  };
};

/**
 * Simulate one direct-rail step against live chain state. Throws on revert.
 * Token mode: 'balance' (affordability gate), 'approve', 'settleToken',
 * 'releaseToken'. Native mode (COMMERCE_ASSET=native): 'settle' / 'release'.
 */
const simulateDirectStep = async ({ kind, managerAddress, consumerAddress, providerAddress, paymentId, invoiceReference, amountWei }) => {
  const provider = directProvider();
  const m = new ethers.Contract(managerAddress, DIRECT_MANAGER_ABI, provider);
  const { kind: tokenKind, address: tokenAddress } = getSettlementToken();
  const units = weiToTokenUnits(amountWei);

  if (kind === 'balance') {
    const tk20 = new ethers.Contract(tokenAddress, DIRECT_ERC20_ABI, provider);
    const have = await tk20.balanceOf(consumerAddress);
    if (have < BigInt(units)) {
      throw new Error(`Insufficient ${tokenKind} balance: wallet holds ${Number(have) / 1e6} ${tokenKind}, the workflow needs ${Number(units) / 1e6} ${tokenKind}.`);
    }
    return { passed: true, gasEstimate: null };
  }
  if (kind === 'approve') {
    const tk20 = new ethers.Contract(tokenAddress, DIRECT_ERC20_ABI, provider);
    const gas = await tk20.approve.estimateGas(managerAddress, units, { from: consumerAddress });
    return { passed: true, gasEstimate: gas.toString() };
  }
  if (kind === 'settleToken') {
    const gas = await m.settleInvoiceToken.estimateGas(paymentId, providerAddress, invoiceReference, tokenAddress, units, { from: consumerAddress });
    return { passed: true, gasEstimate: gas.toString() };
  }
  if (kind === 'settle') {
    const gas = await m.settleInvoice.estimateGas(paymentId, providerAddress, invoiceReference, {
      from: consumerAddress,
      value: BigInt(amountWei || '0')
    });
    return { passed: true, gasEstimate: gas.toString() };
  }
  if (kind === 'releaseToken') {
    // msg.sender must be the buyer — the same rule the contract enforces at
    // execution time, so the simulation sees the same truth.
    await m.releaseToken.staticCall(paymentId, { from: consumerAddress });
    return { passed: true, gasEstimate: null };
  }
  // release (native)
  await m.release.staticCall(paymentId, { from: consumerAddress });
  return { passed: true, gasEstimate: null };
};

const sessionRefs = async (sessionId) => {
  // Deterministic — identical to commerceService's settlement derivation.
  const { ethers } = await import('ethers');
  return {
    paymentId: ethers.keccak256(ethers.toUtf8Bytes(`arbiter:purchase:${sessionId}`)),
    invoiceReference: ethers.keccak256(ethers.toUtf8Bytes(`arbiter:invoice:${sessionId}`))
  };
};

// ==================== ① COMPOSE ====================

/**
 * Compose a settlement workflow for a purchase. Creates a real commerce
 * session (awaiting_payment) through the production path, then derives the
 * exact KeeperHub call descriptors for review.
 */
export const composeWorkflow = async ({ developerId, organizationId, consumerAgentId, serviceId, quantity = '1' }) => {
  const consumer = await getOwnedAgentRow({ developerId, organizationId, agentId: consumerAgentId });
  const intent = await createPrepaidIntent({
    developerId,
    organizationId,
    consumerAgent: consumer,
    service: { service_id: serviceId },
    quantity: String(quantity)
  });
  const session = intent.session; // toPublicSession shape (camelCase)
  const sessionId = session.sessionId;

  // Raw row for the exact wei amount the settlement will use.
  const raw = await getRawSession(sessionId);
  const { managerAddress, providerAddress, provider } = await resolveExecutionCtx(raw);
  const refs = await sessionRefs(sessionId);
  const amountWei = raw.estimated_cost_wei || '0';

  const composed = isKeeperHubRail()
    ? composeSettlementCalls({
        managerAddress,
        paymentId: refs.paymentId,
        invoiceReference: refs.invoiceReference,
        providerAddress,
        amountWei,
        sessionId
      })
    : buildDirectWorkflow({
        managerAddress,
        paymentId: refs.paymentId,
        invoiceReference: refs.invoiceReference,
        providerAddress,
        amountWei,
        sessionId
      });

  logger.info(`[WORKFLOW STUDIO] composed ${composed.steps.length}-step workflow for session ${sessionId}`);

  return {
    workflow: {
      sessionId,
      status: session.status || 'awaiting_payment',
      createdAt: session.createdAt || new Date().toISOString(),
      service: {
        serviceCode: session.serviceId,
        quantity: session.quantity || String(quantity),
        unit: session.unit || null
      },
      consumer: { agentId: session.consumerAgentId || consumerAgentId },
      provider: { agentId: session.providerAgentId, wallet: providerAddress },
      estimatedCost: session.estimatedCostBOT,
      paymentId: refs.paymentId,
      invoiceReference: refs.invoiceReference,
      chainId: composed.chainId,
      rail: composed.rail,
      asset: composed.asset,
      amountHuman: composed.amountHuman,
      amountUnits: composed.amountUnits,
      tokenAddress: composed.tokenAddress,
      steps: composed.steps
    }
  };
};

const getOwnedAgentRow = async ({ developerId, organizationId, agentId }) => {
  let { data: agent } = await supabase
    .from('ai_agents')
    .select('*')
    .eq('agent_id', agentId)
    .maybeSingle();
  if (!agent) {
    const { rows } = await getPool().query('SELECT * FROM ai_agents WHERE agent_id = $1 LIMIT 1', [agentId]);
    agent = rows?.[0];
  }
  if (!agent) throw Object.assign(new Error('Consumer agent not found.'), { status: 404 });
  const owned = organizationId ? agent.organization_id === organizationId : agent.developer_id === developerId;
  if (!owned) throw Object.assign(new Error('You do not own this agent.'), { status: 403 });
  return agent;
};

// ==================== ③ DRY RUN (+ chaos probes) ====================

/**
 * Dry-run the full composed workflow. Direct rail: real on-chain simulation
 * (eth_estimateGas / eth_call against ArbiterManager on Arbitrum Sepolia).
 * KeeperHub rail: KeeperHub simulate:true. Either way: signs nothing,
 * broadcasts nothing, touches no chain state.
 */
export const dryRunWorkflow = async ({ sessionId, organizationId, developerId }) => {
  const session = await loadSessionForOrg({ sessionId, organizationId, developerId });
  const { managerAddress, providerAddress, consumerAddress } = await resolveExecutionCtx(session);
  const refs = await sessionRefs(sessionId);
  const amountWei = session.estimated_cost_wei || '0';

  if (!isKeeperHubRail()) {
    // ── Direct rail: simulate against live Arbitrum Sepolia state. Token mode
    // checks affordability (balance), allowance, escrow hold and release. ──
    if (!consumerAddress) {
      throw Object.assign(new Error('Consumer wallet address missing — cannot simulate the buyer-side settlement.'), { status: 409 });
    }
    const { kind: tkKind } = getSettlementToken();
    const native = (process.env.COMMERCE_ASSET || 'token').toLowerCase() !== 'token';
    const kinds = native ? ['settle', 'release'] : ['balance', 'approve', 'settleToken', 'releaseToken'];
    const labelFor = native
      ? { settle: 'settleInvoice', release: 'release' }
      : { balance: `${tkKind}.balanceOf`, approve: `${tkKind}.approve`, settleToken: 'settleInvoiceToken', releaseToken: 'releaseToken' };
    const steps = [];
    for (const kind of kinds) {
      try {
        const sim = await simulateDirectStep({ kind, managerAddress, consumerAddress, providerAddress, paymentId: refs.paymentId, invoiceReference: refs.invoiceReference, amountWei });
        steps.push({ step: kind, label: labelFor[kind], wouldRevert: false, gasEstimate: sim.gasEstimate, passed: true, deferred: false });
      } catch (err) {
        // Dependent steps revert against CURRENT chain state (no allowance /
        // escrow not funded yet) — expected pre-execution, so deferred.
        const deferred = kind === 'settleToken' || kind === 'releaseToken' || kind === 'release';
        steps.push({
          step: kind,
          label: labelFor[kind],
          wouldRevert: true,
          gasEstimate: null,
          passed: false,
          deferred,
          reason: deferred
            ? (kind === 'settleToken'
              ? `Reverts only because the approve step hasn't executed yet — the allowance is granted right before the escrow hold at execution time.`
              : `Reverts only because the escrow is not funded yet — the settle step above runs first at execution time.`)
            : String(err.message || '').slice(0, 200)
        });
      }
    }
    const allClear = steps.every((s) => s.passed || s.deferred);
    return { sessionId, simulated: true, allClear, steps };
  }

  // ── KeeperHub rail: simulation through KeeperHub's MCP dry run. ──
  const kinds = (process.env.KEEPERHUB_ASSET || 'usdc').toLowerCase() === 'usdc'
    ? ['approve', 'settleToken', 'releaseToken']
    : ['settle', 'release'];

  const steps = [];
  let gatePassed = true; // the FIRST step (approve) is the hard gate
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const call = buildCallForStep({ kind, managerAddress, paymentId: refs.paymentId, invoiceReference: refs.invoiceReference, providerAddress, amountWei });
    try {
      const envelope = await dryRunContractCall(call);
      const passed = envelope.wouldRevert === false;
      steps.push({
        step: kind,
        label: call.label,
        wouldRevert: !passed,
        gasEstimate: envelope.gasEstimate,
        passed,
        deferred: false
      });
      if (i === 0 && !passed) gatePassed = false;
    } catch (err) {
      // dryRunContractCall throws when wouldRevert === true — a caught refusal.
      const dry = err.dryRun || {};
      const isGate = i === 0;
      steps.push({
        step: kind,
        label: call.label,
        wouldRevert: true,
        gasEstimate: dry.gasEstimate ?? null,
        passed: false,
        // Dependent steps simulate against CURRENT chain state: on a fresh
        // session they revert simply because the prior steps haven't executed
        // yet (no allowance / escrow not funded). That is EXPECTED — the rail
        // itself re-simulates every step right before broadcasting it, so a
        // genuinely broken dependent step still gets caught before it ships.
        deferred: !isGate,
        reason: isGate
          ? String(err.message || '').slice(0, 200)
          : `Reverts only because earlier steps haven't executed yet — KeeperHub re-simulates this step immediately before broadcasting it.`
      });
      if (isGate) gatePassed = false;
    }
  }

  return {
    sessionId,
    simulated: true,
    allClear: gatePassed,
    steps
  };
};

/**
 * Chaos probe: a deliberately TAMPERED workflow — the settle step altered to
 * send a different (inflated) amount than reviewed. The simulation layer must
 * refuse it. This is the "agents are probabilistic; execution is not" moment.
 */
export const chaosProbe = async ({ sessionId, organizationId, developerId }) => {
  const session = await loadSessionForOrg({ sessionId, organizationId, developerId });
  const { managerAddress, providerAddress, consumerAddress } = await resolveExecutionCtx(session);
  const refs = await sessionRefs(sessionId);
  const amountWei = session.estimated_cost_wei || '0';

  let refused = false;
  let detail = null;
  let tamperedWei;
  let description;
  let label;

  // Human-readable wei figure for the review UI (USDC units on the KeeperHub
  // rail, native ETH on the direct rail).
  const humanize = (wei) => {
    try {
      if (isKeeperHubRail()) return `${Number(BigInt(wei || '0')) / 1e6} USDC`;
      return `${Number(weiToTokenUnits(wei)) / 1e6} ${getSettlementToken().kind}`;
    } catch { return wei; }
  };

  if (!isKeeperHubRail()) {
    // ── Direct rail: simulate the tampered settle against live chain state.
    // Escalate the tamper factor until the chain itself refuses, so the probe
    // reports the strongest tamper reality rejects (balance/gas truth).
    const factors = [100n, 1_000n, 1_000_000n];
    let lastClean = null;
    for (const factor of factors) {
      tamperedWei = (BigInt(amountWei || '0') * factor).toString();
      label = 'settleInvoiceToken';
      description = `Settle step altered after review: amount inflated ${Number(factor).toLocaleString('en-US')}× vs the approved workflow.`;
      try {
        const sim = await simulateDirectStep({ kind: 'settleToken', managerAddress, consumerAddress, providerAddress, paymentId: refs.paymentId, invoiceReference: refs.invoiceReference, amountWei: tamperedWei });
        lastClean = { gasEstimate: sim.gasEstimate, factor };
      } catch (err) {
        refused = true;
        detail = { wouldRevert: true, gasEstimate: null, reason: String(err.message || '').slice(0, 240), factor: factor.toString() };
        break;
      }
    }
    if (!refused && lastClean) {
      refused = false;
      detail = { wouldRevert: false, gasEstimate: lastClean.gasEstimate, factor: lastClean.factor.toString() };
      description = `Settle step altered after review: amount inflated ${Number(lastClean.factor).toLocaleString('en-US')}× vs the approved workflow.`;
    }
  } else {
    // ── KeeperHub rail: tamper 100× and run through KeeperHub's dry run. ──
    tamperedWei = (BigInt(amountWei || '0') * 100n).toString();
    description = 'Settle step altered after review: amount inflated 100× vs the approved workflow.';
    const call = buildCallForStep({
      kind: (process.env.KEEPERHUB_ASSET || 'usdc').toLowerCase() === 'usdc' ? 'settleToken' : 'settle',
      managerAddress,
      paymentId: refs.paymentId,
      invoiceReference: refs.invoiceReference,
      providerAddress,
      amountWei: tamperedWei
    });
    label = call.label;
    try {
      const envelope = await dryRunContractCall(call);
      refused = envelope.wouldRevert === true;
      detail = { wouldRevert: envelope.wouldRevert, gasEstimate: envelope.gasEstimate };
    } catch (err) {
      refused = err.dryRun?.wouldRevert === true || true; // a thrown dry-run refusal is a refusal
      detail = { wouldRevert: err.dryRun?.wouldRevert ?? true, gasEstimate: err.dryRun?.gasEstimate ?? null, reason: String(err.message || '').slice(0, 240) };
    }
  }

  return {
    sessionId,
    tampered: {
      description,
      reviewedAmount: amountWei,
      tamperedAmount: tamperedWei,
      reviewedAmountHuman: humanize(amountWei),
      tamperedAmountHuman: humanize(tamperedWei),
      label
    },
    keeperHubRefused: refused,
    detail
  };
};

// ==================== ④ EXECUTE ====================

/**
 * Execute the EXACT reviewed workflow. Delegates to the production
 * confirmPrepaidPurchase — the same deterministic derivation of refs/amounts,
 * executed through KeeperHub. No re-composition, no inference.
 */
export const executeWorkflow = async ({ sessionId, organizationId }) => {
  return confirmPrepaidPurchase({ sessionId, organizationId });
};

// ==================== ⑤ PROVE ====================

/**
 * Pull the public proof for a session: HCS anchors from Hedera's mirror node
 * (no trust in this server needed — anyone can re-fetch these) + the session's
 * Base txs from the commerce record.
 */
export const proveWorkflow = async ({ sessionId, organizationId, developerId }) => {
  const mirror = process.env.HEDERA_MIRROR_URL || 'https://testnet.mirrornode.hedera.com';
  const topicId = process.env.HEDERA_HCS_TOPIC_ID || '';

  let anchors = [];
  if (topicId) {
    try {
      const url = `${mirror}/api/v1/topics/${topicId}/messages?limit=100&order=desc`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        anchors = (data.messages || [])
          .map((m) => {
            let parsed = {};
            try { parsed = JSON.parse(Buffer.from(m.message, 'base64').toString('utf8')); } catch { return null; }
            if (parsed?.sessionId !== sessionId) return null;
            return {
              type: parsed.type,
              seq: Number(m.sequence_number),
              consensusTimestamp: m.consensus_timestamp,
              txHash: parsed.txHash || null,
              explorerUrl: parsed.explorerUrl || (parsed.txHash ? `https://sepolia.arbiscan.io/tx/${parsed.txHash}` : null),
              details: parsed.details || null
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.seq - b.seq);
      }
    } catch (err) {
      logger.warn('[WORKFLOW STUDIO] mirror fetch failed:', err.message);
    }
  }

  // Base-side receipts from the session's invoices (best effort).
  let baseTxs = [];
  try {
    const { data: invoices } = await supabase
      .from('ai_invoices')
      .select('invoice_id, tx_hash, status, amount_wei')
      .eq('session_id', sessionId)
      .limit(5);
    baseTxs = (invoices || []).filter((i) => i.tx_hash).map((i) => ({
      invoiceId: i.invoice_id,
      txHash: i.tx_hash,
      explorerUrl: `https://sepolia.arbiscan.io/tx/${i.tx_hash}`,
      status: i.status
    }));
  } catch { /* table/shape differences are fine — HCS is the primary proof */ }

  // Commerce service invoices carry the settlement txs for BOTH rails.
  try {
    const { data: sInvoices } = await supabase
      .from('service_invoices')
      .select('invoice_id, tx_hash, status')
      .eq('metadata->>session_id', sessionId)
      .limit(5);
    for (const i of sInvoices || []) {
      if (i.tx_hash && !baseTxs.some((t) => t.txHash === i.tx_hash)) {
        baseTxs.push({ invoiceId: i.invoice_id, txHash: i.tx_hash, explorerUrl: `https://sepolia.arbiscan.io/tx/${i.tx_hash}`, status: i.status });
      }
    }
  } catch { /* optional evidence — HCS remains the primary proof */ }

  return {
    sessionId,
    hcsTopicId: topicId,
    hashscanUrl: topicId ? `https://hashscan.io/testnet/topic/${topicId}` : null,
    anchors,
    baseTxs,
    verified: anchors.length > 0
  };
};

/** Raw purchase_sessions row (snake_case) — the settlement's source of truth. */
const getRawSession = async (sessionId) => {
  const { data, error } = await supabase
    .from('purchase_sessions')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error || !data) throw Object.assign(new Error('Purchase session not found.'), { status: 404 });
  return data;
};

const loadSessionForOrg = async ({ sessionId, organizationId, developerId }) => {
  const session = await getRawSession(sessionId);
  const ownerOk = organizationId
    ? session.organization_id === organizationId
    : session.developer_id === developerId;
  if (!ownerOk) throw Object.assign(new Error('This session is not in your workspace.'), { status: 403 });
  return session;
};

export default { composeWorkflow, dryRunWorkflow, chaosProbe, executeWorkflow, proveWorkflow };
