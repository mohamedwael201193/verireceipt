// Node-shaped results vs. the miner's raw answer (fields-fix).
//
// Official docs (telegraph-docs c652c68, miners/yaml-config.md "Answers" and
// using/engine-ask.md "The answer's shape"): with an intent_mapping each
// output field is located by its `path`; numbers are computed in code; every
// other field comes from ONE node-side parser model call, and a field whose
// call "did not answer in time or is down" is reported `unavailable`.
// The miner cannot route a non-numeric field around that model call, so a
// consumer that needs the value reads it from the raw answer the node stored
// and hashed (signal_hash). This module does that, and only that:
//   - `ok` fields keep the node's value (source "node");
//   - an `unavailable` NON-numeric field is read at its mapped path from the
//     raw answer, and only when the caller has checked the raw answer against
//     the signal_hash (source "raw");
//   - `missing` / `rejected` are real verdicts and are never overridden;
//   - numeric fields (mapped with a `unit`) are never filled from raw: the
//     node converts them in code, so a raw number is not the canonical value.

export type FieldStatus = "ok" | "missing" | "rejected" | "unavailable";

export interface OutputMapping {
  path: string;
  /** Present on numeric fields: the node converts them in code. */
  unit?: string;
}

/** Mirror of miner.yaml `intent_mapping.<INTENT>.output` (pinned by
 *  tests/shaped-fields.test.ts against the file itself). */
