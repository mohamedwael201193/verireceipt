/**
 * Current Sepolia registration 6220: confirmed updateMiner of 6205, tx
 * 0x083b6aa1…f7c24, block 12229044 (2026-11-28 08:54 UTC, status 1, sent by
 * the miner wallet). 6205 was the updateMiner of 6196 (2026-11-27); 6196 of
 * 6188 (2026-11-25); 6188 of 6181 (tx 0x115e0e23…cb56, block 12197330); 6181
 * of 6177; 6177 of 6176. 6205 is now deregistered on the node; its score
 * carries over through updateMiner. This file is the single source for the
 * displayed registration: the id, the intent count and the bond intent count
 * all derive from the constants below. Node activation stays live-read and
 * requires the exact id, status and YAML hash; pending ingestion is not
 * active. Historical serving IDs are retained for old paid receipts, never
 * rewritten.
 */
import { useLiveQuery, type LiveQueryResult } from "./hooks";

export const SEPOLIA_REGISTRATION_ID = 6220;

/** The intents registration 6220 declares on chain (the 59 landed by the
 * updateMiner tx below, 2026-11-28), in the supported_intents order of the
 * live node record and of miner.yaml at pin 30780baf. Registered and declared
 * sets are kept as separate lists because a future declaration can land
 * before its registration update. */
export const SEPOLIA_REGISTERED_INTENTS = [
  "ONCHAIN_TX_LOOKUP_GENERAL",
  "REGULATORY_FILING_MONITOR_GENERAL",
  "TVL_LOOKUP_GENERAL",
  "OPTIMAL_EXECUTION_ROUTE_GENERAL",
  "GRID_POWER_PRICE_GENERAL",
  "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
  "GAS_PRICE_GENERAL",
  "WALLET_BALANCE_CHECK_GENERAL",
  "TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL",
  "MACRO_ECONOMIC_INDICATOR_GENERAL",
  "DNS_RECORD_LOOKUP_GENERAL",
  "CURRENCY_EXCHANGE_CONVERT",
  "SSL_VERIFICATION_CERT",
  "EMAIL_SECURITY_GENERAL",
  "ACADEMIC_SEARCH_GENERAL",
  "ASSET_RESERVE_ATTESTATION_GENERAL",
  "CODE_PATCH_VERIFY_GENERAL",
  "CORPORATE_REGISTRY_LOOKUP_GENERAL",
  "CROSS_CHAIN_STATE_VERIFY_GENERAL",
  "CRYPTO_PRICE_USD",
  "CVE_LOOKUP_CVSS",
  "EVENT_OUTCOME_RESOLUTION_GENERAL",
  "FINANCIAL_DATA_GENERAL",
  "FX_NOW_CAD",
  "FX_NOW_EUR",
  "FX_NOW_SEK",
  "IP_GEOLOCATION_GENERAL",
  "LIQUIDITY_DEPTH_VERIFY_GENERAL",
  "MALWARE_DETECTION_HASH",
  "MINING_HASHPRICE_VERIFY_GENERAL",
  "NEWS_HEADLINES_GENERAL",
  "NEWS_SEARCH_GENERAL",
  "PAYMENT_METHOD_VERIFY_GENERAL",
  "ROUTE_ETA_GENERAL",
  "SANCTIONS_SCREENING_MATCH_GENERAL",
  "SLA_COMPLIANCE_GENERAL",
  "SPORTS_SCORE_GENERAL",
  "STORM_ALERT_GENERAL",
  "STOCK_PRICE_US_EQUITY",
  "THREAT_INTELLIGENCE_INDICATOR",
  "TOKEN_HOLDER_COUNT_GENERAL",
  "WASH_TRADING_DETECTION_GENERAL",
  "TRANSACTION_RISK_GENERAL",
  "TRAVEL_DISRUPTION_GENERAL",
  "URL_SAFE_GENERAL",
  "URL_SCAN_VERDICT",
  "VENDOR_VERIFY_GENERAL",
  "VULNERABILITY_TRIAGE_GENERAL",
  "WEATHER_CHECK_TEMPERATURE",
  "WEATHER_FORECAST_GENERAL",
  "ONCHAIN_METRIC_VERIFY_GENERAL",
  "AIR_QUALITY_INDEX_GENERAL",
  "API_HEALTH_CHECK_GENERAL",
  "SERVER_UPTIME_MONITOR_GENERAL",
  "SECURITY_REVIEW_GENERAL",
  "WEATHER_FORECAST_VERIFY_GENERAL",
  "RETURN_POLICY_VERIFY_GENERAL",
  "CRYPTO_YIELD_RATE_GENERAL",
  "SENSOR_TELEMETRY_VERIFY_GENERAL"
] as const;

