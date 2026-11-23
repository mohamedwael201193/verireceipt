// MACRO_ECONOMIC_INDICATOR_GENERAL — GET /v1/macro?indicator=&country=&year=
//
// Published World Bank annual observations with receipts over raw source bytes.
// Endpoint aliases name their series in the answer. The registered YAML remains
// unemployment-only. Missing observations and values outside the scored 0..100
// percent range are disclosed with rate_pct null, never clamped or invented.
// Unknown indicators refuse rather than silently changing the question.
//
// COUNTRY RESOLUTION: the input is matched against the World Bank's own
// country catalog (GET /v2/country?format=json&per_page=400 — the same
// source, cached in memory for CATALOG_TTL_MS, never a hand-maintained
// copy that could drift): exact case-insensitive match on the WB name,
// ISO-3166 alpha-2 or alpha-3, plus a small alias table for common
// short names whose WB name differs ("Egypt" → "Egypt, Arab Rep.",
// "Turkey" → "Turkiye", "South Korea" → "Korea, Rep.", "UK" → GB …).
// Aggregate regions (World, Euro area, …) are EXCLUDED — the intent
// asks for a country or region's published statistic and the scored
// reference is a country series; an aggregate input is 422. No fuzzy
// substring matching: an unmatched country is 422 COUNTRY_NOT_FOUND.
import { badRequest, unprocessable, upstreamUnavailable } from "../core/errors";
import { envelope, makeReceipt, type Receipt } from "../core/receipt";
import { saveReceipt } from "../core/storage";

export const INTENT = "MACRO_ECONOMIC_INDICATOR_GENERAL";

const WB_BASE = "https://api.worldbank.org/v2";
const INDICATOR_ID = "SL.UEM.TOTL.ZS";
const SERIES: Record<string, { id: string; unit: string }> = {
  "unemployment rate": { id: INDICATOR_ID, unit: "% of total labour force" },
  "inflation": { id: "FP.CPI.TOTL.ZG", unit: "% annual consumer-price change" },
  "gdp growth": { id: "NY.GDP.MKTP.KD.ZG", unit: "% annual GDP growth" },
  "current account": { id: "BN.CAB.XOKA.GD.ZS", unit: "% of GDP" },
  "gdp per capita": { id: "NY.GDP.PCAP.CD", unit: "current US dollars per person" },
  "population": { id: "SP.POP.TOTL", unit: "people" },
};
const HTTP_TIMEOUT_MS = 12000;
const CATALOG_TTL_MS = 60 * 60 * 1000;

const SUPPORTED_INDICATOR = "unemployment rate";
// Exact aliases only; unsupported requests keep a disclosed refusal.
const INDICATOR_ALIASES = new Set([
  "unemployment rate",
  "unemployment",
  "jobless rate",
  "rate of unemployment",
  "sl.uem.totl.zs",
  "unemployment % of total labor force",
  "unemployment rate % of total labor force",
  "unemployment total",
  "unemployment total of total labor force",
]);

/** Normalize an indicator input; returns the canonical enum value when
 * it is a known variant, else null. */