export const OUTPUT_MAPPING: Record<string, Record<string, OutputMapping>> = {
  CRYPTO_YIELD_RATE_GENERAL:{supply_apy:{path:"supply_apy",unit:"basis points"}},
  GAME_RESULT_GENERAL:{winner:{path:"winner"},home_team:{path:"home_team"},away_team:{path:"away_team"},home_score:{path:"home_score",unit:"points"},away_score:{path:"away_score",unit:"points"},date:{path:"date"}},
  RETURN_POLICY_VERIFY_GENERAL:{retailer:{path:"retailer"},return_window_days:{path:"return_window_days",unit:"days"},conditions:{path:"conditions"},verified:{path:"verified"},sources:{path:"sources"}},
  ONCHAIN_TX_LOOKUP_GENERAL: {
    tx_hash: { path: "tx_hash" },
    status: { path: "status" },
    from: { path: "from" },
    to: { path: "to" },
    block_number: { path: "block_number", unit: "block height" },
    value_eth: { path: "value_eth", unit: "whole native units" },
  },
  REGULATORY_FILING_MONITOR_GENERAL: {
    entity: { path: "entity" },
    filing_count: { path: "filing_count", unit: "filings" },
    filings: { path: "filings" },
    urls: { path: "urls" },
  },
  TVL_LOOKUP_GENERAL: {
    protocol_or_chain: { path: "protocol_or_chain" },
    tvl_usd: { path: "tvl_usd", unit: "USD" },
    chain_tvl_usd: { path: "chain_tvl_usd", unit: "USD" },
    as_of: { path: "as_of" },
  },
  OPTIMAL_EXECUTION_ROUTE_GENERAL: {
    amount_out: { path: "amount_out", unit: "USDC base units (6 decimals)" },
  },
  GRID_POWER_PRICE_GENERAL: {
    lmp_usd_per_mwh: { path: "lmp_usd_per_mwh", unit: "USD per MWh" },
    node_or_zone: { path: "node_or_zone" },
    market: { path: "market" },
    interval_start: { path: "interval_start" },
    currency: { path: "currency" },
  },
  VALIDATOR_PERFORMANCE_VERIFY_GENERAL: {
    effective_balance: { path: "effective_balance", unit: "gwei" },
  },
  GAS_PRICE_GENERAL: {
    chain: { path: "chain" },
    gas_price_gwei: { path: "gas_price_gwei", unit: "gwei" },
    transfer_fee_usd: { path: "transfer_fee_usd", unit: "USD" },
    as_of: { path: "as_of" },
  },
  WALLET_BALANCE_CHECK_GENERAL: {
    address: { path: "address" },
    chain: { path: "chain" },
    balance: { path: "balance", unit: "whole token units" },
    token_symbol: { path: "token_symbol" },
    as_of: { path: "as_of" },
  },
  TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL: {
    total_supply: { path: "total_supply", unit: "whole tokens" },
  },
  MACRO_ECONOMIC_INDICATOR_GENERAL: {
    rate_pct: { path: "rate_pct", unit: "percent" },
  },
  DNS_RECORD_LOOKUP_GENERAL: {
    has_record: { path: "has_record" },
  },
  CURRENCY_EXCHANGE_CONVERT: {
    converted_amount: { path: "converted_amount" },
  },
  SSL_VERIFICATION_CERT: {
    certificate_valid: { path: "certificate_valid" },
  },
  EMAIL_SECURITY_GENERAL: {
    lookup_ok: { path: "lookup_ok" },
  },
  ACADEMIC_SEARCH_GENERAL: {
    answer: { path: "answer" },
    paper_titles: { path: "paper_titles" },
    dois: { path: "dois" },
    total_matches: { path: "total_matches" },
  },
  ASSET_RESERVE_ATTESTATION_GENERAL: {
    attested_reserve: { path: "attested_reserve", unit: "micro-units of the underlying asset" },
    asset: { path: "asset" },
    block: { path: "block" },
    source: { path: "source" },
  },
  CODE_PATCH_VERIFY_GENERAL: {
    passed: { path: "passed" },
    commit: { path: "commit" },
    pipeline: { path: "pipeline" },
  },
  CORPORATE_REGISTRY_LOOKUP_GENERAL: {
    legal_name: { path: "legal_name" },
    registration_id: { path: "registration_id" },
    active: { path: "active" },
    jurisdiction: { path: "jurisdiction" },
    registered_address: { path: "registered_address" },
    incorporated: { path: "incorporated" },
  },
  CROSS_CHAIN_STATE_VERIFY_GENERAL: {
    address: { path: "address" },
    status: { path: "status" },
    chains: { path: "chains" },
    consistent: { path: "consistent" },
    summary: { path: "summary" },
  },
  CVE_LOOKUP_CVSS: {
    cve_id: { path: "cve_id" },
    cvss_score: { path: "cvss_score", unit: "CVSS score (0-10)" },
    description: { path: "description" },
    published: { path: "published" },
    references: { path: "references" },
  },
  EVENT_OUTCOME_RESOLUTION_GENERAL: {
    event: { path: "event" },
    resolved_yes: { path: "resolved_yes" },
    winner: { path: "winner" },
    resolved_at: { path: "resolved_at" },
    sources: { path: "sources" },
  },
  FINANCIAL_DATA_GENERAL: {
    asset: { path: "asset" },
    market_cap_usd: { path: "market_cap_usd", unit: "USD" },
    volume_24h_usd: { path: "volume_24h_usd", unit: "USD" },
    metrics: { path: "metrics" },
    as_of: { path: "as_of" },
  },
  FX_NOW_CAD: {
    rate: { path: "rate", unit: "{key} per USD" },
  },
  FX_NOW_EUR: {
    rate: { path: "rate", unit: "{key} per USD" },
  },
  FX_NOW_SEK: {
    rate: { path: "rate", unit: "{key} per USD" },
  },
  IP_GEOLOCATION_GENERAL: {
    ip: { path: "ip" },
    country: { path: "country" },
    city: { path: "city" },
    latitude: { path: "latitude", unit: "degrees" },
    longitude: { path: "longitude", unit: "degrees" },
    isp: { path: "isp" },
  },
  LIQUIDITY_DEPTH_VERIFY_GENERAL: {
    liquidity_usd: { path: "liquidity_usd", unit: "USD" },
  },
  MALWARE_DETECTION_HASH: {
    malicious: { path: "malicious" },
  },
  NEWS_HEADLINES_GENERAL: {
    topic: { path: "topic" },
    headlines: { path: "headlines" },
    urls: { path: "urls" },
    window: { path: "window" },
    top_headline: { path: "top_headline" },
  },
  NEWS_SEARCH_GENERAL: {
    answer: { path: "answer" },
    result_count: { path: "result_count" },
    sources: { path: "sources" },
  },
  PAYMENT_METHOD_VERIFY_GENERAL: {
    network: { path: "network" },
    issuing_bank: { path: "issuing_bank" },
    issuing_country: { path: "issuing_country" },
    valid: { path: "valid" },
    card_type: { path: "card_type" },
  },
  ROUTE_ETA_GENERAL: {
    duration: { path: "duration", unit: "seconds" },
  },
  SANCTIONS_SCREENING_MATCH_GENERAL: {
    name: { path: "name" },
    matched: { path: "matched" },
    matches: { path: "matches" },
    lists: { path: "lists" },
    match_score: { path: "match_score", unit: "fraction (0-1)" },
  },
  SLA_COMPLIANCE_GENERAL: {
    service: { path: "service" },
    uptime_pct: { path: "uptime_pct", unit: "percent" },
    sla_target_pct: { path: "sla_target_pct", unit: "percent" },
    compliant: { path: "compliant" },
    period: { path: "period" },
  },
  SPORTS_SCORE_GENERAL: {
    home_team: { path: "home_team" },
    away_team: { path: "away_team" },
    home_score: { path: "home_score", unit: "points" },
    away_score: { path: "away_score", unit: "points" },
    status: { path: "status" },
    date: { path: "date" },
  },
  STOCK_PRICE_US_EQUITY: {
    price_usd: { path: "price_usd", unit: "US dollars" },
  },
  THREAT_INTELLIGENCE_INDICATOR: {
    malicious: { path: "malicious" },
  },
  TOKEN_HOLDER_COUNT_GENERAL: {
    token: { path: "token" },
    chain: { path: "chain" },
    holders_count: { path: "holders_count", unit: "addresses" },
    token_symbol: { path: "token_symbol" },
  },
  TRANSACTION_RISK_GENERAL: {
    risk_score: { path: "risk_score", unit: "fraction (0-1)" },
    signals: { path: "signals" },
    summary: { path: "summary" },
  },
  TRAVEL_DISRUPTION_GENERAL: {
    route_or_flight: { path: "route_or_flight" },
    disrupted: { path: "disrupted" },
    status: { path: "status" },
    delay_minutes: { path: "delay_minutes", unit: "minutes" },
    reason: { path: "reason" },
  },
  URL_SAFE_GENERAL: {
    url: { path: "url" },
    verdict: { path: "url_check.verdict" },
    detections: { path: "detections", unit: "detections" },
    summary: { path: "summary" },
  },
  URL_SCAN_VERDICT: {
    safe: { path: "safe" },
  },
  VENDOR_VERIFY_GENERAL: {
    vendor: { path: "vendor" },
    vat_number: { path: "vat_number" },
    valid: { path: "valid" },
    registered_name: { path: "registered_name" },
    registered_address: { path: "registered_address" },
  },
  VULNERABILITY_TRIAGE_GENERAL: {
    cvss_base_score: { path: "cvss_base_score", unit: "CVSS score (0-10)" },
  },
  WEATHER_FORECAST_GENERAL: {
    location: { path: "location" },
    when: { path: "when" },
    temp_max_c: { path: "temp_max_c", unit: "degrees Celsius" },
    temp_min_c: { path: "temp_min_c", unit: "degrees Celsius" },
    precipitation_probability_pct: { path: "precipitation_probability_pct", unit: "percent" },
    condition: { path: "condition" },
  },
  CRYPTO_PRICE_USD: {
    price_usd: { path: "price_usd", unit: "US dollars" },
  },
  MINING_HASHPRICE_VERIFY_GENERAL: {
    hashprice_sats_per_ph_day: { path: "hashprice_sats_per_ph_day", unit: "sats per PH/s per day" },
    block_height: { path: "block_height", unit: "block height" },
    hashrate_eh_s: { path: "hashrate_eh_s", unit: "EH/s" },
    hashprice_usd_per_ph_day: { path: "hashprice_usd_per_ph_day", unit: "USD per PH/s per day" },
  },
  STORM_ALERT_GENERAL: {
    location: { path: "location" },
    risk_score: { path: "risk_score", unit: "fraction (0-1)" },
    risk_level: { path: "risk_level" },
    peak_gust_kmh: { path: "peak_gust_kmh", unit: "km/h" },
    precipitation_mm: { path: "precipitation_mm", unit: "mm" },
    window: { path: "window" },
  },
  WEATHER_CHECK_TEMPERATURE: {
    temperature_c: { path: "temperature_c", unit: "degrees Celsius" },
  },
  ONCHAIN_METRIC_VERIFY_GENERAL: {
    balance_gwei: {"path":"balance_gwei","unit":"Gwei"},
    address: {"path":"address"},
    block: {"path":"block"},
    chain: {"path":"chain"},
    tx_count: {"path":"tx_count"},
  },
  AIR_QUALITY_INDEX_GENERAL: {
    aqi: {"path":"aqi"},
    aqi_scale: {"path":"aqi_scale"},
    acceptable: {"path":"acceptable"},
    european_aqi: {"path":"european_aqi"},
    pm2_5_ugm3: {"path":"pm2_5_ugm3","unit":"micrograms per cubic metre"},
    pm10_ugm3: {"path":"pm10_ugm3","unit":"micrograms per cubic metre"},
    nitrogen_dioxide_ugm3: {"path":"nitrogen_dioxide_ugm3","unit":"micrograms per cubic metre"},
    ozone_ugm3: {"path":"ozone_ugm3","unit":"micrograms per cubic metre"},
    carbon_monoxide_ugm3: {"path":"carbon_monoxide_ugm3","unit":"micrograms per cubic metre"},
    latitude: {"path":"latitude","unit":"degrees"},
    longitude: {"path":"longitude","unit":"degrees"},
    upstream_hour: {"path":"upstream_hour"},
  },
  API_HEALTH_CHECK_GENERAL: {
    url: {"path":"url"},
    healthy: {"path":"healthy"},
    reachable: {"path":"reachable"},
    http_status: {"path":"http_status"},
    latency_ms: {"path":"latency_ms","unit":"milliseconds"},
  },
  SERVER_UPTIME_MONITOR_GENERAL: {
    host: {"path":"host"},
    reachable_now: {"path":"reachable_now"},
    http_status: {"path":"http_status"},
    latency_ms: {"path":"latency_ms","unit":"milliseconds"},
  },
  SECURITY_REVIEW_GENERAL: {
    verdict: {"path":"verdict"},
    vulnerability_count: {"path":"vulnerability_count","unit":"vulnerabilities"},
    issues: {"path":"issues"},
    summary: {"path":"summary"},
  },

  WEATHER_FORECAST_VERIFY_GENERAL: {
    location: {"path": "location"},
    date: {"path": "date"},
    temp_max_c: {"path": "temp_max_c", "unit": "degrees Celsius"},
    temp_min_c: {"path": "temp_min_c", "unit": "degrees Celsius"},
    precipitation_mm: {"path": "precipitation_mm", "unit": "mm"},
    condition: {"path": "condition"},
  },

};

