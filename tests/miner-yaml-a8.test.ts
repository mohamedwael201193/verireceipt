// A8 (miner.yaml rewrite): the registration file must match the official
// Telegraph intent schemas field-for-field and claim nothing the code does
// not back. Expected field lists and units are copied from the live
// GET https://devnode.telegraphprotocol.com/engine/v1/intents/{INTENT}
// responses fetched 2026-11-21 (request/response unchanged vs the
// telegraph-docs c652c68 snapshot). Text-level checks only: the repo has
// no YAML parser dependency, and the frontend suite already pins
// DOC_SNIPPETS.yaml byte-identical to this file.
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { ApiError, errorBody } from "../src/core/errors";
import { makeReceipt } from "../src/core/receipt";

const yaml = readFileSync(resolve(process.cwd(), "miner.yaml"), "utf8");

/** Lines of the block that starts at `start` (exact line) and runs until
 *  the next line with indentation <= the start line's. */
function block(startLine: string): string[] {
  const lines = yaml.split("\n");
  const i = lines.indexOf(startLine);
  expect(i, `missing line: ${startLine}`).toBeGreaterThan(-1);
  const indent = startLine.length - startLine.trimStart().length;
  const out: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  return out;
}

/** Direct child keys of `lines` at exactly `indent` spaces. */
function keysAt(lines: string[], indent: number): string[] {
  const re = new RegExp(`^ {${indent}}([A-Za-z0-9_]+):`);
  return lines.map((l) => re.exec(l)?.[1]).filter((k): k is string => k !== undefined);
}

function acceptedFieldEntries(lines: string[]): Array<{ value: string; lines: string[] }> {
  const start = lines.findIndex(line => line.trim() === "accepted_fields:");
  expect(start).toBeGreaterThan(-1);
  const indent = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].length - lines[end].trimStart().length > indent)) end++;
  const body = lines.slice(start + 1, end).filter(line => line.trim() !== "");
  const starts = body.flatMap((line, index) => line.length - line.trimStart().length === indent + 2 ? [index] : []);
  return starts.map((index, position) => {
    const own = body.slice(index, starts[position + 1] ?? body.length).map(line => line.trim());
    expect(own[0]).not.toMatch(/^-/);
    expect(own[0]).toMatch(/^[^:]+:$/);
    return { value: own[0].slice(0, -1), lines: own };
  });
}

