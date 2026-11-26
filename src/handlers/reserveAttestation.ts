import {handleReserveBacking} from './reserveBacking';
import {handleTokenSupply} from './tokenSupply';
import {TOKEN_CONTRACTS,ADDRESS_RE} from './tokenContracts';
// ASSET_RESERVE_ATTESTATION_GENERAL: exact symbols in POR_FEEDS, plus verified issuance aliases.
//
// Zero-LLM. The latest Chainlink Proof-of-Reserve attestation for a
// supported asset, read on ethereum mainnet through the 2-of-N RPC
// quorum (txLookup doctrine), with a SHA-256 receipt over the exact
// upstream bodies. Probed live 2026-11-23: all three feeds answered
// (WBTC 116,144.74510048 at 1795338491; cbBTC 102,645.96213963 at
// 1795361399; TUSD 501,928,900.88 at 1795321451).
//
// Intent contract (read 2026-11-23): request asset (string); scored
// attested_reserve (number, [1, 1e18], micro-units of the underlying);
// off-chain asset, block, source.
//
// FEEDS: official Chainlink reference data directory
// (reference-data-directory.vercel.app/feeds-mainnet.json, retrieved
// 2026-11-23, hashed into the fixture set). Only feeds probed live
// AND inside the contract's micro-unit range are served. (An earlier
// note here said stETH PoR exceeds the range. It does not: 18 decimals,
// answer ~9.70e24 raw x 10^(6-18) = ~9.70e12 micro-ETH, inside [1, 1e18].
// Checked 2026-11-26.) Unlisted assets get a disclosed coverage-only null answer.
// Micro-unit conversion:
// answer x 10^(6 - feedDecimals); a non-zero remainder is floored and
// the remainder disclosed in the receipt.
//
// QUORUM: decimals() and latestRoundData() are eth_call'd at "latest"
// on every ethereum RPC leg; at least 2 legs must return the identical
// response body (2-of-N: a single dissenting leg is outvoted), else 502.
// Feeds flagged refuseStale are refused with 502 STALE_ATTESTATION when
// older than their heartbeat; the earlier feeds still serve it flagged. The attestation's own
// updatedAt is always named with its age; the feed's heartbeat is
// feed-specific (86400s default). Without refuseStale, stale data is served
// with staleness stated, never silently refreshed.
import {withAnswerClass} from "../core/answerClass";
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, sha256Hex } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { CHAIN_RPCS } from "../config/chains";

const RESERVE_DEADLINE_MS = 9000;
const UA = "VeriReceipt/2.0 reserve-attestation observer (+https://verireceipt.vercel.app)";
const DEFAULT_HEARTBEAT_S = 86400;

export const INTENT = "ASSET_RESERVE_ATTESTATION_GENERAL";

export interface PorFeed { asset: string; proxy: string; feedName: string; issuer?: string; heartbeat?: number; reserveUnit?: string; refuseStale?: boolean; note?: string }
/** Feeds probed live 2026-11-23 from the official Chainlink reference data directory.
 *  issuer is named only where the feed's own documentation supports it. */
