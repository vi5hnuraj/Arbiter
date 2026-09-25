/**
 * heldService — "You pay first. The money waits until you have read what you bought."
 *
 * x402 escrow-by-substitution for Arbiter (inspired by Held, ETHOnline 2026):
 * the 402 challenge stays ordinary x402 — only `payTo` differs. Instead of the
 * seller (treasury), the challenge names the ArbiterManager contract.
 * The buyer's USDC settles on-chain AT ONCE (the seller knows it is real) but
 * lands in review-window escrow, where NEITHER party can take it unilaterally:
 *
 *   approve   → seller paid            (buyer was satisfied)
 *   reject    → buyer refunded         (UNDELIVERED work only — once the provider
 *                                       commits delivery evidence the contract
 *                                       refuses every refund path)
 *   partial   → split release          (half-right work; provider keeps >= 25%)
 *   silence   → autoResolve after the deadline: delivered→paid, else→refunded
 *
 * The deliverable is returned IMMEDIATELY with the payment receipt — the buyer
 * reads it, then decides. The escrow id is the claim ticket for every ending.
 *
 * Env:
 *   X402_HELD_ENABLED   'true' to serve held-mode challenges (default: on when manager set)
 *   MANAGER_ADDRESS     ArbiterManager deployment
 *   USDC_CONTRACT_ADDRESS  settlement token (Circle USDC on Arbitrum Sepolia)
 *   USDG_CONTRACT_ADDRESS  Paxos USDG (Global Dollar) — optional second settlement token
 *   X402_HELD_PRICE_USD_CENTS  price in USD cents (default 100 = $1.00)
 *   X402_HELD_REVIEW_SECONDS   review window (default 3600)
 *   RELAYER_PRIVATE_KEY   relayer that executes approve/reject/autoResolve
 *                        (the buyer signs the DECISION, not a transaction —
 *                        gasless for the buyer, like the rest of Arbiter)
 */
import { ethers } from 'ethers';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';

const MANAGER = () => process.env.MANAGER_ADDRESS || process.env.ARBITER_MANAGER_ADDRESS || '';
const USDC = () => process.env.USDC_CONTRACT_ADDRESS || '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
/**
 * Settlement tokens — first-class, verified assets the platform can settle in.
 * USDG (Paxos Global Dollar) is a supported bonus settlement stablecoin; the
 * verified Arbitrum One proxy is the default when no testnet address is configured.
 * Set USDG_CONTRACT_ADDRESS to the address for the ACTIVE network before settling in USDG.
 */
const USDG = () => process.env.USDG_CONTRACT_ADDRESS || '0x004B506865409877C9fA29bfb1ebA929984B9bbC';
const PRICE_CENTS = () => Number(process.env.X402_HELD_PRICE_USD_CENTS || 100);
const REVIEW_SECONDS = () => Number(process.env.X402_HELD_REVIEW_SECONDS || 3600);

export const isHeldEnabled = () =>
  process.env.X402_HELD_ENABLED !== 'false' && Boolean(MANAGER());

const MANAGER_ABI = [
  'function settleInvoiceUSDEscrow(bytes32 id,address receiver,bytes32 invoiceRef,address token,uint256 usdCents,uint256 maxAmount,bytes32 termsHash,uint256 reviewWindow)',
  'function markDelivered(bytes32 id,bytes32 evidenceHash)',
  'function approveDelivery(bytes32 id)',
  'function approveDeliveryPartial(bytes32 id,uint256 toProvider)',
  'function rejectDelivery(bytes32 id)',
  'function autoResolve(bytes32 id)',
  'function getPayment(bytes32 id) view returns (uint8,uint8,address,address,address,uint256,uint256,bytes32,uint256,bytes32,bool,uint256,bytes32)',
  'error NotBuyer()',
  'error NotDelivered()',
  'error AlreadyDelivered()',
  'error BadSplit()',
  'error WindowClosed()',
  'error WindowOpen()',
  'error NotHeld()',
  'function quoteUSD(uint256 usdCents) view returns (uint256,int256)',
  'event USDSettled(bytes32 indexed id,address indexed receiver,uint256 usdCents,int256 price,uint256 amount)',
];

const relayer = (() => {
  let cached = null;
  return () => {
    if (!cached) {
      const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc');
      cached = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
    }
    return cached;
  };
})();

const manager = () => new ethers.Contract(MANAGER(), MANAGER_ABI, relayer());

// In-memory job metadata (the chain + HCS hold the durable record).
const jobs = new Map(); // escrowId -> { payer, endpoint, amount, delivered, createdAt, evidence }

