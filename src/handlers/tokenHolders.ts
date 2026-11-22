// TOKEN_HOLDER_COUNT_GENERAL — GET /v1/token-holders?token=&chain=
//
// Zero-LLM. Answers the number of distinct addresses holding an ERC-20
// token from a keyless public block INDEXER (Blockscout-family
// /api/v2/tokens/{address}), with a SHA-256 receipt over the exact
// upstream bytes. Fails closed; never guesses a holder count.
//
// Intent contract (https://devnode.telegraphprotocol.com/engine/v1/intents/TOKEN_HOLDER_COUNT_GENERAL,
// read 2026-11-22): required inputs `token` (contract address or name)
// and `chain`; scored output `holders_count` (integer, 0..1e10), plus
// off_chain `token` and `token_symbol`.
//
// WHY SINGLE-SOURCE: holder counts are an indexer-side aggregate, not
// chain state. Independent indexers legitimately disagree (measured
// live 2026-11-22: ethplorer 9,223,477 vs eth.blockscout.com 9,618,845
// holders for ethereum USDC — different indexing lag and counting
// rules), so the exact-value 2-of-N quorum used for RPC state reads
// can never converge across indexers. Instead each chain is served by
// one receipted indexer of record (same pattern as the World Bank
// macro handler: "1/1 authoritative source"), and chains without a
// working keyless indexer are 422 UNSUPPORTED_CHAIN rather than
// answered from an unverifiable source. Blockscout instances probed
// live 2026-11-22: eth.blockscout.com and explorer.optimism.io answer
// keyless; the base/arbitrum/polygon instances sit behind a Cloudflare
// challenge for server-side calls and are NOT used.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, type Receipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { normalizeChain } from "./txLookup";
import { ADDRESS_RE, TOKEN_CONTRACTS, isNativeSymbol, labeledTokenContract, tokenContractFor } from "./tokenContracts";

export const INTENT = "TOKEN_HOLDER_COUNT_GENERAL";

const HTTP_TIMEOUT_MS = 12000;
/** Scored range upper bound from the intent contract. */
const MAX_HOLDERS = 10_000_000_000;

/** Keyless Blockscout-family indexer of record per chain. */
const INDEXERS: Record<string, string> = {
  ethereum: "https://eth.blockscout.com",
  optimism: "https://explorer.optimism.io",
};

const SUPPORTED_CHAINS = Object.keys(INDEXERS);

/** Test seam / runtime override for the HTTP fetch. */
type FetchText = (url: string) => Promise<string>;
let fetchImpl: FetchText | null = null;
export function setTokenHoldersFetchForTests(impl: FetchText | null): void {
  fetchImpl = impl;
}

async function fetchText(url: string): Promise<string> {
  if (fetchImpl) return fetchImpl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

interface IndexerTokenInfo {
  holdersCount: number;
  symbol: string | null;
  rawBody: string;
}

function parseIndexerResponse(rawBody: string, url: string, contract: string): IndexerTokenInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error(`non-JSON token response from ${url}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`unexpected token response shape from ${url}`);
  }
  if (Array.isArray(parsed)) throw new Error('token response must be an object');
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.address_hash !== 'string' || obj.address_hash.toLowerCase() !== contract.toLowerCase() || obj.type !== 'ERC-20') {
    throw new Error('indexer token address/type does not match requested ERC-20 contract');
  }
  const holdersRaw = obj.holders_count;
  const holders = typeof holdersRaw === 'string' && /^\d+$/.test(holdersRaw)
    ? Number(holdersRaw)
    : typeof holdersRaw === 'number' ? holdersRaw : NaN;
  if (!Number.isSafeInteger(holders) || holders < 0 || holders > MAX_HOLDERS) {
    throw new Error(`implausible holders_count ${String(holdersRaw)} from ${url}`);
  }
  const symbol = typeof obj.symbol === "string" && obj.symbol.trim() !== "" ? obj.symbol : null;
  return { holdersCount: holders, symbol, rawBody };
}

export async function handleTokenHolders(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  let tokenRaw = query.token?.trim();
  let chainRaw = query.chain?.trim();
  // Tolerate the builder packing the chain into the token ("USDC on
  // optimism") the same way tokenSupply does; a conflict is a 400.
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
  const chain = normalizeChain(chainRaw);
  if (!tokenRaw || !chain) {
    throw badRequest("MISSING_PARAM", "token and chain are required query parameters");
  }
  const indexer = INDEXERS[chain];
  if (!indexer) {
    throw unprocessable(
      "UNSUPPORTED_CHAIN",
      `unsupported chain for holder counts: ${chain}; served chains: ${SUPPORTED_CHAINS.join(", ")} (keyless indexer of record per chain; other chains are refused rather than guessed)`,
    );
  }

  let contract: string;
  let requestedSymbol: string | null = null;
  const labeled = labeledTokenContract(chain, tokenRaw);
  if (labeled) {
    contract = labeled.contract; requestedSymbol = labeled.requestedSymbol;
  } else if (ADDRESS_RE.test(tokenRaw)) {
    contract = tokenRaw;
  } else if (isNativeSymbol(chain, tokenRaw)) {
    throw unprocessable(
      "UNSUPPORTED_TOKEN",
      `${tokenRaw} is the native coin on ${chain}; holder counts are served for ERC-20 tokens only`,
    );
  } else {
    const lookedUp = tokenContractFor(chain, tokenRaw);
    if (!lookedUp) {
      throw unprocessable(
        "UNSUPPORTED_TOKEN",
        `unsupported token: ${tokenRaw} on ${chain}; pass a 0x contract address or one of: ${Object.keys(
          TOKEN_CONTRACTS[chain] ?? {},
        ).join(", ") || "(none verified)"}`,
      );
    }
    contract = lookedUp;
    requestedSymbol = tokenRaw.trim().toUpperCase();
  }

  const url = `${indexer}/api/v2/tokens/${contract}`;
  let info: IndexerTokenInfo;
  try {
    info = parseIndexerResponse(await fetchText(url), url, contract);
  } catch (err) {
    throw upstreamUnavailable(
      "INDEXER_UNREACHABLE",
      `holder-count indexer failed for ${chain}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // A symbol request must match the indexer's own symbol for the
  // contract — a mismatch means the verified map drifted, and answering
  // would attribute another token's count to the asked symbol.
  if (requestedSymbol && info.symbol && info.symbol.toUpperCase() !== requestedSymbol) {
    throw unprocessable(
      "TOKEN_SYMBOL_MISMATCH",
      `indexer reports symbol ${info.symbol} for ${contract} on ${chain}, not ${requestedSymbol}; refusing to attribute the count`,
    );
  }
  const symbol = requestedSymbol ?? info.symbol ?? "unknown";
  const asOf = new Date().toISOString();

  const fields: Record<string, unknown> = {
    token: contract,
    chain,
    holders_count: info.holdersCount,
    token_symbol: symbol,
    as_of: asOf,
  };

  const receiptDoc: Receipt = makeReceipt(INTENT, url, info.rawBody, "1/1 indexer of record (Blockscout)");
  try {
    await saveReceipt(receiptDoc, info.rawBody);
  } catch {
    // A source observation is not a receipted answer until its evidence is stored.
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }

  return envelope(INTENT, fields, receiptDoc, {
    answer: `${symbol} (${contract}) on ${chain} has ${info.holdersCount} distinct holder addresses (Blockscout indexer, as of ${asOf}).`,
    verdict: "verified",
    confidence: 0.9,
    source: `Blockscout indexer (${indexer}, keyless, receipted)`,
  });
}
