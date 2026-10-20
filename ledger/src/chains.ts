export interface Chain {
  id: number;
  name: string;
  blockscout: string;   // Etherscan-compatible /api base
  llama: string;        // DefiLlama chain slug for token prices
  nativeSymbol: string;
  nativeCoin: string;   // DefiLlama coin key for the native asset
  explorer: string;     // human explorer, for tx links
}

export const CHAINS: Chain[] = [
  { id: 1, name: "Ethereum", blockscout: "https://eth.blockscout.com/api", llama: "ethereum",
    nativeSymbol: "ETH", nativeCoin: "coingecko:ethereum", explorer: "https://etherscan.io" },
  { id: 8453, name: "Base", blockscout: "https://base.blockscout.com/api", llama: "base",
    nativeSymbol: "ETH", nativeCoin: "coingecko:ethereum", explorer: "https://basescan.org" },
  { id: 10, name: "Optimism", blockscout: "https://optimism.blockscout.com/api", llama: "optimism",
    nativeSymbol: "ETH", nativeCoin: "coingecko:ethereum", explorer: "https://optimistic.etherscan.io" },
  { id: 42161, name: "Arbitrum", blockscout: "https://arbitrum.blockscout.com/api", llama: "arbitrum",
    nativeSymbol: "ETH", nativeCoin: "coingecko:ethereum", explorer: "https://arbiscan.io" },
  { id: 137, name: "Polygon", blockscout: "https://polygon.blockscout.com/api", llama: "polygon",
    nativeSymbol: "POL", nativeCoin: "coingecko:polygon-ecosystem-token", explorer: "https://polygonscan.com" },
];

export function chainById(id: number): Chain {
  const c = CHAINS.find((x) => x.id === id);
  if (!c) throw new Error(`unsupported chain ${id}`);
  return c;
}

/** DefiLlama coin key for an asset; contract "native" means the chain's gas token. */
export function coinKey(chainId: number, contract: string): string {
  const c = chainById(chainId);
  return contract === "native" ? c.nativeCoin : `${c.llama}:${contract}`;
}

export function txUrl(chainId: number, hash: string): string {
  return `${chainById(chainId).explorer}/tx/${hash}`;
}
