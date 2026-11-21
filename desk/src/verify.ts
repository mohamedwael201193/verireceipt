// End-to-end verification of one escrow-paid purchase, with no trust in
// the Desk's own memory:
//  1. the node's escrow receipt (X-PAYMENT-RESPONSE) matches what was signed;
//  2. the node's signal record GET /engine/v1/signal/{signal_hash} re-derives:
//     keccak256 over the payload (keys sorted, compact JSON, Go-style
//     escaping of & < >) equals signal_hash, and names our wallet + miner;
//  3. the miner's answer inside that payload carries a VeriReceipt receipt,
//     and sha256 of the miner's STORED evidence bytes (/receipts/{id}/raw)
//     equals its raw_response_sha256 (also cross-checked with /receipts/{id});
//  4. the answer value the engine returned equals the value in the payload.
// The epoch inclusion proof (GET /v1/blocks/{epoch}/deliveries/{hash}) is
// checked separately (scripts/verify-ledger.ts): the testnet records a
// block up to about an hour after the call. The official API also returns
// a Merkle `proof` and `deliveries_root`; the leaf/node hash algorithm is
// not documented in escrow-inference.md or how-it-works.md, so we check
// proof shape (array of 32-byte hex hashes plus the root) and do not
// invent a walker.
import { createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { ENGINE_URL, MINER_BASE_URL, NODE_URL, VERIRECEIPT_ONCHAIN_MINER_ID } from "./constants.js";
import { catalogAgrees, valueFieldPinned } from "./missions.js";
import type { Fetch } from "./client.js";
import { FIELD_FORMAT, formatFor, isNumericField, reconcileShaped, type FieldStatus, type ReconciledField } from "../../src/core/shapedFields.js";

export function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** Compact, key-sorted JSON with Go encoding/json's HTML escaping (& < > as \u00XX). */
export function canonicalPayloadJson(payload: unknown): string {
  return JSON.stringify(sortKeysDeep(payload))
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

export function signalHashOf(payload: unknown): string {
  return keccak256(toBytes(canonicalPayloadJson(payload)));
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface MinerReceipt {
  receipt_id: string;
  raw_response_sha256: string;
  upstream_url?: string;
  intent?: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyInput {
  payer: string;
  minerSlug: string;
  signalHash: string;
  /** The intent field the Desk decides on (e.g. lmp_usd_per_mwh, tvl_usd). */
  valueField: string;
  /** The engine's `result` object from the paid response. */
  engineResult: Record<string, unknown>;
  /** The intent that was purchased; pinned to payload.intent_id. */
  intent: string;
  /** Node field_status from the paid reply (needed to reconcile shaped fields). */
  fieldStatus?: Record<string, FieldStatus>;
}

export interface VerifyOutput {
  verified: boolean;
  checks: Check[];
  minerReceipt: MinerReceipt | null;
  rawSha256: string | null;
  rawBytes: number | null;
  payloadValue: unknown;
  intentId: string | null;
  request: string | null;
  requestParams: Record<string, string> | null;
  signalTimestamp: string | null;
  /** Reconciled fields, filled only when every verify check passed. */
  fields: Record<string, ReconciledField> | null;
  payloadResponse: Record<string, unknown> | null;
}

const RECEIPT_ID = /^rcpt_[A-Z0-9]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const RECEIPT_HASH_RE = /^0x[0-9a-f]{64}$/;
/** Flat escrow price on this miner, in μUSDC (6 decimals) = $0.01. */
export const FLAT_ESCROW_UUSDC = "10000";
export const OFFICIAL_PENDING_ERROR = "no block recorded for this epoch";
export const OFFICIAL_NOT_IN_BLOCK_ERROR = "receipt not in this block";
/** bought_at must sit within this slack of the receipt timestamp and the signal timestamp. */
export const BOUGHT_AT_SLACK_MS = 15_000;
/** Dummy hash used only to probe whether an epoch block has been recorded. */
export const EPOCH_PROBE_HASH = `0x${"00".repeat(32)}`;

/** The checks a VERIFIED escrow purchase must carry, in verifyPurchase order.
 *  Must stay in sync with frontend/src/lib/deskPurchases.ts EXPECTED_VERIFY_CHECKS
 *  (enforced by a copyClaims / desk sync test). */
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

export type SignalPayload = {
  wallet_address?: string;
  miner_slug?: string;
  intent_id?: string;
  request?: string;
  response?: Record<string, unknown>;
  timestamp?: string;
};

/** Parse the official engine request line: `[intent] INTENT → {json}`. */
export function parseEngineRequest(request: unknown): { intentId: string; params: Record<string, string> } | null {
  if (typeof request !== "string") return null;
  const m = /^\[intent\]\s+(\S+)\s+(?:→|->)\s+(\{[\s\S]*\})\s*$/.exec(request);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[2]) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      params[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return { intentId: m[1], params };
  } catch {
    return null;
  }
}

export function paramsEqual(stored: Record<string, string>, live: Record<string, string> | null): boolean {
  if (!live) return false;
  const sk = Object.keys(stored).sort();
  const lk = Object.keys(live).sort();
  if (sk.length !== lk.length || sk.some((k, i) => k !== lk[i])) return false;
  return sk.every((k) => stored[k] === live[k]);
}

export interface LedgerIdentity {
  task_id?: string;
  mission?: string;
  title?: string;
  value_field?: string;
  value?: unknown;
  bought_at?: string;
  nonce?: string;
  signal_hash?: string;
  miner_receipt: { receipt_id: string; raw_response_sha256: string } | null;
  raw_sha256_recomputed: string | null;
  raw_bytes: number | null;
  intent: string;
  params: Record<string, string>;
  checks: Check[];
  verdict: "VERIFIED" | "UNVERIFIED";
  quoted_uusdc: string;
  telegraph_receipt: { receipt_hash: string; rail: string; amount_uusdc: string; epoch_id: number; miner?: string; timestamp?: number };
  delivery_proof?: StoredDeliveryProof | null;
  recovered_fields?: Record<string, { value: unknown; node_status: string; source: "node" | "raw" | "none" }> | null;
  engine?: {
    result?: Record<string, unknown>;
    field_status?: Record<string, string>;
  };
}

/** Shape checks that apply while the epoch delivery is still pending. */
export function receiptPendingShape(r: LedgerIdentity): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (r.quoted_uusdc !== FLAT_ESCROW_UUSDC) failures.push(`quoted_uusdc != ${FLAT_ESCROW_UUSDC}`);
  if (String(r.telegraph_receipt.amount_uusdc) !== FLAT_ESCROW_UUSDC) failures.push(`amount_uusdc != ${FLAT_ESCROW_UUSDC}`);
  if (r.quoted_uusdc !== String(r.telegraph_receipt.amount_uusdc)) failures.push("quoted_uusdc != amount_uusdc");
  if (r.telegraph_receipt.rail !== "escrow") failures.push("rail != escrow");
  if (!RECEIPT_HASH_RE.test(r.telegraph_receipt.receipt_hash)) failures.push("receipt_hash shape");
  if (!Number.isSafeInteger(r.telegraph_receipt.epoch_id) || r.telegraph_receipt.epoch_id < 0) failures.push("epoch_id shape");
  if (typeof r.telegraph_receipt.miner !== "string" || r.telegraph_receipt.miner !== VERIRECEIPT_ONCHAIN_MINER_ID) {
    failures.push("miner");
  }
  return { ok: failures.length === 0, failures };
}

/** Compare stored vs live checks by name, ok, and detail (a forged title or detail must fail). */
export function checksAgree(stored: Check[], live: Check[]): boolean {
  if (stored.length !== live.length) return false;
  const key = (c: Check) => `${c.name}\0${c.ok ? "1" : "0"}\0${c.detail}`;
  const a = [...stored].map(key).sort();
  const b = [...live].map(key).sort();
  return a.every((x, i) => x === b[i]);
}

export function valuesAgree(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Parse an ISO-8601 (or RFC-3339 with extra fractional digits) timestamp to ms, or null. */
export function parseTimeMs(s: unknown): number | null {
  if (typeof s !== "string" || !s) return null;
  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return direct;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "0").slice(0, 3).padEnd(3, "0");
  const t = Date.parse(`${m[1]}.${frac}Z`);
  return Number.isFinite(t) ? t : null;
}

export function boughtAtAgrees(boughtAt: string, receiptTimestampSec?: number, signalTimestamp?: string | null): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const bought = parseTimeMs(boughtAt);
  if (bought == null) return { ok: false, failures: ["bought_at"] };
  if (receiptTimestampSec != null) {
    if (!Number.isFinite(receiptTimestampSec)) failures.push("bought_at vs receipt timestamp");
    else if (Math.abs(bought - receiptTimestampSec * 1000) > BOUGHT_AT_SLACK_MS) failures.push("bought_at vs receipt timestamp");
  }
  if (signalTimestamp != null && signalTimestamp !== "") {
    const sig = parseTimeMs(signalTimestamp);
    if (sig == null || Math.abs(bought - sig) > BOUGHT_AT_SLACK_MS) failures.push("bought_at vs signal timestamp");
  }
  return { ok: failures.length === 0, failures };
}


export function canonicalEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

/** Stored field_status keys must equal FIELD_FORMAT keys, and `ok` exactly on number fields. */
export function fieldStatusShapeOk(intent: string, status: Record<string, string> | undefined): boolean {
  if (!status || !Object.hasOwn(FIELD_FORMAT, intent)) return false;
  const fmt = FIELD_FORMAT[intent];
  const keys = Object.keys(status).filter((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype").sort();
  const expected = Object.keys(fmt).sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) return false;
  for (const k of keys) {
    const st = status[k];
    if (st !== "ok" && st !== "missing" && st !== "rejected" && st !== "unavailable") return false;
    const wantOk = formatFor(intent, k)?.type === "number";
    if (wantOk && st !== "ok") return false;
    if (!wantOk && st === "ok") return false;
  }
  return true;
}

/** For ok numeric fields, engine.result[f] must equal the live payload.response[f]. */
export function okNumericEngineAgrees(
  engineResult: Record<string, unknown> | undefined,
  fieldStatus: Record<string, string> | undefined,
  payloadResponse: Record<string, unknown> | null,
  intent: string,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!engineResult || !fieldStatus || !payloadResponse) return { ok: true, failures };
  for (const [f, st] of Object.entries(fieldStatus)) {
    if (st !== "ok" || !isNumericField(intent, f)) continue;
    if (!valuesAgree(engineResult[f], payloadResponse[f])) failures.push(`engine.result.${f}`);
  }
  return { ok: failures.length === 0, failures };
}

export function recoveredFieldsAgree(
  stored: Record<string, { value: unknown; node_status: string; source: "node" | "raw" | "none" }> | null | undefined,
  live: Record<string, ReconciledField> | null,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (stored != null && live == null) failures.push("recovered_fields present but live fields are null");
  if (live != null && !canonicalEqual(stored ?? null, live)) failures.push("recovered_fields");
  return { ok: failures.length === 0, failures };
}

/** Fail when the committed row's identity, intent, params, or verdict/checks disagree with the live re-derivation. */
export function storedLedgerAgrees(r: LedgerIdentity, v: VerifyOutput): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if ((r.miner_receipt?.receipt_id ?? null) !== (v.minerReceipt?.receipt_id ?? null)) failures.push("receipt_id");
  if ((r.miner_receipt?.raw_response_sha256 ?? null) !== (v.minerReceipt?.raw_response_sha256 ?? null)) failures.push("raw_response_sha256");
  if (r.raw_sha256_recomputed !== v.rawSha256) failures.push("raw_sha256_recomputed");
  if (r.raw_bytes !== v.rawBytes) failures.push("raw_bytes");
  if (r.intent !== v.intentId) failures.push("intent_id");
  if (!paramsEqual(r.params, v.requestParams)) failures.push("params");
  const storedAllOk = r.checks.length > 0 && r.checks.every((c) => c.ok);
  if ((r.verdict === "VERIFIED") !== storedAllOk) failures.push("verdict-vs-stored-checks");
  if ((r.verdict === "VERIFIED") !== v.verified) failures.push("verdict-vs-live");
  if (!checksAgree(r.checks, v.checks)) failures.push("checks");
  failures.push(...receiptPendingShape(r).failures);
  if (
    typeof r.task_id !== "string" || typeof r.mission !== "string" || typeof r.title !== "string" || typeof r.value_field !== "string" ||
    !catalogAgrees({ task_id: r.task_id, mission: r.mission, title: r.title, intent: r.intent, value_field: r.value_field, params: r.params, recovered_fields: r.recovered_fields })
  ) {
    failures.push("catalog");
  }
  if (typeof r.value_field !== "string" || !valueFieldPinned(r.intent, r.value_field)) failures.push("value_field");
  if ("value" in r && !valuesAgree(r.value, v.payloadValue)) failures.push("value");
  if (typeof r.bought_at !== "string") failures.push("bought_at");
  else failures.push(...boughtAtAgrees(r.bought_at, r.telegraph_receipt.timestamp, v.signalTimestamp).failures);
  failures.push(...recoveredFieldsAgree(r.recovered_fields, v.fields).failures);
  if (r.engine?.field_status && !fieldStatusShapeOk(r.intent, r.engine.field_status)) failures.push("field_status");
  if (r.engine?.result && r.value_field && !valuesAgree(r.engine.result[r.value_field], r.value)) {
    failures.push("engine.result vs value");
  }
  failures.push(...okNumericEngineAgrees(r.engine?.result, r.engine?.field_status, v.payloadResponse, r.intent).failures);
  return { ok: failures.length === 0, failures };
}

