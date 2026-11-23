// Fixed-label observability. Never retain URL/query values, bodies, headers, IPs or user ids.
const ROUTE_INTENTS: Record<string, string> = {
  "/v1/tx": "ONCHAIN_TX_LOOKUP_GENERAL", "/v1/tvl": "TVL_LOOKUP_GENERAL",
  "/v1/grid-price": "GRID_POWER_PRICE_GENERAL", "/v1/filings": "REGULATORY_FILING_MONITOR_GENERAL",
  "/v1/route": "OPTIMAL_EXECUTION_ROUTE_GENERAL", "/v1/validator": "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
  "/v1/gas-price": "GAS_PRICE_GENERAL",
  "/v1/transaction-risk": "TRANSACTION_RISK_GENERAL",
  "/v1/financial-data": "FINANCIAL_DATA_GENERAL",
  "/v1/cross-chain-state": "CROSS_CHAIN_STATE_VERIFY_GENERAL",
  "/v1/reserve-attestation": "ASSET_RESERVE_ATTESTATION_GENERAL", "/v1/balance": "WALLET_BALANCE_CHECK_GENERAL",
  "/v1/token-supply": "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", "/v1/macro": "MACRO_ECONOMIC_INDICATOR_GENERAL",
  "/v1/dns": "DNS_RECORD_LOOKUP_GENERAL", "/v1/ssl": "SSL_VERIFICATION_CERT",
  "/v1/cve": "CVE_LOOKUP_CVSS", "/v1/fx": "CURRENCY_EXCHANGE_CONVERT",
  "/v1/token-holders": "TOKEN_HOLDER_COUNT_GENERAL", "/v1/email-security": "EMAIL_SECURITY_GENERAL",
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
  "address", "amount", "base", "block", "block_height", "chain", "country", "cve", "domain",
  "company", "entity", "event", "form_type", "from", "game", "jurisdiction", "destination", "host", "indicator", "lat", "location", "lon", "window_hours", "ip", "interval_start", "node_or_zone",
  "origin", "pair", "period", "symbol", "protocol", "query", "question", "quote", "record_type", "route_or_flight",
  "ticker", "to", "token", "topic", "url", "tx_hash", "validator_index", "year",
] as const;
// Fixed internal categories only. A regex alone could admit a secret-looking code.
const DIAGNOSTIC_ERROR_CODES = new Set([
  "ALL_QUOTERS_FAILED",
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
function intentFor(route: string | undefined): string { return route && Object.hasOwn(ROUTE_INTENTS, route) ? ROUTE_INTENTS[route] : "other"; }
function bucket(intent: string): Counts {
  let value = counts.get(intent);
  if (!value) { value = { arrived: 0, completed: 0, total_latency_ms: 0, max_latency_ms: 0, statuses: {} }; counts.set(intent, value); }
  return value;
}
export function recordRequestArrival(route?: string): void {
  try { bucket(intentFor(route)).arrived++; } catch { /* observability never changes a response */ }
}
export function recordRequestCompletion(route: string | undefined, status: number, latencyMs: number, details: { query?: unknown; errorCode?: unknown } = {}): void {
  try {
    const intent = intentFor(route), row = bucket(intent);
    const code = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "other";
    const latency = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs * 10) / 10) : 0;
    row.completed++; row.total_latency_ms += latency; row.max_latency_ms = Math.max(row.max_latency_ms, latency);
    row.statuses[code] = (row.statuses[code] ?? 0) + 1;
    if (intent !== "other") {
      const query = details.query;
      const param_keys = query !== null && typeof query === "object" ? KNOWN_QUERY_KEYS.filter(key => Object.hasOwn(query, key)) : [];
      console.info(JSON.stringify({ event: "request_complete", intent, path: route, param_keys,
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
