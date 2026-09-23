/**
 * Arbiter demo routes — makes the two flagship flows clickable in the console:
 *
 *   GET  /api/arbiter/info                     → contract, live Chainlink price, wallet balances
 *   GET  /api/arbiter/engagements              → B2B engagements aggregated from contract events
 *   POST /api/arbiter/engagement-demo/run      → full Pact cycle: propose → accept → fund →
 *                                                deliver → approve (returns every tx hash)
 *   POST /api/arbiter/held-demo/start          → settle INTO escrow + deliverable immediately
 *                                                (decide via the existing /api/x402/held/:id/*)
 *   GET  /api/arbiter/reputation               → portable on-chain reputation counters
 *
 * Reads are public; demo writes are relayer-driven exactly like the held e2e
 * (the console user signs a decision, the server pays gas).
 */
import { Router } from 'express';
import { ethers } from 'ethers';
import logger from '../utils/logger.js';
import { buildHeldChallenge } from '../services/heldService.js';
import { getMarketplaceService } from '../services/marketplaceService.js';
import { supabase } from '../config/supabaseClient.js';
import { getWalletService } from '../wallets/walletService.js';

const router = Router();

const RPC = () => process.env.ARC_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc';
const MANAGER = () => process.env.MANAGER_ADDRESS || process.env.ARBITER_MANAGER_ADDRESS || '';
const USDC = () => process.env.USDC_CONTRACT_ADDRESS || '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
/**
 * Paxos USDG (Global Dollar) — the Buildathon bonus-criterion stablecoin.
 * Default is the verified Arbitrum One proxy; set USDG_CONTRACT_ADDRESS to the
 * testnet address of the ACTIVE network before running a USDG settlement there.
 */
const USDG = () => process.env.USDG_CONTRACT_ADDRESS || '0x004B506865409877C9fA29bfb1ebA929984B9bbC';
/** Same wallet precedence as scripts/held-e2e.js */
const buyerKey = () => process.env.PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY || '';
/** Demo provider — the same well-known Hardhat account #1 key used by scripts/demo-b2b.js
 *  (public test key, testnet only; the contract requires provider != client). Set PROVIDER_KEY to override. */
const DEFAULT_PROVIDER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const sellerKey = () => process.env.PROVIDER_KEY || DEFAULT_PROVIDER_KEY;

// Deploy block of the current ArbiterManager on Arbitrum Sepolia (first events ~310961269).
const DEPLOY_BLOCK = 310_961_000;

const MANAGER_ABI = [
  'function settleInvoiceUSDEscrow(bytes32 id,address receiver,bytes32 invoiceRef,address token,uint256 usdCents,uint256 maxAmount,bytes32 termsHash,uint256 reviewWindow)',
  'function markDelivered(bytes32 id,bytes32 evidenceHash)',
  'function approveDelivery(bytes32 id)',
  'function rejectDelivery(bytes32 id)',
  'function autoResolve(bytes32 id)',
  'function getPayment(bytes32 id) view returns (uint8,uint8,address,address,address,uint256,uint256,bytes32,uint256,bytes32,bool,uint256,bytes32)',
  'function proposeEngagement(bytes32 id,address provider,address token,uint256 usdCents,uint64 deadline,bytes32 termsHash)',
  'function acceptEngagement(bytes32 id,bytes32 termsHash)',
  'function fundEngagement(bytes32 id,uint256 maxAmount,uint256 reviewWindow)',
  'function getEngagement(bytes32 id) view returns (uint8,address,address,address,uint256,uint64,bytes32,bool)',
  'function quoteUSD(uint256 usdCents) view returns (uint256,int256)',
  'function engagementsCompleted(address) view returns (uint256)',
  'event EngagementProposed(bytes32 indexed id, address indexed client, address indexed provider, bytes32 termsHash, uint256 usdCents, uint256 deadline)',
  'event EngagementAccepted(bytes32 indexed id, address indexed provider, bytes32 termsHash, uint256 at)',
  'event EngagementFunded(bytes32 indexed id, address indexed client, uint256 amount, int256 price)',
];

