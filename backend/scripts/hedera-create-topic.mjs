/**
 * One-off: create a fresh HCS topic whose memo matches the CURRENT rail
 * (Arbitrum Sepolia direct), replacing the stale "KeeperHub rail" topic.
 *   cd backend && node scripts/hedera-create-topic.mjs
 * Prints NEW_TOPIC=<id>; then update HEDERA_HCS_TOPIC_ID in backend/.env.
 */
import 'dotenv/config';

const MEMO = process.argv[2] || 'Arbiter settlement proofs — Arbitrum Sepolia | machine-to-human audit trail';

const main = async () => {
  const { Client, PrivateKey, TopicCreateTransaction } = await import('@hiero-ledger/sdk');
  const client = Client.forName(process.env.HEDERA_NETWORK === 'mainnet' ? 'mainnet' : 'testnet');
  client.setOperator(process.env.HEDERA_ACCOUNT_ID, PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY));
  client.setRequestTimeout(30_000);

  const tx = await new TopicCreateTransaction().setTopicMemo(MEMO).execute(client);
  const receipt = await tx.getReceipt(client);
  console.log('NEW_TOPIC=' + receipt.topicId.toString());
  process.exit(0);
};

main().catch((err) => {
  console.error('TOPIC_CREATE_FAILED:', err.message);
  process.exit(1);
});
