/**
 * Single source of truth for miner identity and the API contract.
 *
 * Identity (DESIGN-SPEC §8 A2): miner id 774921, slug `verireceipt`
 * (verified free). The dashboard design file's id/slug are WRONG — they
 * must never appear anywhere in this codebase.
 *
 * Endpoints (DESIGN-SPEC §8 A1/A12): GET paths from miner.yaml, the live
 * contract. Both design files name the grid endpoint wrong — the contract
 * is `/v1/grid-price`. The design files also list the intent endpoints as
 * POST paths with `-lookup` suffixes; the contract is the GET paths below.
 *
 * Bond: $1.50 Test USDC — on-chain minerBond(6152) = quoteMinerBond(6) =
 * 1,500,000 base units (see lib/minerBond.ts, the single source).
 * The dashboard's sponsored-checks figure is fabricated — never shown.
 */
import { MINER_BOND_USD_TEXT } from "./lib/minerBond";
export const MINER_ID = 774921;
export const MINER_SLUG = "verireceipt";
export const MINER_NAME = "VeriReceipt Deterministic Oracle";
export const MINER_BASE_URL = "https://verireceipt.onrender.com";

/** Same-origin API prefix: proxied to the Render miner in dev (vite.config.ts)
 *  and in production (vercel.json rewrites). */
export const API_BASE = "/api";

export const DIAMOND_ADDRESS = "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b";
export const DIAMOND_SHORT = "0x72a70e…a08b";
export const CHAIN_NAME = "Sepolia";
export const CHAIN_ID = 11155111;
export const BOND_DISPLAY = `${MINER_BOND_USD_TEXT} Test USDC Bond`;

export type IntentId =
  | "ONCHAIN_TX_LOOKUP_GENERAL"
  | "REGULATORY_FILING_MONITOR_GENERAL"
  | "TVL_LOOKUP_GENERAL"
  | "OPTIMAL_EXECUTION_ROUTE_GENERAL"
  | "GRID_POWER_PRICE_GENERAL"
  | "VALIDATOR_PERFORMANCE_VERIFY_GENERAL";

export const INTENT_ENDPOINTS: { intent: IntentId; method: "GET"; path: string }[] = [
  { intent: "ONCHAIN_TX_LOOKUP_GENERAL", method: "GET", path: "/v1/tx" },
  { intent: "REGULATORY_FILING_MONITOR_GENERAL", method: "GET", path: "/v1/filings" },
  { intent: "TVL_LOOKUP_GENERAL", method: "GET", path: "/v1/tvl" },
  { intent: "OPTIMAL_EXECUTION_ROUTE_GENERAL", method: "GET", path: "/v1/route" },
  { intent: "GRID_POWER_PRICE_GENERAL", method: "GET", path: "/v1/grid-price" },
  { intent: "VALIDATOR_PERFORMANCE_VERIFY_GENERAL", method: "GET", path: "/v1/validator" },
];