export const POR_FEEDS: Record<string, PorFeed> = {
  // Issuer names (2026-11-26) are the issuer of the asset, sourced from issuer pages: Lido help.lido.fi/en/articles/5230610-what-is-steth;
  // ether.fi etherfi.gitbook.io/etherfi/products/staking/eeth; Bitget bitget.com/blog/articles/bitget-chainlink-proof-of-reserve-bgbtc-2025;
  // Huobi htx.com/news/87636; Swell swellnetwork.io/post/rswethpor and chain.link/blog/chainlink-for-lsts-and-lrts; Kinesis support.kinesis.money (C1USD).
  // Additional feeds: directory and 3-of-3 RPC reads verified 2026-11-26. refuseStale: older than the heartbeat is refused, never served.
  STETH: {"asset": "stETH", "proxy": "0xAd410E655C0fE4741F573152592eeb766e686CE7", "feedName": "stETH Proof of Reserves", "issuer": "Lido", "heartbeat": 21600, "reserveUnit": "ETH", "refuseStale": true},
  EETH: {"asset": "eETH", "proxy": "0xC8cd82067eA907EA4af81b625d2bB653E21b5156", "feedName": "eETH Proof of Reserves", "issuer": "ether.fi", "heartbeat": 86400, "reserveUnit": "ETH", "refuseStale": true},
  BGBTC: {"asset": "BGBTC", "proxy": "0xADcc914F882965Ef1B2f1043522b3B81ED081491", "feedName": "BGBTC Proof of Reserves", "issuer": "Bitget", "heartbeat": 86400, "reserveUnit": "BTC", "refuseStale": true, "note": "The reserve is for the Bitget BGBTC asset across chains; this feed is read on Ethereum mainnet."},
  HBTC: {"asset": "HBTC", "proxy": "0x0A8cD0115B1EE87EbA5b8E06A9a15ED93e230f7a", "feedName": "HBTC Proof of Reserves", "issuer": "Huobi", "heartbeat": 259200, "reserveUnit": "BTC", "refuseStale": true},
  SWETH: {"asset": "swETH", "proxy": "0x60cbE8D88EF519cF3C62414D76f50818D211fea1", "feedName": "Swell ETH Proof of Reserves", "issuer": "Swell Network", "heartbeat": 86400, "reserveUnit": "ETH", "refuseStale": true},
  RSWETH: {"asset": "rswETH", "proxy": "0x0c89c488e763AC2d69cB058CCAC7A8B283EE3DbA", "feedName": "Swell Restaked ETH Proof of Reserves", "issuer": "Swell Network", "heartbeat": 86400, "reserveUnit": "ETH", "refuseStale": true},
  C1USD: {"asset": "C1USD", "proxy": "0xAFa801e508613be7CA88D2d0fDB3F84f4c1B0384", "feedName": "C1USD Reserves", "issuer": "Kinesis Money", "heartbeat": 86400, "reserveUnit": "USD", "refuseStale": true},
  // Additional feeds: directory and 3-of-3 RPC reads verified 2026-11-25.
  FBTC: {"asset": "FBTC", "proxy": "0x75A0d3264a949C2C920d7F25Df174af1FaF73399", "feedName": "FBTC Proof of Reserves", "issuer": "Ignition", "heartbeat": 86400, "reserveUnit": "BTC"},
  LBTC: {"asset": "LBTC", "proxy": "0x70c158c7731Da2C14BC84aEBa39A4FF703DDc7d2", "feedName": "Lombard Proof of Reserves", "issuer": "Lombard", "heartbeat": 86400, "reserveUnit": "BTC"},
  USDW: {"asset": "USDW", "proxy": "0xe2c4E28D938aA42A5c5EDD5193f7BD2a972Bf7Bf", "feedName": "USDW Reserves", "issuer": "Wenia", "heartbeat": 43200, "reserveUnit": "USD"},
  UNIBTC: {"asset": "uniBTC", "proxy": "0xc590D9fb8eE78a0909dFF341ccf717000b7b7fF2", "feedName": "uniBTC Proof of Reserves", "issuer": "Bedrock", "heartbeat": 86400, "reserveUnit": "BTC"},
  SOLVBTC: {"asset": "SolvBTC", "proxy": "0xda9258AFc797Cd64d1b6FC651051224cdAB1B25E", "feedName": "SolvBTC Proof of Reserves", "issuer": "Solv Protocol", "heartbeat": 86400, "reserveUnit": "BTC"},
  XSOLVBTC: {"asset": "xSolvBTC", "proxy": "0x461790bDAF5aeD3df6a88cB97Dec42DD0EFA73c0", "feedName": "xSolvBTC Proof of Reserves", "issuer": "Solv Protocol", "heartbeat": 86400, "reserveUnit": "BTC"},
  KAU: {"asset": "KAU", "proxy": "0xaB5Dd7DD7669072a1Ef27c0ba241120A27A1aeC3", "feedName": "KAU Reserves", "issuer": "Kinesis Money", "heartbeat": 86400, "reserveUnit": "g"},
  KAG: {"asset": "KAG", "proxy": "0x3F0543aA057BcAeA152Fe9462Cb3ffaB305a6F8D", "feedName": "KAG Reserves", "issuer": "Kinesis Money", "heartbeat": 86400, "reserveUnit": "ozt"},
  WBTC: { asset: "WBTC", proxy: "0xa81FE04086865e63E12dD3776978E49DEEa2ea4e", feedName: "WBTC Proof of Reserves", issuer: "BitGo" },
  CBBTC: { asset: "cbBTC", proxy: "0xcBe87Dc0Cf9d807848a3E703B01A90B28eCFb2a7", feedName: "cbBTC Reserves", issuer: "Coinbase" },
  // The TUSD feed docs name TrueUSD/TrueUSDB tokens and attestor Moore Hong Kong,
  // not an issuer entity, so no issuer name is served for TUSD.
  TUSD: { asset: "TUSD", proxy: "0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5", feedName: "TUSD Reserves" },
};