export function uniquePurchaseIds(
  rows: Array<{
    task_id?: string;
    telegraph_receipt?: { receipt_hash?: string };
    signal_hash?: string;
    nonce?: string;
    miner_receipt?: { receipt_id?: string } | null;
  }>,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const track = (label: string, values: Array<string | undefined | null>, fold = false) => {
    const seen = new Map<string, number>();
    values.forEach((v, i) => {
      if (!v) return;
      const key = fold ? v.toLowerCase() : v;
      if (seen.has(key)) failures.push(`duplicate ${label} at ${seen.get(key)} and ${i}`);
      else seen.set(key, i);
    });
  };
  track("task_id", rows.map((r) => r.task_id));
  track("receipt_hash", rows.map((r) => r.telegraph_receipt?.receipt_hash));
  track("signal_hash", rows.map((r) => r.signal_hash));
  track("nonce", rows.map((r) => r.nonce), true);
  track("miner_receipt.receipt_id", rows.map((r) => r.miner_receipt?.receipt_id));
  return { ok: failures.length === 0, failures };
}

export function isOfficialPending404(status: number, body: string): boolean {
  if (status !== 404) return false;
  try {
    const j = JSON.parse(body) as { error?: unknown };
    return !!j && typeof j === "object" && !Array.isArray(j) && j.error === OFFICIAL_PENDING_ERROR;
  } catch {
    return false;
  }
}