const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const ENGAGEMENT_STATUS = ['NONE', 'PROPOSED', 'ACCEPTED', 'FUNDED', 'SETTLED', 'CANCELLED'];

const ERC20_META_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

/**
 * Resolve the settlement token for a request. 'USDG' selects Paxos Global Dollar,
 * anything else defaults to USDC. The on-chain symbol is verified before any
 * money moves — this platform settles in the real asset or not at all.
 */
const resolveSettlementToken = async (requested) => {
  const kind = String(requested || 'USDC').toUpperCase();
  if (kind !== 'USDC' && kind !== 'USDG') {
    throw Object.assign(new Error(`unsupported settlement token "${requested}" — use USDC or USDG`), { status: 400 });
  }
  const address = kind === 'USDG' ? USDG() : USDC();
  if (!address) throw Object.assign(new Error(`${kind} address is not configured`), { status: 500 });
  const meta = new ethers.Contract(address, ERC20_META_ABI, provider());
  const [symbol, decimals] = await Promise.all([meta.symbol(), meta.decimals()]);
  if (symbol !== kind) {
    throw Object.assign(new Error(`token at ${address} reports symbol "${symbol}", expected "${kind}" — refusing to settle`), { status: 500 });
  }
  if (Number(decimals) !== 6) {
    throw Object.assign(new Error(`token at ${address} reports ${decimals} decimals, expected 6 — refusing to settle`), { status: 500 });
  }
  return { kind, address };
};

const provider = () => new ethers.JsonRpcProvider(RPC());
const manager = (signer) => new ethers.Contract(MANAGER(), MANAGER_ABI, signer || provider());
const usdc = (signer) => new ethers.Contract(USDC(), ERC20_ABI, signer || provider());
const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '');

// ── 1. Info strip: live price + wallet funding state ────────────────────────
router.get('/info', async (req, res) => {
  try {
    const p = provider();
    const buyer = buyerKey() ? new ethers.Wallet(buyerKey(), p) : null;
    const [amount, price] = await manager().quoteUSD(100); // $1.00 in cents
    const out = {
      manager: MANAGER(),
      usdc: USDC(),
      usdg: USDG(),
      settlementTokens: ['USDC', 'USDG'],
      chainlinkPrice: ethers.formatUnits(price, 8),
      dollarFor100Cents: ethers.formatUnits(amount, 6),
      buyer: buyer ? buyer.address : null,
    };
    if (buyer) {
      out.buyerUsdc = ethers.formatUnits(await usdc(p).balanceOf(buyer.address), 6);
      out.buyerUsdg = ethers.formatUnits(await new ethers.Contract(USDG(), ERC20_ABI, p).balanceOf(buyer.address), 6);
      out.buyerEth = ethers.formatEther(await p.getBalance(buyer.address));
    }
    return res.json(out);
  } catch (err) {
    logger.error('[arbiter] info failed:', err.message);
    return res.status(500).json({ message: err.message });
  }
});

