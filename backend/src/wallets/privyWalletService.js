/**
 * PrivyWalletService — server-wallet provider via Privy Server Wallets.
 *
 * Implements the swappable wallet service provider interface (same contract
 * the previous MPC provider implemented):
 *   createWallet({ name, ownerId }) -> { walletId, address, provider }
 *   getAddress(walletId)            -> string
 *   getBalance(address)             -> { wei, formatted }
 *   getWallet(walletId)             -> provider wallet record
 *   getWalletChainId(walletId)      -> number
 *   sendPayment({ walletId, to, wei, idempotencyKey }) -> { txHash, network }
 *   sendContractCall({ walletId, to, data, wei, gasLimit, idempotencyKey }) -> { txHash }
 *   sendSplitPayment({ walletId, recipients }) -> { txHash }
 *
 * Custody model: Privy Server Wallets — keys are held by Privy; Arbiter
 * authenticates with a Privy app (PRIVY_APP_ID + PRIVY_APP_SECRET) and signs
 * via the Privy REST API with an idempotency key. No private key material ever
 * reaches this process (same property the MPC node provided).
 *
 * Env:
 *   PRIVY_APP_ID           — Privy application id
 *   PRIVY_APP_SECRET       — Privy app secret (server only)
 *   PRIVY_WALLET_API_URL   — default https://api.privy.io/v1
 *   PRIVY_AUTHORIZATION_KEY — optional Privy authorization key (if enabled)
 *   PRIVY_CHAIN_ID         — chain the wallets operate on (default from ARC_CHAIN_ID)
 *
 * Docs: https://docs.privy.io/wallets/using-wallets/ethereum
 */

import { getProvider } from '../services/chainRpcService.js';
import { logger } from '../utils/logger.js';
import { ethers } from 'ethers';
import crypto from 'node:crypto';

/*
 * Token model (Base Sepolia): USDC is an ERC-20 with 6 decimals and native
 * ETH pays gas. The wallet interface below therefore speaks USDC:
 *   - getBalance returns the USDC balance (plus the native gas balance)
 *   - sendPayment transfers USDC by default (token: 'USDC'), native only if asked
 *   - `wei` amounts arriving here are 18-decimal (parseEther) values used
 *     across the codebase; the ERC-20 path normalizes them to USDC base units.
 */