export const heldStats = () => ({
  enabled: isHeldEnabled(),
  manager: MANAGER() || null,
  usdc: USDC(),
  usdg: USDG(),
  settlementTokens: ['USDC', 'USDG'],
  priceUsdCents: PRICE_CENTS(),
  reviewSeconds: REVIEW_SECONDS(),
  jobsTracked: jobs.size,
});

/**
 * Build a held-mode 402 challenge: identical shape to the plain x402 challenge,
 * except `payTo` names the ESCROW CONTRACT and the extensions block carries the
 * release policy. Any client that already speaks Arbiter's x402 can pay
 * without modification — that is the whole point of substitution.
 */
export const buildHeldChallenge = async ({ endpoint, priceCents, settlementToken } = {}) => {
  if (!isHeldEnabled()) return null;
  const cents = Number(priceCents ?? PRICE_CENTS());
  const tokenKind = String(settlementToken || 'USDC').toUpperCase();
  if (tokenKind !== 'USDC' && tokenKind !== 'USDG') {
    throw Object.assign(new Error(`unsupported settlement token "${settlementToken}" — use USDC or USDG`), { status: 400 });
  }
  const tokenAddress = tokenKind === 'USDG' ? USDG() : USDC();
  const escrowId = ethers.keccak256(
    ethers.toUtf8Bytes(`arbiter:held:${endpoint}:${tokenKind}:${Date.now()}:${crypto.randomUUID()}`)
  );
  let quote = null;
  try {
    const [amount, price] = await manager().quoteUSD(cents);
    quote = { amount: amount.toString(), chainlinkPrice: price.toString() };
  } catch (err) {
    logger.warn('[held] quote failed:', err.message);
  }
  return {
    x402Version: 1,
    scheme: 'arbiter-held',
    payTo: MANAGER(),            // ← the substitution: contract, not seller
    asset: tokenAddress,
    assetSymbol: tokenKind,
    network: 'arbitrum-sepolia',
    chainId: Number(process.env.ARC_CHAIN_ID || 421614),
    amount: quote?.amount ?? String(cents * 1_000_000n / 100n),
    usdCents: cents,
    escrowId,
    endpoint,
    extensions: {
      held: {
        releasePolicy: 'deliverable returns immediately; approve pays the seller, reject refunds you before the deadline, silence auto-resolves at the deadline (delivered→paid, undelivered→refunded)',
        reviewSeconds: REVIEW_SECONDS(),
        contract: MANAGER(),
        settlementToken: tokenKind,
      },
    },
  };
};

/**
 * Register a verified escrow payment (called after the on-chain settle tx is
 * confirmed) and return the deliverable right away. The buyer reads first,
 * decides later.
 */
export const openHeldJob = async ({ escrowId, payer, txHash, endpoint, deliverable }) => {
  if (!isHeldEnabled()) throw Object.assign(new Error('held mode disabled'), { status: 503 });
  const m = manager();
  // On-chain truth: this escrow id must exist and be HELD.
  const p = await m.getPayment(escrowId);
  const status = p[1];
  if (status !== 1n) { // HELD
    throw Object.assign(new Error('escrow not HELD — settle transaction has not locked the funds'), { status: 402 });
  }
  const amount = p[5].toString();
  // The service immediately proves the work exists on-chain (seller's delivery
  // evidence = hash of the deliverable the buyer is about to read).
  const evidence = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(deliverable)));
  jobs.set(escrowId, { payer, endpoint, amount, txHash, delivered: false, createdAt: Date.now(), evidence });

  await (await m.markDelivered(escrowId, evidence)).wait();
  jobs.get(escrowId).delivered = true;

  logger.info(`[held] job ${escrowId.slice(0, 14)}… escrowed ${amount} → deliverable released for review`);
  return {
    escrowId,
    status: 'DELIVERED_AWAITING_REVIEW',
    deliverable,                    // ← the buyer reads this NOW
    payment: { txHash, amount, settlementToken: USDC(), tokenSymbol: 'USDC', contract: MANAGER() },
    review: {
      seconds: REVIEW_SECONDS(),
      decide: {
        approve: `POST /api/x402/held/${escrowId}/approve`,
        reject: `POST /api/x402/held/${escrowId}/reject`,
        partial: `POST /api/x402/held/${escrowId}/partial { toProvider }`,
      },
      note: 'No action and the contract auto-resolves at the deadline: delivered work is paid.',
    },
  };
};