/** Official intent response field types (GET /engine/v1/intents/{intent} → response.fields), pinned here so the fill does not depend on a live fetch. `number` fields are never filled from raw, even if a future mapping omits `unit`. */
export type FieldFormatType = "number" | "string" | "datetime" | "date" | "list" | "enum" | "bool";

export interface FieldFormat {
  type: FieldFormatType;
  allowed?: readonly string[];
}

export const FIELD_FORMAT: Record<string, Record<string, FieldFormat>> = {
  CRYPTO_YIELD_RATE_GENERAL:{supply_apy:{type:"number"}},
  GAME_RESULT_GENERAL:{winner:{type:"string"},home_team:{type:"string"},away_team:{type:"string"},home_score:{type:"number"},away_score:{type:"number"},date:{type:"string"}},
  RETURN_POLICY_VERIFY_GENERAL:{retailer:{type:"string"},return_window_days:{type:"number"},conditions:{type:"list"},verified:{type:"bool"},sources:{type:"list"}},
  ONCHAIN_TX_LOOKUP_GENERAL: {
    tx_hash: { type: "string" },
    status: { type: "enum", allowed: ["confirmed", "reverted", "pending", "not_found"] },
    from: { type: "string" },
    to: { type: "string" },
    block_number: { type: "number" },
    value_eth: { type: "number" },
  },
  REGULATORY_FILING_MONITOR_GENERAL: {
    entity: { type: "string" },
    filing_count: { type: "number" },
    filings: { type: "list" },
    urls: { type: "list" },
  },
  TVL_LOOKUP_GENERAL: {
    protocol_or_chain: { type: "string" },
    tvl_usd: { type: "number" },
    chain_tvl_usd: { type: "number" },
    as_of: { type: "string" },
  },
  OPTIMAL_EXECUTION_ROUTE_GENERAL: {
    amount_out: { type: "number" },
  },
  GRID_POWER_PRICE_GENERAL: {
    lmp_usd_per_mwh: { type: "number" },
    node_or_zone: { type: "string" },
    market: { type: "string" },
    interval_start: { type: "datetime" },
    currency: { type: "string" },
  },
  VALIDATOR_PERFORMANCE_VERIFY_GENERAL: {
    effective_balance: { type: "number" },
  },
  GAS_PRICE_GENERAL: {
    chain: { type: "string" },
    gas_price_gwei: { type: "number" },
    transfer_fee_usd: { type: "number" },
    as_of: { type: "string" },
  },
  WALLET_BALANCE_CHECK_GENERAL: {
    address: { type: "string" },
    chain: { type: "string" },
    balance: { type: "number" },
    token_symbol: { type: "string" },
    as_of: { type: "string" },
  },
  TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL: {
    total_supply: { type: "number" },
  },
  MACRO_ECONOMIC_INDICATOR_GENERAL: {
    rate_pct: { type: "number" },
  },
  DNS_RECORD_LOOKUP_GENERAL: {
    has_record: { type: "bool" },
  },
  CURRENCY_EXCHANGE_CONVERT: {
    converted_amount: { type: "number" },
  },
  SSL_VERIFICATION_CERT: {
    certificate_valid: { type: "bool" },
  },
  EMAIL_SECURITY_GENERAL: {
    lookup_ok: { type: "bool" },
  },
  ACADEMIC_SEARCH_GENERAL: {
    answer: { type: "string" },
    paper_titles: { type: "list" },
    dois: { type: "list" },
    total_matches: { type: "number" },
  },
  ASSET_RESERVE_ATTESTATION_GENERAL: {
    attested_reserve: { type: "number" },
    asset: { type: "string" },
    block: { type: "string" },
    source: { type: "string" },
  },
  CODE_PATCH_VERIFY_GENERAL: {
    passed: { type: "bool" },
    commit: { type: "string" },
    pipeline: { type: "string" },
  },
  CORPORATE_REGISTRY_LOOKUP_GENERAL: {
    legal_name: { type: "string" },
    registration_id: { type: "string" },
    active: { type: "bool" },
    jurisdiction: { type: "string" },
    registered_address: { type: "string" },
    incorporated: { type: "datetime" },
  },
  CROSS_CHAIN_STATE_VERIFY_GENERAL: {
    address: { type: "string" },
    status: { type: "string" },
    chains: { type: "list" },
    consistent: { type: "bool" },
    summary: { type: "string" },
  },
  CVE_LOOKUP_CVSS: {
    cve_id: { type: "string" },
    cvss_score: { type: "number" },
    description: { type: "string" },
    published: { type: "datetime" },
    references: { type: "list" },
  },
  EVENT_OUTCOME_RESOLUTION_GENERAL: {
    event: { type: "string" },
    resolved_yes: { type: "bool" },
    winner: { type: "string" },
    resolved_at: { type: "string" },
    sources: { type: "list" },
  },
  FINANCIAL_DATA_GENERAL: {
    asset: { type: "string" },
    market_cap_usd: { type: "number" },
    volume_24h_usd: { type: "number" },
    metrics: { type: "string" },
    as_of: { type: "string" },
  },
  FX_NOW_CAD: {
    rate: { type: "number" },
  },
  FX_NOW_EUR: {
    rate: { type: "number" },
  },
  FX_NOW_SEK: {
    rate: { type: "number" },
  },
  IP_GEOLOCATION_GENERAL: {
    ip: { type: "string" },
    country: { type: "string" },
    city: { type: "string" },
    latitude: { type: "number" },
    longitude: { type: "number" },
    isp: { type: "string" },
  },
  LIQUIDITY_DEPTH_VERIFY_GENERAL: {
    liquidity_usd: { type: "number" },
  },
  MALWARE_DETECTION_HASH: {
    malicious: { type: "bool" },
  },
  NEWS_HEADLINES_GENERAL: {
    topic: { type: "string" },
    headlines: { type: "list" },
    urls: { type: "list" },
    window: { type: "string" },
    top_headline: { type: "string" },
  },
  NEWS_SEARCH_GENERAL: {
    answer: { type: "string" },
    result_count: { type: "number" },
    sources: { type: "list" },
  },
  PAYMENT_METHOD_VERIFY_GENERAL: {
    network: { type: "string" },
    issuing_bank: { type: "string" },
    issuing_country: { type: "string" },
    valid: { type: "bool" },
    card_type: { type: "string" },
  },
  ROUTE_ETA_GENERAL: {
    duration: { type: "number" },
  },
  SANCTIONS_SCREENING_MATCH_GENERAL: {
    name: { type: "string" },
    matched: { type: "bool" },
    matches: { type: "list" },
    lists: { type: "list" },
    match_score: { type: "number" },
  },
  SLA_COMPLIANCE_GENERAL: {
    service: { type: "string" },
    uptime_pct: { type: "number" },
    sla_target_pct: { type: "number" },
    compliant: { type: "bool" },
    period: { type: "string" },
  },
  SPORTS_SCORE_GENERAL: {
    home_team: { type: "string" },
    away_team: { type: "string" },
    home_score: { type: "number" },
    away_score: { type: "number" },
    status: { type: "string" },
    date: { type: "string" },
  },
  STOCK_PRICE_US_EQUITY: {
    price_usd: { type: "number" },
  },
  THREAT_INTELLIGENCE_INDICATOR: {
    malicious: { type: "bool" },
  },
  TOKEN_HOLDER_COUNT_GENERAL: {
    token: { type: "string" },
    chain: { type: "string" },
    holders_count: { type: "number" },
    token_symbol: { type: "string" },
  },
  TRANSACTION_RISK_GENERAL: {
    risk_score: { type: "number" },
    signals: { type: "list" },
    summary: { type: "string" },
  },
  TRAVEL_DISRUPTION_GENERAL: {
    route_or_flight: { type: "string" },
    disrupted: { type: "bool" },
    status: { type: "string" },
    delay_minutes: { type: "number" },
    reason: { type: "string" },
  },
  URL_SAFE_GENERAL: {
    url: { type: "string" },
    verdict: { type: "enum", allowed: ["Safe", "Suspicious", "Malicious", "Unknown"] },
    detections: { type: "number" },
    summary: { type: "string" },
  },
  URL_SCAN_VERDICT: {
    safe: { type: "bool" },
  },
  VENDOR_VERIFY_GENERAL: {
    vendor: { type: "string" },
    vat_number: { type: "string" },
    valid: { type: "bool" },
    registered_name: { type: "string" },
    registered_address: { type: "string" },
  },
  VULNERABILITY_TRIAGE_GENERAL: {
    cvss_base_score: { type: "number" },
  },
  WEATHER_FORECAST_GENERAL: {
    location: { type: "string" },
    when: { type: "string" },
    temp_max_c: { type: "number" },
    temp_min_c: { type: "number" },
    precipitation_probability_pct: { type: "number" },
    condition: { type: "string" },
  },
  CRYPTO_PRICE_USD: {
    price_usd: { type: "number" },
  },
  MINING_HASHPRICE_VERIFY_GENERAL: {
    hashprice_sats_per_ph_day: { type: "number" },
    block_height: { type: "number" },
    hashrate_eh_s: { type: "number" },
    hashprice_usd_per_ph_day: { type: "number" },
  },
  STORM_ALERT_GENERAL: {
    location: { type: "string" },
    risk_score: { type: "number" },
    risk_level: { type: "enum", allowed: ["LOW", "MODERATE", "HIGH", "SEVERE"] },
    peak_gust_kmh: { type: "number" },
    precipitation_mm: { type: "number" },
    window: { type: "string" },
  },
  WEATHER_CHECK_TEMPERATURE: {
    temperature_c: { type: "number" },
  },
  ONCHAIN_METRIC_VERIFY_GENERAL: {
    balance_gwei: { type: "number" },
    address: { type: "string" },
    block: { type: "string" },
    chain: { type: "string" },
    tx_count: { type: "number" },
  },
  AIR_QUALITY_INDEX_GENERAL: {
    aqi: { type: "number" },
    aqi_scale: { type: "string" },
    acceptable: { type: "bool" },
    european_aqi: { type: "number" },
    pm2_5_ugm3: { type: "number" },
    pm10_ugm3: { type: "number" },
    nitrogen_dioxide_ugm3: { type: "number" },
    ozone_ugm3: { type: "number" },
    carbon_monoxide_ugm3: { type: "number" },
    latitude: { type: "number" },
    longitude: { type: "number" },
    upstream_hour: { type: "datetime" },
  },
  API_HEALTH_CHECK_GENERAL: {
    url: { type: "string" },
    healthy: { type: "bool" },
    reachable: { type: "bool" },
    http_status: { type: "number" },
    latency_ms: { type: "number" },
  },
  SERVER_UPTIME_MONITOR_GENERAL: {
    host: { type: "string" },
    reachable_now: { type: "bool" },
    http_status: { type: "number" },
    latency_ms: { type: "number" },
  },
  SECURITY_REVIEW_GENERAL: {
    verdict: { type: "string" },
    vulnerability_count: { type: "number" },
    issues: { type: "list" },
    summary: { type: "string" },
  },

  WEATHER_FORECAST_VERIFY_GENERAL: {
    location: { type: "string" },
    date: { type: "date" },
    temp_max_c: { type: "number" },
    temp_min_c: { type: "number" },
    precipitation_mm: { type: "number" },
    condition: { type: "string" },
  },

};

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function mappingFor(intent: string): Record<string, OutputMapping> | undefined {
  if (DANGEROUS_KEYS.has(intent) || !Object.hasOwn(OUTPUT_MAPPING, intent)) return undefined;
  return OUTPUT_MAPPING[intent];
}

