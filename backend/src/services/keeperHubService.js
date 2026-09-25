/**
 * KeeperHubService — the KeeperHub execution rail for Arbiter.
 *
 * Arbiter keeps the intelligence (discovery, Trust Engine, policy) and
 * delegates on-chain execution to KeeperHub (https://app.keeperhub.com):
 * Turnkey-secured wallets, gas/nonce management, retries, dry-run
 * simulation, and a full per-execution audit trail.
 *
 * Transport: KeeperHub MCP server over HTTP, authenticated with an
 * organisation API key (kh_...) as a Bearer token.
 *   Docs:   https://docs.keeperhub.com/ai-tools/mcp-server
 *   Tools:  execute_contract_call, get_direct_execution_status,
 *           list_action_schemas, get_spending_limits
 *
 * Safe sequence for state-changing calls (per KeeperHub docs):
 *   1. execute_contract_call with simulate:true  -> gas estimate / revert
 *      check; nothing is signed or broadcast. This is the "dry run without
 *      touching the chain" step of the review flow.
 *   2. execute_contract_call (real) with a fresh idempotency_key
 *   3. poll get_direct_execution_status until completed/failed -> tx hash
 *
 * The exact argument names for execute_contract_call are validated at setup
 * time by scripts/keeperhub-probe.js (list_action_schemas / get_plugin);
 * adjust MCP_ARG_FIELD there if the schema differs.
 */

import { ethers } from 'ethers';

const DEFAULT_BASE_URL = 'https://app.keeperhub.com';

// Argument shapes verified against the live tools/list schema (2026-09-17):
//   chain_id: string, contract_address: string, abi: JSON *string*,
//   function_name: string, function_args: JSON *string* (e.g. '["0x..","1000"]'),
//   value: decimal string in ETHER units (not wei!), simulate: boolean,
//   idempotency_key: string (24h dedupe window).

