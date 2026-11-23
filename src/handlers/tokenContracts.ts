// Shared token contract registry + ERC-20 helpers for the wallet-balance
// and token-supply handlers (intent expansion, 2026-11-22).
//
// TOKEN_CONTRACTS is a CURATED map of well-known token contracts, keyed
// by chain then UPPERCASE symbol. Every entry was verified live on-chain
// 2026-11-22 by calling decimals() (0x313ce567) AND symbol() (0x95d89b41)
// at the "finalized" block tag on one of the chain's CHAIN_RPCS legs and
// checking the returned symbol matches the key (script output in the
// commit message / PR notes): e.g. ethereum USDC dec=6 symbol 'USDC',
// ethereum WBTC dec=8, base USDC dec=6, arbitrum USDT dec=6
// (on-chain symbol 'USD₮0' at the canonical USDT address), polygon
// WPOL dec=18. Base USDbC was tried and returned NO decimals at
// finalized, so it is NOT in the map.
//
// A symbol that is not in the map is REFUSED (422 UNSUPPORTED_TOKEN) —
// the handlers never guess a contract address. Callers may always pass
// a raw 0x contract address instead, which needs no registry entry.

import { badRequest } from "../core/errors";

/** balanceOf(address) — ERC-20 selector. */
export const SELECTOR_BALANCE_OF = "0x70a08231";
/** totalSupply() — ERC-20 selector. */
export const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";
/** decimals() — ERC-20 selector. */
export const SELECTOR_DECIMALS = "0x313ce567";
/** symbol() — ERC-20 selector. */
export const SELECTOR_SYMBOL = "0x95d89b41";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Native coin symbol per chain (polygon's native coin is POL since the
 * 2024 MATIC→POL migration). */
export const NATIVE_SYMBOL: Record<string, string> = {
  ethereum: "ETH",
  sepolia: "ETH",
  "base-sepolia": "ETH",
  base: "ETH",
  arbitrum: "ETH",
  optimism: "ETH",
  polygon: "POL",
};

/** Verified token contracts per chain, keyed by UPPERCASE symbol. */
export const TOKEN_CONTRACTS: Record<string, Record<string, string>> = {
  ethereum: {
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    SHIB: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE",
    PEPE: "0x6982508145454Ce325dDbE47a25d4ec3d2311933",
  },
  base: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
    DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  },
  arbitrum: {
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "USDC.E": "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    LINK: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
  },
  optimism: {
    USDC: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    "USDC.E": "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    WETH: "0x4200000000000000000000000000000000000006",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    WBTC: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    OP: "0x4200000000000000000000000000000000000042",
    LINK: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6",
  },
  polygon: {
    USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    "USDC.E": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    WPOL: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    LINK: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
  },
  sepolia: {
    USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    LINK: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  },
};

/**
 * True when `symbol` names the chain's native coin. "ETH" is native on
 * every supported chain except polygon; "POL" (and the pre-migration
 * alias "MATIC") are native on polygon.
 */
export function isNativeSymbol(chain: string, symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (chain === "polygon") return s === "POL" || s === "MATIC";
  return s === "ETH";
}

/** Look up a symbol's contract on a chain; undefined when unknown. */
export function tokenContractFor(chain: string, symbol: string): string | undefined {
  return TOKEN_CONTRACTS[chain]?.[symbol.trim().toUpperCase()];
}

/**
 * Parse a complete display label plus one explicit contract address.
 * The address governs; a known symbol cannot contradict its verified
 * chain-specific contract. No substring mining or symbol fallback.
 */
export function labeledTokenContract(
  chain: string,
  token: string,
): { contract: string; requestedSymbol: string | null } | undefined {
  const match = token.trim().match(/^([^()]+?)\s*\(\s*(0x[0-9a-fA-F]{40})\s*\)$/);
  if (!match) return undefined;
  const label = match[1].trim();
  const address = match[2];
  const known = tokenContractFor(chain, label);
  if (isNativeSymbol(chain, label) || (known && known.toLowerCase() !== address.toLowerCase())) {
    throw badRequest(
      "TOKEN_CONTRACT_MISMATCH",
      `token label '${label}' contradicts explicit contract ${address} on ${chain}`,
    );
  }
  return { contract: address, requestedSymbol: known ? label.toUpperCase() : null };
}

/**
 * Convert a base-unit integer to whole units with at most 6 decimals,
 * truncated (deterministic; the intent comparators score within a
 * tolerance, so truncation at the 7th decimal never crosses it).
 * Uses exact BigInt arithmetic — Number(value) would lose precision for
 * balances above ~9e15 base units (e.g. SHIB holdings).
 */
export function toWholeUnits(value: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const rem = value % base;
  let frac6: bigint;
  if (decimals >= 6) {
    frac6 = rem / 10n ** BigInt(decimals - 6);
  } else {
    frac6 = rem * 10n ** BigInt(6 - decimals);
  }
  return Number(whole) + Number(frac6) / 1e6;
}

/** Chain preference order when a bare symbol names no chain: a symbol
 * found on exactly one listed chain resolves there; a multi-chain
 * symbol resolves to the first chain in this order that lists it
 * (ethereum first — the canonical home of the multi-chain majors in
 * this registry). The resolution is always disclosed by the caller. */
const CANONICAL_CHAIN_ORDER = ["ethereum", "base", "arbitrum", "optimism", "polygon", "sepolia", "base-sepolia"];

/** Canonical home chain + contract for a bare symbol with no chain
 * given, or null when no listed chain carries the symbol. */
export function canonicalHomeChain(symbol: string): { chain: string; contract: string } | null {
  const sym = symbol.trim().toUpperCase();
  for (const chain of CANONICAL_CHAIN_ORDER) {
    const contract = TOKEN_CONTRACTS[chain]?.[sym];
    if (contract) return { chain, contract };
  }
  return null;
}