/** Buyer decision endpoints — the relayer executes, the decision is the buyer's. */
const DECISION_FN = {
  approve: 'approveDelivery',
  reject: 'rejectDelivery',
  partial: 'approveDeliveryPartial',
  auto: 'autoResolve',
};

/**
 * The contract requires approve/reject/partial to come from the BUYER
 * (msg.sender == p.sender). When the demo buyer is a managed agent wallet the
 * relayer cannot sign for it — route the decision through the agent's own
 * signer (Privy), exactly like the settle transaction was sent. Returns the tx
 * hash, or null to let the caller send with the relayer key (relayer IS the
 * buyer, or the action is the permissionless autoResolve).
 */
/**
 * Panel flows register the buyer's managed wallet id at settle time so the
 * decision path never depends on a live DB read (RLS / rate-limit windows).
 */
export const rememberHeldBuyer = (escrowId, { buyerWalletId = null, payer = null } = {}) => {
  const prev = jobs.get(escrowId) || {};
  jobs.set(escrowId, {
    ...prev,
    payer: payer || prev.payer || 'anyone',
    buyerWalletId: buyerWalletId || prev.buyerWalletId || null,
    endpoint: prev.endpoint || 'held-demo-panel',
    createdAt: prev.createdAt || Date.now(),
  });
};

const sendDecisionViaBuyer = async (p, action, escrowId, toProvider) => {
  const buyerAddress = String(p[2]);
  const relayerAddress = await relayer().getAddress();
  if (action === 'auto' || buyerAddress.toLowerCase() === relayerAddress.toLowerCase()) return null;
  const { getWalletService } = await import('../wallets/walletService.js');
  // 1) in-process registration from settle time (no DB round-trip)
  let walletId = jobs.get(escrowId)?.buyerWalletId || null;
  // 2) fall back to the wallet registry (ai_agents, then profiles)
  if (!walletId) {
    const { supabase } = await import('../config/supabaseClient.js');
    const { data: agent } = await supabase
      .from('ai_agents')
      .select('agent_id, wallet_id, status')
      .ilike('wallet_address', buyerAddress)
      .maybeSingle();
    if (agent?.wallet_id && agent.status !== 'suspended') walletId = agent.wallet_id;
    if (!walletId) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .ilike('internal_wallet_address', buyerAddress)
        .maybeSingle();
      walletId = profile?.id || null;
    }
  }
  if (!walletId) {
    throw Object.assign(new Error(
      `decision must be signed by the buyer wallet ${buyerAddress} — no managed wallet is registered for it`,
    ), { status: 403 });
  }
  const iface = new ethers.Interface(MANAGER_ABI);
  const args = action === 'partial' ? [escrowId, BigInt(toProvider)] : [escrowId];
  const result = await getWalletService().sendContractCall({
    walletId,
    to: MANAGER(),
    data: iface.encodeFunctionData(DECISION_FN[action], args),
    // distinct from the settle-time `held-approve-<escrow>` key (USDC approve) so
    // Privy never replays the wrong transaction for us
    idempotencyKey: `held-decide-${action}-${escrowId}`,
  });
  await relayer().provider.waitForTransaction(result.txHash);
  return result.txHash;
};

