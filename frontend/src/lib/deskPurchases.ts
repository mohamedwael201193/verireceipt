// Desk Phase D: escrow-paid purchases made by the autonomous Desk agent
// (desk/scripts/run-purchase.ts) through the Telegraph engine, paid from
// the operator's escrow on the Sepolia Diamond. The records are the
// committed ledger (desk/ledger/purchases.jsonl, exported unchanged to
// lib/deskPurchases.json); nothing here is computed or invented in the
// browser except the live re-hash of the stored raw bytes.
import data from "./deskPurchases.json";
import { sha256Hex } from "./receipt";
import { BOUGHT_AT_SLACK_MS, catalogAgrees, valueFieldPinned } from "./taskCatalog";
import { SEPOLIA_SERVING_REGISTRATION_IDS } from "./minerRegistration";

export interface DeskPurchase {
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
  engine: { miner_id: string; endpoint: string; result_shape: string; field_status: Record<string, string>; duration_ms: number | null; result?: Record<string, unknown> };
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
  recovered_fields?: Record<string, { value: unknown; node_status: string; source: "node" | "raw" | "none" }> | null;
}

/** Safe display of a recovered value: never calls String() on a hostile object. */
export function formatRecoveredValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}

function recoveredValueTypeOk(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "number" && Number.isFinite(value)) return true;
  return false;
}

/** Fields filled from the hash-verified raw answer. Shown only on VERIFIED rows, never for numeric values. */
export function recoveredFromRaw(p: DeskPurchase): Array<{ field: string; value: unknown }> {
  if (purchaseVerdict(p) !== "VERIFIED" || !p.recovered_fields) return [];
  return Object.entries(p.recovered_fields)
    .filter(([, f]) => f && f.source === "raw" && typeof f.value !== "number" && recoveredValueTypeOk(f.value))
    .map(([field, f]) => ({ field, value: f.value }));
}

/** Must stay in sync with desk/src/verify.ts EXPECTED_VERIFY_CHECKS. */
export const EXPECTED_VERIFY_CHECKS = [
  "signal hash re-derived",
  "signal wallet is the payer",
  "signal miner",
  "signal intent",
  "engine value equals miner answer",
  "miner receipt present",
  "stored receipt metadata agrees",
  "sha256(stored raw bytes) = raw_response_sha256",
] as const;

/** End-to-end verified only when the row says so, every expected check is present and passed, and the recomputed sha equals the receipt sha. */
export function isEndToEndVerified(r: DeskPurchase): boolean {
  if (r.verdict !== "VERIFIED" || !Array.isArray(r.checks) || r.miner_receipt == null) return false;
  if (typeof r.raw_sha256_recomputed !== "string" || r.raw_sha256_recomputed !== r.miner_receipt.raw_response_sha256) return false;
  // Every check in the array must pass — an extra failing check must not render VERIFIED.
  if (r.checks.length === 0 || r.checks.some((c) => !c || c.ok !== true)) return false;
  const passed = new Set(r.checks.filter((c) => c.ok).map((c) => c.name));
  return EXPECTED_VERIFY_CHECKS.every((n) => passed.has(n));
}

export function purchaseVerdict(r: DeskPurchase): "VERIFIED" | "UNVERIFIED" {
  return isEndToEndVerified(r) ? "VERIFIED" : "UNVERIFIED";
}

export type DeliveryStatus = "included" | "pending" | "error" | "unknown";

/** Distinguish included, pending, error, and any unrecognised stored status (never shown as pending). */
export function deliveryStatus(r: DeskPurchase): DeliveryStatus {
  const s = r.delivery_proof?.status;
  if (s == null || s === "" || s === "pending") return "pending";
  if (s === "included") return "included";
  if (s === "error") return "error";
  return "unknown";
}

/** KPI subtext for the Epochs cell: only say "charged in these ledger roots" when every purchase is included in a recorded block. */
export function epochChargeSubtext(rows: DeskPurchase[]): string {
  if (rows.length === 0) return "no epochs recorded";
  const statuses = rows.map(deliveryStatus);
  const included = statuses.filter((s) => s === "included").length;
  const errors = statuses.filter((s) => s === "error").length;
  if (included === statuses.length) return "charged in these ledger roots";
  const unknowns = statuses.filter((s) => s === "unknown").length;
  if (unknowns > 0 && included === 0) return "delivery status unknown; not charged in a recorded ledger root";
  if (unknowns > 0) return "some billed in a recorded ledger root; at least one delivery status unknown";
  if (errors === 0 && included === 0 && unknowns === 0) return "pending epoch submission; billed in ledger root once recorded";
  if (errors > 0 && included === 0) return "delivery error; not charged in a recorded ledger root";
  if (errors > 0) return "some billed in a recorded ledger root; at least one delivery error";
  return "some billed in a recorded ledger root; others pending epoch submission";
}

