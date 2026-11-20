// Canonical VeriReceipt miner identity — verified against miner.yaml and
// the live registration. Do NOT use the dashboard design file's
// "89412 / verireceipt-oracle": that identity is wrong.
export const MINER_IDENTITY = {
  id: 774921,
  slug: "verireceipt",
} as const;

export const MINER_NAME = "VeriReceipt Deterministic Oracle";

// Miner bond, verified on-chain: $1.40 Test USDC ($1.00 + 4 x $0.10).
// The dashboard design file's "$1.84 / 184 checks sponsored" is fabricated —
// no such live value exists and it must never be displayed.
export const MINER_BOND_USDC = 1.4;