const resolveJob = async (escrowId, action, { toProvider } = {}) => {
  if (!DECISION_FN[action]) throw Object.assign(new Error('unknown action'), { status: 400 });
  const m = manager();
  const p = await m.getPayment(escrowId);
  if (p[1] !== 1n) throw Object.assign(new Error('escrow already resolved'), { status: 409 });
  const job = jobs.get(escrowId);
  if (job && job.payer && job.payer !== 'anyone') {
    // (soft check — chain remains the authority)
  }
  // Fail fast with readable reasons instead of burning relayer gas on a revert.
  // The chain remains the authority — these mirror ArbiterManager's checks.
  if (action === 'reject' && p[10] === true) {
    throw Object.assign(new Error(
      'refund refused: work is already delivered — the contract allows approve, a partial split (>= 25% to the provider), or the deadline. Use-then-refund is blocked on-chain.',
    ), { status: 409 });
  }
  if (action === 'partial') {
    let to;
    try { to = BigInt(toProvider); } catch { to = null; }
    if (to === null) throw Object.assign(new Error('toProvider amount required'), { status: 400 });
    if (to > p[5] || to * 4n < p[5]) {
      throw Object.assign(new Error(
        'invalid split: once work is delivered the provider must receive between 25% and 100% of the escrow',
      ), { status: 409 });
    }
  }
  let txHash;
  try {
    txHash = await sendDecisionViaBuyer(p, action, escrowId, toProvider);
    if (!txHash) {
      let tx;
      if (action === 'approve') tx = await m.approveDelivery(escrowId);
      else if (action === 'reject') tx = await m.rejectDelivery(escrowId);
      else if (action === 'partial') tx = await m.approveDeliveryPartial(escrowId, toProvider);
      else tx = await m.autoResolve(escrowId);
      txHash = (await tx.wait()).hash;
    }
  } catch (err) {
    if (err.status) throw err; // our own guards above
    const reason = String(err?.reason || err?.shortMessage || err?.message || '');
    const friendly = reason.includes('AlreadyDelivered')
      ? 'refund refused: work is already delivered — use-then-refund is blocked on-chain (approve, split >= 25%, or let the deadline pay the provider)'
      : reason.includes('BadSplit')
        ? 'invalid split: once delivered, the provider must receive between 25% and 100% of the escrow'
        : reason.includes('WindowClosed')
          ? 'review window closed — the escrow already auto-resolved'
          : reason.includes('WindowOpen')
            ? 'review window still open — the deadline has not passed yet'
            : reason.includes('NotDelivered')
              ? 'nothing delivered yet — reject (full refund) is the valid ending before delivery'
              : reason.includes('NotBuyer')
                ? 'decision must be signed by the buyer wallet that paid into the escrow'
                : null;
    if (friendly) throw Object.assign(new Error(friendly), { status: 409 });
    throw err;
  }
  const receipt = await relayer().provider.getTransactionReceipt(txHash);
  const [, status] = await m.getPayment(escrowId);
  return { escrowId, action, txHash, status: Number(status), block: receipt.blockNumber };
};

export const approveHeldJob = (escrowId) => resolveJob(escrowId, 'approve');
export const rejectHeldJob = (escrowId) => resolveJob(escrowId, 'reject');
export const partialHeldJob = (escrowId, toProvider) => resolveJob(escrowId, 'partial', { toProvider });
export const autoResolveHeldJob = (escrowId) => resolveJob(escrowId, 'auto');

/** Buyer-facing status: what does the chain say about my money? */
export const heldJobStatus = async (escrowId) => {
  const m = manager();
  const p = await m.getPayment(escrowId);
  const [pType, status, sender, receiver, , amount, , , deadline, termsHash, delivered, deliveredAt, evidenceHash] = p;
  return {
    escrowId,
    onChain: {
      status: ['PENDING', 'HELD', 'RELEASED', 'CANCELLED'][Number(status)],
      amount: amount.toString(),
      buyer: sender,
      provider: receiver,
      reviewDeadline: Number(deadline),
      delivered,
      deliveredAt: Number(deliveredAt),
      evidenceHash,
      termsHash,
    },
    secondsLeft: Number(deadline) > 0 ? Math.max(0, Number(deadline) - Math.floor(Date.now() / 1000)) : null,
  };
};

// ── Purchase history: every escrow ever opened, durable across restarts ───
// The in-memory `jobs` Map only covers this process's lifetime, but buyers
// expect their escrow purchases to show up on the Receipts page forever.
// listHeldPurchases() merges three sources:
//   1. backend/heldJobs.json  — rows persisted by previous runs
//   2. `jobs`                 — this process's live knowledge (payer, wallet)
//   3. ArbiterManager log scan — the chain is the real record: settle /
//      delivery / decision tx hashes and final PaymentStatus come from events
// The scan is incremental (deployBlock → latest) and cached, so repeat calls
// cost ~2 RPC round-trips. On RPC failure we degrade to the cached rows
// instead of failing the page.

const HISTORY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../heldJobs.json');
const HISTORY_ABI = [
  'function getPayment(bytes32 id) view returns (uint8,uint8,address,address,address,uint256,uint256,bytes32,uint256,bytes32,bool,uint256,bytes32)',
  'event USDSettled(bytes32 indexed id,address indexed receiver,uint256 usdCents,int256 price,uint256 amount)',
  'event Delivered(bytes32 indexed id,address indexed provider,bytes32 evidenceHash,uint256 at)',
  'event DeliveryApproved(bytes32 indexed id,address indexed by,uint256 toProvider,uint256 toBuyer)',
  'event DeliveryRejected(bytes32 indexed id,address indexed by,uint256 refund)',
  'event AutoResolved(bytes32 indexed id,uint8 outcome,uint256 at)',
  'event SettlementCompleted(bytes32 indexed id,address indexed sender,address indexed receiver,uint256 amount,address token,uint8 outcome,bool onTime)',
  'event PaymentCreated(bytes32 indexed id,uint8 indexed pType,address indexed sender,address receiver,uint256 amount,uint256 releaseTime)',
];
// enum Outcome { NONE, APPROVED, PARTIAL, REJECTED, AUTO_DELIVERED, AUTO_REFUNDED }
const OUTCOME_ENDING = {
  1: { status: 2, decision: 'approved' },
  2: { status: 2, decision: 'partial split' },
  3: { status: 3, decision: 'rejected' },
  4: { status: 2, decision: 'auto-resolved · paid' },
  5: { status: 3, decision: 'auto-resolved · refunded' },
};
const STATUS_NAME = ['PENDING', 'HELD', 'RELEASED', 'CANCELLED'];