type OutputSpec = string | null | { unit: string | null; path: string };
const OFFICIAL: Record<string, { endpoint: string; outputs: Record<string, OutputSpec>; inputs: string[] }> = {
  ONCHAIN_TX_LOOKUP_GENERAL: {
    endpoint: "/v1/tx",
    inputs: ["tx_hash", "chain"],
    outputs: {
      tx_hash: null, status: null, from: null, to: null,
      block_number: "block height", value_eth: "whole native units",
    },
  },
  REGULATORY_FILING_MONITOR_GENERAL: {
    endpoint: "/v1/filings",
    inputs: ["entity", "period"],
    outputs: { entity: null, filing_count: "filings", filings: null, urls: null },
  },
  TVL_LOOKUP_GENERAL: {
    endpoint: "/v1/tvl",
    inputs: ["protocol"],
    outputs: { protocol_or_chain: null, tvl_usd: "USD", chain_tvl_usd: "USD", as_of: null },
  },
  OPTIMAL_EXECUTION_ROUTE_GENERAL: {
    endpoint: "/v1/route",
    inputs: ["pair"],
    outputs: { amount_out: "USDC base units (6 decimals)" },
  },
  GRID_POWER_PRICE_GENERAL: {
    endpoint: "/v1/grid-price",
    inputs: ["node_or_zone", "interval_start"],
    outputs: {
      lmp_usd_per_mwh: "USD per MWh", node_or_zone: null, market: null,
      interval_start: null, currency: null,
    },
  },
  VALIDATOR_PERFORMANCE_VERIFY_GENERAL: {
    endpoint: "/v1/validator",
    inputs: ["validator_index"],
    outputs: { effective_balance: "gwei" },
  },
  GAS_PRICE_GENERAL: {
    endpoint: "/v1/gas-price", inputs: ["chain"],
    outputs: { chain: null, gas_price_gwei: "gwei", transfer_fee_usd: "USD", as_of: null },
  },
  WALLET_BALANCE_CHECK_GENERAL: {
    endpoint: "/v1/balance", inputs: ["address", "chain", "token"],
    outputs: { address: null, chain: null, balance: "whole token units", token_symbol: null, as_of: null },
  },
  TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL: {
    endpoint: "/v1/token-supply", inputs: ["token"], outputs: { total_supply: "whole tokens" },
  },
  MACRO_ECONOMIC_INDICATOR_GENERAL: {
    endpoint: "/v1/macro", inputs: ["indicator", "country", "year"], outputs: { rate_pct: "percent" },
  },
  DNS_RECORD_LOOKUP_GENERAL: {
    endpoint: "/v1/dns", inputs: ["name", "record_type"], outputs: { has_record: null },
  },
  CURRENCY_EXCHANGE_CONVERT: {
    endpoint: "/v1/fx", inputs: ["from_currency", "to_currency", "amount"], outputs: { converted_amount: null },
  },
  SSL_VERIFICATION_CERT: {
    endpoint: "/v1/ssl", inputs: ["host"], outputs: { certificate_valid: null },
  },
  EMAIL_SECURITY_GENERAL: {
    endpoint: "/v1/email-security", inputs: ["domain", "record_type"], outputs: { lookup_ok: null },
  },
  ACADEMIC_SEARCH_GENERAL: {
    endpoint: "/v1/academic-search",
    inputs: ["query"],
    outputs: { answer: null, paper_titles: null, dois: null, total_matches: null },
  },
  ASSET_RESERVE_ATTESTATION_GENERAL: {
    endpoint: "/v1/reserve-attestation",
    inputs: ["asset"],
    outputs: { attested_reserve: "micro-units of the underlying asset", asset: null, block: null, source: null },
  },
  CODE_PATCH_VERIFY_GENERAL: {
    endpoint: "/v1/code-patch",
    inputs: ["patch"],
    outputs: { passed: null, commit: null, pipeline: null },
  },
  CORPORATE_REGISTRY_LOOKUP_GENERAL: {
    endpoint: "/v1/corporate-registry",
    inputs: ["company", "jurisdiction"],
    outputs: { legal_name: null, registration_id: null, active: null, jurisdiction: null, registered_address: null, incorporated: null },
  },
  CROSS_CHAIN_STATE_VERIFY_GENERAL: {
    endpoint: "/v1/cross-chain-state",
    inputs: ["reference", "chains"],
    outputs: { address: null, status: null, chains: null, consistent: null, summary: null },
  },
  CRYPTO_PRICE_USD: {
    endpoint: "/v1/crypto-price",
    inputs: ["symbol"],
    outputs: { price_usd: "US dollars" },
  },
  CVE_LOOKUP_CVSS: {
    endpoint: "/v1/cve",
    inputs: ["cve_id"],
    outputs: { cve_id: null, cvss_score: "CVSS score (0-10)", description: null, published: null, references: null },
  },
  EVENT_OUTCOME_RESOLUTION_GENERAL: {
    endpoint: "/v1/event-outcome",
    inputs: ["event"],
    outputs: { event: null, resolved_yes: null, winner: null, resolved_at: null, sources: null },
  },
  FINANCIAL_DATA_GENERAL: {
    endpoint: "/v1/financial-data",
    inputs: ["asset"],
    outputs: { asset: null, market_cap_usd: "USD", volume_24h_usd: "USD", metrics: null, as_of: null },
  },
  FX_NOW_CAD: {
    endpoint: "/v1/fx-now",
    inputs: ["currency"],
    outputs: { rate: "{key} per USD" },
  },
  FX_NOW_EUR: {
    endpoint: "/v1/fx-now",
    inputs: ["currency"],
    outputs: { rate: "{key} per USD" },
  },
  FX_NOW_SEK: {
    endpoint: "/v1/fx-now",
    inputs: ["currency"],
    outputs: { rate: "{key} per USD" },
  },
  IP_GEOLOCATION_GENERAL: {
    endpoint: "/v1/ip-geolocation",
    inputs: ["ip"],
    outputs: { ip: null, country: null, city: null, latitude: "degrees", longitude: "degrees", isp: null },
  },
  LIQUIDITY_DEPTH_VERIFY_GENERAL: {
    endpoint: "/v1/liquidity",
    inputs: ["pool", "chain"],
    outputs: { liquidity_usd: "USD" },
  },
  MALWARE_DETECTION_HASH: {
    endpoint: "/v1/malware-hash",
    inputs: ["indicator"],
    outputs: { malicious: null },
  },
  MINING_HASHPRICE_VERIFY_GENERAL: {
    endpoint: "/v1/mining-hashprice",
    inputs: ["block_height"],
    outputs: { hashprice_sats_per_ph_day: "sats per PH/s per day", block_height: "block height", hashrate_eh_s: "EH/s", hashprice_usd_per_ph_day: "USD per PH/s per day" },
  },
  NEWS_HEADLINES_GENERAL: {
    endpoint: "/v1/news-headlines",
    inputs: ["topic"],
    outputs: { topic: null, headlines: null, urls: null, window: null, top_headline: null },
  },
  NEWS_SEARCH_GENERAL: {
    endpoint: "/v1/news-search",
    inputs: ["query"],
    outputs: { answer: null, result_count: null, sources: null },
  },
  PAYMENT_METHOD_VERIFY_GENERAL: {
    endpoint: "/v1/payment-method",
    inputs: ["bin"],
    outputs: { network: null, issuing_bank: null, issuing_country: null, valid: null, card_type: null },
  },
  ROUTE_ETA_GENERAL: {
    endpoint: "/v1/route-eta",
    inputs: ["origin", "destination"],
    outputs: { duration: "seconds" },
  },
  SANCTIONS_SCREENING_MATCH_GENERAL: {
    endpoint: "/v1/sanctions-screen",
    inputs: ["name"],
    outputs: { name: null, matched: null, matches: null, lists: null, match_score: "fraction (0-1)" },
  },
  SLA_COMPLIANCE_GENERAL: {
    endpoint: "/v1/sla-compliance",
    inputs: ["service", "period"],
    outputs: { service: null, uptime_pct: "percent", sla_target_pct: "percent", compliant: null, period: null },
  },
  SPORTS_SCORE_GENERAL: {
    endpoint: "/v1/sports-score",
    inputs: ["game"],
    outputs: { home_team: null, away_team: null, home_score: "points", away_score: "points", status: null, date: null },
  },
  STORM_ALERT_GENERAL: {
    endpoint: "/v1/storm-alert",
    inputs: ["location", "window_hours"],
    outputs: { location: null, risk_score: "fraction (0-1)", risk_level: null, peak_gust_kmh: "km/h", precipitation_mm: "mm", window: null },
  },
  STOCK_PRICE_US_EQUITY: {
    endpoint: "/v1/stock-price",
    inputs: ["ticker"],
    outputs: { price_usd: "US dollars" },
  },
  THREAT_INTELLIGENCE_INDICATOR: {
    endpoint: "/v1/threat-indicator",
    inputs: ["indicator"],
    outputs: { malicious: null },
  },
  TOKEN_HOLDER_COUNT_GENERAL: {
    endpoint: "/v1/token-holders",
    inputs: ["token", "chain"],
    outputs: { token: null, chain: null, holders_count: "addresses", token_symbol: null },
  },
  TRANSACTION_RISK_GENERAL: {
    endpoint: "/v1/transaction-risk",
    inputs: ["transaction"],
    outputs: { risk_score: "fraction (0-1)", signals: null, summary: null },
  },
  TRAVEL_DISRUPTION_GENERAL: {
    endpoint: "/v1/travel-disruption",
    inputs: ["route_or_flight"],
    outputs: { route_or_flight: null, disrupted: null, status: null, delay_minutes: "minutes", reason: null },
  },
  URL_SAFE_GENERAL: {
    endpoint: "/v1/url-safe",
    inputs: ["url"],
    outputs: { url: null, verdict: { unit: null, path: "url_check.verdict" }, detections: "detections", summary: null },
  },
  URL_SCAN_VERDICT: {
    endpoint: "/v1/url-scan",
    inputs: ["url"],
    outputs: { safe: null },
  },
  VENDOR_VERIFY_GENERAL: {
    endpoint: "/v1/vendor-verify",
    inputs: ["vendor", "vat_number"],
    outputs: { vendor: null, vat_number: null, valid: null, registered_name: null, registered_address: null },
  },
  VULNERABILITY_TRIAGE_GENERAL: {
    endpoint: "/v1/vulnerability-triage",
    inputs: ["cve_id"],
    outputs: { cvss_base_score: "CVSS score (0-10)" },
  },
  WEATHER_CHECK_TEMPERATURE: {
    endpoint: "/v1/weather-check",
    inputs: ["location"],
    outputs: { temperature_c: "degrees Celsius" },
  },
  WEATHER_FORECAST_GENERAL: {
    endpoint: "/v1/weather-forecast",
    inputs: ["location", "window_hours"],
    outputs: { location: null, when: null, temp_max_c: "degrees Celsius", temp_min_c: "degrees Celsius", precipitation_probability_pct: "percent", condition: null },
  },
  ONCHAIN_METRIC_VERIFY_GENERAL: {
    endpoint: "/v1/onchain-metric",
    inputs: ["address", "block", "chain", "metric"],
    outputs: { balance_gwei: "Gwei", address: null, block: null, chain: null, tx_count: null },
  },
  AIR_QUALITY_INDEX_GENERAL: { endpoint: "/v1/air-quality", inputs: ["lat", "lon"], outputs: {"aqi": null, "aqi_scale": null, "acceptable": null, "european_aqi": null, "pm2_5_ugm3": "micrograms per cubic metre", "pm10_ugm3": "micrograms per cubic metre", "nitrogen_dioxide_ugm3": "micrograms per cubic metre", "ozone_ugm3": "micrograms per cubic metre", "carbon_monoxide_ugm3": "micrograms per cubic metre", "latitude": "degrees", "longitude": "degrees", "upstream_hour": null} },
  API_HEALTH_CHECK_GENERAL: { endpoint: "/v1/api-health", inputs: ["url"], outputs: {"url": null, "healthy": null, "reachable": null, "http_status": null, "latency_ms": "milliseconds"} },
  SERVER_UPTIME_MONITOR_GENERAL: { endpoint: "/v1/server-uptime", inputs: ["host"], outputs: {"host": null, "reachable_now": null, "http_status": null, "latency_ms": "milliseconds"} },

  SECURITY_REVIEW_GENERAL: { endpoint: "/v1/security-review", inputs: ["target"], outputs: { verdict: null, vulnerability_count: "vulnerabilities", issues: null, summary: null } },
  WEATHER_FORECAST_VERIFY_GENERAL: { endpoint: "/v1/weather-history", inputs: ["location", "date"], outputs: {"location": null, "date": null, "temp_max_c": "degrees Celsius", "temp_min_c": "degrees Celsius", "precipitation_mm": "mm", "condition": null} },
 RETURN_POLICY_VERIFY_GENERAL:{endpoint:"/v1/return-policy",inputs:["retailer"],outputs:{retailer:null,return_window_days:"days",conditions:null,verified:null,sources:null}},
 GAME_RESULT_GENERAL:{endpoint:"/v1/game-result",inputs:["game"],outputs:{winner:null,home_team:null,away_team:null,home_score:"points",away_score:"points",date:null}},
 CRYPTO_YIELD_RATE_GENERAL:{endpoint:"/v1/yield",inputs:["project","symbol","chain"],outputs:{supply_apy:"basis points"}},
 VESSEL_TELEMETRY_VERIFY_GENERAL:{endpoint:"/v1/vessel-telemetry",inputs:["vessel"],outputs:{vessel:null,speed_knots:"knots",latitude:"degrees",longitude:"degrees",course_deg:"degrees",observed_at:null}},
};

