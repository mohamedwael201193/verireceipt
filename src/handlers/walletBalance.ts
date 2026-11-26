import {walletRpc as rpcCall,pinWalletBlock} from './walletPinnedRpc';
// WALLET_BALANCE_CHECK_GENERAL — GET /v1/balance?address=&chain=&token=
//
// Zero-LLM. Answers the current native-coin or ERC-20 balance of one
// address (or ENS name) on a named chain from the chain's verified
// keyless RPC legs (CHAIN_RPCS[chain]), as a 2-of-N exact-value quorum
// at one fixed block below observed finalized heads, with a SHA-256 receipt over the canonical
// evidence object. Fails closed: an RPC outage, a persistently split
// vote or an ENS resolution conflict throws 502/422 and never guesses a
// balance.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/WALLET_BALANCE_CHECK_GENERAL,
// read 2026-11-22): inputs address (0x or ENS name), chain, optional
// token (symbol or contract; empty = native coin); scored output
// `balance` in WHOLE units (not wei), 6 decimals.
//
// Select one block three below the lowest observed finalized head from at
// least two RPCs. Every balance and token metadata call uses that exact tag.
// Retry one time at block-2 if the first exact-value quorum fails.
import { walletContext } from "./walletContext";
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, stableStringify, type Receipt } from "../core/receipt";
import { CHAIN_RPCS } from "../config/chains";
import { saveReceipt } from "../core/storage";
import { HEX_QTY_RE } from "../core/evmRpc";
import { normalizeChain } from "./txLookup";
import {
  ADDRESS_RE,
  NATIVE_SYMBOL,
  SELECTOR_BALANCE_OF,
  SELECTOR_DECIMALS,
  SELECTOR_SYMBOL,
  TOKEN_CONTRACTS,
  isNativeSymbol,
  toWholeUnits,
  tokenContractFor,
} from "./tokenContracts";

export const INTENT = "WALLET_BALANCE_CHECK_GENERAL";

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
const HTTP_TIMEOUT_MS = 12000;

/** ENS name shape: labels separated by dots, at least one dot. */
const ENS_NAME_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET JSON with a hard timeout; throws on any failure. */
async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return JSON.parse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

interface EnsResolution {
  name: string;
  address: string;
  sources: string[];
}

/**
 * Resolve an ENS name through BOTH keyless resolvers; they must agree.
 * Sequential (the house rule: one upstream call at a time).
 */
async function resolveEns(name: string): Promise<EnsResolution> {
  const enc = encodeURIComponent(name);
  const sources = [
    `https://api.ensideas.com/ens/resolve/${enc}`,
    `https://api.ensdata.net/${enc}`,
  ];
  const addresses: string[] = [];
  let succeeded = 0;
  for (const url of sources) {
    try {
      const body = (await fetchJson(url)) as Record<string, unknown>;
      const addr = typeof body?.address === "string" ? body.address : null;
      if (addr && ADDRESS_RE.test(addr)) {
        succeeded++;
        addresses.push(addr.toLowerCase());
      }
    } catch {
      // An unreachable resolver is UNKNOWN, not a vote.
    }
  }
  if (succeeded < 2) {
    throw upstreamUnavailable(
      "ENS_UNREACHABLE",
      `ENS resolution unreachable: only ${succeeded} of ${sources.length} resolvers answered for ${name}`,
    );
  }
  if (addresses[0] !== addresses[1]) {
    throw upstreamUnavailable(
      "ENS_CONFLICT",
      `ENS resolvers disagree on ${name}; refusing to pick one`,
    );
  }
  return { name, address: addresses[0], sources };
}

interface BalanceLeg {
  rpcUrl: string;
  /** Canonical minimal hex of the raw balance in base units. */
  balanceHex: string;
  balance: bigint;
  /** ERC-20 legs only: decimals and on-chain symbol (null for native). */
  decimals: number | null;
  symbol: string | null;
}

/** Decode an ABI uint256 return; throws on a malformed shape. */
function decodeUint256(result: unknown, what: string, rpcUrl: string): bigint {
  if (typeof result !== "string" || !HEX_QTY_RE.test(result) || result.length > 66) {
    throw new Error(`malformed ${what} from ${rpcUrl}`);
  }
  return BigInt(result);
}