export function isOfficialNotInBlock404(status: number, body: string): boolean {
  if (status !== 404) return false;
  try {
    const j = JSON.parse(body) as { error?: unknown };
    return !!j && typeof j === "object" && !Array.isArray(j) && j.error === OFFICIAL_NOT_IN_BLOCK_ERROR;
  } catch {
    return false;
  }
}

export async function verifyPurchase(input: VerifyInput, f: Fetch = fetch): Promise<VerifyOutput> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let minerReceipt: MinerReceipt | null = null;
  let rawSha256: string | null = null;
  let rawBytes: number | null = null;
  let payloadValue: unknown = undefined;
  let intentId: string | null = null;
  let request: string | null = null;
  let requestParams: Record<string, string> | null = null;
  let signalTimestamp: string | null = null;

  let payloadResponse: Record<string, unknown> | null = null;
  const empty = (): VerifyOutput => ({
    verified: false, checks, minerReceipt, rawSha256, rawBytes, payloadValue, intentId, request, requestParams, signalTimestamp, fields: null, payloadResponse,
  });

  const sigRes = await f(`${ENGINE_URL}/v1/signal/${input.signalHash}`);
  if (!sigRes.ok) {
    add("signal record", false, `GET /engine/v1/signal/{hash} HTTP ${sigRes.status}`);
    return empty();
  }
  const sig = (await sigRes.json()) as { signal_hash?: string; payload?: SignalPayload };
  const derived = signalHashOf(sig.payload);
  add("signal hash re-derived", derived === input.signalHash && sig.signal_hash === input.signalHash,
    `keccak256(payload)=${derived}`);
  add("signal wallet is the payer", String(sig.payload?.wallet_address).toLowerCase() === input.payer.toLowerCase(),
    String(sig.payload?.wallet_address));
  add("signal miner", sig.payload?.miner_slug === input.minerSlug, String(sig.payload?.miner_slug));
  intentId = typeof sig.payload?.intent_id === "string" ? sig.payload.intent_id : null;
  request = typeof sig.payload?.request === "string" ? sig.payload.request : null;
  signalTimestamp = typeof sig.payload?.timestamp === "string" ? sig.payload.timestamp : null;
  const parsed = parseEngineRequest(request);
  requestParams = parsed?.params ?? null;
  // An unparsable payload.request must fail the signal intent check (not only params later).
  const intentOk = intentId === input.intent && parsed !== null && parsed.intentId === input.intent;
  add("signal intent", intentOk, intentId ?? "no intent_id");

  const response = sig.payload?.response ?? {};
  payloadResponse = response;
  payloadValue = response[input.valueField];
  const engineValue = input.engineResult[input.valueField];
  add("engine value equals miner answer", engineValue !== undefined && engineValue !== null && engineValue === payloadValue,
    `${input.valueField}: engine=${JSON.stringify(engineValue)} miner=${JSON.stringify(payloadValue)}`);

  const r = response.receipt as MinerReceipt | undefined;
  if (!r || !RECEIPT_ID.test(String(r.receipt_id)) || !HEX64.test(String(r.raw_response_sha256))) {
    add("miner receipt present", false, "the miner answer carries no well-formed receipt");
    return empty();
  }
  minerReceipt = { receipt_id: r.receipt_id, raw_response_sha256: r.raw_response_sha256, upstream_url: r.upstream_url, intent: r.intent };
  add("miner receipt present", true, r.receipt_id);

  const meta = await f(`${MINER_BASE_URL}/receipts/${r.receipt_id}`);
  const metaJson = meta.ok ? ((await meta.json()) as { raw_response_sha256?: string }) : null;
  add("stored receipt metadata agrees", metaJson?.raw_response_sha256 === r.raw_response_sha256,
    meta.ok ? String(metaJson?.raw_response_sha256) : `HTTP ${meta.status}`);

  const raw = await f(`${MINER_BASE_URL}/receipts/${r.receipt_id}/raw`);
  if (raw.ok) {
    const bytes = new Uint8Array(await raw.arrayBuffer());
    rawBytes = bytes.byteLength;
    rawSha256 = sha256Hex(bytes);
  }
  add("sha256(stored raw bytes) = raw_response_sha256", rawSha256 === r.raw_response_sha256,
    raw.ok ? `${rawSha256} over ${rawBytes} bytes` : `HTTP ${raw.status}`);

  const verified = checks.every((c) => c.ok);
  const fields = verified && input.fieldStatus
    ? reconcileShaped({ intent: input.intent, result: input.engineResult, field_status: input.fieldStatus }, response, { rawVerified: true })
    : null;
  return { verified, checks, minerReceipt, rawSha256, rawBytes, payloadValue, intentId, request, requestParams, signalTimestamp, fields, payloadResponse };
}

