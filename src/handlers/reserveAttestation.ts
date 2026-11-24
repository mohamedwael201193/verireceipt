// ASSET_RESERVE_ATTESTATION_GENERAL — GET /v1/reserve-attestation?asset=<WBTC|cbBTC|TUSD>
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
// AND inside the contract's micro-unit range are served: stETH PoR
// (18 decimals, ~9.7e18 micro-ETH) exceeds the contract range and is
// not enabled. Unlisted assets get a disclosed coverage-only null answer.
// Micro-unit conversion:
// answer x 10^(6 - feedDecimals); a non-zero remainder is floored and
// the remainder disclosed in the receipt.
//
// QUORUM: decimals() and latestRoundData() are eth_call'd at "latest"
// on every ethereum RPC leg; the legs must agree EXACTLY on decimals,
// roundId, answer and updatedAt, else 502. The attestation's own
// updatedAt is always named with its age; the feed's heartbeat is
// 86400s, and a stale attestation is served with the staleness stated,
// never silently refreshed.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { CHAIN_RPCS } from "../config/chains";

const RPC_TIMEOUT_MS = 12000;
const UA = "VeriReceipt/2.0 reserve-attestation observer (+https://verireceipt.vercel.app)";
const HEARTBEAT_S = 86400;

export const INTENT = "ASSET_RESERVE_ATTESTATION_GENERAL";

export interface PorFeed { asset: string; proxy: string; feedName: string; issuer?: string }
/** Feeds probed live 2026-11-23 from the official Chainlink reference data directory.
 *  issuer is named only where the feed's own documentation supports it. */
export const POR_FEEDS: Record<string, PorFeed> = {
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

async function rpcCall(url: string, data: string, to: string): Promise<{ body: string; result: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const result = (JSON.parse(body) as { result?: string }).result;
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error("no result");
    return { body, result: result.toLowerCase() };
  } finally {
    clearTimeout(timer);
  }
}

