// Desk MCP surface (Streamable HTTP, JSON-RPC 2.0, keyless).
//
// The Desk exposes its agent tools at POST /api/mcp. This module is the
// router: it owns the JSON-RPC envelope and the tool registry, and each
// tool is a plain function so other Desk tools (run_m13_allocation_check,
// run_m12_dispatch_check, get_ledger) can register here without touching
// the transport.
//
// Tools shipped here:
//   - verify_receipt: input { signal_hash } or { receipt_id }.
//     Verifies a Telegraph signal end-to-end (see src/desk/verify.ts).
//     A receipt_id resolves through the Desk ledger
//     (receipts/ledger.jsonl, one JSON object per line with receipt_id
//     and signal_hash); without a ledger entry the tool refuses with a
//     clear error instead of guessing — pass signal_hash directly.
//
// No authentication: the blueprint's Desk MCP surface is keyless by
// design (the same as the miner's auth.type: none). The tool performs
// read-only devnode lookups; it never spends, signs, or moves funds.

import { readFileSync } from "fs";
import { resolve } from "path";
import {
  verifyReceipt,
  isHash,
  type FetchFn,
  type ReceiptVerdict,
} from "./verify";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  /** JSON-RPC "result" for tools/call: MCP content blocks + structured result. */
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

export interface McpDeps {
  fetchFn?: FetchFn;
  /** Desk ledger path for receipt_id → signal_hash resolution. */
  ledgerPath?: string;
  now?: () => string;
}

const VERIFY_RECEIPT_TOOL: McpToolDefinition = {
  name: "verify_receipt",
  description:
    "Verify a Telegraph receipt end-to-end: checks verification.verified on " +
    "GET /engine/v1/signal/<signal_hash> (the answer) and, when the ask " +
    "recorded one, the delivery proof on " +
    "GET /v1/blocks/{epoch}/deliveries/<receipt_hash> (the payment). " +
    "Returns a structured verdict {verified, signal_hash, receipt_hash, " +
    "epoch, checked_at, status, signal, delivery, detail}. " +
    "signal_hash and receipt_hash are DIFFERENT hashes: signal_hash comes " +
    "from the ask response, receipt_hash from fulfillment.payments[] — " +
    "never reuse one for the other. A delivery lookup before the epoch " +
    "closes returns status 'pending' (Pending epoch finalization), " +
    "never a broken 404 link. With no receipt_hash the delivery half is " +
    "reported as unchecked, not failed — and the overall verdict is " +
    "'partial' (verified:false), never 'verified': signal-only must " +
    "never read as verified. Direct signal_hash/receipt_hash inputs are " +
    "caller-paired (the caller asserts both hashes belong to the same " +
    "ask); a receipt_id resolves both hashes from one ledger row. " +
    "Pass signal_hash, or receipt_id when the Desk ledger maps it to a signal_hash.",
  inputSchema: {
    type: "object",
    properties: {
      signal_hash: {
        type: "string",
        description: "Telegraph signal hash: 0x + 64 hex characters.",
      },
      receipt_hash: {
        type: "string",
        description:
          "Delivery receipt hash from the ask's fulfillment.payments[] " +
          "(0x + 64 hex). Different from signal_hash — never reuse one " +
          "for the other. Omit when the ask recorded none.",
      },
      epoch: {
        type: "integer",
        description:
          "Epoch the delivery settled in. Omit to let the tool discover " +
          "the latest finalized epoch and scan down from it.",
      },
      receipt_id: {
        type: "string",
        description:
          "Desk receipt id (rcpt_ + 26 chars). Resolved via receipts/ledger.jsonl; " +
          "pass signal_hash directly when no ledger entry exists.",
      },
    },
    required: [],
  },
};

function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: `error: ${message}` }],
    structuredContent: { error: message },
    isError: true,
  };
}

function okResult(verdict: ReceiptVerdict): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(verdict, null, 2) }],
    structuredContent: verdict as unknown as Record<string, unknown>,
    isError: false,
  };
}

export interface LedgerEntry {
  signal_hash: string;
  /**
   * Present-but-malformed values are preserved as-is (unknown) so the
   * handler can refuse them — dropping them would silently report a
   * false "partial". Only a genuinely ABSENT field means "no
   * receipt_hash was recorded". (Round-4 F2.)
   */
  receipt_hash?: unknown;
  epoch?: number;
}