export interface DeliveryProof {
  status: "included" | "pending" | "error";
  detail: string;
  deliveriesRoot?: string;
  delivery?: Record<string, unknown>;
  epochId?: number;
  proof?: string[];
}

/** GET /v1/blocks/{epochId}/deliveries/{receiptHash} at the node root (escrow-inference.md Step 4). */
export async function checkDelivery(epochId: number, receiptHash: string, f: Fetch = fetch): Promise<DeliveryProof> {
  const res = await f(`${NODE_URL}/v1/blocks/${epochId}/deliveries/${receiptHash}`);
  const text = await res.text();
  if (res.status === 404) {
    if (isOfficialPending404(404, text)) return { status: "pending", detail: text.slice(0, 200) };
    return { status: "error", detail: `HTTP 404 ${text.slice(0, 200)}` };
  }
  if (!res.ok) return { status: "error", detail: `HTTP ${res.status} ${text.slice(0, 200)}` };
  const j = JSON.parse(text) as { delivery?: Record<string, unknown>; deliveries_root?: string; epoch_id?: number; proof?: unknown };
  const proof = Array.isArray(j.proof) && j.proof.every((p) => typeof p === "string") ? (j.proof as string[]) : undefined;
  return {
    status: "included",
    detail: "delivery row returned by the node",
    deliveriesRoot: j.deliveries_root,
    delivery: j.delivery,
    epochId: typeof j.epoch_id === "number" ? j.epoch_id : undefined,
    proof,
  };
}

