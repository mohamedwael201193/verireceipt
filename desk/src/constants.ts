// Desk Phase D constants. Every value is from the official Telegraph docs
// (using/escrow-inference.md, using/engine-ask.md, protocol/addresses-and-params.md)
// or from the live node, as noted. TESTNET ONLY: the client refuses any
// network other than Ethereum Sepolia.

/** Testnet node (escrow-inference.md "Engine base URL (testnet)"). */
export const NODE_URL = "https://devnode.telegraphprotocol.com";
export const ENGINE_URL = `${NODE_URL}/engine`;

/** Escrow Diamond on Ethereum Sepolia, lowercased as the node compares it. */
export const DIAMOND = "0x72a70e949362670bf8bcead24efc5b8f950aa08b";

/** Sepolia Test USDC (escrow-inference.md "What You Need"). */
export const SEPOLIA_USDC = "0xcc194e1a843b658526d0d5c431f670028582ae17";

/** CAIP-2 network of the escrow; the only network this client will sign for. */
export const ESCROW_NETWORK = "eip155:11155111";

/** "The validity window (validBefore minus validAfter) may be at most 2 minutes." */
export const MAX_WINDOW_SECONDS = 120;
/** The docs' own example window: validAfter = now - 5, validBefore = now + 100. */
export const VALID_AFTER_SKEW_SECONDS = 5;
export const VALID_FOR_SECONDS = 100;

/** One call at the flat price (engine-ask.md: "the flat price, 10000 = $0.01"). */
export const ONE_CALL_UUSDC = 10_000n;
/** max_budget_usdc bounds on the live testnet node: one call to 260000 μUSDC. */
export const MIN_BUDGET_UUSDC = 10_000n;
export const MAX_BUDGET_UUSDC = 260_000n;

/**
 * Desk spend policy. Per call the Desk never signs more than one flat-price
 * call (direct asks carry no budget). Per UTC day it never signs more than
 * DESK_DAILY_SPEND_CAP_USD from render.yaml ("2.00" = 2,000,000 μUSDC).
 */
export const DESK_MAX_CALL_UUSDC = ONE_CALL_UUSDC;
export const DESK_DAILY_CAP_UUSDC = 2_000_000n;

/** VeriReceipt's routing id in the node's miner catalogue (GET /api/miners, slug "verireceipt"). */
export const VERIRECEIPT_MINER_ID = "774921";
/** On-chain registration id (receipts and delivery rows use this, not the catalogue id). */
export const VERIRECEIPT_ONCHAIN_MINER_ID = "6205";
/**
 * Every on-chain registration id that has served paid calls for slug
 * "verireceipt". A receipt names the registration that served it, so rows
 * keep their id after an updateMiner; append new ids, never rewrite.
 */
export const VERIRECEIPT_ONCHAIN_MINER_IDS: readonly string[] = Array.from(new Set(["6152", "6160", "6188", "6196", VERIRECEIPT_ONCHAIN_MINER_ID]));
/** The miner's public base URL (stored evidence at /receipts/{id}/raw). */
export const MINER_BASE_URL = "https://verireceipt.onrender.com";
