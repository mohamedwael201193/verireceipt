// Desk MCP tests — src/desk/mcp.ts + the /api/mcp and /api/desk/verify
// routes in src/server.ts.
//
// The devnode is stubbed through handleMcpRequest deps; the route tests
// use Fastify inject with no network (only the no-fetch paths: bad
// input, tools/list, unknown method).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { handleMcpRequest, resolveReceiptId, resolveLedgerEntry } from "../src/desk/mcp";
import { signalUrl, deliveryUrl, type FetchFn } from "../src/desk/verify";

const SIGNAL =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const RECEIPT =
  "0x2222222222222222222222222222222222222222222222222222222222222222";
const FIXED_NOW = "2026-11-20T18:00:00.000Z";

function verifiedFetch(): FetchFn {
  return async (url: string) => {
    if (url === signalUrl(SIGNAL)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          verification: { algorithm: "keccak256", commitment: "payload", verified: true },
        }),
      };
    }
    if (url === deliveryUrl(24, RECEIPT)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          delivery: { receipt_hash: RECEIPT },
          epoch_id: 24,
          proof: ["0xaaa"],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

describe("handleMcpRequest — initialize / tools/list", () => {
  it("initialize returns protocol version and server info", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    const result = res.result as Record<string, unknown>;
    expect(typeof result["protocolVersion"]).toBe("string");
    expect((result["serverInfo"] as Record<string, unknown>)["name"]).toBe(
      "verireceipt-desk",
    );
  });

  it("tools/list exposes verify_receipt", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const result = res.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name)).toContain("verify_receipt");
  });

  it("unknown method → -32601", async () => {
    const res = await handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "nope" });
    expect(res.error?.code).toBe(-32601);
  });

  it("malformed body → -32600", async () => {
    const res = await handleMcpRequest("not-an-object");
    expect(res.error?.code).toBe(-32600);
    const res2 = await handleMcpRequest({ jsonrpc: "1.0", id: 1, method: "tools/list" });
    expect(res2.error?.code).toBe(-32600);
  });
});

describe("handleMcpRequest — tools/call verify_receipt", () => {
  it("signal_hash only → PARTIAL (verified:false, delivery null) — signal-only never reads as verified", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { signal_hash: SIGNAL } },
      },
      { fetchFn: verifiedFetch(), now: () => FIXED_NOW },
    );
    const result = res.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(false);
    // J2-F1, corrected: the old expectation (verified:true,
    // status:"verified") pinned the flaw.
    expect(result.structuredContent["verified"]).toBe(false);
    expect(result.structuredContent["status"]).toBe("partial");
    expect(result.structuredContent["signal_hash"]).toBe(SIGNAL);
    expect(result.structuredContent["checked_at"]).toBe(FIXED_NOW);
    expect(result.structuredContent["delivery"]).toBe(null);
    expect(result.content[0].text).toContain(SIGNAL);
  });

  it("signal_hash + receipt_hash + epoch → both halves verified", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "verify_receipt",
          arguments: { signal_hash: SIGNAL, receipt_hash: RECEIPT, epoch: 24 },
        },
      },
      { fetchFn: verifiedFetch(), now: () => FIXED_NOW },
    );
    const result = res.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent["verified"]).toBe(true);
    expect(result.structuredContent["epoch"]).toBe(24);
    const delivery = result.structuredContent["delivery"] as Record<string, unknown>;
    expect(delivery["verified"]).toBe(true);
  });

  it("no args → isError result (not an RPC error), and nothing is fetched", async () => {
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: {} },
      },
      { fetchFn: countingFetch },
    );
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("signal_hash or receipt_id");
    expect(calls).toEqual([]);
  });

  it("malformed signal_hash → isError result, and nothing is fetched", async () => {
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { signal_hash: "zzz" } },
      },
      { fetchFn: countingFetch },
    );
    const result = res.result as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("malformed receipt_hash → isError result, and nothing is fetched", async () => {
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "verify_receipt",
          arguments: { signal_hash: SIGNAL, receipt_hash: "zzz" },
        },
      },
      { fetchFn: countingFetch },
    );
    const result = res.result as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("mistyped receipt_hash (number) → isError result, and nothing is fetched", async () => {
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "verify_receipt",
          arguments: { signal_hash: SIGNAL, receipt_hash: 123 },
        },
      },
      { fetchFn: countingFetch },
    );
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("receipt_hash must be a string");
    expect(calls).toEqual([]);
  });

  it("EMPTY-STRING receipt_hash → isError result, never a 'partial' verdict (round-3 F4)", async () => {
    // The MCP handler used to coerce "" to null, yielding a "partial"
    // verdict whose detail falsely claimed no receipt_hash was
    // recorded. "" is malformed, like every other malformed value.
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "verify_receipt",
          arguments: { signal_hash: SIGNAL, receipt_hash: "" },
        },
      },
      { fetchFn: countingFetch },
    );
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must not be empty");
    expect(result.content[0].text).not.toContain("PARTIALLY");
    expect(calls).toEqual([]);
  });

  it("mistyped epoch (string) → isError result, and nothing is fetched", async () => {
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "verify_receipt",
          arguments: { signal_hash: SIGNAL, receipt_hash: RECEIPT, epoch: "24" },
        },
      },
      { fetchFn: countingFetch },
    );
    const result = res.result as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("mistyped signal_hash (number) → isError result, and nothing is fetched", async () => {
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { signal_hash: 123 } },
      },
      { fetchFn: countingFetch },
    );
    const result = res.result as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("unknown tool → -32602", async () => {
    const res = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "run_m13_allocation_check", arguments: {} },
    });
    expect(res.error?.code).toBe(-32602);
  });
});