const EXECUTION_RAIL = () => (process.env.EXECUTION_RAIL || 'arc').toLowerCase();
const KEEPERHUB_API_KEY = () => process.env.KEEPERHUB_API_KEY || '';
const KEEPERHUB_BASE_URL = () => (process.env.KEEPERHUB_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

/** Default settle chain for the KeeperHub rail (Base Sepolia = 421614). */
export const KEEPERHUB_CHAIN_ID = () => process.env.KEEPERHUB_CHAIN_ID || '421614';

export const isKeeperHubConfigured = () => {
  const key = KEEPERHUB_API_KEY();
  return Boolean(key && key.startsWith('kh_'));
};

export const isKeeperHubRail = () => EXECUTION_RAIL() === 'keeperhub';

const ACCEPT = 'application/json, text/event-stream';

let mcpRequestId = 0;
let mcpSessionId = null;
let sessionInitPromise = null;

const rpcHeaders = () => ({
  'Content-Type': 'application/json',
  'Accept': ACCEPT,
  'Authorization': `Bearer ${KEEPERHUB_API_KEY()}`,
  ...(mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {})
});

/** POST one JSON-RPC message; parses JSON or SSE bodies (202 = notification, no body). */
const postRpc = async (body, { timeoutMs = 65_000 } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${KEEPERHUB_BASE_URL()}/mcp`, {
      method: 'POST',
      headers: rpcHeaders(),
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    const contentType = res.headers.get('content-type') || '';
    let payload = null;
    if (contentType.includes('text/event-stream')) {
      // SSE: one JSON-RPC message per `data:` line; keep the last parseable one.
      const raw = await res.text();
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try { payload = JSON.parse(line.slice(5).trim()); } catch { /* partial frame */ }
      }
    } else if (res.status !== 202) {
      payload = await res.json().catch(() => null);
    }
    return { res, payload };
  } finally {
    clearTimeout(timer);
  }
};

const expectResult = (payload, what) => {
  if (!payload) throw new Error(`KeeperHub MCP: no parsable JSON-RPC response for ${what}`);
  if (payload.error) {
    const err = new Error(`KeeperHub MCP ${what} failed: ${payload.error.message || JSON.stringify(payload.error).slice(0, 300)}`);
    err.keeperhub = payload.error;
    throw err;
  }
  return payload.result;
};

/**
 * MCP Streamable-HTTP handshake, performed once per process:
 *   initialize → capture Mcp-Session-Id → notifications/initialized
 * KeeperHub rejects any tools/call before this sequence completes
 * (error -32003 "Session not initialized" — verified by the probe).
 */
const ensureSession = async () => {
  if (mcpSessionId) return;
  if (!sessionInitPromise) {
    sessionInitPromise = (async () => {
      const { res, payload } = await postRpc({
        jsonrpc: '2.0',
        id: ++mcpRequestId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'arbiter-backend', version: '1.0.0' }
        }
      });
      if (res.status === 401) throw new Error('KeeperHub rejected the API key (401). Check KEEPERHUB_API_KEY.');
      const result = expectResult(payload, 'initialize');
      mcpSessionId = res.headers.get('mcp-session-id') || null;
      log('SESSION', `initialized (protocol ${result?.protocolVersion || '?'})`);
      // Notification — server answers 202 with no body. Must complete before tools/call.
      await postRpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })().finally(() => {
      sessionInitPromise = null;
    });
  }
  await sessionInitPromise;
};

/** Generic JSON-RPC request against the KeeperHub MCP endpoint. */
const rpcRequest = async (method, params = {}, { timeoutMs = 65_000, retrySession = true } = {}) => {
  if (!isKeeperHubConfigured()) {
    throw new Error('KeeperHub is not configured: set KEEPERHUB_API_KEY (kh_...) in backend .env');
  }
  await ensureSession();
  const { res, payload } = await postRpc({
    jsonrpc: '2.0',
    id: ++mcpRequestId,
    method,
    params
  }, { timeoutMs });
  if (res.status === 401) throw new Error('KeeperHub rejected the API key (401). Check KEEPERHUB_API_KEY.');
  if (res.status === 403) throw new Error('KeeperHub scope insufficient (403). The API key needs the write/send-transactions permission.');
  if (res.status === 404 && retrySession) {
    // Session expired server-side: drop it and re-handshake once.
    mcpSessionId = null;
    return rpcRequest(method, params, { timeoutMs, retrySession: false });
  }
  const result = expectResult(payload, method);
  const text = Array.isArray(result?.content)
    ? result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    : '';
  // Tool errors arrive as isError:true content — surface them as throws.
  if (result?.isError) {
    const err = new Error(`KeeperHub tool failed (${method}): ${text.slice(0, 500)}`);
    err.keeperhubText = text;
    throw err;
  }
  return { result, text, structured: result?.structuredContent ?? null };
};

/** MCP tools/call against the KeeperHub endpoint. */
const mcpCall = (tool, args = {}, opts = {}) =>
  rpcRequest('tools/call', { name: tool, arguments: args }, opts);

export { mcpCall as mcpToolCall, rpcRequest as mcpRequest };

/** Parse the first balanced JSON object found in an MCP tool result's text. */
const parseToolJson = (text) => {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (stage, message, extra = {}) => {
  // eslint-disable-next-line no-console
  console.log(`[KEEPERHUB RAIL] ${stage}: ${message}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`);
};

// --- ArbiterPaymentManager ABI (settlement path only) ----------------------
// Must be a real JSON ABI (the tool serializes it as a JSON string) — the
// human-readable ethers shorthand is rejected ("Function not found in ABI").
// v2 manager: native path (Arc) + ERC20/USDC path (Base Sepolia KeeperHub rail).
export const MANAGER_ABI = [
  {
    type: 'function',
    name: 'settleInvoice',
    stateMutability: 'payable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'receiver', type: 'address' },
      { name: 'invoiceRef', type: 'bytes32' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'settleInvoiceToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'receiver', type: 'address' },
      { name: 'invoiceRef', type: 'bytes32' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'releaseToken',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: []
  }
];

/** Circle USDC on Base Sepolia (6 decimals). */
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  }
];

/**
 * Build one contract call descriptor for the Payment Manager.
 * kind: 'approve' | 'settle' | 'settleToken' | 'release' | 'releaseToken'
 */
const buildManagerCall = ({ kind, managerAddress, paymentId, providerAddress, invoiceReference, amountWei, tokenAddress, amountUnits }) => {
  switch (kind) {
    case 'approve':
      return {
        label: 'USDC.approve',
        contractAddress: tokenAddress,
        abi: ERC20_ABI,
        abiFunction: 'approve',
        args: [managerAddress, amountUnits],
        valueEther: '0'
      };
    case 'settleToken':
      return {
        label: 'settleInvoiceToken',
        contractAddress: managerAddress,
        abi: MANAGER_ABI,
        abiFunction: 'settleInvoiceToken',
        args: [paymentId, providerAddress, invoiceReference, tokenAddress, amountUnits],
        valueEther: '0'
      };
    case 'releaseToken':
      return {
        label: 'releaseToken',
        contractAddress: managerAddress,
        abi: MANAGER_ABI,
        abiFunction: 'releaseToken',
        args: [paymentId],
        valueEther: '0'
      };
    case 'settle':
    default:
      return {
        label: 'settleInvoice',
        contractAddress: managerAddress,
        abi: MANAGER_ABI,
        abiFunction: 'settleInvoice',
        args: [paymentId, providerAddress, invoiceReference],
        valueEther: ethers.formatEther(BigInt(amountWei || '0'))
      };
    case 'release':
      return {
        label: 'release',
        contractAddress: managerAddress,
        abi: MANAGER_ABI,
        abiFunction: 'release',
        args: [paymentId],
        valueEther: '0'
      };
  }
};

/** Tool arguments for one contract call, per the verified live schema. */
const toolArgsFor = (call, { simulate = false, idempotencyKey } = {}) => ({
  chain_id: String(KEEPERHUB_CHAIN_ID()),
  contract_address: call.contractAddress,
  abi: JSON.stringify(call.abi),
  function_name: call.abiFunction,
  function_args: JSON.stringify(call.args),
  value: call.valueEther,
  ...(simulate ? { simulate: true } : {}),
  ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
});

/**
 * Dry-run one contract call through KeeperHub simulation.
 * Signs nothing, broadcasts nothing. Returns the simulation envelope
 * (gas estimate, wouldRevert) for the review UI.
 */
export const dryRunContractCall = async (call, { chainId = KEEPERHUB_CHAIN_ID() } = {}) => {
  const { text, structured } = await mcpCall('execute_contract_call', toolArgsFor(call, { simulate: true }));
  const parsed = structured || parseToolJson(text) || {};
  const envelope = {
    simulated: true,
    label: call.label,
    wouldRevert: parsed.wouldRevert ?? null,
    gasEstimate: parsed.gasEstimate ?? parsed.gas ?? null,
    raw: parsed
  };
  log('DRY RUN', `${call.label} on ${call.contractAddress}`, {
    wouldRevert: envelope.wouldRevert,
    gasEstimate: envelope.gasEstimate
  });
  if (envelope.wouldRevert === true) {
    const err = new Error(`KeeperHub dry run reverted (${call.label}): ${text.slice(0, 300)}`);
    err.dryRun = envelope;
    throw err;
  }
  return envelope;
};

/** Extract a tx hash / execution id from any shape the tool returns. */
const extractRefs = (parsed) => ({
  txHash: parsed?.transactionHash || parsed?.txHash || parsed?.tx_hash || null,
  executionId: parsed?.executionId || parsed?.execution_id || parsed?.id || null
});

/**
 * Execute one state-changing contract call through KeeperHub.
 * Returns { txHash, provider: 'keeperhub', executionId }.
 */
export const executeContractCall = async (call, {
  chainId = KEEPERHUB_CHAIN_ID(),
  idempotencyKey
} = {}) => {
  const { text, structured } = await mcpCall('execute_contract_call', toolArgsFor(call, { idempotencyKey }));
  const parsed = structured || parseToolJson(text) || {};
  let { txHash, executionId } = extractRefs(parsed);

  // State-changing calls may return an execution id to poll for the hash.
  if (!txHash && executionId) {
    txHash = await pollDirectExecution(executionId);
  }
  if (!txHash) {
    log('EXECUTE', `no tx hash in ${call.label} response`, { text: text.slice(0, 200) });
    throw new Error(`KeeperHub did not return a transaction hash for ${call.label}.`);
  }
  log('EXECUTE', `${call.label} broadcast: ${txHash}`);
  return { txHash, executionId, provider: 'keeperhub' };
};

/** Poll get_direct_execution_status until the execution completes or fails. */
export const pollDirectExecution = async (executionId, {
  intervalMs = 3_000,
  maxAttempts = 60
} = {}) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text, structured } = await mcpCall('get_direct_execution_status', { execution_id: executionId });
    const parsed = structured || parseToolJson(text) || {};
    const status = String(parsed.status || parsed.state || '').toLowerCase();
    const { txHash } = extractRefs(parsed);
    if (txHash && ['completed', 'confirmed', 'success', 'succeeded'].includes(status)) return txHash;
    if (['failed', 'reverted', 'error'].includes(status)) {
      throw new Error(`KeeperHub execution ${executionId} failed: ${text.slice(0, 300)}`);
    }
    if (attempt === maxAttempts) {
      throw new Error(`KeeperHub execution ${executionId} still pending after ${maxAttempts} polls.`);
    }
    await sleep(intervalMs);
  }
  return null;
};

/**
 * Asset mode for the KeeperHub rail.
 *   'usdc' (default): ERC20 USDC via settleInvoiceToken/releaseToken — the
 *     amount is interpreted in USDC units (6dp), derived from the session's
 *     18dp wei figure (1e16 wei "0.01" → 0.01 USDC → 10000 base units).
 *   'native': ETH via settleInvoice/release (useful for Arc-shaped demos).
 */
const assetMode = () => (process.env.KEEPERHUB_ASSET || 'usdc').toLowerCase();
const usdcAddress = () => process.env.KEEPERHUB_USDC_ADDRESS || USDC_BASE_SEPOLIA;

/** 18dp wei figure → 6dp USDC base units (string). */
const weiToUsdcUnits = (amountWei) => (BigInt(amountWei || '0') / 1_000_000_000_000n).toString();

/**
 * Full prepaid-purchase settlement through KeeperHub — the KeeperHub-rail
 * equivalent of commerceService's settlement contract calls. Every state-changing
 * step is dry-run gated (simulate:true) and idempotency-keyed, and lands in
 * KeeperHub's execution audit trail.
 *
 * USDC mode (default):
 *   1. USDC.approve(manager, amount)   — dry-run + execute
 *   2. settleInvoiceToken(...)         — dry-run + execute
 *   3. releaseToken(id)                — dry-run + execute
 * Native mode: settleInvoice (payable) + release.
 *
 * @returns {{ success: true, txHash, createTxHash, releaseTxHash, dryRun, asset, provider: 'keeperhub', confirmed: true }}
 */
export const settlePurchase = async ({
  managerAddress,
  paymentId,          // bytes32 — keccak of `arbiter:purchase:<sessionId>`
  invoiceReference,   // bytes32 — keccak of `arbiter:invoice:<sessionId>`
  providerAddress,    // receiver passed to settleInvoice(Token)
  amountWei,          // session amount in 18dp wei (converted to USDC units in usdc mode)
  sessionId
}) => {
  if (!managerAddress) throw new Error('KeeperHub rail requires ARBITER_MANAGER_ADDRESS deployed on the KeeperHub chain.');
  if (!providerAddress) throw new Error('KeeperHub rail requires the provider wallet address.');

  const useUsdc = assetMode() === 'usdc';
  const ctx = {
    managerAddress,
    paymentId,
    providerAddress,
    invoiceReference,
    amountWei,
    tokenAddress: usdcAddress(),
    amountUnits: weiToUsdcUnits(amountWei)
  };

  const steps = [];
  const run = async (kind, idemSuffix) => {
    const call = buildManagerCall({ kind, ...ctx });
    const dry = await dryRunContractCall(call);
    const exec = await executeContractCall(call, {
      idempotencyKey: `keeperhub:${idemSuffix}:${sessionId}`
    });
    steps.push({ kind, dry, exec });
    return exec;
  };

  let settle, release;
  if (useUsdc) {
    const approve = await run('approve', 'approve');
    settle = await run('settleToken', 'settle');
    release = await run('releaseToken', 'release');
    log('SETTLE', `purchase ${sessionId} settled via KeeperHub (USDC)`, {
      approveTx: approve.txHash,
      settleTx: settle.txHash,
      releaseTx: release.txHash,
      amountUnits: ctx.amountUnits
    });
  } else {
    settle = await run('settle', 'settle');
    release = await run('release', 'release');
    log('SETTLE', `purchase ${sessionId} settled via KeeperHub (native)`, {
      settleTx: settle.txHash,
      releaseTx: release.txHash
    });
  }

  return {
    success: true,
    txHash: release.txHash,
    createTxHash: settle.txHash,
    releaseTxHash: release.txHash,
    approveTxHash: useUsdc ? steps[0].exec.txHash : null,
    dryRun: Object.fromEntries(steps.map((s) => [s.kind, s.dry])),
    asset: useUsdc ? 'USDC' : 'NATIVE',
    amountUnits: useUsdc ? ctx.amountUnits : null,
    provider: 'keeperhub',
    confirmed: true
  };
};

/**
 * Workflow Studio support — expose the exact call descriptors a settlement
 * would run, WITHOUT executing anything. The UI shows these for human review;
 * execution later re-derives them from the same session (deterministic), so
 * what was reviewed is exactly what runs.
 */
export const composeSettlementCalls = ({ managerAddress, paymentId, invoiceReference, providerAddress, amountWei, sessionId }) => {
  if (!managerAddress) throw new Error('KeeperHub rail requires ARBITER_MANAGER_ADDRESS deployed on the KeeperHub chain.');
  if (!providerAddress) throw new Error('KeeperHub rail requires the provider wallet address.');
  const useUsdc = assetMode() === 'usdc';
  const ctx = {
    managerAddress,
    paymentId,
    providerAddress,
    invoiceReference,
    amountWei,
    tokenAddress: usdcAddress(),
    amountUnits: weiToUsdcUnits(amountWei)
  };
  const kinds = useUsdc ? ['approve', 'settleToken', 'releaseToken'] : ['settle', 'release'];
  const calls = kinds.map((kind) => {
    const call = buildManagerCall({ kind, ...ctx });
    return {
      step: kind,
      label: call.label,
      contractAddress: call.contractAddress,
      functionName: call.abiFunction,
      args: call.args,
      valueEther: call.valueEther,
      // Human-readable summary for the review UI
      summary:
        kind === 'approve'
          ? `Allow the Payment Manager to spend ${Number(ctx.amountUnits) / 1e6} USDC (escrow hold)`
          : kind === 'settleToken' || kind === 'settle'
            ? `Hold funds in escrow for the provider (payment ${String(paymentId).slice(0, 10)}…)`
            : `Release escrowed funds to the provider (payment ${String(paymentId).slice(0, 10)}…)`,
      simulateOnly: true
    };
  });
  return {
    sessionId,
    asset: useUsdc ? 'USDC' : 'NATIVE',
    amountUnits: useUsdc ? ctx.amountUnits : null,
    amountHuman: useUsdc ? Number(ctx.amountUnits) / 1e6 : ethers.formatEther(BigInt(amountWei || '0')),
    tokenAddress: useUsdc ? ctx.tokenAddress : null,
    chainId: String(KEEPERHUB_CHAIN_ID()),
    rail: 'keeperhub',
    steps: calls
  };
};

/** Build the call descriptor for one composed step (used by dry-run + chaos probes). */
export const buildCallForStep = ({ kind, managerAddress, paymentId, invoiceReference, providerAddress, amountWei }) => {
  const ctx = {
    managerAddress,
    paymentId,
    providerAddress,
    invoiceReference,
    amountWei,
    tokenAddress: usdcAddress(),
    amountUnits: weiToUsdcUnits(amountWei)
  };
  return buildManagerCall({ kind, ...ctx });
};

/** Quick connectivity/health check used by the probe script and status endpoints. */
export const probeConnection = async () => {
  const { text } = await mcpCall('get_spending_limits', {});
  return { ok: true, text: text.slice(0, 300) };
};

/** Convenience re-export so callers can encode paymentId/invoiceRef the same way. */
export const encodePurchaseReferences = (sessionId) => ({
  paymentId: ethers.keccak256(ethers.toUtf8Bytes(`arbiter:purchase:${sessionId}`)),
  invoiceReference: ethers.keccak256(ethers.toUtf8Bytes(`arbiter:invoice:${sessionId}`))
});
