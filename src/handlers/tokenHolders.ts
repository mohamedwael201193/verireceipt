import {queryFallback} from '../core/queryFallback';
import {markFailure,failureKind} from '../core/upstreamFailureDiagnostics';
import {withAnswerClass} from '../core/answerClass';
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
// Holder counts are indexer-side aggregates, not RPC state. Ethereum and
// optimism retain Blockscout as indexer of record. BSC, Polygon, Base and
// Arbitrum use GeckoTerminal's token-info holders aggregate. The named
// per-chain source and source update time (when present) are disclosed.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, type Receipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { cachedHolderBody, resetHolderCacheForTests, holderRetrySlot } from "./holderSourceCache";
import { recordUpstreamError } from "../core/upstreams";
import { normalizeChain } from "./txLookup";
import { ADDRESS_RE, TOKEN_CONTRACTS, isNativeSymbol, labeledTokenContract, tokenContractFor } from "./tokenContracts";

export const INTENT = "TOKEN_HOLDER_COUNT_GENERAL";

const HTTP_TIMEOUT_MS = 4000;
/** Scored range upper bound from the intent contract. */
const MAX_HOLDERS = 10_000_000_000;

/** Keyless Blockscout-family indexer of record per chain. */
const INDEXERS: Record<string, string> = {
  ethereum: "https://eth.blockscout.com",
  optimism: "https://explorer.optimism.io",
};

const GECKO_NETWORKS: Record<string, string> = { bsc: "bsc", polygon: "polygon_pos", base: "base", arbitrum: "arbitrum" };
// Verified against token-info address and symbol on 2026-11-23. These are
// holder-index bindings only; they do not extend the RPC token registry.
const HOLDER_CONTRACTS: Record<string, Record<string, string>> = {
  bsc: { USDT: "0x55d398326f99059ff775485246999027b3197955", USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" },
};
const SUPPORTED_CHAINS = [...Object.keys(INDEXERS), ...Object.keys(GECKO_NETWORKS)];

/** Test seam / runtime override for the HTTP fetch. */
type FetchText = (url: string) => Promise<string>;
let fetchImpl: FetchText | null = null;
export function setTokenHoldersFetchForTests(impl: FetchText | null): void {
  fetchImpl = impl;
  resetHolderCacheForTests();
  holderResults.clear();
}

// Caller deadlines do not release ownership of an abort-ignoring fetch/body.
// Bound the retained flights, including timed-out I/O, to avoid a leak.
const activeHolderIO = new Map<string, Promise<string>>();
async function fetchTextOnce(url: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let io = activeHolderIO.get(url);
  if (!io) {
    if (activeHolderIO.size >= 8) throw new Error("holder I/O capacity exhausted");
    io = (async () => {
      try {
        if (fetchImpl) return await fetchImpl(url);
        const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!res.ok) {
          const error = Object.assign(new Error("holder HTTP failure"), { status: res.status, retryAfterMs: undefined as number | undefined });
          const retry = res.headers.get("retry-after");
          if (retry) {
            const ms = /^\d+$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
            if (Number.isFinite(ms) && ms >= 0) error.retryAfterMs = ms;
          }
          markFailure(error, res.status === 429 ? "rate_limited" : "unreachable");
          // The request owns its response body until it is canceled too.
          try { await res.body?.cancel(); } catch { /* Preserve the HTTP failure. */ }
          throw error;
        }
        return await res.text();
      } catch (error) {
        if (failureKind(error) === "unknown") markFailure(error, "unreachable");
        throw error;
      }
    })();
    activeHolderIO.set(url, io);
    const owned = io;
    const release = () => { if (activeHolderIO.get(url) === owned) activeHolderIO.delete(url); };
    void io.then(release, release);
  }
  try {
    return await Promise.race([io, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = Object.assign(new Error("holder HTTP budget exceeded"),{timeout:true});
        markFailure(error, "unreachable");
        reject(error);
      }, Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}

async function fetchText(url: string, timeoutMs = HTTP_TIMEOUT_MS, canStart: () => boolean = () => true): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt=0;attempt<2;attempt++) {
    if (!canStart() || Date.now()>=deadline) throw Error('holder start budget ended');
    try { return await fetchTextOnce(url, Math.max(1,Math.min(attempt===0?2500:4000,deadline-Date.now()))); }
    catch (error) {
      let status:unknown,timeout:unknown;try{status=(error as any)?.status;timeout=(error as any)?.timeout;}catch{}
      const e={status:typeof status==='number'?status:undefined,timeout:timeout===true};
      if(attempt || !(e.status!==undefined && e.status>=500 || e.timeout) || activeHolderIO.has(url) || deadline-Date.now()<=250) throw error;
      if(url.includes('api.geckoterminal.com')){if(!await holderRetrySlot(deadline,canStart))throw error;}
      else await new Promise(r=>setTimeout(r,200));
    }
  }
  throw Error('holder retry exhausted');
}

