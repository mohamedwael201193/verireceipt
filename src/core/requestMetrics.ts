import { targetShapeOf } from '../handlers/packageSecurity';
import {sanitizeAnswerClass} from "./answerClass";
import {refusalParamClass,requestShape,REFUSAL_INTENTS} from "./refusalClass";
import { hostClassOf } from "./hostClass";
// Fixed-label observability. Only route-owned closed enums may expose canonical values.
// Never retain free text, URL/query strings, bodies, headers, IPs or user ids.
import { EDGAR_FORM_TYPES } from "../handlers/edgarFormTypes";
const ROUTE_INTENTS: Record<string, string> = {
  "/v1/weather-history":"WEATHER_FORECAST_VERIFY_GENERAL",
  "/v1/return-policy":"RETURN_POLICY_VERIFY_GENERAL",
  "/v1/security-review": "SECURITY_REVIEW_GENERAL",
  "/v1/onchain-metric": "ONCHAIN_METRIC_VERIFY_GENERAL",
  "/v1/tx": "ONCHAIN_TX_LOOKUP_GENERAL", "/v1/tvl": "TVL_LOOKUP_GENERAL",
  "/v1/grid-price": "GRID_POWER_PRICE_GENERAL", "/v1/filings": "REGULATORY_FILING_MONITOR_GENERAL",
  "/v1/route": "OPTIMAL_EXECUTION_ROUTE_GENERAL", "/v1/validator": "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
  "/v1/gas-price": "GAS_PRICE_GENERAL",
  "/v1/transaction-risk": "TRANSACTION_RISK_GENERAL",
  "/v1/financial-data": "FINANCIAL_DATA_GENERAL",
  "/v1/cross-chain-state": "CROSS_CHAIN_STATE_VERIFY_GENERAL",
  "/v1/reserve-attestation": "ASSET_RESERVE_ATTESTATION_GENERAL", "/v1/threat-indicator": "THREAT_INTELLIGENCE_INDICATOR", "/v1/url-scan": "URL_SCAN_VERDICT", "/v1/weather-forecast": "WEATHER_FORECAST_GENERAL", "/v1/vendor-verify": "VENDOR_VERIFY_GENERAL", "/v1/payment-method": "PAYMENT_METHOD_VERIFY_GENERAL", "/v1/url-safe": "URL_SAFE_GENERAL", "/v1/malware-hash": "MALWARE_DETECTION_HASH", "/v1/sla-compliance": "SLA_COMPLIANCE_GENERAL", "/v1/sports-score": "SPORTS_SCORE_GENERAL", "/v1/balance": "WALLET_BALANCE_CHECK_GENERAL",
  "/v1/token-supply": "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", "/v1/macro": "MACRO_ECONOMIC_INDICATOR_GENERAL",
  "/v1/dns": "DNS_RECORD_LOOKUP_GENERAL", "/v1/ssl": "SSL_VERIFICATION_CERT",
  "/v1/cve": "CVE_LOOKUP_CVSS", "/v1/fx": "CURRENCY_EXCHANGE_CONVERT", "/v1/fx-now": "FX_NOW_EUR/CAD/SEK",
  "/v1/wash-trading": "WASH_TRADING_DETECTION_GENERAL", "/v1/token-holders": "TOKEN_HOLDER_COUNT_GENERAL", "/v1/email-security": "EMAIL_SECURITY_GENERAL",
  "/v1/vulnerability-triage": "VULNERABILITY_TRIAGE_GENERAL",
  "/v1/academic-search": "ACADEMIC_SEARCH_GENERAL",
  "/v1/code-patch": "CODE_PATCH_VERIFY_GENERAL",
  "/v1/stock-price": "STOCK_PRICE_US_EQUITY",
  "/v1/sanctions-screen": "SANCTIONS_SCREENING_MATCH_GENERAL",
  "/v1/ip-geolocation": "IP_GEOLOCATION_GENERAL",
  "/v1/game-result": "GAME_RESULT_GENERAL",
  "/v1/corporate-registry": "CORPORATE_REGISTRY_LOOKUP_GENERAL",
  "/v1/air-quality": "AIR_QUALITY_INDEX_GENERAL",
  "/v1/storm-alert": "STORM_ALERT_GENERAL",
  "/v1/news-headlines": "NEWS_HEADLINES_GENERAL",
  "/v1/news-search": "NEWS_SEARCH_GENERAL",
  "/v1/route-eta": "ROUTE_ETA_GENERAL",
  "/v1/api-health": "API_HEALTH_CHECK_GENERAL",
  "/v1/server-uptime": "SERVER_UPTIME_MONITOR_GENERAL",
  "/v1/mining-hashprice": "MINING_HASHPRICE_VERIFY_GENERAL",
  "/v1/crypto-price": "CRYPTO_PRICE_USD",
  "/v1/crypto-transfer": "CRYPTO_TRANSFER_VERIFY_GENERAL",
  "/v1/weather-check": "WEATHER_CHECK_TEMPERATURE",
  "/v1/event-outcome": "EVENT_OUTCOME_RESOLUTION_GENERAL",
  "/v1/travel-disruption": "TRAVEL_DISRUPTION_GENERAL",
};
// Only known parameter NAMES are emitted, including rejected aliases. Never values
// or unknown names: callers can put a credential into an arbitrary query key.
const KNOWN_QUERY_KEYS = [
  "vendor", "vat_number", "date", "retailer", "address", "asset", "amount", "base", "bin", "block", "block_height", "chain", "chains", "country", "cve", "domain",
  "company", "entity", "event", "form_type", "form", "cik", "patch", "from", "game", "jurisdiction", "destination", "host", "indicator", "lat", "location", "lon", "window_hours", "ip", "interval_start", "node_or_zone",
  "service", "metric", "origin", "pair", "period", "symbol", "protocol", "query", "question", "quote", "record_type", "reference", "route_or_flight",
  "target", "ticker", "to", "token", "topic", "url", "transaction", "tx_hash", "validator_index", "year",
] as const;
// Fixed internal categories only. A regex alone could admit a secret-looking code.
const DIAGNOSTIC_ERROR_CODES = new Set([
  "RATE_LIMITED", "PORT_NOT_CHECKED", "PRIVATE_HOST", "BAD_URL", "BAD_SCHEME", "PROBE_BUDGET",
  "AMBIGUOUS_VAT", "INVALID_VENDOR", "INVALID_VAT", "VIES_SCOPE", "VIES_UNREACHABLE", "VIES_MALFORMED", "VIES_ERROR",
  "INVALID_LOCATION", "INVALID_DATE", "APPROVED_SOURCES_UNAVAILABLE",
  "ALL_QUOTERS_FAILED",
  "AMBIGUOUS_COMPANY", "COMPANY_TOO_LONG", "EDGAR_BAD_BODY", "GLEIF_UNAVAILABLE", "INVALID_JURISDICTION", "SEC_UNAVAILABLE",
  "PROTOCOL_NOT_FOUND", "CHAIN_TVL_NONE",
  "EVENT_NOT_FOUND", "AMBIGUOUS_EVENT", "NON_BINARY_MARKET", "EVENT_NOT_RESOLVED",
  "UNCLEAN_RESOLUTION", "POLYMARKET_UNREACHABLE", "EVENT_TOO_LONG",
  "UNKNOWN_FORM", "MULTIPLE_FORM_TYPES", "CONFLICTING_FORM_TYPE", "CONFUSABLE_FORM_TYPE",
  "ENTITY_NOT_FOUND", "AMBIGUOUS_ENTITY", "ENTITY_CIK_MISMATCH", "INVALID_CIK",
  "INVALID_PERIOD", "FISCAL_PERIOD_UNSUPPORTED", "MISSING_ENTITY", "MISSING_PERIOD", "INVALID_FORM_TYPE",
  "CHAIN_MISMATCH",
  "CIRCUIT_OPEN",
  "COUNTRY_NOT_FOUND",
  "CVE_ASSESSMENTS_DISAGREE",
  "CVE_SOURCES_DOWN",
  "DNS_RESOLVERS_DISAGREE",
  "DNS_RESOLVERS_DOWN",
  "DUPLICATE_PARAM",
  "EMAIL_DNS_SOURCES_DOWN",
  "EMAIL_DNS_STATUS_DISAGREEMENT",
  "ENS_CONFLICT",
  "ENS_UNREACHABLE",
  "EVIDENCE_CORRUPT",
  "FUTURE_INTERVAL",
  "FX_SOURCES_DISAGREE",
  "FX_SOURCES_DOWN",
  "GRID_CACHE_INVALID",
  "GRID_CACHE_MISS",
  "GRID_CACHE_STALE",
  "INDEXER_UNREACHABLE",
  "INTERNAL",
  "INVALID_ADDRESS",
  "INVALID_AMOUNT",
  "INVALID_CURRENCY",
  "INVALID_CVE",
  "INVALID_DOMAIN",
  "INVALID_HOST",
  "INVALID_INTERVAL",
  "INVALID_JSON",
  "INVALID_NAME",
  "INVALID_NODE",
  "INVALID_PAGE_INDEX",
  "INVALID_PAIR",
  "INVALID_RECEIPT_ID",
  "INVALID_RECORD_TYPE",
  "INVALID_TX_HASH",
  "ECOSYSTEM_NOT_COVERED",
  "INVALID_TARGET",
  "NO_ADVISORY_COVERAGE",
  "OSV_UNAVAILABLE",
  "INVALID_VALIDATOR_INDEX",
  "INVALID_YEAR",
  "MAX_PARAM_VALUE",
  "MISSING_PARAM",
  "NO_CVSS_V3",
  "NO_DATA",
  "OFF_BOUNDARY_INTERVAL",
  "PRIVATE_HOST",
  "QUORUM_CONFLICT",
  "QUORUM_DISAGREEMENT",
  "QUORUM_UNREACHABLE",
  "RECEIPT_CORRUPT",
  "RECEIPT_PERSIST_FAILED",
  "ROUTE_DEADLINE",
  "RPC_CONFIG",
  "STALE_BLOCK_PIN",
  "TLS_DNS_UNAVAILABLE",
  "TLS_PROBE_UNAVAILABLE",
  "TLS_UNVERIFIABLE",
  "TOKEN_CONTRACT_MISMATCH",
  "TOKEN_SYMBOL_MISMATCH",
  "STALE_ATTESTATION",
  "UNKNOWN_PARAM",
  "UNSUPPORTED_CHAIN",
  "UNSUPPORTED_DNS_QUERY",
  "UNSUPPORTED_INDICATOR",
  "UNSUPPORTED_TOKEN",
  "UNSUPPORTED_ZONE",
  "VALIDATOR_NOT_FOUND",
  "WORLD_BANK_UNAVAILABLE",
]);
export function diagnosticErrorCode(value: unknown): string {
  return typeof value === "string" && DIAGNOSTIC_ERROR_CODES.has(value) ? value : "OTHER_ERROR";
}
interface Counts { arrived: number; completed: number; total_latency_ms: number; max_latency_ms: number; statuses: Record<string, number> }
const counts = new Map<string, Counts>();
export function intentFor(route: string | undefined): string { return route && Object.hasOwn(ROUTE_INTENTS, route) ? ROUTE_INTENTS[route] : "other"; }
function bucket(intent: string): Counts {
  let value = counts.get(intent);
  if (!value) { value = { arrived: 0, completed: 0, total_latency_ms: 0, max_latency_ms: 0, statuses: {} }; counts.set(intent, value); }
  return value;
}
const CHAIN_ROUTES = new Set(["/v1/tx", "/v1/gas-price", "/v1/transaction-risk", "/v1/balance", "/v1/token-supply", "/v1/token-holders", "/v1/onchain-metric"]);
const CHAINS = new Set(["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc", "avalanche", "gnosis", "sepolia", "base-sepolia"]);
const FORMS = new Set(EDGAR_FORM_TYPES);
/** Own data properties only: diagnostics never execute request getters. */
function ownString(query: unknown, key: string): string | undefined {
  if (!query || typeof query !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(query, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}
export function safeRequestEnums(route: string, query: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const pick = (key: string, allowed: Set<string>, upper = false) => {
    const raw = ownString(query, key); if (raw === undefined) return;
    const value = upper ? raw.trim().toUpperCase() : raw.trim().toLowerCase();
    out[key] = allowed.has(value) ? value : "other";
  };
  if (CHAIN_ROUTES.has(route)) pick("chain", CHAINS);
  if (route === "/v1/dns") pick("record_type", new Set(["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA", "CAA", "PTR"]), true);
  if (route === "/v1/fx" || route === "/v1/fx-now") {
    for (const key of ["base", "quote"]) pick(key, new Set(["USD", "EUR", "CAD", "SEK", "GBP", "JPY", "CHF", "AUD", "NZD", "CNY"]), true);
  }
  if (route === "/v1/filings") {
    for (const key of ["form_type", "form"]) pick(key, FORMS, true);
    const period = ownString(query, "period");
    if (period !== undefined) {
      const value = period.trim().toLowerCase();
      out.period_kind = /^\d{4}$/.test(value) ? "year" : /^(?:last|past|trailing)?[ _-]*\d+[ _-]*(?:months?|years?)$/.test(value) ? "relative_months"
        : /^(?:year[ _-]*to[ _-]*date|y[ _-]*t[ _-]*d)$/.test(value) ? "ytd" : /quarter|^q[1-4] /.test(value) ? "quarter_like"
        : /^\d{4}-\d{2}-\d{2}(?:\.\.| to )\d{4}-\d{2}-\d{2}$/.test(value) ? "date_range" : "other";
    }
  }
  return out;
}
export function recordRequestArrival(route?: string, query?: unknown): void {
  try {
    const intent = intentFor(route); bucket(intent).arrived++;
    if (intent !== "other") console.info(JSON.stringify({ event: "request_start", intent, path: route,
      param_keys: query && typeof query === "object" ? KNOWN_QUERY_KEYS.filter(key => Object.hasOwn(query, key)) : [],
      ...(route === "/v1/security-review" ? { target_shape: targetShapeOf(ownString(query, "target")) } : {}),
      ...(route === "/v1/server-uptime" ? { host_class: hostClassOf(ownString(query, "host")) } : {}),
      input_enums: safeRequestEnums(route!, query) }));
  } catch { /* observability never changes a response */ }
}

export function recordRequestCompletion(route: string | undefined, status: number, latencyMs: number, details: { query?: unknown; errorCode?: unknown; receiptId?:unknown; answerClass?:unknown; rawErrorCode?:unknown; errorLabel?:unknown; disclosedNull?:unknown; nullStatus?:unknown } = {}): void {
  try {
    const intent = intentFor(route), row = bucket(intent);
    const code = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "other";
    const latency = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs * 10) / 10) : 0;
    row.completed++; row.total_latency_ms += latency; row.max_latency_ms = Math.max(row.max_latency_ms, latency);
    row.statuses[code] = (row.statuses[code] ?? 0) + 1;
    // Emitted just before request_complete so the completion line stays the last line of a request.
    const nullAnswer=status===200&&route==='/v1/liquidity'&&details.disclosedNull===true;
    if((status>=400||nullAnswer)&&route!==undefined&&Object.hasOwn(REFUSAL_INTENTS,route)){
      const errorCode=nullAnswer?'DISCLOSED_NULL':typeof details.rawErrorCode==='string'?details.rawErrorCode:typeof details.errorCode==='string'?details.errorCode:'';
      const cls=refusalParamClass(route,errorCode,details.query,typeof details.errorLabel==='string'?details.errorLabel:undefined);
      if(cls)console.info(JSON.stringify({event:'refusal_param_class',intent:REFUSAL_INTENTS[route],error_code:/^[A-Z][A-Z0-9_]{2,47}$/.test(errorCode)?errorCode:'OTHER_ERROR',status:code,...cls,...(nullAnswer?{data_status:details.nullStatus==='no_data'||details.nullStatus==='source_unavailable'?details.nullStatus:'other'}:{})}));
    }
    if (intent !== "other") {
      const query = details.query;
      const param_keys = query !== null && typeof query === "object" ? KNOWN_QUERY_KEYS.filter(key => Object.hasOwn(query, key)) : [];
      const transaction = route === "/v1/transaction-risk" && status === 400 && details.errorCode === "INVALID_TX_HASH"
        && query !== null && typeof query === "object" ? (query as Record<string, unknown>).transaction : undefined;
      const input = typeof transaction === "string" ? transaction.trim() : undefined;
      const prefix = input?.startsWith("0x") ? "0x" : input?.startsWith("0X") ? "0X" : "none";
      const tail = input === undefined ? "" : prefix === "none" ? input : input.slice(2);
      const input_shape = input === undefined ? undefined : {
        length: input.length, prefix,
        charset: /^[0-9a-f]+$/i.test(tail) ? (/[a-f]/.test(tail) && /[A-F]/.test(tail) ? "hex_mixed_case" : "hex") : "other",
        hex_digits: (tail.match(/[0-9a-f]/gi) ?? []).length,
        has_whitespace_inside: /\s/.test(input),
      };
      const receiptId=status===200&&typeof details.receiptId==='string'&&/^rcpt_[A-Z0-9]{26}$/.test(details.receiptId)?details.receiptId:undefined;
      const refused=status>=400 ? intent==='EVENT_OUTCOME_RESOLUTION_GENERAL'?{outcome:'refused',source:'none'}:intent==='ONCHAIN_METRIC_VERIFY_GENERAL'?{metric_kind:ownString(details.query,'metric')??'balance',leg:'none',result:'refused',refusal_reason:status===400?'invalid_input':'other'}:undefined:undefined;
      // Fixed input shape only. Never log the prefix itself, its length or unknown keys.
      const paymentBin=intent==='PAYMENT_METHOD_VERIFY_GENERAL'?ownString(details.query,'bin'):undefined;
      const paymentClass=intent==='PAYMENT_METHOD_VERIFY_GENERAL'?{input_class:paymentBin===undefined||paymentBin.trim()===''?'missing':/^\d{6,8}$/.test(paymentBin.trim())?'prefix':/^\d{12,256}$/.test(paymentBin.trim())?'checksum':'invalid'}:undefined;
      // Error-code constants only; no resolver messages or DNS input values inspected.
      const dnsReasons:Record<string,string>={DNS_RESOLVERS_DISAGREE:'resolver_disagreement',DNS_RESOLVERS_DOWN:'inconclusive',INVALID_RECORD_TYPE:'bad_type',MISSING_PARAM:'missing_param',INVALID_NAME:'invalid_name',RECEIPT_PERSIST_FAILED:'persistence_failed',INTERNAL:'internal'};
      const dnsClass=intent==='DNS_RECORD_LOOKUP_GENERAL'&&status>=400?{dns_refusal_reason:typeof details.errorCode==='string'&&Object.hasOwn(dnsReasons,details.errorCode)?dnsReasons[details.errorCode]:'other'}:undefined;
      const answerClass=sanitizeAnswerClass(intent,details.answerClass??dnsClass??paymentClass??refused);
      console.info(JSON.stringify({ event: "request_complete", intent, path: route, param_keys, request_shape: requestShape(query),
        ...(route === "/v1/security-review" ? { target_shape: targetShapeOf(ownString(details.query, "target")) } : {}),
        ...(route === "/v1/server-uptime" ? { host_class: hostClassOf(ownString(details.query, "host")) } : {}),
        ...(input_shape ? { input_shape } : {}), ...(receiptId?{receipt_id:receiptId}:{}), ...(answerClass?{answer_class:answerClass}:{}),
        error_code: details.errorCode == null ? null : diagnosticErrorCode(details.errorCode), status: code, latency_ms: latency }));
    }
  } catch { /* never log an exception or request content */ }
}
export function requestMetricsSnapshot(): Record<string, unknown> {
  return Object.fromEntries([...counts].map(([intent, row]) => [intent, {
    arrived: row.arrived, completed: row.completed, in_flight: Math.max(0, row.arrived - row.completed),
    statuses: { ...row.statuses }, max_latency_ms: row.max_latency_ms,
    mean_latency_ms: row.completed ? Math.round(row.total_latency_ms / row.completed * 10) / 10 : 0,
  }]));
}
export function resetRequestMetricsForTests(): void { counts.clear(); }