describe("A8 miner.yaml vs the official intent schemas", () => {
  it("declares exactly the fifty-nine reviewed intents, each on its own endpoint", () => {
    const si = block("  supported_intents:").map((l) => l.trim().replace(/^- /, "")).filter(Boolean);
    expect(si).toEqual(Object.keys(OFFICIAL));
    for (const [intent, o] of Object.entries(OFFICIAL)) {
      const ep = block(`  - path: ${o.endpoint}`);
      expect(ep.map(line => line.trim())).toContain(`- ${intent}`);
    }
  });

  for (const [intent, o] of Object.entries(OFFICIAL)) {
    it(`${intent}: outputs are exactly the schema's response fields, units exact`, () => {
      const m = block(`  ${intent}:`);
      expect(m[0]).toBe(`    endpoint: ${o.endpoint}`);
      const outStart = m.indexOf("    output:");
      const outLines = m.slice(outStart + 1);
      expect(keysAt(outLines, 6)).toEqual(Object.keys(o.outputs));
      for (const [field, rawSpec] of Object.entries(o.outputs)) {
        // Value: the unit string, null for unitless, or {unit, path} when the
        // mapped dot path is not the bare field name (e.g. URL_SAFE verdict,
        // nested because the envelope reserves the top-level key).
        const unit = rawSpec !== null && typeof rawSpec === "object" ? rawSpec.unit : rawSpec;
        const wantPath = rawSpec !== null && typeof rawSpec === "object" ? rawSpec.path : field;
        const f = outLines.slice(outLines.indexOf(`      ${field}:`) + 1);
        const own = f.slice(0, f.findIndex((l) => /^ {6}\S/.test(l)) === -1 ? f.length : f.findIndex((l) => /^ {6}\S/.test(l)));
        expect(own).toContain(`        path: ${wantPath}`);
        const unitLine = own.find((l) => l.startsWith("        unit:"));
        if (unit === null) expect(unitLine).toBeUndefined();
        else expect(unitLine?.trim().replace(/^unit:\s*/, "").replace(/^"(.*)"$/, "$1")).toBe(unit);
      }
      const inLines = m.slice(m.indexOf("    input:") + 1, outStart);
      for (const name of o.inputs) expect(inLines).toContain(`        from: ${name}`);
    });
  }

  it("TX maps no l1_fee_eth (not an official TX field); the API body may still carry it", () => {
    expect(yaml).not.toContain("l1_fee_eth");
  });

  it("ROUTE accepted_fields contains exactly the canonical ETH/USDC pair and binding", () => {
    const lines = block("  - path: /v1/route");
    const trimmed = lines.map(line => line.trim());
    expect(trimmed).toContain("- name: pair");
    expect(trimmed[trimmed.indexOf("- name: pair") + 1]).toBe("type: string");
    const entries = acceptedFieldEntries(lines);
    expect(entries.map(entry => entry.value)).toEqual(["ETH/USDC"]);
    expect(entries[0].lines.slice(0, 3)).toEqual([
      "ETH/USDC:", "intents:", "- OPTIMAL_EXECUTION_ROUTE_GENERAL",
    ]);
    expect(entries[0].lines.join(" ")).toContain("Sell exactly 1 ETH for USDC on Ethereum mainnet; amount_out is USDC base units (6 decimals).");
  });

  it.each([
    ["/v1/macro", ["unemployment rate"], "MACRO_ECONOMIC_INDICATOR_GENERAL"],
    ["/v1/dns", ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA", "SRV", "PTR"], "DNS_RECORD_LOOKUP_GENERAL"],
  ] as const)("%s uses a value-keyed accepted_fields map with exact values and intent bindings", (endpoint, values, intent) => {
    const entries = acceptedFieldEntries(block(`  - path: ${endpoint}`));
    expect(entries.map(entry => entry.value)).toEqual(values);
    for (const entry of entries) expect(entry.lines.slice(0, 3)).toEqual([`${entry.value}:`, "intents:", `- ${intent}`]);
  });

  it.each(["/v1/route", "/v1/macro", "/v1/dns"])("%s accepted_fields control rejects the former sequence representation", endpoint => {
    const lines = block(`  - path: ${endpoint}`);
    const values = new Set(acceptedFieldEntries(lines).map(entry => `${entry.value}:`));
    const sequence = lines.map(line => values.has(line.trim())
      ? `${" ".repeat(line.length - line.trimStart().length)}- value: ${line.trim().slice(0, -1)}`
      : line);
    expect(() => acceptedFieldEntries(sequence)).toThrow();
  });

  it("VALIDATOR declares a canonical digit string and finalized-root consensus, not head state", () => {
    const lines = block("  - path: /v1/validator");
    const trimmed = lines.map(line => line.trim());
    const prose = lines.join(" ").replace(/\s+/g, " ");
    expect(trimmed[trimmed.indexOf("- name: validator_index") + 1]).toBe("type: string");
    for (const text of ["canonical decimal", "At least two configured public beacon sources must agree", "at least two validator responses must agree", "finalized", "Any returned dissent or found-versus-404 conflict fails closed"])
      expect(prose).toContain(text);
    expect(prose).not.toContain("head state");
    const m = block("  VALIDATOR_PERFORMANCE_VERIFY_GENERAL:").join("\n");
    expect(m).toContain("        from: validator_index");
    expect(m).not.toMatch(/validator_index:[\s\S]*how:/);
  });

  it("TX, ROUTE and VALIDATOR simple inputs have no how (code mapping)", () => {
    for (const intent of [
      "ONCHAIN_TX_LOOKUP_GENERAL",
      "OPTIMAL_EXECUTION_ROUTE_GENERAL",
      "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
    ]) {
      const m = block(`  ${intent}:`);
      const inLines = m.slice(m.indexOf("    input:") + 1, m.indexOf("    output:"));
      expect(inLines.join("\n"), intent).not.toMatch(/^\s+how:/m);
    }
  });

  it("FILINGS, TVL and GRID keep how where a rewrite is needed", () => {
    const filings = block("  REGULATORY_FILING_MONITOR_GENERAL:").join("\n");
    expect(filings).toContain('how: "Copy the subject of the question verbatim');
    expect(filings).toContain("      form_type:\n        from: entity");
    expect(block("  TVL_LOOKUP_GENERAL:").join("\n")).toContain("how:");
    expect(block("  GRID_POWER_PRICE_GENERAL:").join("\n")).toContain("how:");
  });

  it("GRID declares actual source and scope limits without adding unsupported markets", () => {
    expect(yaml).not.toContain("ENTSO");
    const ep = block("  - path: /v1/grid-price").join(" ").replace(/\s+/g, " ");
    for (const text of ["CAISO OASIS day-ahead hourly LMP", "NYISO real-time 5-minute zonal LBMP", "Elering is cache-only", "TH_NP15_GEN-APND", "TH_SP15_GEN-APND", "TH_ZP26_GEN-APND", "ZONE_A..ZONE_K", "EE, FI, LV, LT", "Other market/zone combinations are refused"])
      expect(ep).toContain(text);
    expect(ep).not.toMatch(/ERCOT|MISO|HB_NORTH/);
  });

  it("FILINGS entity how copies the subject verbatim incl. form type and CIK (A1 r8 wording)", () => {
    expect(yaml).toContain(
      `how: "Copy the subject of the question verbatim, including any SEC form type and CIK (e.g. 'Form 10-Q filings by Tesla, Inc. (CIK 1318605)')."`,
    );
    expect(yaml).not.toContain("without the form type");
    expect(yaml).not.toMatch(/Federal Register/);
  });

  it("errors block points at the fields errorBody() really emits", () => {
    expect(yaml).toContain("\nerrors:\n  message_path: message\n  code_path: code\n\n");
    const body = errorBody(new ApiError(422, "INVALID_PAIR", "x"));
    expect(body.message).toBe("x");
    expect(body.code).toBe("INVALID_PAIR");
  });

  it("the hash format the YAML states (64 lowercase hex, no 0x) is what makeReceipt emits", () => {
    expect(yaml).toContain("64 lowercase hex characters, no 0x prefix");
    const r = makeReceipt("TVL_LOOKUP_GENERAL", "https://example.invalid", "abc", "1/1");
    expect(r.raw_response_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("limitations use the machine-enforced codes MAX_PARAM_SIZE and MAX_PARAM_VALUE", () => {
    expect(yaml).not.toContain("MAX_PARAM_LENGTH");
    expect(yaml).toContain("  - code: MAX_PARAM_SIZE\n");
    for (const p of ["entity", "protocol"]) {
      expect(yaml).toContain(`    param: ${p}\n    property: length\n    value_num: 512\n    operator: lte\n`);
    }
    expect(yaml).toContain("  - code: MAX_PARAM_VALUE\n");
    expect(yaml).toContain("    param: validator_index\n    property: value\n    value_num: 1000000000\n    operator: lte\n");
    // `index` is not a declared input or alias.
    expect(yaml).not.toMatch(/name: index\b/);
  });

  it("docs links point at the hosts that answer 200 (verified live 2026-11-21)", () => {
    expect(block("docs:")).toEqual([
      "  website: https://verireceipt.vercel.app",
      "  documentation: https://verireceipt.vercel.app/docs",
      "  repository: https://github.com/mohamedwael201193/verireceipt",
      "",
    ]);
  });

  it("ends with exactly one trailing newline (YAML_HASH is over the raw bytes)", () => {
    expect(yaml.endsWith("\n")).toBe(true);
    expect(yaml.endsWith("\n\n")).toBe(false);
  });
});