/** A delivery lookup is OK only when the epoch block is still pending, or when the included row matches the receipt. An "error" (HTTP failure, etc.) must not count as OK. */
export function deliveryIsOk(
  d: DeliveryProof,
  receipt: { receipt_hash: string; amount_uusdc: string; miner?: string },
  payer: string,
  intent?: string,
): boolean {
  if (d.status === "error") return false;
  if (d.status === "pending") return true;
  if (d.status !== "included" || !d.delivery) return false;
  // receipt_hash must be present on the delivery row; do not fall back to the ledger's own hash.
  if (typeof d.delivery.receipt_hash !== "string" || d.delivery.receipt_hash !== receipt.receipt_hash) return false;
  if (String(d.delivery.payer ?? "").toLowerCase() !== payer.toLowerCase()) return false;
  if (Number(d.delivery.usdc) !== Number(receipt.amount_uusdc)) return false;
  if (intent != null && String(d.delivery.intent ?? "") !== intent) return false;
  if (String(d.delivery.miner_id ?? "") !== VERIRECEIPT_ONCHAIN_MINER_ID) return false;
  if (receipt.miner !== undefined && receipt.miner !== VERIRECEIPT_ONCHAIN_MINER_ID) return false;
  return true;
}

/**
 * Shape-check the official Merkle proof the delivery endpoint returns.
 * We do not walk the proof: the leaf/node hash algorithm is not documented.
 */