export function formatFor(intent: string, field: string): FieldFormat | undefined {
  if (DANGEROUS_KEYS.has(intent) || DANGEROUS_KEYS.has(field) || !Object.hasOwn(FIELD_FORMAT, intent)) return undefined;
  const m = FIELD_FORMAT[intent];
  if (!Object.hasOwn(m, field)) return undefined;
  return m[field];
}

/** Numeric iff the official format type is `number`. Falls back to a present `unit` only when the field has no format entry. */
export function isNumericField(intent: string, field: string): boolean {
  const fmt = formatFor(intent, field);
  if (fmt) return fmt.type === "number";
  const m = mappingFor(intent)?.[field];
  return m?.unit !== undefined;
}

export function valueMatchesFormat(value: unknown, fmt: FieldFormat | undefined, field?: string): boolean {
  if (!fmt) return false;
  switch (fmt.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string": {
      if (typeof value !== "string" || value === "" || value.includes("\u0000")) return false;
      if (field === "tx_hash" || field === "from" || field === "to") {
        return /^0x[0-9a-fA-F]+$/.test(value) && value.length > 2;
      }
      return true;
    }
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
        new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
    case "datetime":
      return typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));
    case "bool":
      // Raw answers must already carry semantic booleans. Node parser tokens
      // (for example DNS status0/NOERROR) are not coerced here.
      return typeof value === "boolean";
    case "list":
      if (!Array.isArray(value)) return false;
      if (field === "urls") {
        return value.every((u) => typeof u === "string" && /^https?:\/\//i.test(u));
      }
      return true;
    case "enum":
      return typeof value === "string" && !!fmt.allowed && fmt.allowed.includes(value);
    default:
      return false;
  }
}