function holderFailureClass(error:unknown,token:string):Record<string,unknown>{
 let status:unknown;try{const d=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'status'):undefined;status=d&&'value'in d?d.value:undefined;}catch{}
 return{token_class:ADDRESS_RE.test(token)?'address':'symbol',...(typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?{upstream_http_status:status}:{})};
}

interface IndexerTokenInfo {
  holdersCount: number;
  symbol: string | null;
  rawBody: string;
  sourceUpdated?: string;
}

interface HolderResult { info: IndexerTokenInfo; url: string; sourceName: string; fetchedAt: string }
const holderResults = new Map<string,HolderResult>();
const RESULT_TTL_MS=15*60_000, RESULT_MAX_STALE_MS=24*60*60_000;

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

function parseGecko(rawBody: string, network: string, contract: string): IndexerTokenInfo {
  const data = JSON.parse(rawBody)?.data;
  const a = data?.attributes;
  if (data?.id?.toLowerCase() !== `${network}_${contract}`.toLowerCase() || data?.type !== "token" ||
      typeof a?.address !== "string" || a.address.toLowerCase() !== contract.toLowerCase()) {
    throw new Error("GeckoTerminal network/token identity mismatch");
  }
  const count = a?.holders?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > MAX_HOLDERS) {
    throw new Error("GeckoTerminal holders count missing or outside contract range");
  }
  if (typeof a.symbol !== "string" || !a.symbol.trim()) throw new Error("GeckoTerminal symbol missing");
  const updated = a?.holders?.last_updated;
  if (typeof updated !== "string" || !Number.isFinite(Date.parse(updated)) ||
      Date.parse(updated) > Date.now() + 60000 || Date.now() - Date.parse(updated) > 86400000) {
    throw new Error("GeckoTerminal holder update time missing or stale");
  }
  return { holdersCount: count, symbol: a.symbol, rawBody, sourceUpdated: updated };
}