/** Shape check at load: a malformed export must fail loudly, never render half a row. A VERIFIED verdict is rejected unless the full expected check set passed and the sha matches. */
export function assertPurchases(rows: unknown): DeskPurchase[] {
  if (!Array.isArray(rows)) throw new Error("deskPurchases.json is not an array");
  for (const r of rows as DeskPurchase[]) {
    if (
      !r ||
      !/^0x[0-9a-f]{64}$/.test(r.telegraph_receipt?.receipt_hash ?? "") ||
      !/^0x[0-9a-f]{64}$/.test(r.signal_hash ?? "") ||
      (r.verdict !== "VERIFIED" && r.verdict !== "UNVERIFIED") ||
      !Array.isArray(r.checks)
    ) {
      throw new Error("deskPurchases.json has a malformed record");
    }
    if (r.verdict === "VERIFIED" && !isEndToEndVerified(r)) {
      throw new Error("deskPurchases.json marks a record VERIFIED without the full expected check set or a matching sha");
    }
    if (!catalogAgrees(r)) {
      throw new Error("deskPurchases.json has a row that does not match the pinned task catalog");
    }
    if (!valueFieldPinned(r.intent, r.value_field)) {
      throw new Error("deskPurchases.json has a row whose value_field is not the official scored field for its intent");
    }
    const bought = Date.parse(r.bought_at);
    const receiptMs = typeof r.telegraph_receipt?.timestamp === "number" ? r.telegraph_receipt.timestamp * 1000 : NaN;
    if (typeof r.bought_at !== "string" || !Number.isFinite(bought) || !Number.isFinite(receiptMs) || Math.abs(bought - receiptMs) > BOUGHT_AT_SLACK_MS) {
      throw new Error("deskPurchases.json has a bought_at that is inconsistent with the receipt timestamp");
    }
    if (typeof r.telegraph_receipt?.miner !== "string" || !SEPOLIA_SERVING_REGISTRATION_IDS.map(String).includes(r.telegraph_receipt.miner)) {
      throw new Error("deskPurchases.json has a row whose telegraph_receipt.miner is not one of our on-chain registration ids");
    }
    if (typeof r.title !== "string" || typeof r.mission !== "string" || typeof r.task_id !== "string") {
      throw new Error("deskPurchases.json has a row that does not match the pinned task catalog");
    }
    if (r.recovered_fields) {
      for (const [, f] of Object.entries(r.recovered_fields)) {
        if (!f || (f.source !== "node" && f.source !== "raw" && f.source !== "none")) {
          throw new Error("deskPurchases.json has a malformed recovered_fields entry");
        }
        if (!recoveredValueTypeOk(f.value)) {
          throw new Error("deskPurchases.json has a recovered_fields value that is not a string, number, or null");
        }
        if (f.source === "raw" && typeof f.value === "number") {
          throw new Error("deskPurchases.json claims a numeric field was recovered from raw");
        }
      }
    }
  }
  const keys: Array<[string, (r: DeskPurchase) => string | undefined, boolean?]> = [
    ["task_id", (r) => r.task_id],
    ["receipt_hash", (r) => r.telegraph_receipt?.receipt_hash],
    ["signal_hash", (r) => r.signal_hash],
    ["nonce", (r) => r.nonce, true],
    ["miner_receipt.receipt_id", (r) => r.miner_receipt?.receipt_id],
  ];
  for (const [label, get, fold] of keys) {
    const seen = new Set<string>();
    for (const r of rows as DeskPurchase[]) {
      const raw = get(r);
      if (!raw) continue;
      const v = fold ? raw.toLowerCase() : raw;
      if (seen.has(v)) throw new Error(`deskPurchases.json has a duplicate ${label}`);
      seen.add(v);
    }
  }
  return rows as DeskPurchase[];
}

/** Fail-soft loader: a bad export must not take down the Dashboard route, only the panel. */
export function loadPurchases(raw: unknown): { rows: DeskPurchase[]; error: string | null } {
  try {
    return { rows: assertPurchases(raw), error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

const loaded = loadPurchases(data as unknown);
export const DESK_PURCHASES: DeskPurchase[] = loaded.rows;
export const DESK_PURCHASES_LOAD_ERROR: string | null = loaded.error;

export interface DeskSummary {
  total: number;
  verified: number;
  spentUusdc: number;
  epochs: number[];
  epochsSubtext: string;
}

export function summarize(rows: DeskPurchase[]): DeskSummary {
  return {
    total: rows.length,
    verified: rows.filter(isEndToEndVerified).length,
    spentUusdc: rows.reduce((s, r) => s + Number(r.telegraph_receipt.amount_uusdc), 0),
    epochs: [...new Set(rows.map((r) => r.telegraph_receipt.epoch_id))].sort((a, b) => a - b),
    epochsSubtext: epochChargeSubtext(rows),
  };
}

/** μUSDC (6 decimals) as dollars, e.g. 10000 -> "$0.01". */
export function uusdcToUsd(u: number): string {
  return `$${(u / 1_000_000).toFixed(2)}`;
}

/** Public lookups a reader can run to check one purchase without trusting this page. */
export function auditLinks(p: DeskPurchase): { signal: string; delivery: string; rawPath: string | null } {
  return {
    signal: `https://devnode.telegraphprotocol.com/engine/v1/signal/${p.signal_hash}`,
    delivery: `https://devnode.telegraphprotocol.com/v1/blocks/${p.telegraph_receipt.epoch_id}/deliveries/${p.telegraph_receipt.receipt_hash}`,
    rawPath: p.miner_receipt ? `/api/receipts/${p.miner_receipt.receipt_id}/raw` : null,
  };
}

export type RehashResult =
  | { state: "match"; sha: string; bytes: number }
  | { state: "mismatch"; sha: string; bytes: number }
  | { state: "error"; message: string };

/** Live: GET the stored raw bytes through the same-origin proxy and SHA-256 them. */
export async function rehashStoredRaw(p: DeskPurchase, f: typeof fetch = fetch): Promise<RehashResult> {
  const { rawPath } = auditLinks(p);
  if (!rawPath || !p.miner_receipt) return { state: "error", message: "no miner receipt" };
  try {
    const res = await f(rawPath, { cache: "no-store" });
    if (!res.ok) return { state: "error", message: `HTTP ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const sha = await sha256Hex(bytes);
    return { state: sha === p.miner_receipt.raw_response_sha256 ? "match" : "mismatch", sha, bytes: bytes.byteLength };
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
