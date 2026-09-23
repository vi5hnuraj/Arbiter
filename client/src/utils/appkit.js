import { createAppKit } from '@reown/appkit/react';
import { Ethers5Adapter } from '@reown/appkit-adapter-ethers5';
import { defineChain } from '@reown/appkit/networks';

// Primary network: Arbitrum Sepolia — the chain Arbiter settles on
// (USDC ERC20 + native gas, priced via the live Chainlink USDC/USD feed).
export const arbitrumSepolia = defineChain({
  id: 421614,
  caipNetworkId: 'eip155:421614',
  chainNamespace: 'eip155',
  name: 'Arbitrum Sepolia',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc'],
    },
  },
  blockExplorers: {
    default: { name: 'Arbiscan', url: import.meta.env.VITE_EXPLORER_URL || 'https://sepolia.arbiscan.io' },
  },
  testnet: true,
});

export const appkit = createAppKit({
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '8fe9b4cfa486d6e1632640d06975e3b7',
  adapters: [new Ethers5Adapter()],
  networks: [arbitrumSepolia],
  metadata: {
    name: 'Arbiter — Agent Commerce on Arbitrum',
    description: 'Autonomous AI agents pay in USDC with Trust-Engine-verified settlement escrowed by the Arbiter contract on Arbitrum',
    url: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173',
    icons: []
  },
  features: { analytics: false },
  themeMode: 'dark',
  themeVariables: { '--w3m-accent': '#06b6d4' }
});
