/**
 * Held-mode x402 routes — "You pay first. The money waits until you have read
 * what you bought." (Escrow-by-substitution, inspired by Held, ETHOnline 2026.)
 *
 *   GET  /api/x402/held/work          → 402 challenge naming the ESCROW contract
 *   POST /api/x402/held/work          → X-PAYMENT { escrowId, txHash, payer }
 *                                       → verify escrow on-chain → deliverable NOW
 *   GET  /api/x402/held/:escrowId     → on-chain status of the held money
 *   POST /api/x402/held/:escrowId/approve  → seller paid
 *   POST /api/x402/held/:escrowId/reject   → buyer refunded (before deadline)
 *   POST /api/x402/held/:escrowId/partial  → { toProvider } split release
 */
import { Router } from 'express';
import { ethers } from 'ethers';
import logger from '../utils/logger.js';
import {
  buildHeldChallenge, openHeldJob, approveHeldJob, rejectHeldJob,
  partialHeldJob, heldJobStatus, heldStats, isHeldEnabled, listHeldPurchases,
} from '../services/heldService.js';

const router = Router();

/** The deliverable the buyer reads before deciding. */
const buildDeliverable = (question) => ({
  answer: `Analysis of "${String(question).slice(0, 120)}"`,
  confidence: 0.82,
  provider: 'arbiter-research-agent-v1',
  generatedAt: new Date().toISOString(),
});

// ── 1. Challenge: ordinary 402, payTo = escrow contract ────────────────────
router.get('/work', async (req, res) => {
  if (!isHeldEnabled()) return res.status(503).json({ status: 503, message: 'held mode disabled' });
  const challenge = await buildHeldChallenge({ endpoint: '/api/x402/held/work' });
  res.set('WWW-Authenticate', `x402 challenge="${challenge.escrowId}"`);
  return res.status(402).json(challenge);
});

// ── 2. Paid request: buyer settled INTO escrow, deliverable returns now ────
router.post('/work', async (req, res) => {
  if (!isHeldEnabled()) return res.status(503).json({ status: 503, message: 'held mode disabled' });

  const header = req.headers['x-payment'] || req.headers['X-PAYMENT'];
  if (!header) return res.status(402).json(await buildHeldChallenge({ endpoint: '/api/x402/held/work' }));

  let claim;
  try {
    claim = typeof header === 'string' ? JSON.parse(header) : header;
  } catch {
    return res.status(400).json({ status: 400, message: 'X-PAYMENT must be JSON: { escrowId, txHash, payer }' });
  }
  if (!claim.escrowId || !/^0x[0-9a-fA-F]{64}$/.test(claim.escrowId)) {
    return res.status(400).json({ status: 400, message: 'escrowId (bytes32) required — take it from the 402 challenge.' });
  }
  if (!claim.txHash || !/^0x[0-9a-fA-F]{64}$/.test(claim.txHash)) {
    return res.status(400).json({ status: 400, message: 'txHash of your settle transaction required.' });
  }

  try {
    // On-chain check: the tx must exist, succeed, and target the escrow contract.
    const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc');
    const receipt = await provider.getTransactionReceipt(claim.txHash);
    if (!receipt || receipt.status !== 1) {
      return res.status(402).json({ status: 402, message: 'settle transaction not mined / failed.' });
    }
    if (receipt.to.toLowerCase() !== (process.env.MANAGER_ADDRESS || '').toLowerCase()) {
      return res.status(402).json({ status: 402, message: 'settle transaction did not target the escrow contract.' });
    }

    const result = await openHeldJob({
      escrowId: claim.escrowId,
      payer: claim.payer || null,
      txHash: claim.txHash,
      endpoint: '/api/x402/held/work',
      deliverable: buildDeliverable(req.body?.question || 'default research question'),
    });
    return res.status(200).json(result);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) logger.error('[held] openHeldJob failed:', err.message);
    return res.status(status).json({ status, message: err.message });
  }
});

// ── 3. Purchase history: every held escrow, newest first ──────────────────
// Powers the Receipts page's "Held escrow purchases" section — escrow buys
// are purchases too. Merges persisted rows + live jobs + an incremental
// ArbiterManager log scan (see listHeldPurchases).
router.get('/', async (req, res) => {
  try {
    return res.json({ escrows: await listHeldPurchases() });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) logger.error('[held] listHeldPurchases failed:', err.message);
    return res.status(status).json({ status, message: err.message });
  }
});

// ── 4. Status ────────────────────────────────────────────────────────────────
router.get('/:escrowId', async (req, res) => {
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(req.params.escrowId)) {
      return res.status(400).json({ status: 400, message: 'bad escrowId' });
    }
    return res.json(await heldJobStatus(req.params.escrowId));
  } catch (err) {
    return res.status(err.status || 404).json({ status: err.status || 404, message: err.message });
  }
});

// ── 5. Decisions ─────────────────────────────────────────────────────────────
const decision = (fn) => async (req, res) => {
  try {
    return res.json(await fn(req.params.escrowId, req.body?.toProvider));
  } catch (err) {
    if (err.code === 'CALL_EXCEPTION') err.status = 409;
    return res.status(err.status || 500).json({ status: err.status || 500, message: err.message });
  }
};
router.post('/:escrowId/approve', decision((id) => approveHeldJob(id)));
router.post('/:escrowId/reject', decision((id) => rejectHeldJob(id)));
router.post('/:escrowId/partial', decision((id, toProvider) => partialHeldJob(id, toProvider)));
router.get('/stats/overview', (req, res) => res.json(heldStats()));

export default router;