export function merkleProofShapeOk(d: DeliveryProof): boolean {
  if (d.status !== "included") return true;
  if (typeof d.deliveriesRoot !== "string" || !RECEIPT_HASH_RE.test(d.deliveriesRoot)) return false;
  if (!d.proof || d.proof.length < 1 || d.proof.length > 32) return false;
  return d.proof.every((p) => typeof p === "string" && RECEIPT_HASH_RE.test(p));
}

export type StoredDeliveryProof = {
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
};

/** What `--write` may store. Never stores `included` when the delivery row mismatches or lacks receipt_hash. */
export function deliveryProofToStore(d: DeliveryProof, deliveryOk: boolean, checkedAt: string): StoredDeliveryProof | null {
  if (deliveryOk && d.status === "pending") {
    return { status: "pending", checked_at: checkedAt };
  }
  if (deliveryOk && d.status === "included" && d.delivery) {
    return {
      status: "included",
      checked_at: checkedAt,
      ...(d.deliveriesRoot ? { deliveries_root: d.deliveriesRoot } : {}),
      ...(d.epochId != null ? { epoch_id: d.epochId } : {}),
      receipt_hash: String(d.delivery.receipt_hash),
      payer: String(d.delivery.payer),
      usdc: Number(d.delivery.usdc),
      ...(typeof d.delivery.intent === "string" ? { intent: d.delivery.intent } : {}),
      ...(typeof d.delivery.miner_id === "string" ? { miner_id: d.delivery.miner_id } : {}),
      ...(d.proof ? { proof_nodes: d.proof.length } : {}),
    };
  }
  if (d.status === "included" && !deliveryOk) {
    return { status: "error", checked_at: checkedAt };
  }
  return null;
}

function normAddr(s: unknown): string {
  return String(s ?? "").toLowerCase();
}

/**
 * Compare a stored delivery_proof with the live lookup.
 * Stored `pending` while live is `included` is stale (run --write), not a pass.
 * Stored `included` vs live pending, a forged root, or a bogus status fails.
 */