describe("resolveReceiptId / resolveLedgerEntry via the Desk ledger", () => {
  const ledgerPath = join(tmpdir(), `vr-ledger-${Date.now()}.jsonl`);
  const receiptId = "rcpt_ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  it("resolves receipt_id → signal_hash (+ receipt_hash, epoch) from ledger.jsonl", () => {
    writeFileSync(
      ledgerPath,
      [
        JSON.stringify({ receipt_id: "rcpt_OTHER", signal_hash: "0x00" }),
        "this line is corrupt json and must be skipped",
        JSON.stringify({
          receipt_id: receiptId,
          signal_hash: SIGNAL,
          receipt_hash: RECEIPT,
          epoch: 24,
        }),
        "",
      ].join("\n"),
    );
    expect(resolveReceiptId(receiptId, ledgerPath)).toBe(SIGNAL);
    expect(resolveLedgerEntry(receiptId, ledgerPath)).toEqual({
      signal_hash: SIGNAL,
      receipt_hash: RECEIPT,
      epoch: 24,
    });
    expect(resolveReceiptId("rcpt_MISSING", ledgerPath)).toBe(null);
    unlinkSync(ledgerPath);
  });

  it("missing ledger file → null (unresolvable, not a throw)", () => {
    expect(resolveReceiptId(receiptId, join(tmpdir(), "vr-no-such-ledger.jsonl"))).toBe(
      null,
    );
  });

  it("tools/call with a ledger-backed receipt_id verifies the resolved hashes", async () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        receipt_id: receiptId,
        signal_hash: SIGNAL,
        receipt_hash: RECEIPT,
        epoch: 24,
      }) + "\n",
    );
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { receipt_id: receiptId } },
      },
      { fetchFn: verifiedFetch(), ledgerPath, now: () => FIXED_NOW },
    );
    const result = res.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent["signal_hash"]).toBe(SIGNAL);
    expect(result.structuredContent["receipt_hash"]).toBe(RECEIPT);
    expect(result.structuredContent["epoch"]).toBe(24);
    unlinkSync(ledgerPath);
  });

  it("resolveLedgerEntry PRESERVES a present-but-malformed receipt_hash (round-4 F2)", () => {
    const ledger = join(tmpdir(), `vr-ledger-r4-preserve-${Date.now()}.jsonl`);
    writeFileSync(
      ledger,
      [
        JSON.stringify({ receipt_id: "rcpt_EMPTY", signal_hash: SIGNAL, receipt_hash: "" }),
        JSON.stringify({ receipt_id: "rcpt_NUM", signal_hash: SIGNAL, receipt_hash: 12345 }),
        JSON.stringify({ receipt_id: "rcpt_ABSENT", signal_hash: SIGNAL }),
      ].join("\n"),
    );
    // "" and 12345 are present values, not absent ones — they must
    // survive resolution so the handler can refuse them, never be
    // dropped into a false "partial".
    expect(resolveLedgerEntry("rcpt_EMPTY", ledger)).toEqual({
      signal_hash: SIGNAL,
      receipt_hash: "",
    });
    expect(resolveLedgerEntry("rcpt_NUM", ledger)).toEqual({
      signal_hash: SIGNAL,
      receipt_hash: 12345,
    });
    const absent = resolveLedgerEntry("rcpt_ABSENT", ledger);
    expect(absent).toEqual({ signal_hash: SIGNAL });
    expect(absent !== null && "receipt_hash" in absent).toBe(false);
    unlinkSync(ledger);
  });

  it("tools/call with a ledger receipt_hash '' → isError, never a false 'partial' (round-4 F2)", async () => {
    const ledger = join(tmpdir(), `vr-ledger-r4-empty-${Date.now()}.jsonl`);
    writeFileSync(
      ledger,
      JSON.stringify({ receipt_id: receiptId, signal_hash: SIGNAL, receipt_hash: "" }) +
        "\n",
    );
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { receipt_id: receiptId } },
      },
      { fetchFn: countingFetch, ledgerPath: ledger, now: () => FIXED_NOW },
    );
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must not be empty");
    expect(result.content[0].text).not.toContain("PARTIALLY");
    expect(calls).toEqual([]);
    unlinkSync(ledger);
  });

  it("tools/call with a ledger receipt_hash 12345 (number) → isError, never a false 'partial' (round-4 F2)", async () => {
    const ledger = join(tmpdir(), `vr-ledger-r4-num-${Date.now()}.jsonl`);
    writeFileSync(
      ledger,
      JSON.stringify({ receipt_id: receiptId, signal_hash: SIGNAL, receipt_hash: 12345 }) +
        "\n",
    );
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { receipt_id: receiptId } },
      },
      { fetchFn: countingFetch, ledgerPath: ledger, now: () => FIXED_NOW },
    );
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("receipt_hash must be a string");
    expect(result.content[0].text).not.toContain("PARTIALLY");
    expect(calls).toEqual([]);
    unlinkSync(ledger);
  });

  it("resolveLedgerEntry PRESERVES a present-but-null receipt_hash (round-5 F1)", () => {
    const ledger = join(tmpdir(), `vr-ledger-r5-null-${Date.now()}.jsonl`);
    writeFileSync(
      ledger,
      JSON.stringify({ receipt_id: "rcpt_NULL", signal_hash: SIGNAL, receipt_hash: null }) +
        "\n",
    );
    // null is a PRESENT value, not an absent field — the entry must
    // carry the key so the handler can refuse it, never drop it into
    // a false "partial".
    const entry = resolveLedgerEntry("rcpt_NULL", ledger);
    expect(entry).not.toBe(null);
    expect(entry !== null && "receipt_hash" in entry).toBe(true);
    expect(entry?.receipt_hash).toBe(null);
    unlinkSync(ledger);
  });

  it("tools/call with a ledger receipt_hash null → isError, never a false 'partial' (round-5 F1)", async () => {
    const ledger = join(tmpdir(), `vr-ledger-r5-null-call-${Date.now()}.jsonl`);
    writeFileSync(
      ledger,
      JSON.stringify({ receipt_id: receiptId, signal_hash: SIGNAL, receipt_hash: null }) +
        "\n",
    );
    const calls: string[] = [];
    const countingFetch: FetchFn = async (url: string) => {
      calls.push(url);
      return verifiedFetch()(url);
    };
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { receipt_id: receiptId } },
      },
      { fetchFn: countingFetch, ledgerPath: ledger, now: () => FIXED_NOW },
    );
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("receipt_hash must be a string");
    expect(result.content[0].text).toContain("null receipt_hash");
    expect(result.content[0].text).not.toContain("PARTIALLY");
    expect(calls).toEqual([]);
    unlinkSync(ledger);
  });

  it("tools/call with a ledger row whose receipt_hash is genuinely ABSENT → still partial (round-4 F2: do not over-reject)", async () => {
    const ledger = join(tmpdir(), `vr-ledger-r4-absent-${Date.now()}.jsonl`);
    writeFileSync(
      ledger,
      JSON.stringify({ receipt_id: receiptId, signal_hash: SIGNAL }) + "\n",
    );
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { receipt_id: receiptId } },
      },
      { fetchFn: verifiedFetch(), ledgerPath: ledger, now: () => FIXED_NOW },
    );
    const result = res.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent["verified"]).toBe(false);
    expect(result.structuredContent["status"]).toBe("partial");
    expect(result.structuredContent["receipt_hash"]).toBe(null);
    expect(result.structuredContent["delivery"]).toBe(null);
    unlinkSync(ledger);
  });

  it("tools/call with an unresolvable receipt_id → isError, nothing verified", async () => {
    const res = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "verify_receipt", arguments: { receipt_id: "rcpt_MISSING" } },
      },
      { fetchFn: verifiedFetch(), ledgerPath: join(tmpdir(), "vr-no-such-ledger.jsonl") },
    );
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pass signal_hash directly");
  });
});

