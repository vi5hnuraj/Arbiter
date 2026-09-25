/**
 * WalletService — abstraction over embedded/server wallet providers.
 *
 * Arbiter never hardcodes a single provider. All agent-wallet operations go
 * through this interface, so the underlying custody provider can be swapped
 * (Privy Server Wallets today; Turnkey via KeeperHub; any future provider)
 * without touching the agent API layer.
 *
 * A provider must implement:
 *   createWallet({ name, ownerId }) -> Promise<{ walletId, address, provider }>
 *   getAddress(walletId)            -> Promise<string>
 *   getBalance(address)             -> Promise<{ wei: string, formatted: string }>
 *   sendPayment({ walletId, to, wei, token }) -> Promise<{ txHash, network }>
 */

import { createPrivyWalletService } from './privyWalletService.js';

export const getWalletService = () => {
  return createPrivyWalletService();
};

export const WALLET_PROVIDER = 'privy';