/**
 * Resolve a Desk receipt_id to its ledger entry (signal_hash plus, when
 * the ask recorded them, receipt_hash and epoch) via the ledger file.
 * Returns null when the ledger is absent or holds no such receipt —
 * the caller then refuses with a clear message instead of guessing.
 */
export function resolveLedgerEntry(
  receiptId: string,
  ledgerPath?: string,
): LedgerEntry | null {
  const path = ledgerPath ?? resolve(process.cwd(), "receipts", "ledger.jsonl");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // No ledger yet — not an error, just unresolvable.
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (row["receipt_id"] === receiptId && typeof row["signal_hash"] === "string") {
        const entry: LedgerEntry = { signal_hash: row["signal_hash"] };
        // Round-4 F2: preserve a PRESENT receipt_hash whatever its
        // type/value ("", 12345, "zzz", ...) — only a genuinely ABSENT
        // field means "no receipt_hash was recorded". The old
        // typeof === "string" copy dropped a numeric value and the
        // truthiness check at the call site dropped "", so both
        // silently became a false "partial" with the false detail
        // "No receipt_hash was recorded for this ask".
        if ("receipt_hash" in row) {
          entry.receipt_hash = row["receipt_hash"];
        }
        if (typeof row["epoch"] === "number") entry.epoch = row["epoch"];
        return entry;
      }
    } catch {
      continue; // A corrupt ledger line never blocks the other rows.
    }
  }
  return null;
}

/** Resolve a Desk receipt_id to its signal_hash via the ledger file. */
export function resolveReceiptId(
  receiptId: string,
  ledgerPath?: string,
): string | null {
  return resolveLedgerEntry(receiptId, ledgerPath)?.signal_hash ?? null;
}