// ── 2. Engagements list, aggregated from contract events ────────────────────
let listCache = { at: 0, data: null };
router.get('/engagements', async (req, res) => {
  try {
    if (listCache.data && Date.now() - listCache.at < 30_000) return res.json(listCache.data);
    const m = manager();
    const latest = await provider().getBlockNumber();
    const proposed = [];
    for (let from = DEPLOY_BLOCK; from <= latest; from += 50_000) {
      const to = Math.min(from + 49_999, latest);
      proposed.push(...(await m.queryFilter(m.filters.EngagementProposed(), from, to)));
    }
    const [accepted, funded] = await Promise.all([
      m.queryFilter(m.filters.EngagementAccepted(), DEPLOY_BLOCK, 'latest').catch(() => []),
      m.queryFilter(m.filters.EngagementFunded(), DEPLOY_BLOCK, 'latest').catch(() => []),
    ]);
    const acceptedIds = new Set(accepted.map((e) => e.args.id));
    const fundedMap = new Map(funded.map((e) => [e.args.id, e.args]));
    const items = [];
    for (const ev of proposed) {
      const { id, client, provider: prov, termsHash, usdCents, deadline } = ev.args;
      let status = acceptedIds.has(id) ? 'ACCEPTED' : 'PROPOSED';
      let onchain = null;
      try {
        const g = await m.getEngagement(id);
        status = ENGAGEMENT_STATUS[Number(g[0])] || status;
        onchain = { funded: g[7], deadline: Number(g[5]) };
      } catch { /* keep event-derived status */ }
      const f = fundedMap.get(id);
      items.push({
        id,
        idShort: short(id),
        client,
        provider: prov,
        usd: (Number(usdCents) / 100).toFixed(2),
        termsHash,
        status,
        amount: f ? ethers.formatUnits(f.amount, 6) : null,
        chainlinkPrice: f ? ethers.formatUnits(f.price, 8) : null,
        proposedTx: ev.transactionHash,
        acceptedTx: accepted.find((e) => e.args.id === id)?.transactionHash || null,
        fundedTx: f?.transactionHash || null,
        blockNumber: ev.blockNumber,
      });
    }
    items.sort((a, b) => b.blockNumber - a.blockNumber);
    listCache = { at: Date.now(), data: { count: items.length, items } };
    return res.json(listCache.data);
  } catch (err) {
    logger.error('[arbiter] engagements failed:', err.message);
    return res.status(500).json({ message: err.message });
  }
});

// ── 3. Full Pact-cycle demo: propose → accept → fund → deliver → approve ────
router.post('/engagement-demo/run', async (req, res) => {
  const usdCents = Math.max(1, Math.min(500, Number(req.body?.usdCents) || 25));
  const steps = [];
  try {
    if (!MANAGER()) throw new Error('MANAGER_ADDRESS not configured');
    const p = provider();
    const buyer = new ethers.Wallet(buyerKey(), p);
    const seller = new ethers.Wallet(sellerKey(), p);
    if (seller.address.toLowerCase() === buyer.address.toLowerCase()) {
      throw new Error('PROVIDER_KEY wallet must differ from the buyer wallet (contract requires provider != client)');
    }
    const mBuyer = manager(buyer);
    const mSeller = manager(seller);
    const token = USDC();

    // fund check
    const needed = (await mBuyer.quoteUSD(usdCents))[0];
    const bal = await usdc(p).balanceOf(buyer.address);
    if (bal < needed) {
      throw Object.assign(new Error(`buyer wallet needs ${ethers.formatUnits(needed, 6)} USDC — has ${ethers.formatUnits(bal, 6)}. Claim test USDC at https://faucet.circle.com (network: Arbitrum Sepolia).`), { status: 402 });
    }
    // allowance check (only spends gas when needed)
    if ((await usdc(p).allowance(buyer.address, MANAGER())) < needed) {
      const atx = await usdc(buyer).approve(MANAGER(), ethers.MaxUint256);
      await atx.wait();
      steps.push({ step: 'approve USDC', txHash: atx.hash });
    }

    const id = ethers.keccak256(ethers.toUtf8Bytes(`arbiter:engagement-demo:${Date.now()}:${ethers.hexlify(ethers.randomBytes(4))}`));
    const terms = JSON.stringify({ service: 'console-demo', usdCents, createdAt: Date.now() });
    const termsHash = ethers.keccak256(ethers.toUtf8Bytes(terms));

    const t1 = await (await mBuyer.proposeEngagement(id, seller.address, token, usdCents, 0, termsHash)).wait();
    steps.push({ step: 'propose', txHash: t1.hash, detail: `termsHash ${short(termsHash)}` });

    const t2 = await (await mSeller.acceptEngagement(id, termsHash)).wait();
    steps.push({ step: 'accept (mutual signature)', txHash: t2.hash });

    const t3 = await (await mBuyer.fundEngagement(id, needed, 3600)).wait();
    const q = await mBuyer.quoteUSD(usdCents);
    steps.push({ step: 'fund escrow', txHash: t3.hash, detail: `${ethers.formatUnits(needed, 6)} USDC @ Chainlink ${ethers.formatUnits(q[1], 8)}` });

    const evidence = ethers.keccak256(ethers.toUtf8Bytes(`${terms}:delivered`));
    const t4 = await (await mSeller.markDelivered(id, evidence)).wait();
    steps.push({ step: 'deliver (evidence hash on-chain)', txHash: t4.hash });

    const t5 = await (await mBuyer.approveDelivery(id)).wait();
    steps.push({ step: 'approve → provider paid', txHash: t5.hash });

    const rep = await mBuyer.engagementsCompleted(seller.address);
    return res.json({
      engagementId: id,
      engagementIdShort: short(id),
      steps,
      reputation: rep.toString(),
      arbiscan: steps.map((s) => `https://sepolia.arbiscan.io/tx/${s.txHash}`),
    });
  } catch (err) {
    logger.error('[arbiter] engagement demo failed:', err.message);
    return res.status(err.status || 500).json({ message: err.message, steps });
  }
});

