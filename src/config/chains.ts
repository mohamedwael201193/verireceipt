// RPC URLs verified live 2026-11-20 with eth_blockNumber (see report).
// LlamaRPC failed on every chain (eth/base: Cloudflare 525; arbitrum/
// optimism/polygon: empty response) and Ankr public now requires an API key
// (HTTP 200 with JSON-RPC error -32000 "Unauthorized"), so neither is
// included. Every chain below therefore has 2 verified URLs, not 3 —
// quorum2of3 still works (2/2 agreement), but there is no spare upstream.
export const CHAIN_RPCS: Record<string, string[]> = {
  ethereum: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
  base: ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
  arbitrum: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
  optimism: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
  polygon: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
  sepolia: ["https://ethereum-sepolia-rpc.publicnode.com"],
};

export const MAINNET_RPCS: string[] = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
];