/** Decode an ABI-encoded string return (offset, length, bytes). */
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
  const bytes = Buffer.from(hex.slice(128, 128 + len * 2), "hex");
  return bytes.toString("utf8");
}

/** Fetch one leg's balance at the pinned numeric tag. Throws on any failure. */
async function fetchBalanceLeg(
  rpcUrl: string,
  address: string,
  contract: string | null,
  blockTag:string,
): Promise<BalanceLeg> {
  if (contract === null) {
    const { result } = await rpcCall(rpcUrl, "eth_getBalance", [address, blockTag]);
    const balance = decodeUint256(result, "eth_getBalance result", rpcUrl);
    return {
      rpcUrl,
      balanceHex: "0x" + balance.toString(16),
      balance,
      decimals: null,
      symbol: null,
    };
  }
  const data =
    SELECTOR_BALANCE_OF + address.toLowerCase().slice(2).padStart(64, "0");
  const { result: balResult } = await rpcCall(rpcUrl, "eth_call", [
    { to: contract, data },
    blockTag,
  ]);
  const balance = decodeUint256(balResult, "balanceOf result", rpcUrl);
  const { result: decResult } = await rpcCall(rpcUrl, "eth_call", [
    { to: contract, data: SELECTOR_DECIMALS },
    blockTag,
  ]);
  const decimals = Number(decodeUint256(decResult, "decimals result", rpcUrl));
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`implausible decimals ${decimals} from ${rpcUrl}`);
  }
  const { result: symResult } = await rpcCall(rpcUrl, "eth_call", [
    { to: contract, data: SELECTOR_SYMBOL },
    blockTag,
  ]);
  const symbol = decodeAbiString(symResult, rpcUrl);
  return {
    rpcUrl,
    balanceHex: "0x" + balance.toString(16),
    balance,
    decimals,
    symbol,
  };
}

function legsAgree(a: BalanceLeg, b: BalanceLeg): boolean {
  return (
    a.balanceHex === b.balanceHex && a.decimals === b.decimals && a.symbol === b.symbol
  );
}

interface Round {
  successes: BalanceLeg[];
  errored: number;
}

async function fetchRound(
  rpcs: string[],
  address: string,
  contract: string | null,
  blockTag:string,
): Promise<Round> {
  const successes: BalanceLeg[] = [];
  let errored = 0;
  for (const rpcUrl of rpcs) {
    try {
      successes.push(await fetchBalanceLeg(rpcUrl, address, contract,blockTag));
    } catch {
      errored++;
    }
  }
  return { successes, errored };
}

/** First leg value with at least one agreeing partner, else null. */
function agreeingPair(legs: BalanceLeg[]): { leg: BalanceLeg; count: number } | null {
  let best: { leg: BalanceLeg; count: number } | null = null;
  for (const candidate of legs) {
    const count = legs.filter((other) => legsAgree(candidate, other)).length;
    if (count >= 2 && (best === null || count > best.count)) {
      best = { leg: candidate, count };
    }
  }
  return best;
}