// Official issuer contract lists, verified 2026-11-23. These contracts
// measure Ethereum issuance only, not all native chains backed by the feed.
const ETHEREUM_TOKENS: Record<string, { address: string; decimals: number }> = {
  WBTC: { address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 },
  CBBTC: { address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", decimals: 8 },
  TUSD: { address: "0x0000000000085d4780b73119b644ae5ecd22b376", decimals: 18 },
};

const DECIMALS_SEL = "0x313ce567";
const LATEST_ROUND_SEL = "0xfeaf968c";

// Required feed reads and optional enrichment use separate budgets and ownership pools.
const activeSupplyReads = new Set<string>();
// One required operation per URL/feed, held until underlying I/O really settles.
// The closed feed set and configured RPC URLs bound required in-flight keys.
const activeFeedReads = new Set<string>();
export function resetReserveFeedReadsForTests() { activeFeedReads.clear(); }
export function resetReserveSupplyReadsForTests() { activeSupplyReads.clear(); }
async function boundedRpcCall(url: string, data: string, to: string, deadline: number, required: boolean): Promise<{body: string; result: string}> {
  const active = required ? activeFeedReads : activeSupplyReads;
  const key = JSON.stringify(required ? [url, to] : [url, data, to]);
  if (Date.now() >= deadline || active.has(key) || (!required && active.size >= 16)) throw Error("reserve source unavailable");
  active.add(key);
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const io = (async () => {
    try {
      const res = await fetch(url, { method: "POST", redirect: "error", signal: abort.signal,
        headers: { "content-type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{to, data}, "latest"] }) });
      if (!res.ok || !res.body) throw Error("reserve RPC HTTP unavailable");
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 10000) { void reader.cancel().catch(() => {}); throw Error("reserve RPC body too large"); }
        chunks.push(part.value);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(body);
      if (parsed.error || typeof parsed.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(parsed.result)) throw Error("reserve RPC invalid envelope");
      return {body, result: parsed.result.toLowerCase()};
    } finally { active.delete(key); }
  })();
  try {
    return await Promise.race([io, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(Error("reserve RPC deadline")); }, Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

async function quorumCall(rpcs: string[], data: string, to: string, what: string, deadline: number, required = false): Promise<{ result: string; bodies: Record<string, string> }> {
  const settled = await Promise.allSettled(rpcs.map((url) => boundedRpcCall(url, data, to, deadline, required)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<{ body: string; result: string }> => s.status === "fulfilled").map((s) => s.value);
  if (ok.length < 2) {
    throw upstreamUnavailable("RPC_QUORUM_UNREACHABLE", `fewer than two ethereum RPC legs answered ${what} (${ok.length}/${rpcs.length})`);
  }
  const groups = new Map<string, { result: string; bodies: Record<string, string>; n: number }>();
  ok.forEach((r, i) => {
    const g = groups.get(r.result) ?? { result: r.result, bodies: {}, n: 0 };
    g.bodies[`leg${i}`] = r.body;
    g.n += 1;
    groups.set(r.result, g);
  });
  const best = [...groups.values()].sort((a, b) => b.n - a.n)[0];
  if (best.n < 2) {
    throw upstreamUnavailable("RPC_QUORUM_DISAGREEMENT", `the ethereum RPC legs disagree on ${what}; no attestation is guessed`);
  }
  if (best.result === "0x") {
    throw upstreamUnavailable("FEED_UNREADABLE", `the PoR feed answered empty for ${what} on ${best.n} agreeing legs; refusing to serve`);
  }
  return { result: best.result, bodies: best.bodies };
}

export interface RoundData { roundId: bigint; answer: bigint; updatedAt: number }

export function parseRoundData(hex: string): RoundData {
  const h = hex.slice(2);
  if (h.length < 64 * 5) throw upstreamUnavailable("FEED_BAD_BODY", "the latestRoundData answer is short; refusing to parse it");
  return {
    roundId: BigInt(`0x${h.slice(0, 64)}`),
    answer: BigInt(`0x${h.slice(64, 128)}`),
    updatedAt: Number(BigInt(`0x${h.slice(192, 256)}`)),
  };
}

/** Exact decimal rendering of a raw feed answer (BigInt, no float rounding), thousands-grouped, trailing zeros trimmed. Display only. */
export function exactReserveText(raw: bigint, decimals: number): string {
  const div = 10n ** BigInt(decimals);
  const whole = (raw / div).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (raw % div).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const RESERVE_ALIASES:Record<string,string>={
 'wrapped bitcoin':'WBTC','wrapped btc':'WBTC','coinbase wrapped bitcoin':'CBBTC','coinbase wrapped btc':'CBBTC','coinbase bitcoin':'CBBTC','trueusd':'TUSD','true usd':'TUSD',
 'ignition fbtc':'FBTC','lombard bitcoin':'LBTC','lombard btc':'LBTC','solv btc':'SOLVBTC','kinesis gold':'KAU','kinesis silver':'KAG'
};
export function resolveReserveAsset(input:string):string {
 const exact=input.trim().toLowerCase().replace(/\s+/g,' ');
 return RESERVE_ALIASES[exact]??input.trim().toUpperCase();
}
export function reserveInputDiagnostic(input:string):Record<string,unknown> {
 const words=new Set(input.toLowerCase().split(/[^a-z0-9]+/));
 const terms=['wbtc','cbbtc','tusd','usdc','usdt','dai','steth','fbtc','lbtc','bitcoin','wrapped','coinbase','trueusd','gold','silver','btc','eth','reserve','reserves'];
 return {asset_terms:terms.filter(t=>words.has(t)),asset_sha256:sha256Hex(input),asset_length:input.length};
}
export async function handleReserveAttestation(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const assetRaw = query.asset?.trim();
  if(assetRaw&&assetRaw.length>256)throw badRequest('BAD_ASSET','asset too long');
  if (!assetRaw) throw badRequest("MISSING_PARAM", `asset is required, one of: ${Object.values(POR_FEEDS).map((f) => f.asset).join(", ")}`);
  // Exact Ethereum issuance-address aliases only; never prefixes or cross-chain guesses.
  const addressKey = Object.entries(ETHEREUM_TOKENS).find(([,token]) => token.address === assetRaw.toLowerCase())?.[0];
  const key = addressKey ?? resolveReserveAsset(assetRaw);
  if(key==='WETH'||key==='WSTETH')return handleReserveBacking(key);
  const feed = Object.hasOwn(POR_FEEDS, key) ? POR_FEEDS[key] : undefined;
  if (!feed) {
    console.info(JSON.stringify({event:"reserve_asset_unmapped",...reserveInputDiagnostic(assetRaw)}));
    const publicSymbol=Object.hasOwn(TOKEN_CONTRACTS.ethereum,key)&&/^[A-Z0-9.-]{2,12}$/.test(key)?key:undefined;
    const contract=ADDRESS_RE.test(assetRaw)?assetRaw:TOKEN_CONTRACTS.ethereum[key];
    let issuance:Record<string,unknown>|null=null;
    if(contract){try{const supplied=await handleTokenSupply({token:contract,chain:'ethereum'});issuance={total_supply:supplied.total_supply,supply_base_units:supplied.supply_base_units,decimals:supplied.decimals,symbol:supplied.token_symbol,contract,chain:'ethereum',scope:'Ethereum ERC20 issuance only, not reserves, backing or solvency',source_receipt:supplied.receipt};}catch{issuance=null;}}
    const fetchedAt=new Date().toISOString();
    const fields={asset:publicSymbol??null,attested_reserve:null,ethereum_total_supply:issuance?.total_supply??null,reserve_vs_ethereum_supply_pct:null,collateral_ratio_pct:null,issuance,status:issuance?'issuance_only':'coverage_unavailable',reason_code:'no_verified_reserve_source'};
    const evidence=JSON.stringify({requested_asset_sha256:sha256Hex(assetRaw),...(publicSymbol?{public_symbol:publicSymbol}:{}),...fields,method:'No verified reserve source; available Ethereum issuance is separately receipted and is not collateral evidence',fetched_at:fetchedAt});
    const receipt=makeReceipt(INTENT,'urn:verireceipt:reserve-coverage',evidence,'coverage decision; no reserve attestation or collateral ratio asserted');
    try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','coverage evidence could not be stored');}
    return withAnswerClass(envelope(INTENT,fields,receipt,{answer:`No verified reserve source is configured for this asset. No reserve or collateral ratio is asserted. ${issuance?'Ethereum ERC20 issuance was separately read by quorum: '+issuance.total_supply+' tokens. This is issuance only, not reserve backing or a solvency audit.':'Ethereum issuance is unavailable or no exact Ethereum token binding resolves; no value is guessed.'} Covered PoR feeds: ${Object.values(POR_FEEDS).map(f=>f.asset).join(', ')}.`,verdict:'unavailable',confidence:0,source:'local coverage decision'+(issuance?'; separately receipted Ethereum token issuance quorum':'')}),INTENT,{asset_known:false,source_kind:issuance?'issuance_only':'coverage_only',numeric_vs_null:'null',reserve_asset_bucket:'other',...(publicSymbol?{reserve_public_symbol:publicSymbol}:{})});
  }
  const heartbeat = feed.heartbeat ?? DEFAULT_HEARTBEAT_S;
  const reserveUnit = feed.reserveUnit ?? feed.asset;
  const feedDeadline = Date.now() + RESERVE_DEADLINE_MS;
  const fetchedAt = new Date().toISOString();
  const rpcs = CHAIN_RPCS.ethereum;
  const dec = await quorumCall(rpcs, DECIMALS_SEL, feed.proxy, "decimals()", feedDeadline, true);
  const decimals = Number(BigInt(dec.result));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw upstreamUnavailable("FEED_BAD_BODY", `the feed reported implausible decimals (${decimals})`);
  }
  const round = await quorumCall(rpcs, LATEST_ROUND_SEL, feed.proxy, "latestRoundData()", feedDeadline, true);
  const data = parseRoundData(round.result);
  if (data.answer <= 0n) throw unprocessable("NO_USABLE_ATTESTATION", "the feed's latest round carries a non-positive reserve; refusing to serve it");
  // Micro-units of the underlying: answer x 10^(6 - decimals).
  let micro: bigint;
  let remainder = 0n;
  if (decimals <= 6) {
    micro = data.answer * 10n ** BigInt(6 - decimals);
  } else {
    const div = 10n ** BigInt(decimals - 6);
    micro = data.answer / div;
    remainder = data.answer % div;
  }
  if (micro < 1n || micro > 10n ** 18n) {
    throw unprocessable("OUT_OF_CONTRACT_RANGE", `the attestation is ${micro} micro-units, outside the contract range [1, 1e18]; refusing to serve it wrong`);
  }
  const updatedIso = new Date(data.updatedAt * 1000).toISOString();
  const ageS = Math.max(0, Math.floor(Date.now() / 1000) - data.updatedAt);
  const stale = ageS > heartbeat;
  if (stale && feed.refuseStale) {
    throw upstreamUnavailable("STALE_ATTESTATION", `the ${feed.asset} feed's latest attestation is ${Math.floor(ageS / 3600)}h old, older than its ${Math.floor(heartbeat / 3600)}h heartbeat; refusing to serve a stale reserve`);
  }
  const asOf = new Date().toISOString();
  const human = Number(data.answer) / 10 ** decimals;
  let ethereumSupply: number | null = null;
  let supplyEvidence: unknown = null;
  const token = ETHEREUM_TOKENS[key];
  try {
    if (!token) throw new Error("no verified Ethereum issuance binding");
    const supplyDeadline = Date.now() + 900;
    const [supply, tokenDec] = await Promise.all([
      quorumCall(rpcs, "0x18160ddd", token.address, "token totalSupply()", supplyDeadline),
      quorumCall(rpcs, DECIMALS_SEL, token.address, "token decimals()", supplyDeadline),
    ]);
    if (!/^0x[0-9a-f]{64}$/.test(supply.result) || !/^0x[0-9a-f]{64}$/.test(tokenDec.result) || Number(BigInt(tokenDec.result)) !== token.decimals) throw new Error("token read invalid");
    ethereumSupply = Number(BigInt(supply.result)) / 10 ** token.decimals;
    if (!Number.isFinite(ethereumSupply) || ethereumSupply <= 0) throw new Error("token supply invalid");
    supplyEvidence = { address: token.address, decimals: token.decimals, raw_supply: BigInt(supply.result).toString(), raw_bodies: { supply: supply.bodies, decimals: tokenDec.bodies }, scope: "Ethereum native ERC20 issuance only; excludes other chains" };
  } catch {
    ethereumSupply = null;
    supplyEvidence = { status: "unavailable", reason: token ? "token_supply_quorum_unavailable" : "no_verified_ethereum_issuance_binding" };
  }
  const computedRatio = ethereumSupply === null ? null : human / ethereumSupply * 100;
  const ethereumRatio = computedRatio !== null && Number.isFinite(computedRatio) ? computedRatio : null;
  const evidence = JSON.stringify({ asset: feed.asset, feed: feed.feedName, issuer: feed.issuer ?? null, proxy: feed.proxy,
    // The contract's off-chain field "source" is served as source_feed because
    // the response envelope reserves "source"; this key records that mapping.
    field_mapping: { source: "source_feed" },
    feed_registry: "https://reference-data-directory.vercel.app/feeds-mainnet.json (expanded 2026-11-25)",
    reserve_unit: reserveUnit,
    as_of: asOf, round_id: data.roundId.toString(), answer_raw: data.answer.toString(), feed_decimals: decimals,
    updated_at: updatedIso, age_seconds: ageS, heartbeat_seconds: heartbeat, stale,
    micro_units: micro.toString(), micro_remainder: remainder.toString(),
    derivation: "attested_reserve = answer x 10^(6 - feed_decimals), floored with the remainder disclosed",
    ethereum_supply: supplyEvidence, reserve_vs_ethereum_supply_pct: ethereumRatio, collateral_ratio_pct: null,
    raw_bodies: { decimals: dec.bodies, round: round.bodies }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, `ethereum RPC quorum, Chainlink PoR ${feed.proxy}`, evidence, "Chainlink Proof of Reserve via 2-of-N RPC quorum; micro-unit derivation disclosed");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer = `${feed.asset} attested reserve: ${exactReserveText(data.answer, decimals)} ${reserveUnit} (${micro.toString()} micro-units) per the Chainlink ${feed.feedName} feed${feed.issuer ? ` (issuer ${feed.issuer})` : ""}, round ${data.roundId}, attested ${updatedIso} (${Math.floor(ageS / 3600)}h ago${stale ? `, OLDER than the ${heartbeat / 3600}h heartbeat` : ""}). ` +
    `${ethereumSupply === null ? "Ethereum total supply unavailable; no ratio asserted. " : `Ethereum total supply ${ethereumSupply} ${feed.asset}; reserve versus Ethereum-only supply ${ethereumRatio}%. `}This is not a global collateral ratio; collateral_ratio_pct is null. ${token ? "The reserve feed covers wider issuance and other native chains are excluded from the supply denominator. " : "No verified Ethereum issuance token binding is configured for this asset. "} Supply is read at latest while the reserve is the timestamped feed attestation, not a time-matched solvency audit. ` +
    `Read on ethereum mainnet through the RPC quorum; this is the feed's own attestation, not an independent audit.${remainder ? ` Micro-unit remainder floored: ${remainder}.` : ""}${feed.note ? ` ${feed.note}` : ""}`;
  return withAnswerClass(envelope(INTENT, {
    attested_reserve: Number(micro),
    asset: feed.asset,
    reserve_units: human, reserve_unit: reserveUnit, ethereum_total_supply: ethereumSupply,
    reserve_vs_ethereum_supply_pct: ethereumRatio, collateral_ratio_pct: null,
    supply_scope: "Ethereum native ERC20 issuance only, excludes other chains",
    round_id: data.roundId.toString(), updated_at: updatedIso, feed_age_seconds: ageS, heartbeat_seconds: heartbeat,
    block: `round ${data.roundId}, attested ${updatedIso}`,
    // The contract's off-chain field is named "source"; the envelope
    // reserves that key, so it is served as source_feed and mapped in
    // the evidence.
    source_feed: `Chainlink ${feed.feedName} feed ${feed.proxy} via ethereum RPC quorum; fetched ${fetchedAt}`,
  }, receipt, { answer, verdict: "verified", confidence: 0.9,
    source: `Chainlink ${feed.feedName} ${feed.proxy} via ethereum RPC quorum (${rpcs.join(", ")}); fetched ${fetchedAt}` }), INTENT, {asset_known:true,source_kind:"por_feed",numeric_vs_null:"numeric",reserve_asset_bucket:["WBTC","cbBTC","TUSD"].includes(feed.asset)?feed.asset:"other"});
}
