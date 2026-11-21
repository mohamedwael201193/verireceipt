// Append-only purchase ledger (desk/ledger/purchases.jsonl). Each line is
// one escrow-paid purchase with only public data: no key, no signature.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export interface PurchaseRecord {
  version: 1;
  task_id: string;
  mission: string;
  title: string;
  intent: string;
  params: Record<string, string>;
  bought_at: string;
  payer: string;
  miner_catalogue_id: string;
  nonce: string;
  valid_after: string;
  valid_before: string;
  quoted_uusdc: string;
  telegraph_receipt: {
    receipt_hash: string;
    rail: string;
    miner: string;
    amount_uusdc: string;
    epoch_id: number;
    settlement: string;
    chain: string;
    timestamp: number;
  };
  signal_hash: string;
  engine: { miner_id: string; endpoint: string; result_shape: string; field_status: Record<string, string>; duration_ms: number | null };
  value_field: string;
  value: unknown;
  miner_receipt: { receipt_id: string; raw_response_sha256: string; upstream_url?: string } | null;
  raw_sha256_recomputed: string | null;
  raw_bytes: number | null;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  verdict: "VERIFIED" | "UNVERIFIED";
  delivery_proof: {
    status: string;
    checked_at: string;
    deliveries_root?: string;
    epoch_id?: number;
    receipt_hash?: string;
    payer?: string;
    usdc?: number;
    intent?: string;
    miner_id?: string;
    proof_nodes?: number;
  } | null;
}

export function readLedger(file: string): PurchaseRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PurchaseRecord);
}

export function appendLedger(file: string, rec: PurchaseRecord): void {
  appendFileSync(file, JSON.stringify(rec) + "\n");
}

/** μUSDC signed on the UTC day of `now`, from the ledger (the Desk's daily-cap input). */
export function spentOnUtcDay(records: PurchaseRecord[], now: Date): bigint {
  const day = now.toISOString().slice(0, 10);
  return records
    .filter((r) => r.bought_at.slice(0, 10) === day)
    .reduce((s, r) => s + BigInt(r.telegraph_receipt.amount_uusdc), 0n);
}

/** Rewrite the ledger in place. After a purchase is recorded, `--write` may update `delivery_proof` (and, when the fields-fix path is applied, backfill `recovered_fields` / `engine.result`). */
export function writeLedger(file: string, records: PurchaseRecord[]): void {
  writeFileSync(file, records.map((r) => JSON.stringify(r) + "\n").join(""));
}
