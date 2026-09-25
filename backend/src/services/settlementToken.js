/**
 * settlementToken — single source of truth for the stablecoin settlement asset
 * used by the marketplace/Workflow Studio flow (direct rail) and the x402 held
 * escrow flow.
 *
 *   COMMERCE_ASSET  'token' (default) → ERC20 stablecoin (USDC/USDG)
 *                   'native'          → legacy native-ETH path
 *   COMMERCE_TOKEN  'USDC' (default) | 'USDG'  (Paxos Global Dollar)
 *
 * Session amounts are stored as 18dp wei figures (1 unit = $1 of buying power);
 * both settlement tokens use 6 decimals, so units = wei / 1e12.
 */

export const USDC_DEFAULT = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';   // Circle USDC, Arbitrum Sepolia
export const USDG_DEFAULT = '0x004B506865409877C9fA29bfb1ebA929984B9bbC';   // Paxos USDG — verify per network!

export const isTokenMode = () =>
  (process.env.COMMERCE_ASSET || 'token').toLowerCase() === 'token';

export const getSettlementToken = () => {
  const kind = (process.env.COMMERCE_TOKEN || 'USDC').toUpperCase();
  const address = kind === 'USDG'
    ? (process.env.USDG_CONTRACT_ADDRESS || USDG_DEFAULT)
    : (process.env.USDC_CONTRACT_ADDRESS || USDC_DEFAULT);
  return { kind, address, decimals: 6 };
};

/** 18dp wei figure → 6dp token base units (string). */
export const weiToTokenUnits = (amountWei) =>
  (BigInt(amountWei || '0') / 1_000_000_000_000n).toString();

/** Human string for a 18dp wei figure in the active asset. */
export const humanizeAmount = (amountWei) => {
  try {
    if (!isTokenMode()) return `${Number(BigInt(amountWei || '0')) / 1e18} ETH`;
    return `${Number(BigInt(weiToTokenUnits(amountWei))) / 1e6} ${getSettlementToken().kind}`;
  } catch {
    return amountWei;
  }
};

export default { isTokenMode, getSettlementToken, weiToTokenUnits, humanizeAmount };