async function quorumCall(rpcs: string[], data: string, to: string, what: string): Promise<{ result: string; bodies: Record<string, string> }> {
  const settled = await Promise.allSettled(rpcs.map((url) => rpcCall(url, data, to)));
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

export async function handleReserveAttestation(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const assetRaw = query.asset?.trim();
  if (!assetRaw) throw badRequest("MISSING_PARAM", `asset is required, one of: ${Object.values(POR_FEEDS).map((f) => f.asset).join(", ")}`);
  // Exact Ethereum issuance-address aliases only; never prefixes or cross-chain guesses.
  const addressKey = Object.entries(ETHEREUM_TOKENS).find(([,token]) => token.address === assetRaw.toLowerCase())?.[0];
  const key = addressKey ?? assetRaw.toUpperCase();
  const feed = Object.hasOwn(POR_FEEDS, key) ? POR_FEEDS[key] : undefined;
  if (!feed) {
    return { answer: `No probed-live Chainlink PoR feed is enabled for "${assetRaw.slice(0, 80)}". Covered assets: ${Object.values(POR_FEEDS).map(f => f.asset).join(", ")}. No reserve is asserted; this coverage-only response is outside the scored numeric attestation contract.`,
      asset: assetRaw.slice(0, 80), attested_reserve: null, ethereum_total_supply: null,
      reserve_vs_ethereum_supply_pct: null, collateral_ratio_pct: null,
      verdict: "unavailable", confidence: 0, receipt: null };
  }
  const fetchedAt = new Date().toISOString();
  const rpcs = CHAIN_RPCS.ethereum;
  const dec = await quorumCall(rpcs, DECIMALS_SEL, feed.proxy, "decimals()");
  const decimals = Number(BigInt(dec.result));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw upstreamUnavailable("FEED_BAD_BODY", `the feed reported implausible decimals (${decimals})`);
  }
  const round = await quorumCall(rpcs, LATEST_ROUND_SEL, feed.proxy, "latestRoundData()");
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
  const stale = ageS > HEARTBEAT_S;
  const asOf = new Date().toISOString();
  const human = Number(data.answer) / 10 ** decimals;
  let ethereumSupply: number | null = null;
  let supplyEvidence: unknown = null;
  const token = ETHEREUM_TOKENS[key];
  try {
    const [supply, tokenDec] = await Promise.all([
      quorumCall(rpcs, "0x18160ddd", token.address, "token totalSupply()"),
      quorumCall(rpcs, DECIMALS_SEL, token.address, "token decimals()"),
    ]);
    if (!/^0x[0-9a-f]{64}$/.test(supply.result) || !/^0x[0-9a-f]{64}$/.test(tokenDec.result) || Number(BigInt(tokenDec.result)) !== token.decimals) throw new Error("token read invalid");
    ethereumSupply = Number(BigInt(supply.result)) / 10 ** token.decimals;
    if (!Number.isFinite(ethereumSupply) || ethereumSupply <= 0) throw new Error("token supply invalid");
    supplyEvidence = { address: token.address, decimals: token.decimals, raw_supply: BigInt(supply.result).toString(), raw_bodies: { supply: supply.bodies, decimals: tokenDec.bodies }, scope: "Ethereum native ERC20 issuance only; excludes other chains" };
  } catch {
    ethereumSupply = null;
    supplyEvidence = { status: "unavailable", reason: "token_supply_quorum_unavailable" };
  }
  const computedRatio = ethereumSupply === null ? null : human / ethereumSupply * 100;
  const ethereumRatio = computedRatio !== null && Number.isFinite(computedRatio) ? computedRatio : null;
  const evidence = JSON.stringify({ asset: feed.asset, feed: feed.feedName, issuer: feed.issuer ?? null, proxy: feed.proxy,
    // The contract's off-chain field "source" is served as source_feed because
    // the response envelope reserves "source"; this key records that mapping.
    field_mapping: { source: "source_feed" },
    feed_registry: "Chainlink reference data directory feeds-mainnet.json (retrieved 2026-11-23)",
    as_of: asOf, round_id: data.roundId.toString(), answer_raw: data.answer.toString(), feed_decimals: decimals,
    updated_at: updatedIso, age_seconds: ageS, heartbeat_seconds: HEARTBEAT_S, stale,
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
  const answer = `${feed.asset} attested reserve: ${human.toLocaleString("en-US", { maximumFractionDigits: decimals })} ${feed.asset} (${micro.toString()} micro-units) per the Chainlink ${feed.feedName} feed${feed.issuer ? ` (issuer ${feed.issuer})` : ""}, round ${data.roundId}, attested ${updatedIso} (${Math.floor(ageS / 3600)}h ago${stale ? `, OLDER than the ${HEARTBEAT_S / 3600}h heartbeat` : ""}). ` +
    `${ethereumSupply === null ? "Ethereum total supply unavailable; no ratio asserted. " : `Ethereum total supply ${ethereumSupply} ${feed.asset}; reserve versus Ethereum-only supply ${ethereumRatio}%. `}This is not a global collateral ratio: the reserve feed covers wider issuance and other native chains are excluded from the supply denominator; collateral_ratio_pct is null. Supply is read at latest while the reserve is the timestamped feed attestation, not a time-matched solvency audit. ` +
    `Read on ethereum mainnet through the RPC quorum; this is the feed's own attestation, not an independent audit.${remainder ? ` Micro-unit remainder floored: ${remainder}.` : ""}`;
  return envelope(INTENT, {
    attested_reserve: Number(micro),
    asset: feed.asset,
    reserve_units: human, ethereum_total_supply: ethereumSupply,
    reserve_vs_ethereum_supply_pct: ethereumRatio, collateral_ratio_pct: null,
    supply_scope: "Ethereum native ERC20 issuance only, excludes other chains",
    round_id: data.roundId.toString(), updated_at: updatedIso, feed_age_seconds: ageS, heartbeat_seconds: HEARTBEAT_S,
    block: `round ${data.roundId}, attested ${updatedIso}`,
    // The contract's off-chain field is named "source"; the envelope
    // reserves that key, so it is served as source_feed and mapped in
    // the evidence.
    source_feed: `Chainlink ${feed.feedName} feed ${feed.proxy} via ethereum RPC quorum; fetched ${fetchedAt}`,
  }, receipt, { answer, verdict: "verified", confidence: 0.9,
    source: `Chainlink ${feed.feedName} ${feed.proxy} via ethereum RPC quorum (${rpcs.join(", ")}); fetched ${fetchedAt}` });
}