describe("HTTP routes (Fastify inject, no network)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/desk/verify without signal_hash → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/desk/verify" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Record<string, unknown>)["error"]).toContain("signal_hash");
  });

  it("GET /api/desk/verify with a malformed hash → 400 (no fetch)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/desk/verify?signal_hash=zzz",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/desk/verify with a malformed receipt_hash → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/desk/verify?signal_hash=${SIGNAL}&receipt_hash=zzz`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/desk/verify with an EMPTY receipt_hash → 400 (round-3 F4: HTTP already refused it)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/desk/verify?signal_hash=${SIGNAL}&receipt_hash=`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/desk/verify with a bad epoch → 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/desk/verify?signal_hash=${SIGNAL}&epoch=abc`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/desk/verify rejects Number()-loose epochs: empty, 0x18, 1e3, -1 → 400", async () => {
    for (const epoch of ["", "0x18", "1e3", "-1", "24.5", " 24"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/desk/verify?signal_hash=${SIGNAL}&epoch=${encodeURIComponent(epoch)}`,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("POST /api/mcp tools/list → 200 with verify_receipt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name)).toContain("verify_receipt");
  });

  it("POST /api/mcp with a malformed body → JSON-RPC -32600", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: { nope: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { error: { code: number } }).error.code).toBe(-32600);
  });
});
