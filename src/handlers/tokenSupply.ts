// TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL — GET /v1/token-supply?token=
//
// Zero-LLM. Answers the current total minted supply of an ERC-20 token
// from the token's chain RPC legs (CHAIN_RPCS[chain]) as a 2-of-N
// exact-value quorum over eth_call totalSupply() + decimals() at the
// FINALIZED block tag, with a SHA-256 receipt over the canonical
// evidence object. Fails closed; never guesses a supply.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL,
// read 2026-11-22): one required input `token` — "Token symbol or
// contract address, and its chain" (e.g. "USDC on ethereum"); scored
// output `total_supply` in whole tokens (decimals applied).
//
// "and its chain": the token parameter itself carries the chain
// ("USDC on ethereum"). A separate chain query parameter is also
// accepted when the builder splits it; a contradiction between the two
// is a 400 CHAIN_MISMATCH (txLookup's rule), never a silent pick.
//
// The finalized-tag quorum choice and the arbitrum drpc gap are the
// same as the wallet-balance handler (see walletBalance.ts header,
// measured live 2026-11-22). A symbol outside the curated verified
// TOKEN_CONTRACTS map is 422 UNSUPPORTED_TOKEN; a raw 0x contract
// address always works. Native coins have no totalSupply() contract —
// a native symbol is 422 with a pointer to WETH/WPOL.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, stableStringify, type Receipt } from "../core/receipt";
import { CHAIN_RPCS } from "../config/chains";
import { saveReceipt } from "../core/storage";
import { HEX_QTY_RE, rpcCall } from "../core/evmRpc";
import { normalizeChain } from "./txLookup";
import {
  ADDRESS_RE,
  SELECTOR_DECIMALS,
  SELECTOR_SYMBOL,
  SELECTOR_TOTAL_SUPPLY,
  TOKEN_CONTRACTS,
  canonicalHomeChain,
  isNativeSymbol,
  labeledTokenContract,
  toWholeUnits,
  tokenContractFor,
} from "./tokenContracts";


export const INTENT = "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL";

const SUPPORTED_CHAINS = [
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "sepolia",
  "base-sepolia",
];

const REPOLL_DELAY_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SupplyLeg {
  rpcUrl: string;
  supplyHex: string;
  supply: bigint;
  decimals: number;
  symbol: string;
}

function decodeUint256(result: unknown, what: string, rpcUrl: string): bigint {
  if (typeof result !== "string" || !HEX_QTY_RE.test(result) || result.length > 66) {
    throw new Error(`malformed ${what} from ${rpcUrl}`);
  }
  return BigInt(result);
}

function decodeAbiString(result: unknown, rpcUrl: string): string {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) {
    throw new Error(`malformed symbol result from ${rpcUrl}`);
  }
  const hex = result.slice(2);
  if (hex.length < 128) throw new Error(`short symbol result from ${rpcUrl}`);
  const len = parseInt(hex.slice(64, 128), 16);
  if (!Number.isSafeInteger(len) || len < 0 || 128 + len * 2 > hex.length) {
    throw new Error(`bad symbol length from ${rpcUrl}`);
  }
  return Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8");
}

/** Fetch one leg's totalSupply + decimals + symbol at finalized. */
async function fetchSupplyLeg(rpcUrl: string, contract: string): Promise<SupplyLeg> {
  const { result: supResult } = await rpcCall(rpcUrl, "eth_call", [
    { to: contract, data: SELECTOR_TOTAL_SUPPLY },
    "finalized",
  ]);
  const supply = decodeUint256(supResult, "totalSupply result", rpcUrl);
  const { result: decResult } = await rpcCall(rpcUrl, "eth_call", [
    { to: contract, data: SELECTOR_DECIMALS },
    "finalized",
  ]);
  const decimals = Number(decodeUint256(decResult, "decimals result", rpcUrl));
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`implausible decimals ${decimals} from ${rpcUrl}`);
  }
  const { result: symResult } = await rpcCall(rpcUrl, "eth_call", [
    { to: contract, data: SELECTOR_SYMBOL },
    "finalized",
  ]);
  const symbol = decodeAbiString(symResult, rpcUrl);
  return {
    rpcUrl,
    supplyHex: "0x" + supply.toString(16),
    supply,
    decimals,
    symbol,
  };
}