/** Registered intent count: always the length of the list above. */
export const SEPOLIA_REGISTERED_INTENT_COUNT: number = SEPOLIA_REGISTERED_INTENTS.length;

export const SEPOLIA_PREVIOUS_REGISTRATION_ID = 6205;
export const SEPOLIA_REGISTER_TX =
  "0x083b6aa1d130e241bc8a57c82fb7098ef35b902d14fa1e0c24dee5fcdd7f7c24";
export const SEPOLIA_REGISTER_BLOCK = 12229044;
export const SEPOLIA_YAML_HASH =
  "0xc334c69ccae79480fe5ff9726d91d3f0efee7b87d60bcc8edea2d5c6a5ab9ad9";
export const SEPOLIA_YAML_PIN = "30780baf2526d4b1f74583d3e804a2f50019e072";
/**
 * Every registration id that has answered paid calls for slug "verireceipt".
 * Telegraph receipts name the registration that served the call, so committed
 * purchases keep their old id after an updateMiner; ids are appended, never
 * rewritten. The current registration is always included.
 */
export const SEPOLIA_SERVING_REGISTRATION_IDS: readonly number[] = Array.from(
  new Set([6152, 6160, 6174, 6176, 6177, 6181, 6188, 6196, 6205, SEPOLIA_REGISTRATION_ID]), // pin:keep (historical ids)
);
export const SEPOLIA_EXPLORER_TX = `https://sepolia.etherscan.io/tx/${SEPOLIA_REGISTER_TX}`;
export const TELEGRAPH_NODE_BASE = "https://devnode.telegraphprotocol.com";

export type NodeListing =
  | { kind: "active"; raw: unknown }
  | {
      kind: "listed";
      raw: unknown;
      active: false;
      /** Live activation_status (e.g. pending, unreachable, rejected), if any. */
      status?: string;
      rejectionReason?: string;
    }
  | { kind: "not_found" }
  | { kind: "unreachable"; detail: string };

