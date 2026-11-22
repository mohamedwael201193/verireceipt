/**
 * Miner registration bond: one source of truth for every bond figure in the UI.
 *
 * On-chain facts (Ethereum Sepolia, Diamond 0x72a70e…a08b, read 2026-11-22):
 *   minerBondParams() -> [1000000, 100000, 70000, 9, 172800]
 *   quoteMinerBond(14) -> [2150000, 2150000]   (14 intents)
 *   minerBond(6174)   -> [2150000, 2150000]              (our live registration)
 *   updateMiner tx 0x8466bb0a…4c3e created registration6174 at block12190478.
 * Bonds on this Diamond are paid in Sepolia Test USDC (6 decimals), per
 * telegraph-docs protocol/addresses-and-params.md. Pricing per
 * protocol/roles.md: $1 for the first intent, $0.10 for each further intent
 * up to 9, then $0.07 each. VeriReceipt declares 14 intents:
 * $1.00 + 8 x $0.10 + 5 x $0.07 = $2.15.
 *
 * Static displays use the labelled constant below. The Status page also
 * re-reads minerBond(6174) and quoteMinerBond(14) live and shows any
 * disagreement instead of hiding it.
 */

import { SEPOLIA_REGISTRATION_ID } from "./minerRegistration";
import { DECLARED_INTENT_COUNT } from "./minerManifest";

export const BOND_REGISTRATION_ID = SEPOLIA_REGISTRATION_ID;
export const BOND_INTENT_COUNT = DECLARED_INTENT_COUNT;
/** 6-decimal Test USDC base units: on-chain minerBond(6174) == quoteMinerBond(14). */
export const MINER_BOND_BASE_UNITS = 2_150_000;
export const MINER_BOND_SOURCE =
  "on-chain minerBond(6174) = quoteMinerBond(14) = 2,150,000 Test USDC base units (Sepolia, read 2026-11-22)";

/** minerBondParams() as read on 2026-11-22 (USD, 6 decimals). */
export const MINER_BOND_PARAMS = {
  firstIntent: 1_000_000,
  furtherIntent: 100_000,
  tailIntent: 70_000,
  tierCap: 9,
} as const;

export type BondParams = {
  firstIntent: number;
  furtherIntent: number;
  tailIntent: number;
  tierCap: number;
};

/**
 * quoteMinerBond(n) semantics, reproduced from minerBondParams(). Matches the
 * live chain for n = 1, 2, 6, 10, 12 (1.00 / 1.10 / 1.50 / 1.87 / 2.01).
 */
export function bondForIntents(n: number, p: BondParams = MINER_BOND_PARAMS): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("intent count must be a positive integer");
  const mid = Math.min(n, p.tierCap) - 1;
  const tail = Math.max(0, n - p.tierCap);
  return p.firstIntent + mid * p.furtherIntent + tail * p.tailIntent;
}

/** 2150000 -> "$2.15" (6-decimal USDC base units, exact integer cents). */
export function formatUsdcBaseUnits(units: number | bigint): string {
  const u = BigInt(units);
  const ZERO = BigInt(0);
  if (u < ZERO) throw new RangeError("negative amount");
  const cents = (u + BigInt(5_000)) / BigInt(10_000); // round half up to cents
  const dollars = cents / BigInt(100);
  const rem = cents % BigInt(100);
  return `$${dollars.toString()}.${rem.toString().padStart(2, "0")}`;
}

/** "$2.15" */
export const MINER_BOND_USD_TEXT = formatUsdcBaseUnits(MINER_BOND_BASE_UNITS);
/** 2.15 */
export const MINER_BOND_USD = MINER_BOND_BASE_UNITS / 1_000_000;

// ---- live read (Status page) ----------------------------------------------

export const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const DIAMOND = "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b";
/** keccak256("minerBond(uint256)")[0:4] and keccak256("quoteMinerBond(uint256)")[0:4]. */
export const SEL_MINER_BOND = "0x692030d4";
export const SEL_QUOTE_MINER_BOND = "0xc17a8722";

function uintArg(n: number): string {
  return n.toString(16).padStart(64, "0");
}

async function ethCall(data: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(SEPOLIA_RPC, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: DIAMOND, data }, "latest"] }),
  });
  if (!res.ok) throw new Error(`Sepolia RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`Sepolia RPC error: ${body.error.message ?? "unknown"}`);
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(body.result) || body.result.length < 66) {
    throw new Error("Sepolia RPC returned no uint256");
  }
  return body.result;
}

function firstWord(hex: string): bigint {
  return BigInt("0x" + hex.slice(2, 66));
}

export interface LiveMinerBond {
  /** minerBond(6174), Test USDC base units. */
  registrationBond: bigint;
  /** quoteMinerBond(14) first return value, base units. */
  quoteForIntents: bigint;
  /** Both live values equal the labelled constant. */
  matchesConstant: boolean;
}

export async function fetchLiveMinerBond(signal?: AbortSignal): Promise<LiveMinerBond> {
  const [a, b] = await Promise.all([
    ethCall(SEL_MINER_BOND + uintArg(BOND_REGISTRATION_ID), signal),
    ethCall(SEL_QUOTE_MINER_BOND + uintArg(BOND_INTENT_COUNT), signal),
  ]);
  const registrationBond = firstWord(a);
  const quoteForIntents = firstWord(b);
  const k = BigInt(MINER_BOND_BASE_UNITS);
  return { registrationBond, quoteForIntents, matchesConstant: registrationBond === k && quoteForIntents === k };
}

/** Badge for the /status live bond re-read. */
export interface BondBadge {
  tone: "ok" | "err" | "dim";
  text: string;
}

/**
 * Decide the live re-read badge (J2 Minor 3, r7). useLiveQuery keeps the
 * previous `data` while a refetch runs and after a refetch FAILS, so the
 * badge must not trust `data` alone: an error from the LATEST read wins
 * (UNVERIFIED), a read in flight shows "re-reading", and only a settled,
 * error-free read can show "matches" / "differs".
 */
export function bondBadge(bond: {
  data: LiveMinerBond | null;
  error: Error | null;
  loading: boolean;
}): BondBadge {
  if (bond.error) {
    return { tone: "dim", text: `live re-read failed (${bond.error.message}) — UNVERIFIED` };
  }
  if (bond.loading) return { tone: "dim", text: "re-reading on-chain…" };
  if (!bond.data) return { tone: "dim", text: "live re-read failed — UNVERIFIED" };
  if (bond.data.matchesConstant) return { tone: "ok", text: "live re-read matches" };
  return {
    tone: "err",
    text:
      `live re-read differs: minerBond(${BOND_REGISTRATION_ID}) ${formatUsdcBaseUnits(bond.data.registrationBond)} · ` +
      `quoteMinerBond(${BOND_INTENT_COUNT}) ${formatUsdcBaseUnits(bond.data.quoteForIntents)}`,
  };
}
