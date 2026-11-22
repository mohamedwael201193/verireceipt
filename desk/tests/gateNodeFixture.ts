// Shared mock node for gate/probe tests: serves the 402 challenge, the paid
// ask, the signal record, delivery/epoch endpoints and the miner receipt.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { vi } from "vitest";
import { sha256Hex, signalHashOf } from "../src/verify";

const live402auto = readFileSync(join(__dirname, "fixtures", "challenge-774921.json"), "utf8").replaceAll("/v1/ask/774921", "/v1/ask");
const acct = privateKeyToAccount(generatePrivateKey());
export const makePayer = () => ({ address: acct.address, signMessage: vi.fn((message: string) => acct.signMessage({ message })) });
export const payerAddress = acct.address.toLowerCase();

export const RECEIPT_HASH = "0x" + "ab".repeat(32);
export const RAW = new TextEncoder().encode("upstream defillama bytes");
export const RAW_SHA = sha256Hex(RAW);
export const RCPT = "rcpt_" + "A".repeat(26);

export interface NodeOpts {
  miner?: string;
  intent?: string;
  valueField?: string;
  resultFields?: Record<string, unknown>;
  minerSlug?: string | null;
  value?: number;
  payloadValue?: number;
  signalHash?: string;
  delivery?: "included" | "pending";
  available?: string;
  wallet?: string;
  requestParams?: Record<string, string>;
  badReceiptHeader?: boolean;
  /** The previous epoch's block-WINDOW endpoint errors (pending cannot be legitimized). */
  prevProbeError?: boolean;
  prevWindow?: { fromOffsetSec: number; toOffsetSec: number; epochId?: number | null };
  /** field_status for the paid reply; null omits the field. Default { tvl_usd: "ok" }. */
  fieldStatus?: Record<string, string> | null;
  /** Override the signal payload timestamp; null omits the field. */
  payloadTimestamp?: string | null;
  /** The paid POST rejects after submission (network failure). */
  paidRejects?: boolean;
}

export function node(opts: NodeOpts = {}) {
  const miner = opts.miner ?? "6160";
  const intent = opts.intent ?? "TVL_LOOKUP_GENERAL";
  const valueField = opts.valueField ?? "tvl_usd";
  const value = opts.value ?? 2_000_000_000;
  const payloadValue = opts.payloadValue ?? value;
  const ts = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    wallet_address: opts.wallet ?? payerAddress,
    intent_id: intent,
    request: `[intent] ${intent} → ${JSON.stringify(opts.requestParams ?? { protocol: "aave-v3" })}`,
    response: { [valueField]: payloadValue, ...opts.resultFields, receipt: { receipt_id: RCPT, raw_response_sha256: RAW_SHA, upstream_url: "https://api.llama.fi/protocol/aave-v3" } },
    timestamp: opts.payloadTimestamp === null ? undefined : (opts.payloadTimestamp ?? new Date(ts * 1000).toISOString()),
  };
  if (opts.minerSlug !== null) payload.miner_slug = opts.minerSlug ?? "verireceipt";
  if (payload.timestamp === undefined) delete payload.timestamp;
  const signalHash = signalHashOf(payload);
  const body: Record<string, unknown> = {
    miner_id: miner, endpoint: "/v1/tvl", result_shape: "intent",
    result: { [valueField]: value, ...opts.resultFields }, signal_hash: opts.signalHash ?? signalHash,
  };
  if (opts.fieldStatus !== null) body.field_status = opts.fieldStatus ?? { [valueField]: "ok" };
  const receipt = {
    receipt_hash: RECEIPT_HASH, rail: "escrow", payer: payerAddress, miner, intent,
    amount_uusdc: "10000", epoch_id: 40, settlement: "epoch", chain: "telegraph", timestamp: ts,
  };
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/ledger/account/")) {
      return new Response(JSON.stringify({ available: opts.available ?? "1000000", balance: "1", deposited: "1", unbilled: "0", charged: "0" }));
    }
    if (url === "https://devnode.telegraphprotocol.com/engine/v1/ask") {
      if (!new Headers(init?.headers).get("X-PAYMENT")) return new Response(live402auto, { status: 402 });
      if (opts.paidRejects) throw new Error("socket hangup after submission");
      const header = opts.badReceiptHeader ? Buffer.from(JSON.stringify({ ...receipt, miner: "x" })).toString("base64") : Buffer.from(JSON.stringify(receipt)).toString("base64");
      return new Response(JSON.stringify(body), { status: 200, headers: { "x-payment-response": header } });
    }
    if (url.includes("/engine/v1/signal/")) return new Response(JSON.stringify({ signal_hash: signalHash, payload }));
    if (url.includes("/v1/blocks/40/deliveries/")) {
      if (opts.delivery === "pending") return new Response(JSON.stringify({ error: "no block recorded for this epoch" }), { status: 404 });
      return new Response(JSON.stringify({
        delivery: { receipt_hash: RECEIPT_HASH, payer: payerAddress, usdc: 10000, intent, miner_id: miner },
        deliveries_root: "0x" + "ef".repeat(32), epoch_id: 40, proof: ["0x" + "01".repeat(32)],
      }));
    }
    if (url.endsWith("/v1/blocks/40")) {
      if (opts.delivery === "pending") return new Response(JSON.stringify({ error: "no block recorded for this epoch" }), { status: 404 });
      return new Response(JSON.stringify({ epoch_id: 40, window_from: new Date((ts - 60) * 1000).toISOString(), window_to: new Date((ts + 60) * 1000).toISOString() }));
    }
    if (url.includes("/v1/blocks/39/deliveries/")) {
      // Epoch 39 is recorded: an unknown receipt is "not in this block".
      return new Response(JSON.stringify({ error: "receipt not in this block" }), { status: 404 });
    }
    if (url.endsWith("/v1/blocks/39")) {
      // The predecessor WINDOW endpoint: a failure here must fail pending closed.
      if (opts.prevProbeError) return new Response("node exploded", { status: 500 });
      return new Response(JSON.stringify({ epoch_id: opts.prevWindow?.epochId === null ? undefined : opts.prevWindow?.epochId ?? 39, window_from: new Date((ts + (opts.prevWindow?.fromOffsetSec ?? -180)) * 1000).toISOString(), window_to: new Date((ts + (opts.prevWindow?.toOffsetSec ?? -61)) * 1000).toISOString() }));
    }
    if (url.includes("/v1/blocks/")) return new Response(JSON.stringify({ error: "no block recorded for this epoch" }), { status: 404 });
    if (url.endsWith(`/receipts/${RCPT}`)) return new Response(JSON.stringify({ raw_response_sha256: RAW_SHA }));
    if (url.endsWith(`/receipts/${RCPT}/raw`)) return new Response(RAW);
    throw new Error(`unexpected fetch ${url}`);
  });
  return { f: f as unknown as typeof fetch };
}
