// QA-04 / QA-06 / QA-12 (external live-site QA, 2026-11-21).
// QA-04: valid bare-hex digests (what the live API emits) pass the suite;
//        a 0x prefix is tolerated; anything not 32 bytes of hex fails
//        with a message showing the digest's shape.
// QA-06: the future-grid refusal keeps the server's retry_after_sec all
//        the way into the case result (F01), and the probe interval stays
//        close enough that the delay is inside the client's 24 h bound.
// QA-12: the benchmark categories' counts come from the case list.

import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Benchmarks from "./Benchmarks";
import { describeDigestShape, normalizeSha256Hex } from "../../lib/receipt";
import { MAX_RETRY_AFTER_SEC } from "../../lib/api";
import { TRAP_PRESETS } from "../landing/data";
import { BENCH_CASES } from "./benchmarks";
import { futureGridInterval } from "./utils";

const BARE = "f001022596bb110c821112a8b12f794e0d5c545475b7d5f0ccfb42d9b431e57b"; // live receipt digest, 2026-11-21

function receipt(sha: unknown) {
  return {
    receipt_id: "rcpt_QA04000000000000000001",
    intent: "ONCHAIN_TX_LOOKUP_GENERAL",
    upstream_url: "https://example.org/rpc",
    raw_response_sha256: sha,
    quorum_votes: "2/3 sources agreed",
    fetched_at: "2026-11-21T16:00:00.000Z",
    audit_url: "https://verireceipt.onrender.com/receipts/rcpt_QA04000000000000000001",
  };
}

function respond(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function caseById(id: string) {
  const c = BENCH_CASES.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
}

afterEach(() => vi.unstubAllGlobals());

describe("QA-04 digest contract", () => {
  it("normalizeSha256Hex accepts bare and 0x forms, rejects everything else", () => {
    expect(normalizeSha256Hex(BARE)).toBe(BARE);
    expect(normalizeSha256Hex(`0x${BARE}`)).toBe(BARE);
    expect(normalizeSha256Hex(BARE.toUpperCase())).toBe(BARE);
    expect(normalizeSha256Hex(BARE.slice(1))).toBeNull();
    expect(normalizeSha256Hex(`${BARE}0`)).toBeNull();
    expect(normalizeSha256Hex(`0x0x${BARE.slice(2)}`)).toBeNull();
    expect(normalizeSha256Hex("z".repeat(64))).toBeNull();
    expect(normalizeSha256Hex(42)).toBeNull();
    expect(normalizeSha256Hex(null)).toBeNull();
    expect(describeDigestShape("0xabc")).toBe("0x-prefixed, 3 chars");
    expect(describeDigestShape("zz")).toBe("2 chars, non-hex");
  });

  it("T11 (unknown tx on base, live shape, bare digest) passes", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const p = new URL(String(url), "http://x").searchParams;
      return respond(200, {
        tx_hash: p.get("tx_hash"),
        status: "not_found",
        from: null,
        to: null,
        block_number: null,
        value_eth: null,
        answer: "not found",
        verdict: "not_found",
        confidence: 1,
        source: "x",
        checked_at: "2026-11-21T16:00:00.000Z",
        receipt: receipt(BARE),
      });
    });
    const r = await caseById("T11").run({ record: () => undefined });
    expect(r.verdict).toBe("PASS");
  });

  it("a malformed digest still fails, and the message shows its shape", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const p = new URL(String(url), "http://x").searchParams;
      return respond(200, {
        tx_hash: p.get("tx_hash"), status: "not_found", from: null, to: null, block_number: null, value_eth: null,
        answer: "x", verdict: "not_found", confidence: 1, source: "x", checked_at: "2026-11-21T16:00:00.000Z",
        receipt: receipt(BARE.slice(0, 40)),
      });
    });
    const r = await caseById("T11").run({ record: () => undefined });
    expect(r.verdict).toBe("FAIL");
    expect(r.actual).toContain("malformed (40 chars; expected 64 hex chars, optional 0x)");
  });
});

describe("QA-06 retry metadata", () => {
  it("futureGridInterval is 2-3 h ahead, so the server delay fits the client bound", () => {
    const now = new Date("2026-11-21T16:10:00.000Z");
    const iv = new Date(futureGridInterval(now)).getTime();
    expect(iv - now.getTime()).toBeGreaterThanOrEqual(2 * 3600 * 1000);
    expect(iv - now.getTime()).toBeLessThanOrEqual(3 * 3600 * 1000);
    // Worst case delay = interval start + 1 h settlement - now < 4 h.
    expect((iv + 3600 * 1000 - now.getTime()) / 1000).toBeLessThan(MAX_RETRY_AFTER_SEC);
  });

  it("F01 passes when the API returns 422 FUTURE_INTERVAL with retry_after_sec", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const p = new URL(String(url), "http://x").searchParams;
      const start = Date.parse(p.get("interval_start") ?? "");
      const retry = Math.ceil((start + 3600 * 1000 - Date.now()) / 1000);
      return respond(422, { error: "future_interval", code: "FUTURE_INTERVAL", message: "not finished", retry_after_sec: retry });
    });
    const r = await caseById("F01").run({ record: () => undefined });
    expect(r.verdict).toBe("PASS");
  });

  it("the landing grid trap is computed at use time and always in the future", () => {
    const a = Date.parse(TRAP_PRESETS.grid.interval_start);
    expect(a).toBeGreaterThan(Date.now());
    expect(a - Date.now()).toBeLessThanOrEqual(3 * 3600 * 1000);
  });
});

describe("QA-12 category counts", () => {
  it("filter labels show counts derived from the case list", () => {
    render(createElement(Benchmarks, { onRecord: () => undefined, showToast: () => undefined }));
    const n = (cat: string) => BENCH_CASES.filter((c) => c.cat === cat).length;
    expect(screen.getByRole("button", { name: `All ${BENCH_CASES.length}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `${n("reg")} Cross-Bug Regressions` })).toBeTruthy();
    expect(screen.getByRole("button", { name: `${n("refusal")} Refusals (400 / 422)` })).toBeTruthy();
    expect(screen.queryByText("4 Refusal 422 Matrix")).toBeNull();
  });
});