// ── 4. Held-mode demo: settle INTO escrow, deliverable returns now ──────────
// Roles on-chain: buyer settles (msg.sender becomes p.sender), the SELLER marks
// delivered (msg.sender must equal p.receiver), then the buyer decides. The
// relayer only executes the buyer's DECISION via /api/x402/held/:id/*.
router.post('/held-demo/start', async (req, res) => {
  try {
    if (!MANAGER()) throw new Error('MANAGER_ADDRESS not configured');
    const usdCents = Math.max(1, Math.min(500, Number(req.body?.usdCents) || 50));
    const serviceId = req.body?.serviceId ? String(req.body.serviceId) : null;
    const buyerAgentId = req.body?.buyerAgentId ? String(req.body.buyerAgentId) : null;
    // Settlement token: 'USDC' (default) or 'USDG' — Paxos Global Dollar, the
    // Buildathon bonus-criterion stablecoin. The real symbol is verified on-chain.
    const token = await resolveSettlementToken(req.body?.settlementToken);
    const challenge = await buildHeldChallenge({ endpoint: 'held-demo-panel', priceCents: usdCents, settlementToken: token.kind });
    const p = provider();
    let buyer;
    let buyerAgent = null;
    if (buyerAgentId) {
      const { data, error } = await supabase.from('ai_agents').select('*').eq('agent_id', buyerAgentId).eq('status', 'active').maybeSingle();
      if (error || !data) throw Object.assign(new Error('Selected buyer agent was not found or is inactive.'), { status: 404 });
      if (!data.wallet_id || !data.wallet_address) throw Object.assign(new Error('Selected buyer agent does not have a managed wallet.'), { status: 409 });
      buyerAgent = data;
      buyer = { address: data.wallet_address };
    } else buyer = new ethers.Wallet(buyerKey(), p);
    const seller = new ethers.Wallet(sellerKey(), p);
    const service = serviceId ? await getMarketplaceService(serviceId) : null;
    const selectedProvider = service?.provider?.wallet || seller.address;
    if (service && selectedProvider.toLowerCase() !== seller.address.toLowerCase()) {
      throw Object.assign(new Error('The selected marketplace provider is not connected to the demo provider signer. Set PROVIDER_KEY to that provider wallet before running this on-chain demo.'), { status: 409 });
    }
    if (seller.address.toLowerCase() === buyer.address.toLowerCase()) {
      throw new Error('PROVIDER_KEY wallet must differ from the buyer wallet (delivery requires receiver != buyer)');
    }
    const needed = BigInt(challenge.amount);

    const tokenContract = new ethers.Contract(token.address, ERC20_ABI, p);
    const bal = await tokenContract.balanceOf(buyer.address);
    if (bal < needed) {
      throw Object.assign(new Error(`buyer wallet needs ${ethers.formatUnits(needed, 6)} ${token.kind} — has ${ethers.formatUnits(bal, 6)}. Fund the buyer wallet with ${token.kind} on Arbitrum Sepolia first (USDC faucet: https://faucet.circle.com).`), { status: 402 });
    }
    const walletService = buyerAgent ? getWalletService() : null;
    const sendBuyerCall = async (to, data, idempotencyKey) => {
      if (!buyerAgent) return null;
      const result = await walletService.sendContractCall({ walletId: buyerAgent.wallet_id, to, data, idempotencyKey });
      await p.waitForTransaction(result.txHash);
      return result.txHash;
    };
    const erc20Interface = new ethers.Interface(['function approve(address spender,uint256 amount) returns (bool)']);
    const managerInterface = new ethers.Interface(MANAGER_ABI);
    if ((await tokenContract.allowance(buyer.address, MANAGER())) < needed) {
      if (buyerAgent) await sendBuyerCall(token.address, erc20Interface.encodeFunctionData('approve', [MANAGER(), ethers.MaxUint256]), `held-approve-${challenge.escrowId}`);
      else await (await tokenContract.connect(buyer).approve(MANAGER(), ethers.MaxUint256)).wait();
    }

    // ① buyer settles INTO the escrow contract
    const settleArgs = [
      challenge.escrowId, seller.address, challenge.escrowId, token.address, usdCents, needed, challenge.escrowId, challenge.extensions.held.reviewSeconds,
    ];
    let settleTx;
    if (buyerAgent) settleTx = await sendBuyerCall(MANAGER(), managerInterface.encodeFunctionData('settleInvoiceUSDEscrow', settleArgs), `held-settle-${challenge.escrowId}`);
    else {
      const settle = await manager(buyer).settleInvoiceUSDEscrow(...settleArgs);
      settleTx = (await settle.wait()).hash;
    }

    // ② seller immediately commits the delivery evidence (buyer reads NOW, decides later)
    const deliverable = { answer: `Held-mode analysis for the console demo ($${(usdCents / 100).toFixed(2)}).`, confidence: 0.82, provider: 'arbiter-research-agent-v1', generatedAt: new Date().toISOString() };
    const evidence = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(deliverable)));
    const drc = await (await manager(seller).markDelivered(challenge.escrowId, evidence)).wait();

    return res.json({
      escrowId: challenge.escrowId,
           escrowIdShort: short(challenge.escrowId),
      buyer: buyer.address,
      provider: selectedProvider,
      serviceId: service?.serviceId || null,
      serviceTitle: service?.title || null,
      buyerAgentId: buyerAgent?.agent_id || null,
      contract: MANAGER(),
      usdc: token.address,
      settlementToken: token.kind,
      network: 'Arbitrum Sepolia',
      chainId: 421614,
        settleTx,
       deliveryTx: drc.hash,
      amount: challenge.amount,
      amountUsdc: ethers.formatUnits(challenge.amount, 6),
      amountLabel: `${ethers.formatUnits(challenge.amount, 6)} ${token.kind}`,
      quote: { usdCents, amount: challenge.amount, settlementToken: token.kind },
      reviewSeconds: challenge.extensions.held.reviewSeconds,
      deliverable,
      status: 'DELIVERED_AWAITING_REVIEW',
    });
  } catch (err) {
    logger.error('[arbiter] held demo failed:', err.message);
    return res.status(err.status || 500).json({ message: err.message });
  }
});

// ── 5. Portable reputation counters ─────────────────────────────────────────
router.get('/reputation', async (req, res) => {
  try {
    const m = manager();
    const buyer = buyerKey() ? new ethers.Wallet(buyerKey()).address : null;
    let seller = null;
    try { seller = new ethers.Wallet(sellerKey()).address; } catch { /* not configured */ }
    const out = {};
    for (const [label, addr] of [['buyer', buyer], ['provider', seller]]) {
      if (!addr) continue;
      out[label] = { address: addr, engagementsCompleted: (await m.engagementsCompleted(addr)).toString() };
    }
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

export default router;
