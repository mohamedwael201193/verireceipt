import { MINER_BOND_USD } from "./minerBond";

// Canonical VeriReceipt miner identity — verified against miner.yaml and
// the live registration. Do NOT use the dashboard design file's
// "89412 / verireceipt-oracle": that identity is wrong.
export const MINER_IDENTITY = {
  id: 774921,
  slug: "verireceipt",
} as const;

export const MINER_NAME = "VeriReceipt Deterministic Oracle";

// Miner bond: $1.50 Test USDC = on-chain minerBond(6160) = quoteMinerBond(6)
// = 1,500,000 base units ($1.00 + 5 x $0.10 for six intents). Derived from
// ./minerBond, the single source of truth.
// The dashboard design file's "$1.84 / 184 checks sponsored" is fabricated —
// no such live value exists and it must never be displayed.
export const MINER_BOND_USDC = MINER_BOND_USD;