export function storedDeliveryAgrees(
  stored: StoredDeliveryProof | null | undefined,
  live: DeliveryProof,
  row: { telegraph_receipt: { receipt_hash: string; amount_uusdc: string; epoch_id: number; miner?: string }; payer: string; intent: string },
): { ok: boolean; failures: string[]; stale: boolean } {
  const failures: string[] = [];
  let stale = false;
  const status = stored?.status;
  if (status && status !== "pending" && status !== "included" && status !== "error") {
    failures.push("delivery_proof status");
  }
  if ((!stored || status === "pending" || status === "error") && live.status === "included") {
    failures.push("delivery_proof stale (run --write)");
    stale = true;
  }
  if (status === "included" && live.status === "pending") {
    failures.push("delivery_proof included but live pending");
  }
  if (status === "included" && live.status === "error") {
    failures.push("delivery_proof included but live error");
  }
  if (live.status === "included") {
    if (!merkleProofShapeOk(live)) failures.push("merkle proof shape");
    if (stored && status === "included") {
      if ((stored.deliveries_root ?? "") !== (live.deliveriesRoot ?? "")) failures.push("deliveries_root");
      if (stored.epoch_id != null && live.epochId != null && stored.epoch_id !== live.epochId) failures.push("delivery epoch_id");
      if (stored.receipt_hash != null && stored.receipt_hash !== live.delivery?.receipt_hash) failures.push("delivery receipt_hash");
      if (stored.payer != null && normAddr(stored.payer) !== normAddr(live.delivery?.payer)) failures.push("delivery payer");
      if (stored.usdc != null && Number(stored.usdc) !== Number(live.delivery?.usdc)) failures.push("delivery usdc");
      if (stored.intent != null && stored.intent !== live.delivery?.intent) failures.push("delivery intent");
      if (stored.miner_id != null && stored.miner_id !== live.delivery?.miner_id) failures.push("delivery miner_id");
    }
    if (live.epochId != null && live.epochId !== row.telegraph_receipt.epoch_id) failures.push("live epoch_id != receipt epoch_id");
    if (live.delivery) {
      if (live.delivery.receipt_hash !== row.telegraph_receipt.receipt_hash) failures.push("live receipt_hash");
      if (normAddr(live.delivery.payer) !== normAddr(row.payer)) failures.push("live payer");
      if (Number(live.delivery.usdc) !== Number(row.telegraph_receipt.amount_uusdc)) failures.push("live usdc");
      if (String(live.delivery.intent ?? "") !== row.intent) failures.push("live intent");
      if (row.telegraph_receipt.miner != null && String(live.delivery.miner_id ?? "") !== row.telegraph_receipt.miner) {
        failures.push("live miner_id");
      }
    }
  }
  return { ok: failures.length === 0, failures, stale };
}

export interface EpochBlockWindow {
  status: "recorded" | "pending" | "error";
  detail: string;
  epoch_id?: number;
  windowFromMs?: number;
  windowToMs?: number;
  deliveriesRoot?: string;
}

/** GET /v1/blocks/{epochId} — used for window_from / window_to consistency. */
export async function fetchEpochBlock(epochId: number, f: Fetch = fetch): Promise<EpochBlockWindow> {
  const res = await f(`${NODE_URL}/v1/blocks/${epochId}`);
  const text = await res.text();
  if (res.status === 404) {
    if (isOfficialPending404(404, text)) return { status: "pending", detail: text.slice(0, 200) };
    return { status: "error", detail: `HTTP 404 ${text.slice(0, 200)}` };
  }
  if (!res.ok) return { status: "error", detail: `HTTP ${res.status} ${text.slice(0, 200)}` };
  const j = JSON.parse(text) as { deliveries_root?: string; epoch_id?: number; body?: { window_from?: string; window_to?: string; epoch_id?: number }; window_from?: string; window_to?: string };
  const body = (j.body ?? j) as { window_from?: string; window_to?: string; epoch_id?: number };
  const windowFromMs = parseTimeMs(body.window_from);
  const windowToMs = parseTimeMs(body.window_to);
  return {
    status: "recorded",
    detail: "block recorded",
    epoch_id: typeof j.epoch_id === "number" ? j.epoch_id : typeof body.epoch_id === "number" ? body.epoch_id : epochId,
    windowFromMs: windowFromMs ?? undefined,
    windowToMs: windowToMs ?? undefined,
    deliveriesRoot: j.deliveries_root,
  };
}

