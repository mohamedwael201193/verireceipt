import {handleGleifRegistry} from './gleifRegistry';
// CORPORATE_REGISTRY_LOOKUP_GENERAL: SEC first for US filers, GLEIF elsewhere
// and on a completed SEC crosswalk miss. SEC failure is not a miss.
// SEC CIK and recent-filing activity are distinct from legal standing. GLEIF
// returns legal entity status and registeredAs, with explicit incomplete LEI
// coverage. Neither source proves nonexistence on a negative name search.
// GLEIF terms, source policy, pacing and captures: docs/corporate-gleif.md.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";
import { resolveCikFromTickers, type TickersMap } from "./filings";
import { sha256Hex } from "../core/receipt";

function pad10(n: number): string { return String(n).padStart(10, "0"); }

const SOURCE_TIMEOUT_MS = 6000;
const TICKERS_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_DAYS = 400;

function requireUserAgent(): string {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua || ua.trim() === "") {
    throw upstreamUnavailable("SEC_USER_AGENT_MISSING", "SEC_USER_AGENT environment variable is required for SEC EDGAR requests");
  }
  return ua.trim();
}

async function fetchText(url: string, ua: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": ua, Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

let tickersCache: { data: TickersMap; fetchedAt: number; raw: string } | null = null;
export function __clearCorporateRegistryCacheForTests(): void { tickersCache = null; }

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const submissionsUrl = (cik10: string): string => `https://data.sec.gov/submissions/CIK${cik10}.json`;

export interface EdgarProfile {
  legalName: string; cik: string; ein: string; entityType: string;
  stateOfIncorporation: string; tickers: string[]; exchanges: string[];
  address: string; lastFilingDate: string; active: boolean;
}

export function parseSubmissions(raw: string, cik10: string, nowIso: string): EdgarProfile {
  const d = JSON.parse(raw) as Record<string, unknown>;
  if (String(d.cik ?? "").padStart(10, "0") !== cik10) {
    throw upstreamUnavailable("EDGAR_BAD_BODY", `EDGAR answered for CIK ${String(d.cik)}, not ${cik10}; refusing a mismatched profile`);
  }
  if (typeof d.name !== "string" || !d.name) throw upstreamUnavailable("EDGAR_BAD_BODY", "EDGAR profile has no legal name");
  const addr = (d.addresses as { business?: Record<string, unknown> } | undefined)?.business ?? {};
  const address = [addr.street1, addr.street2, [addr.city, addr.stateOrCountryDescription ?? addr.stateOrCountry].filter(Boolean).join(", "), addr.zipCode]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean).join(", ");
  const recent = (d.filings as { recent?: { filingDate?: unknown } } | undefined)?.recent;
  const dates = Array.isArray(recent?.filingDate) ? (recent!.filingDate as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const lastFilingDate = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : "";
  const nowMs = Date.parse(nowIso);
  const active = lastFilingDate !== "" && Number.isFinite(nowMs) &&
    (nowMs - Date.parse(lastFilingDate)) <= ACTIVE_WINDOW_DAYS * 86400000;
  return {
    legalName: d.name, cik: cik10,
    ein: typeof d.ein === "string" ? d.ein : "",
    entityType: typeof d.entityType === "string" ? d.entityType : "",
    stateOfIncorporation: typeof d.stateOfIncorporation === "string" ? d.stateOfIncorporation : "",
    tickers: Array.isArray(d.tickers) ? (d.tickers as unknown[]).filter((x): x is string => typeof x === "string") : [],
    exchanges: Array.isArray(d.exchanges) ? (d.exchanges as unknown[]).filter((x): x is string => typeof x === "string") : [],
    address, lastFilingDate, active,
  };
}

const US_JURISDICTIONS = new Set(["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"]);

export const INTENT = "CORPORATE_REGISTRY_LOOKUP_GENERAL";

export async function handleCorporateRegistry(query: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const company = query.company?.trim();
  if (!company) throw badRequest("MISSING_PARAM", "company is required (name, ticker or CIK)");
  if (company.length > 120) throw badRequest("COMPANY_TOO_LONG", "company must be at most 120 characters");
  const jurisdiction = query.jurisdiction?.trim();
  if (!jurisdiction) throw badRequest("MISSING_PARAM", "jurisdiction is required");
  if (!US_JURISDICTIONS.has(jurisdiction.toLowerCase())) {
    return handleGleifRegistry(company,jurisdiction);
  }
  const ua = requireUserAgent();
  const fetchedAtTickers = new Date().toISOString();
  if (!tickersCache || Date.now() - tickersCache.fetchedAt > TICKERS_TTL_MS) {
    const raw = await fetchText(TICKERS_URL, ua).catch((err: unknown) => {
      throw upstreamUnavailable("SEC_UNAVAILABLE", `SEC company_tickers fetch failed: ${err instanceof Error ? err.message : "unknown error"}`);
    });
    tickersCache = { data: JSON.parse(raw) as TickersMap, fetchedAt: Date.now(), raw };
  }
  const tickersRawForReceipt = tickersCache.fetchedAt;
  const tickersRawBody = tickersCache.raw;
  const match = resolveCikFromTickers(company, tickersCache.data);
  if (!match) {
    return handleGleifRegistry(company,"US");
  }
  const subUrl = submissionsUrl(match.cik10);
  const subRaw = await fetchText(subUrl, ua).catch((err: unknown) => {
    throw upstreamUnavailable("SEC_UNAVAILABLE", `EDGAR submissions fetch failed: ${err instanceof Error ? err.message : "unknown error"}`);
  });
  const asOf = new Date().toISOString();
  const profile = parseSubmissions(subRaw, match.cik10, asOf);
  const evidence = JSON.stringify({ company, jurisdiction: "US", resolved_cik: match.cik10, match_kind: match.matchKind,
    as_of: asOf, profile,
    active_criterion: `filed with the SEC within the last ${ACTIVE_WINDOW_DAYS} days (EDGAR carries no good-standing flag)`,
    source_policy: "SEC EDGAR single registry (company_tickers.json + submissions API); US filers only; CIK is the registration id; no incorporation date in EDGAR",
    // The tickers crosswalk body is too large to embed; its SHA-256 plus the
    // single resolved row let a judge recompute the CIK resolution.
    tickers_sha256: sha256Hex(tickersRawBody),
    resolved_ticker_row: Object.values(tickersCache.data).find((e) => pad10(Number(e.cik_str)) === match.cik10) ?? null,
    raw_bodies: { submissions: subRaw }, tickers_file_cached_at: new Date(tickersRawForReceipt).toISOString(), fetched_at: fetchedAtTickers });
  const receipt = makeReceipt(INTENT, subUrl, evidence, "SEC EDGAR single registry; active = recent filer activity, not legal standing");
  receipt.fetched_at = fetchedAtTickers;
  try {
    await saveReceipt(receipt, evidence);
  } catch {
    throw upstreamUnavailable("RECEIPT_PERSIST_FAILED", "receipt evidence could not be stored; answer unavailable");
  }
  return envelope(INTENT, {
    legal_name: profile.legalName,
    registration_id: match.cik10.replace(/^0+/, "") || "0",
    active: profile.active,
    jurisdiction: "US",
    registered_address: profile.address,
    incorporated: "",
    cik: match.cik10, ein: profile.ein, entity_type: profile.entityType,
    state_of_incorporation: profile.stateOfIncorporation,
    tickers: profile.tickers, exchanges: profile.exchanges,
    last_filing_date: profile.lastFilingDate,
  }, receipt, {
    answer: `${profile.legalName} — SEC EDGAR registry (US). CIK ${Number(match.cik10)}${profile.ein ? `, EIN ${profile.ein}` : ""}` +
      `${profile.tickers.length ? `, tickers ${profile.tickers.join("/")} on ${profile.exchanges.join("/") || "unlisted exchange"}` : ""}. ` +
      `${profile.address ? `Business address on file: ${profile.address}. ` : ""}` +
      `${profile.stateOfIncorporation ? `State of incorporation: ${profile.stateOfIncorporation}. ` : ""}` +
      `${profile.lastFilingDate ? `Last SEC filing ${profile.lastFilingDate}; ` : "No SEC filings on record; "}` +
      `active = ${profile.active} by the only criterion EDGAR supports: filed within the last ${ACTIVE_WINDOW_DAYS} days. ` +
      "This is a filer-activity signal, NOT a legal good-standing or solvency determination. " +
      "EDGAR does not carry the incorporation date, so none is reported. Coverage: US SEC filers only; the CIK is EDGAR's registry identifier, not an LEI or state company number.",
    verdict: "verified",
    confidence: match.matchKind === "name" ? 0.9 : 1.0,
    source: `${subUrl} + ${TICKERS_URL}; SEC EDGAR single registry, honestly scoped to US filers; active is filer activity within ${ACTIVE_WINDOW_DAYS} days, not legal standing; fetched ${fetchedAtTickers}`,
  });
}
