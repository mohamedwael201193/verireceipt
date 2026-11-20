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
  /**
   * Verification mode (CONTRACT.md). The miner MUST carry this per
   * receipt; a receipt without the label is treated as
   * "snapshot_raw_digest" (default, ALL five intents): the digest covers
   * the exact raw bytes as fetched at answer time, and a live upstream
   * re-fetch can never reproduce them — so the upstream re-fetch panel
   * (VerifyPanel) is informational only for these receipts, never a
   * verification verdict. Only "immutable_live_recheck" receipts (bytes
   * a live re-fetch is guaranteed to reproduce byte-identically) may be
   * verified by an upstream re-fetch.
   */
  verification_mode?: "snapshot_raw_digest" | "immutable_live_recheck";
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
  filings: Filing[];
  urls: string[];
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