function legsAgree(a: SupplyLeg, b: SupplyLeg): boolean {
  return a.supplyHex === b.supplyHex && a.decimals === b.decimals && a.symbol === b.symbol;
}

interface Round {
  successes: SupplyLeg[];
  errored: number;
}

async function fetchRound(rpcs: string[], contract: string): Promise<Round> {
  const successes: SupplyLeg[] = [];
  let errored = 0;
  for (const rpcUrl of rpcs) {
    try {
      successes.push(await fetchSupplyLeg(rpcUrl, contract));
    } catch {
      errored++;
    }
  }
  return { successes, errored };
}

function agreeingPair(legs: SupplyLeg[]): { leg: SupplyLeg; count: number } | null {
  let best: { leg: SupplyLeg; count: number } | null = null;
  for (const candidate of legs) {
    const count = legs.filter((other) => legsAgree(candidate, other)).length;
    if (count >= 2 && (best === null || count > best.count)) {
      best = { leg: candidate, count };
    }
  }
  return best;
}

export async function handleTokenSupply(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const aliases=["token","query","q","input","symbol","asset"] as const;
  const supplied=aliases.flatMap(key=>query[key]?.trim()?[{key,value:query[key]!.trim()}]:[]);
  if(new Set(supplied.map(v=>v.value.toLowerCase())).size>1)throw badRequest("TOKEN_INPUT_CONFLICT","token aliases disagree; supply one exact token input");
  const tokenInput=supplied[0]?.value;
  let tokenRaw = tokenInput;
  let chainRaw = query.chain?.trim();
  // The contract packs chain into the token param: "USDC on ethereum".
  const onChainMatch = tokenRaw?.match(/^(.+?)\s+on\s+(.+)$/i);
  if (onChainMatch) {
    tokenRaw = onChainMatch[1].trim();
    if (chainRaw) {
      if (normalizeChain(onChainMatch[2].trim()) !== normalizeChain(chainRaw)) {
        throw badRequest(
          "CHAIN_MISMATCH",
          `conflicting chain: token names '${onChainMatch[2].trim()}' but chain parameter is '${chainRaw}'`,
        );
      }
    } else {
      chainRaw = onChainMatch[2].trim();
    }
  }
  let chain = normalizeChain(chainRaw);
  // A bare symbol with no chain resolves to its canonical home chain
  // from the registry (single-chain symbols to their only chain;
  // multi-chain symbols to the first canonical-order chain listing
  // them). The resolution is disclosed in the answer and receipt,
  // never silent. A raw 0x address still needs an explicit chain.
  let homeChain: string | null = null;
  if (tokenRaw && !chain && !ADDRESS_RE.test(tokenRaw)) {
    const home = canonicalHomeChain(tokenRaw);
    if (home) {
      chain = home.chain;
      homeChain = home.chain;
    }
  }
  if (!tokenRaw || !chain) {
    throw badRequest(
      "MISSING_PARAM",
      "token (symbol or 0x contract, e.g. 'USDC on ethereum') is a required query parameter; a bare symbol must be one of the listed tokens, and a raw contract address needs its chain",
    );
  }
  const rpcs = CHAIN_RPCS[chain];
  if (!rpcs || !SUPPORTED_CHAINS.includes(chain)) {
    throw badRequest(
      "UNSUPPORTED_CHAIN",
      `unsupported chain: ${chain}; expected one of ${SUPPORTED_CHAINS.join(", ")}`,
    );
  }

  const labeled = labeledTokenContract(chain, tokenRaw);
  tokenRaw = labeled?.contract ?? tokenRaw;

  let contract: string;
  let requestedSymbol: string | null = labeled?.requestedSymbol ?? null;
  if (ADDRESS_RE.test(tokenRaw)) {
    contract = tokenRaw;
  } else if (isNativeSymbol(chain, tokenRaw)) {
    throw unprocessable(
      "UNSUPPORTED_TOKEN",
      `${tokenRaw} is the native coin on ${chain} and has no totalSupply() contract; ask for the wrapped token (WETH/WPOL) instead`,
    );
  } else {
    const lookedUp = tokenContractFor(chain, tokenRaw);
    if (!lookedUp) {
      throw unprocessable(
        "UNSUPPORTED_TOKEN",
        `unsupported token: ${tokenRaw} on ${chain}; pass a 0x contract address or one of: ${Object.keys(
          TOKEN_CONTRACTS[chain] ?? {},
        ).join(", ")}`,
      );
    }
    contract = lookedUp;
    requestedSymbol = tokenRaw.trim().toUpperCase();
  }

  const total = rpcs.length;
  let round = await fetchRound(rpcs, contract);
  let pair = agreeingPair(round.successes);
  if (pair === null) {
    await sleep(REPOLL_DELAY_MS);
    round = await fetchRound(rpcs, contract);
    pair = agreeingPair(round.successes);
  }
  if (pair === null) {
    if (round.successes.length >= 2) {
      throw upstreamUnavailable(
        "QUORUM_DISAGREEMENT",
        `quorum disagreement: ${round.successes.length} sources answered on ${chain} but no two agreed`,
      );
    }
    throw upstreamUnavailable(
      "QUORUM_UNREACHABLE",
      `quorum unreachable: only ${round.successes.length} of ${total} sources answered on ${chain}`,
    );
  }

  const winner = pair.leg;
  const totalSupply = toWholeUnits(winner.supply, winner.decimals);
  const symbol = requestedSymbol ?? winner.symbol;
  const asOf = new Date().toISOString();
  const votes = `${pair.count}/${total} sources agreed`;

  const fields: Record<string, unknown> = {
    total_supply: totalSupply,
    total_supply_scope: "chain-specific ERC-20 totalSupply, decimals applied; not a global asset or circulating supply",
    token_symbol: symbol,
    chain,
    as_of: asOf,
  };

  const evidence = stableStringify({
    as_of: asOf,
    block_tag: "finalized",
    chain,
    chain_resolution: homeChain
      ? { input: tokenInput, resolved_chain: homeChain, note: "no chain given; resolved to the symbol's canonical home chain in the registry, disclosed, never a silent pick" }
      : "not used (chain given)",
    total_supply_scope: "chain-specific ERC-20 totalSupply, decimals applied; not a global asset or circulating supply",
    decimals: winner.decimals,
    method: "eth_call totalSupply+decimals+symbol",
    rpc_url: winner.rpcUrl,
    supply_base_units_hex: winner.supplyHex,
    token_contract: contract,
    token_symbol_onchain: winner.symbol,
  });
  const receiptDoc: Receipt = makeReceipt(INTENT, winner.rpcUrl, evidence, votes);
  try {
    await saveReceipt(receiptDoc, evidence);
  } catch {
    throw upstreamUnavailable(
      "RECEIPT_PERSIST_FAILED",
      "receipt evidence could not be stored; answer unavailable",
    );
  }

  return envelope(INTENT, fields, receiptDoc, {
    answer: `${homeChain ? `No chain was given; ${symbol} resolved to its canonical home chain ${homeChain} (disclosed, not a silent pick). ` : ""}${symbol} total supply on ${chain}: ${totalSupply} (finalized block, ${votes}).`,
    verdict: "verified",
    confidence: pair.count === total ? 1.0 : 0.9,
    source: `EVM RPC quorum (${chain}, 2-of-${total}, finalized)`,
  });
}