/** Fields the node must hand to its parser model (no `unit`), per intent. */
export function parserFields(intent: string): string[] {
  const m = mappingFor(intent);
  if (!m) throw new Error(`unknown intent: ${intent}`);
  return Object.keys(m).filter((k) => !isNumericField(intent, k));
}

/** Read a plain dot path (a numeric segment indexes an array). Returns
 *  undefined when any segment is absent. Wildcards are not used by this
 *  miner's mapping and are rejected rather than guessed. */
export function readPath(raw: unknown, path: string): unknown {
  const segs = path.split(".");
  for (const seg of segs) {
    if (seg === "" || seg === "*" || seg.endsWith("[]") || seg.startsWith("{") || DANGEROUS_KEYS.has(seg)) {
      throw new Error(`unsupported path segment: ${seg}`);
    }
  }
  let cur: unknown = raw;
  for (const seg of segs) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

export interface ShapedReply {
  intent: string;
  result: Record<string, unknown>;
  field_status: Record<string, FieldStatus>;
}

export interface ReconciledField {
  value: unknown;
  node_status: FieldStatus;
  source: "node" | "raw" | "none";
}

export function reconcileShaped(
  reply: ShapedReply,
  raw: unknown,
  opts: { rawVerified: boolean },
): Record<string, ReconciledField> {
  const mapping = mappingFor(reply.intent);
  if (!mapping) throw new Error(`unknown intent: ${reply.intent}`);
  const out: Record<string, ReconciledField> = Object.create(null);
  const statuses = reply.field_status ?? {};
  for (const field of Object.keys(statuses)) {
    if (DANGEROUS_KEYS.has(field)) continue;
    const status = statuses[field];
    if (status === "ok") {
      out[field] = { value: reply.result[field], node_status: status, source: "node" };
      continue;
    }
    const m = Object.hasOwn(mapping, field) ? mapping[field] : undefined;
    const fmt = formatFor(reply.intent, field);
    if (status === "unavailable" && opts.rawVerified && m && !isNumericField(reply.intent, field)) {
      const v = readPath(raw, m.path);
      if (v !== undefined && v !== null && valueMatchesFormat(v, fmt, field)) {
        out[field] = { value: v, node_status: status, source: "raw" };
        continue;
      }
    }
    out[field] = { value: null, node_status: status, source: "none" };
  }
  return out;
}