export async function handleBalance(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  let addressRaw = query.address?.trim();
  let chainRaw = query.chain?.trim();
  // The request builder may append " on <chain>" to the address (same
  // shape txLookup handles); a conflict with an explicit chain is a 400.
  const onChainMatch = addressRaw?.match(/^(\S+)\s+on\s+(.+)$/i);
  if (onChainMatch) {
    addressRaw = onChainMatch[1];
    if (chainRaw) {
      if (normalizeChain(onChainMatch[2].trim()) !== normalizeChain(chainRaw)) {
        throw badRequest(
          "CHAIN_MISMATCH",
          `conflicting chain: address names '${onChainMatch[2].trim()}' but chain parameter is '${chainRaw}'`,
        );
      }
    } else {
      chainRaw = onChainMatch[2].trim();
    }
  }
  const chain = normalizeChain(chainRaw);
  if (!addressRaw || !chain) {
    throw badRequest("MISSING_PARAM", "address and chain are required query parameters");
  }
  const rpcs = CHAIN_RPCS[chain];
  if (!rpcs || !SUPPORTED_CHAINS.includes(chain)) {
    throw badRequest(
      "UNSUPPORTED_CHAIN",
      `unsupported chain: ${chain}; expected one of ${SUPPORTED_CHAINS.join(", ")}`,
    );
  }

  // Address: 0x directly, or an ENS name through the 2-source quorum.
  let address: string;
  let ens: EnsResolution | null = null;
  if (ADDRESS_RE.test(addressRaw)) {
    address = addressRaw.toLowerCase();
  } else if (ENS_NAME_RE.test(addressRaw) && addressRaw.length <= 255) {
    ens = await resolveEns(addressRaw);
    address = ens.address;
  } else {
    throw badRequest(
      "INVALID_ADDRESS",
      "address must be a 0x-prefixed 40-hex-character address or an ENS name",
    );
  }

  // Token: empty / native symbol → native coin; 0x contract → ERC-20 at
  // that address; symbol → the verified TOKEN_CONTRACTS map, else 422.
  const tokenRaw = query.token?.trim() ?? "";
  let contract: string | null = null;
  let requestedSymbol: string | null = null;
  if (tokenRaw !== "" && !isNativeSymbol(chain, tokenRaw)) {
    if (ADDRESS_RE.test(tokenRaw)) {
      contract = tokenRaw;
      requestedSymbol = null;
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
  }

  const total = rpcs.length;
  let pin:Awaited<ReturnType<typeof pinWalletBlock>>;
  try{pin=await pinWalletBlock(rpcs);}catch{throw upstreamUnavailable('QUORUM_UNREACHABLE','at least two finalized heads required to pin a source block');}
  let blockNumber=pin.number,blockTag='0x'+blockNumber.toString(16);
  let round = await fetchRound(rpcs, address, contract,blockTag);
  let pair = agreeingPair(round.successes);
  if (pair === null) {
    await sleep(REPOLL_DELAY_MS);
    blockNumber-=2n;blockTag='0x'+blockNumber.toString(16);
    round = await fetchRound(rpcs, address, contract,blockTag);
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
  const decimals = contract === null ? 18 : winner.decimals!;
  const symbol =
    contract === null ? NATIVE_SYMBOL[chain] : (winner.symbol ?? "UNKNOWN");
  const balance = toWholeUnits(winner.balance, decimals);
  const asOf = new Date().toISOString();
  const votes = `${pair.count}/${total} sources agreed`;

  const context = await walletContext(rpcs, address,blockTag);
  const { context_evidence,block_number:contextBlockNumber, ...accountContext } = context;
  const fields: Record<string, unknown> = {
    ...accountContext,
    account_context_block_number:contextBlockNumber,
    balance_wei: contract === null ? winner.balance.toString() : null,
    balance_base_units: winner.balance.toString(),
    block_number:Number(blockNumber),
    funded: winner.balance > 0n,
    funding_status: winner.balance > 0n ? "funded" : "zero_balance",
    address,
    chain,
    balance,
    token_symbol: symbol,
    as_of: asOf,
  };

  // Canonical evidence: every value needed to re-derive the answer —
  // the agreed raw hex balance, token metadata, the block tag, and (for
  // ENS inputs) the name resolution with both source URLs.
  const evidence = stableStringify({
    address,
    as_of: asOf,
    balance_base_units_hex: winner.balanceHex,
    account_context: context,
    block_tag:blockTag,block_number:Number(blockNumber),block_selection:pin,
    chain,
    decimals,
    ens: ens ? { name: ens.name, resolved_address: ens.address, sources: ens.sources } : null,
    method: contract === null ? "eth_getBalance" : "eth_call balanceOf+decimals+symbol",
    rpc_url: winner.rpcUrl,
    token_contract: contract,
    token_symbol: symbol,
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
    answer: `${address} holds ${balance} ${symbol} on ${chain} (fixed block ${blockNumber}, selected below observed finalized heads, ${votes}). ${winner.balance > 0n ? "Funded" : "Zero balance"}; ${context.account_type}; outgoing transaction count ${context.transaction_count ?? "unavailable"}. ${context.context_scope}.`,
    verdict: "verified",
    confidence: pair.count === total ? 1.0 : 0.9,
    source: `EVM RPC quorum (${chain}, 2-of-${total}, fixed block ${blockNumber} below finalized heads)`,
  });
}
