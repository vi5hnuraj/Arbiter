/**
 * hederaProofService — Machine-to-Human proof anchoring via Hedera HCS.
 *
 * Pattern borrowed from Recibo (live x402 delivery-proof project): every
 * meaningful settlement state transition is anchored as an immutable,
 * publicly-readable message on a Hedera Consensus Service topic. A human —
 * auditor, judge, payer, regulator — can verify what happened WITHOUT
 * trusting Arbiter's servers: open hashscan.io, read the topic, compare
 * the anchored Base Sepolia tx hashes against Basescan.
 *
 * Flow on a completed purchase (Base Sepolia / KeeperHub rail):
 *   HELD       ← settleInvoice tx (funds escrowed in Payment Manager)
 *   DELIVERED  ← service delivered + credits granted (sha256 of the receipt)
 *   RELEASED   ← release tx (escrow released to provider)
 *
 * DESIGN: fail-open, always. Proof anchoring is an audit enhancement —
 * if Hedera is unreachable, the purchase still completes and this service
 * logs a warning. Anchors are fire-and-forget (not awaited on the critical
 * settlement path).
 *
 * Env:
 *   HEDERA_ACCOUNT_ID    operator account (0.0.x) that pays HCS fees (~$0.0001/msg)
 *   HEDERA_PRIVATE_KEY   operator's ECDSA private key
 *   HEDERA_HCS_TOPIC_ID  existing topic to anchor to (run scripts once to create)
 *   HEDERA_NETWORK       'testnet' (default) | 'mainnet'
 *   HEDERA_PROOF_ENABLED set to 'false' to disable entirely (default: enabled iff credentials present)
 */

import 'dotenv/config';
import logger from '../utils/logger.js';

const NETWORK = process.env.HEDERA_NETWORK || 'testnet';
const TOPIC_ID = process.env.HEDERA_HCS_TOPIC_ID || '';
const ACCOUNT_ID = process.env.HEDERA_ACCOUNT_ID || '';
const PRIVATE_KEY = process.env.HEDERA_PRIVATE_KEY || '';

export const isHederaProofConfigured = () =>
  Boolean(ACCOUNT_ID && PRIVATE_KEY && TOPIC_ID) &&
  process.env.HEDERA_PROOF_ENABLED !== 'false';

// Lazy SDK import + memoized client so the backend boots fine with no Hedera
// credentials (isConfigured=false) and never pays SDK init cost until needed.
let _clientPromise = null;
const getClient = async () => {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const { Client, PrivateKey } = await import('@hiero-ledger/sdk');
      const { default: dotenv } = await import('dotenv');
      dotenv.config({ override: false });
      const client = Client.forName(NETWORK === 'mainnet' ? 'mainnet' : 'testnet');
      client.setOperator(
        process.env.HEDERA_ACCOUNT_ID || ACCOUNT_ID,
        PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY || PRIVATE_KEY)
      );
      return client;
    })().catch((err) => {
      _clientPromise = null;
      throw err;
    });
  }
  return _clientPromise;
};

/**
 * Anchor an arbitrary JSON payload to the HCS topic.
 *
 * @param {object} payload  Serializable proof payload.
 * @returns {Promise<{ok: boolean, topicId?, sequenceNumber?, consensusTimestamp?, transactionId?, error?}>}
 */
export const anchorProof = async (payload) => {
  if (!isHederaProofConfigured()) {
    return { ok: false, error: 'not_configured' };
  }
  try {
    const { TopicMessageSubmitTransaction } = await import('@hiero-ledger/sdk');
    const client = await getClient();
    const message = JSON.stringify({
      ...payload,
      anchoredAt: new Date().toISOString(),
      anchorer: 'arbiter/hederaProofService',
    });

    const txResponse = await new TopicMessageSubmitTransaction({
      topicId: TOPIC_ID,
      message,
    }).execute(client);

    // getRecord includes consensusTimestamp; getReceipt does not.
    const record = await txResponse.getRecord(client);
    const receipt = record.receipt;

    const anchorMeta = {
      ok: true,
      topicId: TOPIC_ID,
      sequenceNumber: receipt.topicSequenceNumber.toString(),
      consensusTimestamp: record.consensusTimestamp?.toString?.() || null,
      transactionId: record.transactionId?.toString?.() || null,
      hashscanUrl: `https://hashscan.io/${NETWORK}/topic/${TOPIC_ID}`,
    };
    logger.info(`[HEDERA-PROOF] anchored seq=${anchorMeta.sequenceNumber} type=${payload.type}`);
    return anchorMeta;
  } catch (err) {
    // Fail-open: anchoring must never break settlement.
    logger.warn('[HEDERA-PROOF] anchor failed (fail-open):', err.message);
    return { ok: false, error: err.message };
  }
};

/**
 * Anchor the purchase lifecycle. Called from commerceService after each
 * settlement milestone. All Base tx hashes ride inside the payload so the
 * HCS message is a self-contained, human-auditable record.
 */
export const anchorPurchaseEvent = async ({ type, sessionId, paymentId, invoiceReference, txHash, explorerUrl, details }) => {
  return anchorProof({
    schema: 'arbiter.purchase.v1',
    type,                     // HELD | DELIVERED | RELEASED | REFUNDED | FAILED
    sessionId,
    paymentId,
    invoiceReference,
    txHash: txHash || null,
    explorerUrl: explorerUrl || (txHash ? `https://sepolia.arbiscan.io/tx/${txHash}` : null),
    details: details || null,
  });
};

export default { anchorProof, anchorPurchaseEvent, isHederaProofConfigured };