export async function handleTokenHolders(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  return holderLookup(query);
}
async function holderLookup(
  query: Record<string, string | undefined>,
  boot?: {deadline:number;canStart:()=>boolean},
): Promise<Record<string, unknown>> {
  query=queryFallback(query,"token",text=>text);
  const startedAt = Date.now();
  const deadlineAt = Math.min(startedAt + 7_500,boot?.deadline??Infinity);
  const canStart=boot?.canStart??(()=>true);
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
  const network = GECKO_NETWORKS[chain];
  if (!indexer && !network) {
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
    const lookedUp = HOLDER_CONTRACTS[chain]?.[tokenRaw.toUpperCase()] ?? tokenContractFor(chain, tokenRaw);
    if (!lookedUp) {
      throw unprocessable(
        "UNSUPPORTED_TOKEN",
        `unsupported token: ${tokenRaw} on ${chain}; pass a 0x contract address or one of: ${Object.keys(
          { ...TOKEN_CONTRACTS[chain], ...HOLDER_CONTRACTS[chain] },
        ).join(", ") || "(none verified)"}`,
      );
    }
    contract = lookedUp;
    requestedSymbol = tokenRaw.trim().toUpperCase();
  }

  const resultKey=`${chain}:${contract.toLowerCase()}`;
  const prior=holderResults.get(resultKey);
  const age=prior?Date.now()-Date.parse(prior.fetchedAt):Infinity;
  const fresh=prior && age>=0 && age<RESULT_TTL_MS;
  let url = network
    ? `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${contract}/info`
    : `${indexer}/api/v2/tokens/${contract}`;
  let sourceName = network ? "GeckoTerminal" : "Blockscout";
  let info: IndexerTokenInfo;
  let bodyFetchedAt: string;
  let staleReason: string | undefined;
  try {
  if (fresh) { info=prior.info;url=prior.url;sourceName=prior.sourceName;bodyFetchedAt=prior.fetchedAt; } else {
  try {
    const observation = network
      ? await cachedHolderBody(url, (remaining) => fetchText(url, remaining,canStart), (raw) => { try{parseGecko(raw, network, contract);}catch(error){markFailure(error,'bad_payload');throw error;} }, deadlineAt)
      : { body: await fetchText(url, Math.min(4_000, deadlineAt - Date.now()),canStart), fetchedAt: new Date().toISOString() };
    bodyFetchedAt = observation.fetchedAt;
    staleReason = "staleReason" in observation ? observation.staleReason : undefined;
    if (staleReason) recordUpstreamError("geckoterminal", staleReason.includes("429") ? "UPSTREAM_RATE_LIMITED" : "INDEXER_UNREACHABLE");
    try{info = network ? parseGecko(observation.body, network, contract) : parseIndexerResponse(observation.body, url, contract);}catch(error){markFailure(error,'bad_payload');throw error;}
  } catch (err) {
    if(network)recordUpstreamError('geckoterminal',holderFailureClass(err,tokenRaw).upstream_http_status===429?'UPSTREAM_RATE_LIMITED':'INDEXER_UNREACHABLE');
    if(chain==='ethereum'){
      // Same token, second holder index. No estimated count or combined aggregate.
      const fallbackUrl=`https://api.geckoterminal.com/api/v2/networks/eth/tokens/${contract}/info`;
      try{
        const observation=await cachedHolderBody(fallbackUrl,remaining=>fetchText(fallbackUrl,remaining,canStart),raw=>{try{parseGecko(raw,'eth',contract);}catch(error){markFailure(error,'bad_payload');throw error;}},deadlineAt);
        info=parseGecko(observation.body,'eth',contract);bodyFetchedAt=observation.fetchedAt;staleReason=observation.staleReason;
        url=fallbackUrl;sourceName='GeckoTerminal (Ethereum fallback after Blockscout unavailable)';
      }catch(fallbackError){
        throw withAnswerClass(upstreamUnavailable('INDEXER_UNREACHABLE','Blockscout and GeckoTerminal Ethereum holder indexes unavailable; no count invented'),INTENT,{upstream_name:'geckoterminal',upstream_failure:failureKind(fallbackError),...holderFailureClass(fallbackError,tokenRaw)});
      }
    }else{
      throw withAnswerClass(upstreamUnavailable(
        "INDEXER_UNREACHABLE",
        `${sourceName} holder-count indexer failed for ${chain}: ${err instanceof Error ? err.message : String(err)}`,
      ),INTENT,{upstream_name:network?'geckoterminal':'blockscout',upstream_failure:failureKind(err),...holderFailureClass(err,tokenRaw)});
    }
  }

  }
  } catch(error) {
    if(!prior || age<0 || Date.now()-Date.parse(prior.fetchedAt)>=RESULT_MAX_STALE_MS) throw error;
    info=prior.info;url=prior.url;sourceName=prior.sourceName;bodyFetchedAt=prior.fetchedAt;
    staleReason='upstream request failed; last validated holder observation, not a current count';

  }

  // A symbol request must match the indexer's own symbol for the
  // contract — a mismatch means the verified map drifted, and answering
  // would attribute another token's count to the asked symbol.
  if (requestedSymbol && (info.symbol === null || info.symbol.toUpperCase() !== requestedSymbol)) {
    throw unprocessable(
      "TOKEN_SYMBOL_MISMATCH",
      `indexer reports symbol ${info.symbol} for ${contract} on ${chain}, not ${requestedSymbol}; refusing to attribute the count`,
    );
  }
  if (!fresh && !staleReason) {
    if(holderResults.size>=128)holderResults.delete(holderResults.keys().next().value!);
    holderResults.set(resultKey,{info,url,sourceName,fetchedAt:bodyFetchedAt});
  }
  if(boot) return {warmed:true};
  const symbol = requestedSymbol ?? info.symbol ?? "unknown";
  const asOf = info.sourceUpdated ?? bodyFetchedAt;

  const fields: Record<string, unknown> = {
    token: contract,
    chain,
    holders_count: info.holdersCount,
    token_symbol: symbol,
    as_of: asOf, fetched_at:bodyFetchedAt,
    stale: Boolean(staleReason),
    ...(staleReason ? { stale_reason: staleReason } : {}),
  };

  const receiptDoc: Receipt = makeReceipt(INTENT, url, info.rawBody, `1/1 indexer of record (${sourceName})${staleReason ? "; STALE DISCLOSED: source failure fallback; source observation " + asOf : ""}`);
  receiptDoc.fetched_at = bodyFetchedAt;
  if (Date.now() >= deadlineAt) throw upstreamUnavailable("HOLDER_DEADLINE", "holder lookup exceeded its 7.5s observation budget; no answer served");
  try {
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([saveReceipt(receiptDoc, info.rawBody), new Promise<never>((_resolve, reject) => {
        persistTimer = setTimeout(() => reject(new Error("holder persistence deadline exceeded")), Math.max(1, startedAt + 8_000 - Date.now()));
      })]);
    } finally { if (persistTimer) clearTimeout(persistTimer); }
  } catch {
    // A source observation is not a receipted answer until its evidence is stored.
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }

  if (Date.now() >= startedAt + 8_000) throw upstreamUnavailable("HOLDER_DEADLINE", "holder lookup exceeded its 8s total budget; no answer served");
  return envelope(INTENT, fields, receiptDoc, {
    answer: `${staleReason ? `STALE cached holder count acquired ${bodyFetchedAt}, cache age ${Math.floor((Date.now()-Date.parse(bodyFetchedAt))/1000)} seconds, upstream unavailable; not a fresh query. Not a current count. ` : ""}${symbol} (${contract}) on ${chain} has ${info.holdersCount} distinct holder addresses (${sourceName} indexer, as of ${asOf}).${staleReason ? " Upstream lookup failed (" + staleReason + "). This is the last real cached value observed at " + asOf + "; no count has been estimated or updated." : ""}`,
    verdict: staleReason ? "stale" : "verified",
    confidence: staleReason ? 0.5 : 0.9,
    source: `${sourceName} indexer (${url}, keyless, receipted); holder aggregate, not RPC state${(network||sourceName.startsWith("GeckoTerminal")) ? "; validated holder result may be reused for15minutes, or disclosed stale on error below24hours acquisition age; as_of is provider holders.last_updated" : ""}`,
  });
}

export function holderUpstreamForQuery(query: Record<string, string | undefined>): string {
  const chain = normalizeChain(query.chain ?? query.token?.match(/\s+on\s+(.+)$/i)?.[1]);
  return GECKO_NETWORKS[chain ?? ""] ? "geckoterminal" : "blockscout";
}

let holderBootStarted=false,holderBootStopped=false;
export function stopHolderBootWarm():void {holderBootStopped=true;}
export function resetHolderBootWarmForTests():void {holderBootStarted=false;holderBootStopped=true;}
export function startHolderBootWarm():void {
  if(holderBootStarted)return;holderBootStarted=true;holderBootStopped=false;
  void (async()=>{
    const deadline=Date.now()+120000;
    for(const chain of ['bsc','ethereum']) for(const token of ['USDT','USDC']) {
      await new Promise<void>(r=>{const t=setTimeout(r,1000);t.unref?.();});
      if(holderBootStopped||Date.now()>=deadline)return;
      try{await holderLookup({chain,token},{deadline,canStart:()=>!holderBootStopped&&Date.now()<deadline});}catch{return;}
    }
  })().catch(()=>{});
}
