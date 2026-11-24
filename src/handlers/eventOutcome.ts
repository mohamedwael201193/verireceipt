import {withAnswerClass} from "../core/answerClass";
// EVENT_OUTCOME_RESOLUTION_GENERAL — GET /v1/event-outcome?event=<market question>
//
// Zero-LLM. The resolved outcome of a prediction-market event, with a
// SHA-256 receipt over the exact upstream response body.
//
// Intent contract (read 2026-11-22): request event (string); response
// outcome enum yes/no/unresolved + resolved_yes bool; off-chain event,
// winner, resolved_at, sources.
//
// SOURCE: Polymarket gamma API public-search, keyless, probed live
// 2026-11-23. Scope honestly named in every answer: resolved binary
// Polymarket markets only — this is one venue's resolution record,
// not an independent determination of the underlying real-world event.
//
// Match exactly or by unique normalized containment. A genuine no-match
// enables the narrow Wikipedia fallback; ambiguous and nonbinary matches refuse.
// A found explicitly open binary market is disclosed as unresolved, never priced
// into an outcome. Closed markets still require UMA resolved and a clean1/0 pair.
import { ApiError, badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

import { wikipediaEventOutcome } from './eventWikipedia';

const SOURCE_TIMEOUT_MS = 8000;
const UA = "VeriReceipt/2.0 event-resolution observer (+https://verireceipt.vercel.app)";

export const INTENT = "EVENT_OUTCOME_RESOLUTION_GENERAL";

export interface PmMarket {
  question: string; closed: boolean; closedKnown?: boolean; umaStatus: string;
  outcomes: string[]; prices: string[]; endDate: string; resolutionSource: string; slug: string;
}

export function parseSearch(raw: string): PmMarket[] {
  const d = JSON.parse(raw) as { events?: unknown };
  const out: PmMarket[] = [];
  for (const e of (Array.isArray(d.events) ? d.events : []) as Record<string, unknown>[]) {
    for (const m of (Array.isArray(e.markets) ? e.markets : []) as Record<string, unknown>[]) {
      const parseArr = (v: unknown): string[] => {
        if (Array.isArray(v)) return v.map(String);
        if (typeof v === "string") { try { return (JSON.parse(v) as unknown[]).map(String); } catch { return []; } }
        return [];
      };
      out.push({
        question: String(m.question ?? ""), closed: m.closed === true, closedKnown: typeof m.closed === "boolean",
        umaStatus: String(m.umaResolutionStatus ?? ""), outcomes: parseArr(m.outcomes),
        prices: parseArr(m.outcomePrices), endDate: String(m.endDate ?? ""),
        resolutionSource: String(m.resolutionSource ?? ""), slug: String(m.slug ?? ""),
      });
    }
  }
  return out;
}

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function matchMarket(markets: PmMarket[], event: string): PmMarket {
  const q = norm(event);
  const exact = markets.filter((m) => norm(m.question) === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw unprocessable("AMBIGUOUS_EVENT", `several markets carry this exact question: ${exact.map((m) => m.slug).join("; ")}`);
  const contained = markets.filter((m) => { const n = norm(m.question); return q && (n.includes(q) || q.includes(n)); });
  if (contained.length === 1) return contained[0];
  if (contained.length === 0) throw unprocessable("EVENT_NOT_FOUND", `no Polymarket market matches "${event}"; resolved Polymarket markets only, nothing is inferred`);
  throw unprocessable("AMBIGUOUS_EVENT", `${contained.length} markets match "${event}": ${contained.slice(0, 5).map((m) => m.question).join("; ")}${contained.length > 5 ? "; …" : ""} — ask the exact market question`);
}

export type Resolution = { outcome: "yes" | "no"; resolved_yes: boolean; winner: string } | {outcome:"unresolved";resolved_yes:false};

export function resolveMarket(m: PmMarket): Resolution {
  if (m.outcomes.length!==2 || new Set(m.outcomes.map(x=>x.toLowerCase())).size!==2 || !m.outcomes.every(x=>/^(yes|no)$/i.test(x))) {
    throw unprocessable("NON_BINARY_MARKET", "matched market must have exactly Yes and No outcomes; yes/no enum only");
  }
  if(m.closedKnown===false)throw unprocessable("EVENT_NOT_RESOLVED", "market closed status is missing; no outcome asserted");
  if(!m.closed){
    if(m.prices.length!==2||!m.prices.every(x=>x.trim()!==''&&Number.isFinite(Number(x))&&Number(x)>=0&&Number(x)<=1))throw unprocessable("NON_BINARY_MARKET", "open market has malformed binary prices; no outcome asserted");
    return {outcome:"unresolved",resolved_yes:false};
  }
  if (!m.closed || m.umaStatus !== "resolved") {
    throw unprocessable("EVENT_NOT_RESOLVED", `"${m.question}" is not resolved (closed=${m.closed}, uma=${m.umaStatus || "n/a"}); unresolved outcomes are refused, never inferred`);
  }
  if (m.outcomes.length !== 2 || m.prices.length !== 2) {
    throw unprocessable("NON_BINARY_MARKET", `"${m.question}" is not a binary market; the contract's yes/no enum cannot carry its winner`);
  }
  const wi = m.prices.findIndex((p) => Number(p) === 1);
  const li = m.prices.findIndex((p) => Number(p) === 0);
  if (wi === -1 || li === -1 || wi === li) {
    throw unprocessable("UNCLEAN_RESOLUTION", `"${m.question}" resolved without a clean 1/0 price pair (${m.prices.join("/")}); never inferred`);
  }
  const winner = m.outcomes[wi];
  if (!/^(yes|no)$/i.test(winner)) {
    throw unprocessable("NON_BINARY_MARKET", `"${m.question}" resolved to "${winner}", which the contract's yes/no enum cannot carry`);
  }
  return { outcome: winner.toLowerCase() as "yes" | "no", resolved_yes: winner.toLowerCase() === "yes", winner };
}

export async function handleEventOutcome(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const event = query.event?.trim();
  if (!event) throw badRequest("MISSING_PARAM", "event is required (the market question)");
  if (event.length > 200) throw badRequest("EVENT_TOO_LONG", "event must be at most 200 characters");
  const url = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(event)}&limit_per_type=3`;
  const fetchedAt = new Date().toISOString();
  let body: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    throw upstreamUnavailable("POLYMARKET_UNREACHABLE", "the Polymarket gamma API could not be reached");
  }
  const markets = parseSearch(body);
  let market: PmMarket;
  try { market = matchMarket(markets, event); }
  catch (error) {
    // Only a genuine no-match enables fallback; matched markets never use it.
    if (error instanceof ApiError && error.code === 'EVENT_NOT_FOUND') return wikipediaEventOutcome(event, body, url);
    throw error;
  }
  const r = resolveMarket(market);
  const asOf = new Date().toISOString();
  if(r.outcome==='unresolved'){
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(market.slug))throw unprocessable('EVENT_NOT_RESOLVED','open market has no usable source slug; no outcome asserted');
    const sourceUrl=`https://polymarket.com/event/${market.slug}`;
    const evidence=JSON.stringify({event,as_of:asOf,matched_market:market,candidates_seen:markets.length,source_policy:'Found explicitly open binary market only; unresolved is not a negative outcome or price probability',raw_bodies:{search:body},fetched_at:fetchedAt});
    const receipt=makeReceipt(INTENT,url,evidence,'Polymarket gamma single source; explicitly open binary market, no outcome asserted');receipt.fetched_at=fetchedAt;
    try{await saveReceipt(receipt,evidence);}catch{throw upstreamUnavailable('RECEIPT_PERSIST_FAILED','receipt evidence could not be stored; answer unavailable');}
    return withAnswerClass(envelope(INTENT,{outcome:'unresolved',resolved_yes:false,event:market.question,sources:[sourceUrl]},receipt,{answer:`Polymarket market '${market.question}' is not resolved as of ${fetchedAt}; no outcome is asserted. resolved_yes=false does not assert NO when outcome is unresolved.`,verdict:'unresolved',confidence:0.9,source:`${url}; explicitly open market status only; fetched ${fetchedAt}`}),INTENT,{outcome:'unresolved',source:'polymarket'});
  }
  const evidence = JSON.stringify({ event, as_of: asOf,
    matched_market: market, candidates_seen: markets.length,
    source_policy: "Polymarket gamma public-search; closed + UMA-resolved + clean 1/0 pair only; one venue's resolution record, not an independent determination",
    raw_bodies: { search: body }, fetched_at: fetchedAt });
  const receipt = makeReceipt(INTENT, url, evidence, "Polymarket gamma single source; resolved binary markets only, never inferred");
  receipt.fetched_at = fetchedAt;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  const answer =
    `"${market.question}" resolved ${r.winner.toUpperCase()} on Polymarket (UMA resolution status: resolved; market closed, end date ${market.endDate})` +
    `${market.resolutionSource ? `; named resolution source: ${market.resolutionSource}` : ""}. ` +
    `This is one venue's resolution record (Polymarket), not an independent determination of the underlying event.`;
  return withAnswerClass(envelope(INTENT, {
    outcome: r.outcome,
    resolved_yes: r.resolved_yes,
    event: market.question,
    winner: r.winner,
    resolved_at: market.endDate,
    sources: ["Polymarket gamma (UMA-resolved market)"],
  }, receipt, { answer, verdict: "verified", confidence: 0.85,
    source: `${url}; Polymarket UMA-resolved market, one venue's record; fetched ${fetchedAt}` }),INTENT,{outcome:r.outcome,source:"polymarket"});
}