export interface MinerRegistrationStatus {
  registrationId: number;
  previousRegistrationId: number;
  registerTx: string;
  registerBlock: number;
  yamlHash: string;
  yamlPin: string;
  explorerTx: string;
  /** Live Telegraph node read for /api/miners/{registrationId}. */
  nodeByRegistrationId: NodeListing;
  /**
   * True only when the live node body for the current registration says activation_status
   * "active" AND carries that registration_id AND the pinned yaml_hash
   * (all three required; no boolean fallbacks). Pending ingestion (404)
   * is not active.
   */
  nodeReportsActive: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The node wraps the record in {"miner": {...}}; accept a bare record too. */
function minerRecord(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  if (isRecord(body.miner)) return body.miner;
  return body;
}

function normHash(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  return s.startsWith("0x") ? s.slice(2) : s;
}

interface ActiveRead {
  active: boolean;
  status?: string;
  rejectionReason?: string;
}

/**
 * Strict activation gate (J2 Minor 2, r7). "active" requires ALL of:
 *   - activation_status is the string "active" (no boolean `active` /
 *     `is_active` fallback — the node's documented field is the string);
 *   - registration_id is present and equals the id that was asked for;
 *   - for the current registration, yaml_hash is present and equals the pinned miner.yaml
 *     hash (a missing hash is NOT a pass).
 * Anything else is reported as listed-but-not-active with the reason.
 */
function activeFlag(body: unknown, expectedId: string): ActiveRead {
  const rec = minerRecord(body);
  if (!rec) return { active: false, status: "no miner record in the node response" };
  const reason = typeof rec.rejection_reason === "string" ? rec.rejection_reason : undefined;
  const rid = rec.registration_id;
  if (rid === undefined || rid === null) {
    return { active: false, status: "registration_id missing", rejectionReason: reason };
  }
  if (String(rid) !== expectedId) {
    return {
      active: false,
      status: `registration_id ${String(rid)} != ${expectedId}`,
      rejectionReason: reason,
    };
  }
  const v = rec.activation_status;
  if (typeof v !== "string") {
    return { active: false, status: "activation_status missing", rejectionReason: reason };
  }
  const status = v.trim().toLowerCase();
  if (status !== "active") return { active: false, status, rejectionReason: reason };
  if (expectedId === String(SEPOLIA_REGISTRATION_ID)) {
    const h = normHash(rec.yaml_hash);
    if (h === undefined || h.length === 0) {
      return { active: false, status: "active but yaml_hash missing", rejectionReason: reason };
    }
    if (h !== normHash(SEPOLIA_YAML_HASH)) {
      return { active: false, status: "active with an unexpected yaml_hash", rejectionReason: reason };
    }
  }
  return { active: true, status, rejectionReason: reason };
}

export async function readNodeMiner(
  id: string | number,
  signal?: AbortSignal,
): Promise<NodeListing> {
  const url = `${TELEGRAPH_NODE_BASE}/api/miners/${encodeURIComponent(String(id))}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (signal?.aborted) throw err;
    const detail = err instanceof Error ? err.message : "network error";
    return { kind: "unreachable", detail };
  }
  if (res.status === 404) return { kind: "not_found" };
  if (!res.ok) {
    return { kind: "unreachable", detail: `HTTP ${res.status}` };
  }
  let raw: unknown = null;
  try {
    raw = await res.json();
  } catch {
    return { kind: "unreachable", detail: "node returned a non-JSON body" };
  }
  if (isRecord(raw) && typeof raw.error === "string" && /not found/i.test(raw.error)) {
    return { kind: "not_found" };
  }
  const flag = activeFlag(raw, String(id));
  if (flag.active === true) return { kind: "active", raw };
  return {
    kind: "listed",
    raw,
    active: false,
    ...(flag.status ? { status: flag.status } : {}),
    ...(flag.rejectionReason ? { rejectionReason: flag.rejectionReason } : {}),
  };
}

export async function fetchMinerRegistrationStatus(
  signal?: AbortSignal,
): Promise<MinerRegistrationStatus> {
  const nodeByRegistrationId = await readNodeMiner(SEPOLIA_REGISTRATION_ID, signal);
  return {
    registrationId: SEPOLIA_REGISTRATION_ID,
    previousRegistrationId: SEPOLIA_PREVIOUS_REGISTRATION_ID,
    registerTx: SEPOLIA_REGISTER_TX,
    registerBlock: SEPOLIA_REGISTER_BLOCK,
    yamlHash: SEPOLIA_YAML_HASH,
    yamlPin: SEPOLIA_YAML_PIN,
    explorerTx: SEPOLIA_EXPLORER_TX,
    nodeByRegistrationId,
    nodeReportsActive: nodeByRegistrationId.kind === "active",
  };
}

export function useMinerRegistration(): LiveQueryResult<MinerRegistrationStatus> {
  return useLiveQuery("miner-registration", (signal) => fetchMinerRegistrationStatus(signal));
}

export function describeNodeListing(listing: NodeListing): string {
  if (listing.kind === "active") return "active (live Telegraph node)";
  if (listing.kind === "listed") {
    const st = listing.status ? ` (status: ${listing.status})` : "";
    const why = listing.rejectionReason ? ` — ${listing.rejectionReason}` : "";
    return `listed on the live Telegraph node, not marked active${st}${why}`;
  }
  if (listing.kind === "not_found") {
    return "not listed yet — node ingestion pending (UNVERIFIED)";
  }
  return `node unreachable (${listing.detail}) — UNVERIFIED`;
}
