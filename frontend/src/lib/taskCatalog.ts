// Pinned static identity of each Desk task and the official scored field
// per intent. Must stay in sync with desk/src/missions.ts (enforced by
// copyClaims / deskPurchases tests).

export interface TaskCatalogEntry {
  mission: "M12" | "M13";
  title: string;
  intent: string;
  valueField: string;
  node_or_zone?: string;
  market?: string;
  protocol?: string;
  /** Every param of a fully static task, pinned exactly (the row's params must equal this). */
  pinned_params?: Record<string, string>;
}

export const VALUE_FIELD_BY_INTENT: Record<string, string> = {
  GRID_POWER_PRICE_GENERAL: "lmp_usd_per_mwh",
  TVL_LOOKUP_GENERAL: "tvl_usd",
  ONCHAIN_TX_LOOKUP_GENERAL: "block_number",
  REGULATORY_FILING_MONITOR_GENERAL: "filing_count",
  OPTIMAL_EXECUTION_ROUTE_GENERAL: "amount_out",
  VALIDATOR_PERFORMANCE_VERIFY_GENERAL: "effective_balance",
};

export const TASK_CATALOG: Record<string, TaskCatalogEntry> = {
  "m12-caiso-np15": {
    mission: "M12",
    title: "Mission 12 · CAISO NP15 dispatch gate",
    intent: "GRID_POWER_PRICE_GENERAL",
    valueField: "lmp_usd_per_mwh",
    node_or_zone: "TH_NP15_GEN-APND",
    market: "CAISO",
  },
  "m12-nyiso-zone-j": {
    mission: "M12",
    title: "Mission 12 · NYISO Zone J dispatch gate",
    intent: "GRID_POWER_PRICE_GENERAL",
    valueField: "lmp_usd_per_mwh",
    node_or_zone: "ZONE_J",
    market: "NYISO",
  },
  "m13-tvl-aave-v3": {
    mission: "M13",
    title: "Mission 13 · Aave V3 TVL check",
    intent: "TVL_LOOKUP_GENERAL",
    valueField: "tvl_usd",
    protocol: "aave-v3",
  },
  "m13-tx-desk-deposit": {
    mission: "M13",
    title: "Mission 13 · Counterparty tx check (Desk escrow deposit, Sepolia)",
    intent: "ONCHAIN_TX_LOOKUP_GENERAL",
    valueField: "block_number",
    pinned_params: { tx_hash: "0xe8696cc29652173b1fdce601cfbd5d61649583bf811163d778d412739b78d2d3", chain: "sepolia" },
  },
  "m13-filings-aapl-10q-2025": {
    mission: "M13",
    title: "Mission 13 · Apple Inc. Form 10-Q count, calendar 2025 (SEC EDGAR)",
    intent: "REGULATORY_FILING_MONITOR_GENERAL",
    valueField: "filing_count",
    pinned_params: { entity: "Form 10-Q filings by Apple Inc. (CIK 320193)", period: "calendar 2025" },
  },
  "m13-route-eth-usdc": {
    mission: "M13",
    title: "Mission 13 · 1 ETH to USDC execution quote (Ethereum mainnet)",
    intent: "OPTIMAL_EXECUTION_ROUTE_GENERAL",
    valueField: "amount_out",
    pinned_params: { pair: "ETH/USDC" },
  },
  "m13-validator-1": {
    mission: "M13",
    title: "Mission 13 · Beacon validator 1 effective balance",
    intent: "VALIDATOR_PERFORMANCE_VERIFY_GENERAL",
    valueField: "effective_balance",
    pinned_params: { validator_index: "1" },
  },
};

export function catalogAgrees(r: {
  task_id: string;
  mission: string;
  title: string;
  intent: string;
  value_field: string;
  params?: Record<string, string>;
  recovered_fields?: Record<string, { value: unknown; node_status?: string; source?: string }> | null;
}): boolean {
  if (typeof r.task_id !== "string" || typeof r.mission !== "string" || typeof r.title !== "string" || typeof r.value_field !== "string" || typeof r.intent !== "string") {
    return false;
  }
  const c = Object.hasOwn(TASK_CATALOG, r.task_id) ? TASK_CATALOG[r.task_id] : undefined;
  if (!c || c.mission !== r.mission || c.title !== r.title || c.intent !== r.intent || c.valueField !== r.value_field) return false;
  if (c.node_or_zone != null && r.params?.node_or_zone !== c.node_or_zone) return false;
  if (c.protocol != null && r.params?.protocol !== c.protocol) return false;
  if (c.market != null && r.recovered_fields?.market?.value !== c.market) return false;
  if (c.pinned_params != null) {
    const want = Object.keys(c.pinned_params).sort();
    const got = r.params ? Object.keys(r.params).sort() : [];
    if (want.length !== got.length || want.some((k, i) => k !== got[i] || r.params![k] !== c.pinned_params![k])) return false;
  }
  return true;
}

export function valueFieldPinned(intent: string, valueField: string): boolean {
  return Object.hasOwn(VALUE_FIELD_BY_INTENT, intent) && VALUE_FIELD_BY_INTENT[intent] === valueField;
}

/** bought_at vs receipt timestamp slack; keep equal to desk/src/verify.ts BOUGHT_AT_SLACK_MS. */
export const BOUGHT_AT_SLACK_MS = 15_000;
