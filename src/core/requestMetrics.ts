// Bounded aggregate observability. Never collect URL/query/body/header/IP/user ids.
const ROUTE_INTENTS: Record<string, string> = {
  "/v1/tx": "ONCHAIN_TX_LOOKUP_GENERAL", "/v1/tvl": "TVL_LOOKUP_GENERAL",
  "/v1/grid-price": "GRID_POWER_PRICE_GENERAL", "/v1/filings": "REGULATORY_FILING_MONITOR_GENERAL",
  "/v1/route": "OPTIMAL_EXECUTION_ROUTE_GENERAL", "/v1/validator": "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
  "/v1/gas-price": "GAS_PRICE_GENERAL", "/v1/balance": "WALLET_BALANCE_CHECK_GENERAL",
  "/v1/token-supply": "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL", "/v1/macro": "MACRO_ECONOMIC_INDICATOR_GENERAL",
  "/v1/dns": "DNS_RECORD_LOOKUP_GENERAL", "/v1/ssl": "SSL_VERIFICATION_CERT",
  "/v1/cve": "CVE_LOOKUP_CVSS", "/v1/fx": "CURRENCY_EXCHANGE_CONVERT",
  "/v1/token-holders": "TOKEN_HOLDER_COUNT_GENERAL", "/v1/email-security": "EMAIL_SECURITY_GENERAL",
  "/v1/vulnerability-triage": "VULNERABILITY_TRIAGE_GENERAL",
};
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
export function recordRequestCompletion(route: string | undefined, status: number, latencyMs: number): void {
  try {
    const intent = intentFor(route), row = bucket(intent);
    const code = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "other";
    const latency = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs * 10) / 10) : 0;
    row.completed++; row.total_latency_ms += latency; row.max_latency_ms = Math.max(row.max_latency_ms, latency);
    row.statuses[code] = (row.statuses[code] ?? 0) + 1;
    if (intent !== "other") console.info(JSON.stringify({ event: "request_complete", intent, status: code, latency_ms: latency }));
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