/** Adjacent official windows share a boundary; treat [window_from, window_to). */
export function timeInEpochWindow(t: number, from: number, to: number): boolean {
  return t >= from && t < to;
}

/** Cheap probe: recorded iff the official delivery lookup is not "no block recorded". */
export async function epochBlockRecorded(epochId: number, f: Fetch = fetch): Promise<"recorded" | "pending" | "error"> {
  const d = await checkDelivery(epochId, EPOCH_PROBE_HASH, f);
  if (d.status === "pending") return "pending";
  if (d.status === "included") return "recorded";
  if (isOfficialNotInBlock404(404, d.detail) || d.detail.includes(OFFICIAL_NOT_IN_BLOCK_ERROR)) return "recorded";
  return "error";
}

/** Latest recorded epoch in [0, hi], assuming recorded epochs form a prefix (no holes). */
export async function findLatestRecordedEpoch(hi: number, f: Fetch = fetch): Promise<number | null> {
  if (hi < 0) return null;
  let lo = 0;
  let high = hi;
  let ans: number | null = null;
  while (lo <= high) {
    const mid = Math.floor((lo + high) / 2);
    const st = await epochBlockRecorded(mid, f);
    if (st === "recorded") {
      ans = mid;
      lo = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return ans;
}

/**
 * Bound epoch_id by the receipt timestamp: if a recorded block window contains
 * the receipt time, epoch_id must be that epoch (so 99999 cannot stay pending).
 * If the time is after the latest recorded window_to, pending is OK only at latest+1.
 */
export async function checkEpochConsistency(
  input: { claimedEpoch: number; receiptTimeMs: number },
  f: Fetch = fetch,
): Promise<{ ok: boolean; failures: string[]; liveEpoch?: number }> {
  const failures: string[] = [];
  if (!Number.isSafeInteger(input.claimedEpoch) || input.claimedEpoch < 0) {
    return { ok: false, failures: ["epoch_id shape"] };
  }
  const claimed = await fetchEpochBlock(input.claimedEpoch, f);
  if (claimed.status === "recorded") {
    if (claimed.windowFromMs == null || claimed.windowToMs == null) {
      return { ok: false, failures: ["epoch window missing"] };
    }
    if (!timeInEpochWindow(input.receiptTimeMs, claimed.windowFromMs, claimed.windowToMs)) {
      failures.push("epoch_id window does not contain receipt time");
    }
    return { ok: failures.length === 0, failures, liveEpoch: input.claimedEpoch };
  }
  if (claimed.status === "error") {
    return { ok: false, failures: [`epoch block ${claimed.detail}`] };
  }
  const latest = await findLatestRecordedEpoch(input.claimedEpoch - 1, f);
  if (latest == null) return { ok: true, failures: [] };
  let e: number | null = latest;
  while (e != null && e >= 0) {
    const b = await fetchEpochBlock(e, f);
    if (b.status !== "recorded" || b.windowFromMs == null || b.windowToMs == null) break;
    if (timeInEpochWindow(input.receiptTimeMs, b.windowFromMs, b.windowToMs)) {
      failures.push(`receipt time falls in recorded epoch ${e}, not ${input.claimedEpoch}`);
      return { ok: false, failures, liveEpoch: e };
    }
    if (input.receiptTimeMs >= b.windowToMs) break;
    e -= 1;
  }
  const latestBlock = await fetchEpochBlock(latest, f);
  if (latestBlock.status === "recorded" && latestBlock.windowToMs != null && input.receiptTimeMs >= latestBlock.windowToMs) {
    if (input.claimedEpoch !== latest + 1) {
      failures.push(`pending epoch_id must be ${latest + 1} (next after recorded epoch ${latest}), not ${input.claimedEpoch}`);
    }
  }
  return { ok: failures.length === 0, failures };
}