export function verifyReceiptTool(deps: McpDeps = {}): {
  definition: McpToolDefinition;
  handler: ToolHandler;
} {
  const handler: ToolHandler = async (args) => {
    const signalHash = args["signal_hash"];
    const receiptId = args["receipt_id"];
    // Mistyped inputs fail closed BEFORE any fetch: a non-string
    // signal_hash / receipt_id / receipt_hash is refused, never
    // silently ignored (a mistyped payment half must never vanish).
    if (signalHash !== undefined && typeof signalHash !== "string") {
      return errorResult("signal_hash must be a string (0x + 64 hex characters). Nothing was verified.");
    }
    if (receiptId !== undefined && typeof receiptId !== "string") {
      return errorResult("receipt_id must be a string. Nothing was verified.");
    }
    if (
      args["receipt_hash"] !== undefined &&
      args["receipt_hash"] !== null &&
      typeof args["receipt_hash"] !== "string"
    ) {
      return errorResult(
        "receipt_hash must be a string (0x + 64 hex characters) when given. Nothing was verified.",
      );
    }
    let hash: string | null = null;

    if (typeof signalHash === "string" && signalHash.length > 0) {
      hash = signalHash;
    } else if (typeof receiptId === "string" && receiptId.length > 0) {
      const resolved = resolveLedgerEntry(receiptId, deps.ledgerPath);
      if (resolved === null) {
        return errorResult(
          `receipt_id ${receiptId} has no usable signal_hash in the Desk ledger ` +
            `(receipts/ledger.jsonl) — pass signal_hash directly. ` +
            `Nothing was verified.`,
        );
      }
      hash = resolved.signal_hash;
      // A ledger entry may carry the ask's receipt_hash/epoch; they ride
      // along unless the caller passed explicit values (explicit wins).
      // Round-4 F2: presence, not truthiness — a present-but-malformed
      // ledger receipt_hash ("", 12345) must reach the validation
      // below and error, never be dropped into a false "partial".
      // Round-5 F1: a ledger-supplied null is PRESENT, not absent —
      // the resolver preserves it ("receipt_hash" in row), so copying
      // it into args would let the null carve-out in the second
      // validation below treat it as absent and return a false
      // "partial" ("No receipt_hash was recorded"). Refuse it here,
      // at the ledger-copy site, before it can masquerade as absent.
      // Direct-args null stays "absent" (the contract is
      // receipt_hash?: string | null and the first check above also
      // skips null) — only ledger-sourced null errors.
      if (args["receipt_hash"] === undefined && resolved.receipt_hash === null) {
        return errorResult(
          "receipt_hash must be a string (0x + 64 hex characters) when given — the Desk ledger records a null receipt_hash for this ask. Nothing was verified.",
        );
      }
      if (args["receipt_hash"] === undefined && resolved.receipt_hash !== undefined) {
        args = { ...args, receipt_hash: resolved.receipt_hash };
      }
      if (args["epoch"] === undefined && typeof resolved.epoch === "number") {
        args = { ...args, epoch: resolved.epoch };
      }
    } else {
      return errorResult(
        "verify_receipt needs signal_hash or receipt_id. Nothing was verified.",
      );
    }

    if (!isHash(hash)) {
      return errorResult(
        "signal_hash must be 0x + 64 hex characters. Nothing was verified.",
      );
    }

    const receiptHash = args["receipt_hash"];
    const epochRaw = args["epoch"];
    // Round-4 F2: validate the receipt_hash AGAIN here, not only the
    // direct-args check above — a ledger-supplied value ("" / 12345 /
    // "zzz") is assigned to args AFTER that check, so without this it
    // would slip past validation and silently become a false "partial".
    if (
      receiptHash !== undefined &&
      receiptHash !== null &&
      typeof receiptHash !== "string"
    ) {
      return errorResult(
        "receipt_hash must be a string (0x + 64 hex characters) when given. Nothing was verified.",
      );
    }
    // Round-3 F4: an explicitly-passed empty-string receipt_hash is a
    // malformed payment half, not an absent one. The length>0 coercion
    // below used to turn "" into null, yielding a "partial" verdict
    // whose detail falsely claimed no receipt_hash was recorded.
    if (receiptHash === "") {
      return errorResult(
        "receipt_hash must not be empty — an empty receipt_hash is a malformed payment half, not an absent one. Nothing was verified.",
      );
    }
    let receipt: string | null = null;
    if (typeof receiptHash === "string" && receiptHash.length > 0) {
      if (!isHash(receiptHash)) {
        return errorResult(
          "receipt_hash must be 0x + 64 hex characters. Nothing was verified.",
        );
      }
      receipt = receiptHash;
    }
    let epoch: number | null = null;
    if (epochRaw !== undefined && epochRaw !== null) {
      if (typeof epochRaw !== "number" || !Number.isInteger(epochRaw) || epochRaw < 0) {
        return errorResult("epoch must be a non-negative integer. Nothing was verified.");
      }
      epoch = epochRaw;
    }

    // verifyReceipt throws only on mistyped input (validated above), so
    // reaching the catch is a defect — surface it as a tool error,
    // never as a verdict.
    let verdict: ReceiptVerdict;
    try {
      verdict = await verifyReceipt(
        { signal_hash: hash, receipt_hash: receipt, epoch },
        {
          fetchFn: deps.fetchFn,
          now: deps.now,
        },
      );
    } catch (err) {
      return errorResult(
        `Verification refused: ${err instanceof Error ? err.message : "invalid input"}`,
      );
    }
    return okResult(verdict);
  };
  return { definition: VERIFY_RECEIPT_TOOL, handler };
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcError(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Handle one JSON-RPC 2.0 request body for POST /api/mcp.
 *
 * Methods: initialize, tools/list, tools/call. Anything else returns
 * -32601 (method not found); a malformed body returns -32600 (invalid
 * request). A tool that refuses its input returns a tools/call result
 * with isError:true (the MCP convention) — the RPC itself still succeeds.
 */
export async function handleMcpRequest(
  body: unknown,
  deps: McpDeps = {},
): Promise<JsonRpcResponse> {
  const tool = verifyReceiptTool(deps);
  const tools: Record<string, ToolHandler> = { [tool.definition.name]: tool.handler };
  const definitions = [tool.definition];

  if (!isRecord(body)) {
    return rpcError(null, -32600, "Invalid Request: body must be a JSON-RPC object.");
  }
  const id = body["id"] ?? null;
  if (body["jsonrpc"] !== "2.0" || typeof body["method"] !== "string") {
    return rpcError(id, -32600, "Invalid Request: expected jsonrpc 2.0 with a method.");
  }

  switch (body["method"]) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "verireceipt-desk", version: "2.0.0" },
        },
      };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: definitions } };
    case "tools/call": {
      const params = isRecord(body["params"]) ? body["params"] : {};
      const name = params["name"];
      if (typeof name !== "string" || !(name in tools)) {
        return rpcError(id, -32602, `Unknown tool: ${typeof name === "string" ? name : "?"}`);
      }
      const args = isRecord(params["arguments"]) ? params["arguments"] : {};
      const result = await tools[name](args);
      return { jsonrpc: "2.0", id, result };
    }
    default:
      return rpcError(id, -32601, `Method not found: ${body["method"]}`);
  }
}
