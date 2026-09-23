/**
 * Backward-compatibility facade — the wallet provider is now Privy.
 * All components keep importing from './mpcWallet'; the implementation
 * lives in './privyWallet' (Privy server wallets via the backend).
 */
export * from './privyWallet.js';