const history = new Map(); // escrowId -> persisted row
let historyLoaded = false;
let chainMeta = { deployBlock: null, scannedTo: 0 };
let scanInFlight = null;

const loadHistory = () => {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    chainMeta = { deployBlock: saved.deployBlock ?? null, scannedTo: saved.scannedTo || 0 };
    Object.entries(saved.escrows || {}).forEach(([id, row]) => history.set(id, row));
  } catch (err) {
    logger.warn('[held] could not read heldJobs.json — starting with an empty history:', err.message);
  }
};

const saveHistory = () => {
  try {
    const escrows = {};
    history.forEach((row, id) => { escrows[id] = row; });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ ...chainMeta, escrows }, null, 2));
  } catch (err) {
    logger.warn('[held] could not persist heldJobs.json:', err.message);
  }
};

const historyRow = (escrowId) => {
  if (!history.has(escrowId)) history.set(escrowId, { escrowId, statusNum: null });
  return history.get(escrowId);
};

/** Earliest block that can contain our contract's logs (binary search on code). */
const findDeployBlock = async () => {
  const provider = relayer().provider;
  const latest = await provider.getBlockNumber();
  try {
    let lo = 0;
    let hi = latest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const code = await provider.getCode(MANAGER(), mid);
      if (code && code !== '0x') hi = mid;
      else lo = mid + 1;
    }
    return lo;
  } catch (err) {
    logger.warn('[held] deploy-block search failed, falling back to latest − 1M blocks:', err.message);
    return Math.max(0, latest - 1_000_000);
  }
};

/** Fold one chunk of ArbiterManager logs into the history rows. */
const absorbLogs = async (logs) => {
  if (!logs.length) return;
  const provider = relayer().provider;
  const iface = new ethers.Interface(HISTORY_ABI);
  // One getBlock per unique block in the chunk, so rows get real timestamps.
  const blockNums = [...new Set(logs.map((l) => l.blockNumber))];
  const blockTimes = new Map();
  await Promise.all(blockNums.map(async (bn) => {
    try {
      const b = await provider.getBlock(bn);
      if (b?.timestamp) blockTimes.set(bn, b.timestamp * 1000);
    } catch { /* timestamp is cosmetic — skip */ }
  }));

  for (const log of logs) {
    let parsed = null;
    try { parsed = iface.parseLog({ topics: [...log.topics], data: log.data }); } catch { continue; }
    if (!parsed) continue;
    const id = parsed.args.id;
    if (!id) continue;
    const row = historyRow(id);
    const at = blockTimes.get(log.blockNumber);
    if (at && (!row.createdAt || at < row.createdAt)) row.createdAt = at;

    switch (parsed.name) {
      case 'PaymentCreated':
        // Only ESCROW-type payments (pType 2) become held purchases.
        if (Number(parsed.args.pType) !== 2) { history.delete(id); continue; }
        row.payer = parsed.args.sender;
        row.receiver = parsed.args.receiver;
        if (row.statusNum == null) row.statusNum = 1; // HELD
        break;
      case 'USDSettled':
        row.receiver = parsed.args.receiver;
        row.usdCents = Number(parsed.args.usdCents);
        try {
          row.amountRaw = parsed.args.amount.toString();
          row.amount = Number(ethers.formatUnits(parsed.args.amount, 6)).toFixed(6);
        } catch { /* leave amount unset */ }
        row.settleTx = log.transactionHash;
        break;
      case 'Delivered':
        row.delivered = true;
        row.deliveredTx = log.transactionHash;
        break;
      case 'DeliveryApproved':
        row.statusNum = 2;
        row.decision = 'approved';
        row.decisionTx = log.transactionHash;
        break;
      case 'DeliveryRejected':
        row.statusNum = 3;
        row.decision = 'rejected';
        row.decisionTx = log.transactionHash;
        break;
      case 'AutoResolved':
      case 'SettlementCompleted': {
        const ending = OUTCOME_ENDING[Number(parsed.args.outcome)];
        if (ending) {
          row.statusNum = ending.status;
          row.decision = ending.decision;
          row.decisionTx = log.transactionHash;
        }
        if (parsed.name === 'SettlementCompleted') {
          row.payer = row.payer || parsed.args.sender;
          row.receiver = row.receiver || parsed.args.receiver;
        }
        break;
      }
      default:
        continue; // not an escrow-lifecycle event — don't create a row for it
    }
    row.updatedAt = Date.now();
  }
};

