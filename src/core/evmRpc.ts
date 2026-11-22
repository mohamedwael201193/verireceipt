// Shared low-level EVM JSON-RPC helpers (intent expansion, 2026-11-22).
//
// WHY THIS FILE EXISTS: the gas-price, wallet-balance and token-supply
// handlers all need the exact call mechanics txLookup.ts already uses
// (one POST per call, 12 s per-call budget, strict JSON-RPC envelope
// checks). Those helpers were private to txLookup. They are copied here
// VERBATIM in behaviour — same timeouts, same error shapes — so the new
// handlers ride the proven path without editing txLookup (an untouched
// txLookup keeps its own 12/12 gate green; a refactor would put both
// lanes in one diff). txLookup keeps its private copies for now.
//
// Rules every caller inherits (measured 2026-11-20/21, see txLookup.ts):
// - Legs are run SEQUENTIALLY by the handlers (one POST at a time); the
//   6-way concurrent fan-out self-timed-out while sequential serves.
// - Every hex quantity must match HEX_QTY_RE: decimal "123" is malformed,
//   never 123 wei.

/** Per-call RPC budget (A2-fix, 2026-11-20): 12 s for EACH upstream POST. */
export const RPC_TIMEOUT_MS = 12000;

/** A hex quantity must be 0x-prefixed hex (txLookup R4 MINOR 1). */
export const HEX_QTY_RE = /^0x[0-9a-fA-F]+$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function assertHexQty(v: string, field: string): void {
  if (!HEX_QTY_RE.test(v)) {
    throw new Error(`malformed ${field}: not a 0x-prefixed hex quantity: ${v}`);
  }
}

/**
 * One JSON-RPC POST. Returns the parsed `result` AND the exact raw
 * response text (receipt evidence hashes the raw text). Throws on HTTP
 * errors, invalid JSON, JSON-RPC error objects and missing `result` —
 * the caller treats any throw as an errored leg.
 */
export async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
): Promise<{ result: unknown; rawText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${url}`);
    const rawText = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`RPC invalid JSON from ${url}`);
    }
    if (!isRecord(parsed)) throw new Error(`RPC malformed response from ${url}`);
    if (parsed.error !== undefined && parsed.error !== null) {
      throw new Error(`RPC error from ${url}: ${JSON.stringify(parsed.error)}`);
    }
    if (!("result" in parsed)) throw new Error(`RPC response without result from ${url}`);
    return { result: parsed.result, rawText };
  } finally {
    clearTimeout(timer);
  }
}
