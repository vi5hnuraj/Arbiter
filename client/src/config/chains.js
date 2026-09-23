// client/src/config/chains.js
// Active chain: Arbitrum Sepolia (Arbiter rail, USDC ERC20 settlement).
// Values come from client/.env (VITE_CHAIN_*), with safe defaults here.

const chainId = Number(import.meta.env.VITE_CHAIN_ID || 421614);
const rpcUrl = import.meta.env.VITE_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
const chainName = import.meta.env.VITE_CHAIN_NAME || "Arbitrum Sepolia";
const explorerUrl = import.meta.env.VITE_EXPLORER_URL || "https://sepolia.arbiscan.io/";
const symbol = import.meta.env.VITE_CHAIN_SYMBOL || "ETH";

export const activeChain = {
  chainId: chainId,
  rpc: [rpcUrl],
  nativeCurrency: {
    decimals: 18,
    name: symbol === "ETH" ? "Ether" : symbol,
    symbol: symbol,
  },
  shortName: "arbitrum-sepolia",
  slug: "arbitrum-sepolia",
  testnet: true,
  chain: chainName,
  name: chainName,
  explorers: [
    {
      name: `Arbiscan Explorer`,
      url: explorerUrl,
      standard: "EIP309"
    }
  ]
};