export function normalizeIndicator(input: string): string | null {
  const stripped = input
    .toLowerCase()
    .replace(/\(\s*(%|percent|percentage)\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
  if (INDICATOR_ALIASES.has(stripped)) return SUPPORTED_INDICATOR;
  const aliases: Record<string, string> = {
    inflation: "inflation", cpi: "inflation", "consumer prices": "inflation",
    "fp.cpi.totl.zg": "inflation", "gdp growth": "gdp growth",
    "ny.gdp.mktp.kd.zg": "gdp growth", "current account": "current account",
    "bn.cab.xoka.gd.zs": "current account", "gdp per capita": "gdp per capita",
    "ny.gdp.pcap.cd": "gdp per capita", population: "population", "sp.pop.totl": "population",
  };
  return Object.hasOwn(aliases, stripped) ? aliases[stripped] : null;
}

/**
 * Common short names whose World Bank catalog name (or ISO code)
 * differs. Keys are lowercased inputs; values are the ISO-3166 alpha-2
 * code the catalog is searched by. Kept tiny and explicit — anything
 * else falls through to the exact name/ISO match or a 422.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  egypt: "EG",
  turkey: "TR",
  "south korea": "KR",
  korea: "KR",
  russia: "RU",
  iran: "IR",
  venezuela: "VE",
  vietnam: "VN",
  syria: "SY",
  bolivia: "BO",
  tanzania: "TZ",
  moldova: "MD",
  laos: "LA",
  brunei: "BN",
  "czech republic": "CZ",
  czechia: "CZ",
  "ivory coast": "CI",
  "cape verde": "CV",
  uae: "AE",
  usa: "US",
  america: "US",
  "united states": "US",
  "south africa": "ZA",
  "hong kong": "HK",
  macau: "MO",
  macao: "MO",
  palestine: "PS",
  "kyrgyz republic": "KG",
  kyrgyzstan: "KG",
  slovakia: "SK",
  "slovak republic": "SK",
};

interface WbCountry {
  /** WB row id: ISO-3166 alpha-3 for countries ("EGY"). */
  id: string;
  iso2Code: string;
  name: string;
  iso3: string;
  isAggregate: boolean;
}

let catalogCache: { at: number; countries: WbCountry[] } | null = null;

/** Test seam: drop the cached catalog between cases. */
export function resetMacroCachesForTests(): void {
  catalogCache = null;
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadCatalog(): Promise<WbCountry[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.countries;
  }
  const raw = await fetchText(`${WB_BASE}/country?format=json&per_page=400`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw upstreamUnavailable("WORLD_BANK_UNAVAILABLE", "World Bank catalog returned invalid JSON");
  }
  if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) {
    throw upstreamUnavailable("WORLD_BANK_UNAVAILABLE", "World Bank catalog returned an unexpected shape");
  }
  const countries: WbCountry[] = [];
  for (const row of parsed[1] as Array<Record<string, unknown>>) {
    const region = row?.region as Record<string, unknown> | undefined;
    if (typeof row?.id !== "string" || typeof row?.name !== "string") continue;
    countries.push({
      id: row.id,
      iso2Code: typeof row.iso2Code === "string" ? row.iso2Code : "",
      name: row.name,
      iso3: row.id,
      isAggregate: region?.value === "Aggregates",
    });
  }
  catalogCache = { at: Date.now(), countries };
  return countries;
}

/**
 * Resolve a country input to a non-aggregate WB country. Exact
 * case-insensitive match on ISO-2 / ISO-3 / WB name, then the alias
 * table. Returns null when nothing matches.
 */
export function resolveCountry(
  countries: WbCountry[],
  input: string,
): WbCountry | null {
  const q = input.trim().toLowerCase().replace(/\s+/g, " ");
  const real = countries.filter((c) => !c.isAggregate);
  for (const c of real) {
    if (c.iso2Code.toLowerCase() === q || c.iso3.toLowerCase() === q) return c;
  }
  for (const c of real) {
    if (c.name.toLowerCase() === q) return c;
  }
  const aliasIso = COUNTRY_ALIASES[q];
  if (aliasIso) {
    const hit = real.find((c) => c.iso2Code === aliasIso);
    if (hit) return hit;
  }
  return null;
}