/** Incremental scan: last scanned block → latest, chunked so no RPC limit bites. */
const scanChain = async () => {
  const provider = relayer().provider;
  loadHistory();
  const latest = await provider.getBlockNumber();
  if (chainMeta.deployBlock == null) {
    chainMeta.deployBlock = await findDeployBlock();
    chainMeta.scannedTo = Math.max(0, chainMeta.deployBlock - 1);
  }
  let start = Math.max(chainMeta.deployBlock, chainMeta.scannedTo + 1);
  let chunk = 50_000;
  while (start <= latest) {
    const end = Math.min(start + chunk - 1, latest);
    let logs;
    try {
      logs = await provider.getLogs({ address: MANAGER(), fromBlock: start, toBlock: end });
    } catch (err) {
      if (chunk > 1_000) { chunk = Math.max(1_000, Math.floor(chunk / 5)); continue; } // retry smaller
      throw err;
    }
    await absorbLogs(logs);
    chainMeta.scannedTo = end;
    start = end + 1;
  }
};

/** Merge this process's live jobs into the persisted rows. */
const mergeLiveJobs = () => {
  jobs.forEach((job, id) => {
    const row = historyRow(id);
    if (job.payer) row.payer = row.payer || job.payer;
    if (job.delivered) {
      row.delivered = true;
      row.deliveredTx = row.deliveredTx || job.deliveryTx || null;
    }
    if (job.createdAt) row.createdAt = row.createdAt || job.createdAt;
    if (job.evidence) row.evidence = row.evidence || job.evidence;
    if (row.statusNum == null) row.statusNum = 1; // open in this process ⇒ HELD
  });
};

/**
 * Every held/escrow purchase, newest first — powers the Receipts page's
 * "Held escrow purchases" section. Rows are only included when they actually
 * settled into escrow (USDSettled seen, or a live job) so unrelated payment
 * events never show up as purchases.
 */
export const listHeldPurchases = async () => {
  if (!isHeldEnabled()) throw Object.assign(new Error('held mode disabled'), { status: 503 });
  loadHistory();
  if (!scanInFlight) {
    scanInFlight = scanChain().catch((err) => {
      logger.warn('[held] history chain scan failed — serving cached rows:', err.message);
    }).finally(() => { scanInFlight = null; });
  }
  await scanInFlight;
  mergeLiveJobs();

  // Any row without a final event chain-known: ask the contract directly
  // (one view call per unresolved escrow — normally zero to a handful).
  const unresolved = [...history.values()].filter((r) => r.settleTx && r.statusNum == null);
  if (unresolved.length) {
    const m = manager();
    await Promise.all(unresolved.map(async (row) => {
      try {
        const p = await m.getPayment(row.escrowId);
        row.statusNum = Number(p[1]);
        if (p[10]) row.delivered = true;
      } catch { /* leave unresolved; UI shows it as open */ }
    }));
  }

  saveHistory();
  return [...history.values()]
    .filter((r) => r.settleTx || jobs.has(r.escrowId)) // only real escrow purchases
    .map((r) => ({
      escrowId: r.escrowId,
      escrowIdShort: `${r.escrowId.slice(0, 10)}…${r.escrowId.slice(-8)}`,
      status: STATUS_NAME[r.statusNum ?? 1] || 'HELD',
      statusNum: r.statusNum ?? 1,
      delivered: !!r.delivered,
      decision: r.decision || null,
      amount: r.amount || null,
      usdCents: r.usdCents ?? null,
      payer: r.payer || null,
      receiver: r.receiver || null,
      settleTx: r.settleTx || null,
      deliveredTx: r.deliveredTx || null,
      decisionTx: r.decisionTx || null,
      createdAt: r.createdAt || r.updatedAt || null,
    }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
};