const USDC_DECIMALS = 6;
const WEI_PER_USDC_UNIT = 1_000_000_000_000n; // 1e12 — 18-dec -> 6-dec normalization
const usdcAddress = () =>
  (process.env.USDC_CONTRACT_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e'); // Base Sepolia USDC
const usdcContract = () =>
  new ethers.Contract(
    usdcAddress(),
    ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'],
    getProvider()
  );
// Paxos USDG (Global Dollar) — optional second settlement token, 6 decimals.
// Default is the verified testnet proxy on Arbitrum Sepolia; override via env.
const usdgAddress = () =>
  (process.env.USDG_CONTRACT_ADDRESS || '0xFFC95faa3d63Cde504a05B567C600B78C0b41892');
const usdgContract = () =>
  new ethers.Contract(
    usdgAddress(),
    ['function balanceOf(address) view returns (uint256)'],
    getProvider()
  );

const PRIVY_API = () => (process.env.PRIVY_WALLET_API_URL || 'https://api.privy.io/v1').replace(/\/+$/, '');
const PRIVY_APP_ID = () => process.env.PRIVY_APP_ID || '';
const PRIVY_APP_SECRET = () => process.env.PRIVY_APP_SECRET || '';
const PRIVY_AUTHORIZATION_KEY = () => process.env.PRIVY_AUTHORIZATION_KEY || '';

const chainId = () =>
  Number(process.env.PRIVY_CHAIN_ID || process.env.ARC_CHAIN_ID || process.env.CHAIN_ID || 421614);

export const isPrivyConfigured = () => Boolean(PRIVY_APP_ID() && PRIVY_APP_SECRET());

/** Live gas estimate for a plain transfer (module-level for auth flows). */
export const transferGasWei = async () => {
  const rpc = getProvider();
  const fee = await rpc.getFeeData().catch(() => null);
  return 21_000n * (fee?.gasPrice ?? 1_000_000_000n);
};

/** Production guard: refuse to boot with a stubbed wallet provider. */
export const assertPrivyProductionConfiguration = () => {
  const env = (process.env.NODE_ENV || '').toLowerCase();
  if (env !== 'production') return;
  const problems = [];
  if (!PRIVY_APP_ID()) problems.push('PRIVY_APP_ID is not set');
  if (!PRIVY_APP_SECRET()) problems.push('PRIVY_APP_SECRET is not set');
  if (problems.length) {
    throw new Error(`Privy production configuration invalid: ${problems.join('; ')}`);
  }
  logger.info('[PRIVY WALLET] production configuration verified');
};

const assertConfigured = () => {
  if (!isPrivyConfigured()) {
    throw Object.assign(
      new Error('Privy is not configured: set PRIVY_APP_ID and PRIVY_APP_SECRET in backend .env'),
      { code: 'PRIVY_NOT_CONFIGURED' }
    );
  }
};

const privyHeaders = () => ({
  'Content-Type': 'application/json',
  'privy-app-id': PRIVY_APP_ID(),
  'Authorization': `Basic ${Buffer.from(`${PRIVY_APP_ID()}:${PRIVY_APP_SECRET()}`).toString('base64')}`,
  // Privy requires a unique UUID per request (idempotency / request-tracing id).
  'privy-ca-id': crypto.randomUUID(),
  ...(PRIVY_AUTHORIZATION_KEY() ? { 'privy-authorization-key': PRIVY_AUTHORIZATION_KEY() } : {})
});

const privyRequest = async (path, { method = 'POST', body, headers, timeoutMs = 60_000 } = {}) => {
  assertConfigured();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${PRIVY_API()}${path}`, {
      method,
      headers: { ...privyHeaders(), ...(headers || {}) },
      signal: controller.signal,
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = payload?.error || payload?.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(`Privy ${method} ${path} failed: ${msg}`), { status: res.status, privy: payload });
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
};

const timeoutMs = () => Math.max(1000, Number(process.env.MPC_RPC_TIMEOUT_MS || 60000));

const waitForReceipt = async (txHash) => {
  const provider = getProvider();
  const deadline = Date.now() + timeoutMs();
  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
    if (receipt) {
      if (receipt.status !== 1) {
        throw new Error(`Transaction reverted on-chain: ${txHash}`);
      }
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  logger.warn(`[PRIVY WALLET] receipt not seen before timeout: ${txHash}`);
  return null;
};

export const createPrivyWalletService = () => {
  const provider = 'privy';

  const getWallet = async (walletId) => {
    assertConfigured();
    return privyRequest(`/wallets/${encodeURIComponent(walletId)}`, { method: 'GET' });
  };

  const createWallet = async ({ name /* kept for interface compat; stored in Arbiter DB */, ownerId } = {}) => {
    assertConfigured();
    // Privy's create-wallet body accepts only chain_type (owner requires a
    // real Privy user DID; label is not a supported key). The friendly name
    // lives in Arbiter's profiles/ai_agents rows.
    const created = await privyRequest('/wallets', {
      body: { chain_type: 'ethereum' }
    });
    const walletId = created?.id;
    const address = created?.address;
    if (!walletId || !address) throw new Error(`Privy wallet creation returned an unexpected shape: ${JSON.stringify(created).slice(0, 200)}`);
    logger.info(`[PRIVY WALLET] created wallet ${walletId} (${address}) for owner ${ownerId || 'n/a'}`);
    return { walletId, address, provider, raw: created };
  };

  const getAddress = async (walletId) => {
    const w = await getWallet(walletId);
    return w?.address;
  };

  const getBalance = async (address) => {
    const providerRpc = getProvider();
    // USDC (the settlement asset every consumer displays) + native gas, in parallel.
    const [nativeWei, usdcRaw, usdgRaw] = await Promise.all([
      providerRpc.getBalance(address).catch(() => 0n),
      usdcContract().balanceOf(address).catch(() => 0n),
      usdgContract().balanceOf(address).catch(() => 0n)
    ]);
    // `wei` is normalized to 18 decimals so BigInt comparisons against
    // parseEther amounts across the codebase keep working; `formatted` is USDC.
    const wei18 = usdcRaw * WEI_PER_USDC_UNIT;
    return {
      wei: wei18.toString(),
      formatted: Number(usdcRaw) / 10 ** USDC_DECIMALS,
      nativeWei: nativeWei.toString(),
      nativeFormatted: Number(nativeWei) / 1e18,
      usdg: Number(usdgRaw) / 10 ** 6,
      usdgAddress: usdgAddress(),
      token: 'USDC',
      tokenAddress: usdcAddress()
    };
  };

  const getWalletChainId = async () => chainId();

  const rpcSignAndSend = async ({ walletId, method, params, idempotencyKey }) => {
    assertConfigured();
    // Privy's current /rpc schema: `caip2` at the BODY root, params as an
    // object wrapping the tx; idempotency lives in the x-idempotency-key
    // header (a body-level idempotency_key is rejected as an unknown key).
    let rpcParams = params;
    if (Array.isArray(params)) {
      const tx = { ...params[0] };
      delete tx.chain_id; // superseded by caip2
      rpcParams = { transaction: tx };
    } else if (params && typeof params === 'object' && (params.to || params.data || params.value !== undefined)) {
      const tx = { ...params };
      delete tx.chain_id; // superseded by caip2
      rpcParams = { transaction: tx };
    }
    const res = await privyRequest('/wallets/' + encodeURIComponent(walletId) + '/rpc', {
      body: { method, params: rpcParams, caip2: `eip155:${chainId()}` },
      headers: idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : undefined
    });
    const data = res?.data || res;
    const hash = data?.hash || data?.transaction_hash || data?.transactionHash;
    if (!hash) {
      throw new Error(`Privy ${method} returned no tx hash: ${JSON.stringify(res).slice(0, 200)}`);
    }
    await waitForReceipt(hash);
    return { txHash: hash, network: chainId(), provider };
  };

  const sendPayment = async ({ walletId, to, wei, token, idempotencyKey }) => {
    // USDC (default): ERC-20 transfer from the server wallet. Gas still paid
    // in native ETH, so refuse early with a clear message if the wallet cannot
    // cover gas rather than reverting opaquely on-chain.
    if ((token || 'USDC').toUpperCase() === 'USDC') {
      const selfAddress = await getAddress(walletId);
      const native = await getProvider().getBalance(selfAddress).catch(() => 0n);
      if (native === 0n) {
        throw Object.assign(
          new Error('Agent wallet has no native gas (ETH). USDC transfers on Base need a little ETH for gas — fund the wallet or use the KeeperHub rail, which pays gas from the org wallet.'),
          { status: 400 }
        );
      }
      const amountUsdcUnits = BigInt(wei || '0') / WEI_PER_USDC_UNIT; // 18-dec -> 6-dec
      const data = usdcContract().interface.encodeFunctionData('transfer', [to, amountUsdcUnits]);
      return sendContractCall({
        walletId,
        to: usdcAddress(),
        data,
        wei: '0',
        idempotencyKey: idempotencyKey ? `${idempotencyKey}-usdc` : undefined
      });
    }
    // Native transfer (explicit token !== 'USDC')
    return rpcSignAndSend({
      walletId,
      method: 'eth_sendTransaction',
      params: [{ to, value: '0x' + BigInt(wei || '0').toString(16), chain_id: `eip155:${chainId()}` }],
      idempotencyKey: idempotencyKey || `privy-pay-${walletId}-${to}-${wei}`
    });
  };

  const sendContractCall = async ({ walletId, to, data, wei = '0', gasLimit, idempotencyKey }) => {
    return rpcSignAndSend({
      walletId,
      method: 'eth_sendTransaction',
      params: [{
        to,
        data,
        value: '0x' + BigInt(wei || '0').toString(16),
        chain_id: `eip155:${chainId()}`,
        ...(gasLimit ? { gas: '0x' + BigInt(gasLimit).toString(16) } : {})
      }],
      idempotencyKey: idempotencyKey || `privy-contract-${walletId}-${to}-${data?.slice(0, 10)}-${wei}`
    });
  };

  const sendSplitPayment = async ({ walletId, recipients, idempotencyKey }) => {
    // Send sequentially; each transfer is individually idempotent.
    let lastHash = null;
    for (const r of recipients) {
      const res = await sendPayment({
        walletId,
        to: r.to,
        wei: r.wei,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:${r.to}` : undefined
      });
      lastHash = res.txHash;
    }
    return { txHash: lastHash, network: chainId(), provider };
  };

  const signMessage = async ({ walletId, message }) => {
    assertConfigured();
    const res = await privyRequest('/wallets/' + encodeURIComponent(walletId) + '/rpc', {
      body: { method: 'personal_sign', params: { message, address: walletId } }
    });
    return res?.data?.signature || res?.data?.sign_response?.signature;
  };

  const transferGasPriceWei = async () => {
    const rpc = getProvider();
    const fee = await rpc.getFeeData().catch(() => null);
    return fee?.gasPrice ?? 1_000_000_000n;
  };

  const transferGasWei = async () => 21_000n * (await transferGasPriceWei());

  return {
    provider,
    createWallet,
    getAddress,
    getBalance,
    getWallet,
    getWalletChainId,
    sendPayment,
    sendContractCall,
    sendSplitPayment,
    signMessage,
    transferGasWei
  };
};
