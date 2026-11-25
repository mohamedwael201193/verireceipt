// VeriReceipt API response types.
// Contract source: miner.yaml (read-only) + live responses from
// https://verireceipt.onrender.com. Every endpoint response carries a
// `receipt` block; live responses also carry answer/verdict/confidence/
// source/checked_at, which the index signatures below preserve.

export interface Receipt {
  receipt_id: string;
  upstream_url: string;
  raw_response_sha256: string;
  fetched_at: string;
  // Live receipts also carry intent, quorum_votes, audit_url, etc.
  [key: string]: unknown;
}

export interface HealthResponse {
  status: string;
  service: string;
  uptime_s: number;
  upstreams: Record<string, unknown>;
}

export interface Filing {
  form: string;
  accession: string;
  filing_date: string;
  url: string;
  [key: string]: unknown;
}

/** Shared shape: every miner endpoint returns its fields plus a receipt. */
export type ReceiptedResponse = {
  receipt: Receipt;
  [key: string]: unknown;
};

export interface TxResponse extends ReceiptedResponse {
  tx_hash: string;
  status: string;
  from: string | null;
  to: string | null;
  block_number: number | null;
  value_eth: string | number | null;
}

export interface FilingsResponse extends ReceiptedResponse {
  entity: string;
  filing_count: number;
  /** The EDGAR form filter the miner applied (null = all forms). */
  form_type?: string | null;
  /** Official output: titles of the matching filings, newest first. */
  filings: string[];
  /** Undeclared companion: the same records as objects, same order as filings/urls. */
  filings_detail?: Filing[];
  urls: string[];
}

export interface SanctionsMatch {
  list: string;
  name: string;
  score?: number;
  alias?: boolean;
}

export interface SanctionsScreenResponse extends ReceiptedResponse {
  name: string;
  matched: boolean;
  matches?: SanctionsMatch[];
  lists?: string[];
  match_score?: number;
  verdict?: string;
  confidence?: number;
  source?: string;
  checked_at?: string;
}

export interface ReserveAttestationResponse extends ReceiptedResponse {
  attested_reserve?: number | null;
  asset?: string;
  reserve_units?: number | null;
  ethereum_total_supply?: number | null;
  reserve_vs_ethereum_supply_pct?: number | null;
  collateral_ratio_pct?: number | null;
  supply_scope?: string;
  round_id?: string;
  updated_at?: string;
  feed_age_seconds?: number;
  heartbeat_seconds?: number;
  block?: string;
  source_feed?: string;
  verdict?: string;
  confidence?: number;
}

export interface CorporateRegistryResponse extends ReceiptedResponse {
  legal_name?: string;
  registration_id?: string;
  active?: boolean;
  jurisdiction?: string;
  registered_address?: string;
  incorporated?: string;
  lei?: string;
  lookup_status?: string;
  verdict?: string;
  confidence?: number;
  source?: string;
  checked_at?: string;
}

export interface StockPriceResponse extends ReceiptedResponse {
  ticker: string;
  price_usd: number;
  currency: string;
  exchange: string;
  /** Yahoo's own exchange timestamp for the quote. */
  market_time?: string;
  /** When the miner acquired the quote. */
  as_of?: string;
  stale?: boolean;
  quote_age_seconds?: number;
  verdict?: string;
}

export interface TokenHoldersResponse extends ReceiptedResponse {
  token?: string;
  chain?: string;
  holders_count?: number;
  token_symbol?: string;
  as_of?: string;
  stale?: boolean;
  stale_reason?: string;
  verdict?: string;
}

export interface PoolLiquidityResponse extends ReceiptedResponse {
  pool?: string;
  chain?: string;
  liquidity_usd?: number;
  verdict?: string;
  confidence?: number;
  source?: string;
  checked_at?: string;
}

export interface TokenSupplyResponse extends ReceiptedResponse {
  total_supply?: number;
  total_supply_scope?: string;
  token_symbol?: string;
  chain?: string;
  as_of?: string;
  verdict?: string;
}

export interface TvlResponse extends ReceiptedResponse {
  protocol_or_chain: string;
  tvl_usd: number;
  chain_tvl_usd: number | null;
  as_of: string;
}

export interface RouteResponse extends ReceiptedResponse {
  amount_out: number;
  block_number?: number;
  winning_venue?: string;
}

export interface GridPriceResponse extends ReceiptedResponse {
  lmp_usd_per_mwh: number;
  node_or_zone: string;
  market: string;
  interval_start: string;
  currency: string;
}

export interface ValidatorResponse extends ReceiptedResponse {
  validator_index: string | number;
  effective_balance: number;
  status?: string;
}