export async function handleMacro(
  query: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const indicatorInput = query.indicator?.trim();
  const indicatorRaw = indicatorInput?.toLowerCase().replace(/\s+/g, " ");
  const countryRaw = query.country?.trim();
  const yearRaw = query.year?.trim();
  if (!indicatorRaw || !countryRaw) {
    throw badRequest("MISSING_PARAM", "indicator and country are required query parameters");
  }
  const indicator = indicatorRaw === SUPPORTED_INDICATOR ? SUPPORTED_INDICATOR : normalizeIndicator(indicatorRaw);
  if (indicator === null) {
    throw unprocessable(
      "UNSUPPORTED_INDICATOR",
      `unsupported indicator: ${query.indicator}; no default is substituted. Supported endpoint indicators: ${Object.keys(SERIES).join(", ")}`,
    );
  }
  const series = SERIES[indicator];
  const indicatorNormalized = indicatorInput !== undefined && indicatorInput !== SUPPORTED_INDICATOR;
  if (yearRaw !== undefined && !/^\d{4}$/.test(yearRaw)) {
    throw badRequest("INVALID_YEAR", "year must be a 4-digit calendar year (1960-2100)");
  }
  const requestedYear = yearRaw === undefined ? undefined : Number(yearRaw);
  if (requestedYear !== undefined && (requestedYear < 1960 || requestedYear > 2100)) {
    throw badRequest("INVALID_YEAR", "year must be between 1960 and 2100");
  }

  let countries: WbCountry[];
  try {
    countries = await loadCatalog();
  } catch (err) {
    if (err instanceof Error && err.name === "ApiError") throw err;
    throw upstreamUnavailable(
      "WORLD_BANK_UNAVAILABLE",
      "World Bank country catalog is unreachable",
    );
  }
  const country = resolveCountry(countries, countryRaw);
  if (country === null) {
    throw unprocessable(
      "COUNTRY_NOT_FOUND",
      `country not found in the World Bank catalog: ${countryRaw} (aggregate regions are not served)`,
    );
  }

  const iso = country.iso2Code || country.id;
  // Official MRNEV selects published, nonempty data. Never guess that
  // the current calendar year already has an annual observation.
  // https://datahelpdesk.worldbank.org/knowledgebase/articles/898581-api-basic-call-structures
  const selector = requestedYear === undefined ? "mrnev=1" : `date=${requestedYear}`;
  const url = `${WB_BASE}/country/${encodeURIComponent(iso)}/indicator/${series.id}?${selector}&format=json&per_page=100`;
  let rawText: string;
  try {
    rawText = await fetchText(url);
  } catch {
    throw upstreamUnavailable("WORLD_BANK_UNAVAILABLE", "World Bank indicator API is unreachable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw upstreamUnavailable("WORLD_BANK_UNAVAILABLE", "World Bank indicator API returned invalid JSON");
  }
  if (!Array.isArray(parsed) || (parsed[1] !== null && !Array.isArray(parsed[1]))) {
    throw upstreamUnavailable("WORLD_BANK_UNAVAILABLE", "World Bank indicator API returned an unexpected row shape");
  }
  const rows = (parsed[1] ?? []) as Array<Record<string, unknown>>;
  const row = requestedYear === undefined
    ? rows.filter((r) => /^\d{4}$/.test(String(r?.date)) && Number(r.date) >= 1960 &&
        Number(r.date) <= 2100 && r.value !== null && r.value !== undefined)
        .sort((a, b) => Number(b.date) - Number(a.date))[0]
    : rows.find((r) => String(r?.date) === String(requestedYear));
  const year = requestedYear ?? (row ? Number(row.date) : undefined);
  const value = row?.value;
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw upstreamUnavailable("WORLD_BANK_UNAVAILABLE", "World Bank returned a nonnumeric observation");
  }
  const hasValue = typeof value === "number" && Number.isFinite(value);
  const percentSeries = !["gdp per capita", "population"].includes(indicator);
  const ratePct = hasValue && percentSeries && value >= 0 && value <= 100 ? Math.round(value * 1e6) / 1e6 : null;
  const asOf = new Date().toISOString();
  const fields: Record<string, unknown> = {
    rate_pct: ratePct,
    indicator,
    indicator_id: series.id,
    indicator_input: indicatorInput,
    country: country.name,
    country_iso3: country.iso3 || country.id,
    year,
    year_resolution: requestedYear === undefined ? "latest_published_nonempty" : "requested_year",
    as_of: asOf,
  };

  const receiptDoc: Receipt = makeReceipt(INTENT, url, rawText, "1/1 authoritative source (World Bank)");
  try {
    await saveReceipt(receiptDoc, rawText);
  } catch {
    throw upstreamUnavailable(
      "RECEIPT_PERSIST_FAILED",
      "receipt evidence could not be stored; answer unavailable",
    );
  }

  return envelope(INTENT, fields, receiptDoc, {
    answer: `${indicatorNormalized ? `"${indicatorInput}" read as "${indicator}". ` : ""}Mapping: ${indicator} -> World Bank ${series.id}. ${country.name}${requestedYear === undefined ? " latest published observation" : ""}${year === undefined ? "" : ` in ${year}`}: ${hasValue ? `${value} ${series.unit}.${ratePct === null ? " rate_pct is null: this observation is outside the scored 0..100 percent field or is not a percentage." : ""}` : "no data published for the requested observation; rate_pct is null, not zero."}`,
    verdict: hasValue ? "verified" : "no_data",
    confidence: hasValue ? 1.0 : 0,
    source: "World Bank API (api.worldbank.org, authoritative publisher)",
  });
}
