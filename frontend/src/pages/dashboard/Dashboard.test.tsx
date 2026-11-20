// Tests for the Dashboard & Proof Hub page (the dashboard's OWN suite).
//
// The page must render its four views with live (mocked) data and must NOT
// render any of the mock file's canned numbers. Network is fully mocked at
// the fetch level; the data-layer lib's real getHealth/getTx/... run against
// the mock, so these tests exercise the real probe/record/render paths —
// a desk run must actually append receipts to the ledger, and the
// benchmark suite must actually execute its cases against live-shaped
// responses.
//
// Count note (honest): this file is the dashboard's own suite. Earlier
// reports of "10 tests" counted the scaffold harness's tests; this file
// had 2. The count below is this file alone.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "../Dashboard";
import ReceiptDrawer from "./ReceiptDrawer";
import ReceiptsLedger from "./ReceiptsLedger";
import { BENCH_CASES } from "./benchmarks";
import { DOC_SNIPPETS } from "./docs";
import type { LiveReceipt } from "./types";
import { appendToLedger, LEDGER_CAP, toLiveReceipt } from "./utils";

const RECEIPT = {
  receipt_id: "rcpt_TEST00000000000000000001",
  intent: "ONCHAIN_TX_LOOKUP_GENERAL",
  upstream_url: "https://example.com/upstream",
  raw_response_sha256: `0x${"a".repeat(64)}`,
  quorum_votes: "3/3 sources agreed",
  fetched_at: "2026-11-20T07:00:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_TEST00000000000000000001",
};

function envelope(extra: Record<string, unknown>) {
  return {
    ...extra,
    answer: "mock answer",
    verdict: "verified",
    confidence: 1,
    source: "mock",
    checked_at: "2026-11-20T07:00:00.000Z",
    receipt: RECEIPT,
  };
}

export function mockFetch(url: string) {
  const u = new URL(String(url), "http://localhost");
  const p = u.searchParams;
  let status = 200;
  let body: unknown = {};
  if (u.pathname.endsWith("/health")) {
    body = { status: "ok", service: "verireceipt", uptime_s: 123, upstreams: {} };
  } else if (u.pathname.endsWith("/v1/tx")) {
    const chain = p.get("chain");
    if (chain === "base-sepolia") {
      status = 400;
      body = { error: "unsupported_chain", code: "UNSUPPORTED_CHAIN", message: "unsupported chain: base-sepolia" };
    } else if (chain === "base") {
      // Unknown on base: honest 200 not_found, no invented fields.
      body = envelope({ tx_hash: p.get("tx_hash"), status: "not_found", from: null, to: null, block_number: null, value_eth: null, verdict: "not_found" });
    } else {
      body = envelope({ tx_hash: p.get("tx_hash"), status: "confirmed", from: "0x5875db54cd9ae2b2a875e09bb731772297ae9d92", to: "0x0000000aa232009084bd71a5797d089aa4edfad4", block_number: 26454409, value_eth: 0 });
    }
  } else if (u.pathname.endsWith("/v1/filings")) {
    if (p.get("entity") === "ZZZZZ_INVALID") {
      status = 422;
      body = { error: "unknown_entity", code: "UNKNOWN_ENTITY", message: "unknown entity: ZZZZZ_INVALID" };
    } else {
      body = envelope({ entity: p.get("entity") ?? "AAPL", filing_count: 1, filings: [], urls: [] });
    }
  } else if (u.pathname.endsWith("/v1/tvl")) {
    body = envelope({ protocol_or_chain: "aave-v3", tvl_usd: 100, chain_tvl_usd: 90, as_of: "2026-11-20T07:00:00.000Z" });
  } else if (u.pathname.endsWith("/v1/route")) {
    body = envelope({ amount_out: 1700000000 });
  } else if (u.pathname.endsWith("/v1/grid-price")) {
    const interval = p.get("interval_start") ?? "";
    if (p.get("node_or_zone") === "UNKNOWN_ZONE_99") {
      status = 422;
      body = { error: "unknown_zone", code: "UNKNOWN_ZONE", message: "unknown zone: UNKNOWN_ZONE_99" };
    } else if (interval && new Date(interval).getTime() > Date.now()) {
      status = 422;
      body = { error: "future_interval", code: "FUTURE_INTERVAL", message: "interval is in the future", retry_after_sec: 3600 };
    } else {
      body = envelope({ lmp_usd_per_mwh: 42, node_or_zone: "TH_NP15_GEN-APND", market: "CAISO", interval_start: "2026-11-20T05:00:00.000Z", currency: "USD" });
    }
  } else if (u.pathname.includes("mcp")) {
    status = 404;
    body = { error: "not_found" };
  }
  const text = JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(JSON.parse(text) as unknown),
    text: () => Promise.resolve(text),
  });
}

/** A fetch that never resolves unless its signal aborts (Cancel tests). */
function hangingFetch(_url: string, init?: { signal?: AbortSignal }) {
  return new Promise<never>((_resolve, reject) => {
    const sig = init?.signal;
    if (sig?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
}

function makeReceipt(overrides: Partial<LiveReceipt> & { intent: string }): LiveReceipt {
  const outcome =
    overrides.status === 200 || overrides.status === undefined
      ? { ok: true as const, body: { receipt: RECEIPT }, receipt: RECEIPT, latencyMs: 42 }
      : { ok: false as const, body: { error: "x" }, latencyMs: 42, status: overrides.status ?? 422 };
  return toLiveReceipt(overrides.intent, overrides.query ?? "q", "https://example.com", outcome);
}

describe("Dashboard page", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", (url: string) => mockFetch(url));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the Mission Desk view with live chrome and no canned numbers", async () => {
    render(<Dashboard />);
    expect(await screen.findByText("Mission Desk.")).toBeTruthy();
    expect(screen.getAllByText("Receipts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Benchmarks").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Status & Docs").length).toBeGreaterThan(0);
    // None of the mock file's canned figures may appear.
    expect(screen.queryByText(/\$1\.84/)).toBeNull();
    expect(screen.queryByText(/184 checks/)).toBeNull();
    expect(screen.queryByText(/Score 98 \/ 100/)).toBeNull();
    expect(screen.queryByText(/Archived Receipts: 124/)).toBeNull();
    // Verified bond is shown instead (Auth drawer value; the StatusDocs
    // "Bond $1.40" badge only exists while that view is mounted).
    expect(screen.getByText("$1.40 Test USDC")).toBeTruthy();
    // The session ledger chrome renders (starts empty — 0 receipts).
    expect(await screen.findByText(/Session receipts:/)).toBeTruthy();
  });

  it("shows the honest empty ledger state when no calls have been made", () => {
    render(<ReceiptsLedger receipts={[]} onInspect={() => undefined} showToast={() => undefined} />);
    expect(screen.getByText(/No receipts yet in this session/)).toBeTruthy();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.getByText(/Export ledger\.jsonl/)).toBeDisabled();
  });

  it("a Mission Desk run actually appends live receipts to the ledger", async () => {
    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText(/COMPLETE · APPENDED TO LEDGER/, {}, { timeout: 15000 })).toBeTruthy();
    // The verdict is derived from the live (mocked) responses, not canned.
    expect(screen.getByText(/Score 100 \/ 100/)).toBeTruthy();
    // Switch to the Receipts view: the run's receipts are really there.
    const receiptsTab = screen.getAllByRole("button", { name: "02 Receipts" })[0];
    fireEvent.click(receiptsTab);
    expect(await screen.findByText("ONCHAIN_TX_LOOKUP", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("TVL_LOOKUP")).toBeTruthy();
    expect(screen.getByText("REGULATORY_FILING_MONITOR")).toBeTruthy();
    const totalCell = screen.getByText("Total Calls").closest(".kpi-cell");
    expect(totalCell?.textContent).toContain("4");
  }, 30000);

  it("a cleared desk input is NOT silently replaced by a preset default", async () => {
    render(<Dashboard />);
    const entityInput = screen.getByLabelText(/Entity \/ Protocol/) as HTMLInputElement;
    fireEvent.change(entityInput, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText(/COMPLETE · APPENDED TO LEDGER/, {}, { timeout: 15000 })).toBeTruthy();
    // The TVL check ran with the empty value and was refused (400) —
    // the stream shows the real refusal, not a verdict on aave-v3.
    expect(screen.getByText(/Invalid parameter "protocol"/)).toBeTruthy();
    // The ledger records the empty query, proving no default was substituted.
    const receiptsTab = screen.getAllByRole("button", { name: "02 Receipts" })[0];
    fireEvent.click(receiptsTab);
    expect(await screen.findByText("protocol=", {}, { timeout: 5000 })).toBeTruthy();
  }, 30000);

  it("a desk run can be cancelled and the Run button comes back", async () => {
    vi.stubGlobal("fetch", (url: string, init?: { signal?: AbortSignal }) => hangingFetch(url, init));
    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText("Cancel run", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel run"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Run Live Checks/ })).toBeEnabled(), { timeout: 5000 });
    expect(screen.getByText(/CANCELLED — RUN ABORTED/)).toBeTruthy();
  }, 30000);

  it("the benchmark suite executes its runnable cases and reports 12/12", async () => {
    render(<Dashboard />);
    const benchTab = screen.getAllByRole("button", { name: "03 Benchmarks" })[0];
    fireEvent.click(benchTab);
    fireEvent.click(screen.getByRole("button", { name: /Run 24-Case Adversarial Suite/ }));
    // 12 runnable (T11/T12 on base + 4 regressions + 3 refusals + 3 burst);
    // T01–T10 are honest SKIP (base-sepolia-only), F04/B03 are SKIP.
    expect(await screen.findByText("12 / 12", {}, { timeout: 20000 })).toBeTruthy();
    expect(screen.getByText(/12 skipped \(not executable via public API\)/)).toBeTruthy();
    // T11's expanded row shows the probe actually executed (chain base).
    fireEvent.click(screen.getByText("T11"));
    expect(await screen.findByText(/"chain":"base"/, {}, { timeout: 5000 })).toBeTruthy();
    // The base-sepolia traps render as SKIP with the reason, never a pass.
    fireEvent.click(screen.getByText("T01"));
    expect(await screen.findByText(/"chain":"base-sepolia"/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getAllByText("SKIP").length).toBeGreaterThanOrEqual(10);
  }, 60000);

  it("a benchmark suite run can be cancelled and the Run button comes back", async () => {
    vi.stubGlobal("fetch", (url: string, init?: { signal?: AbortSignal }) => hangingFetch(url, init));
    render(<Dashboard />);
    const benchTab = screen.getAllByRole("button", { name: "03 Benchmarks" })[0];
    fireEvent.click(benchTab);
    fireEvent.click(screen.getByRole("button", { name: /Run 24-Case Adversarial Suite/ }));
    expect(await screen.findByText("Cancel suite", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel suite"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Run 24-Case/ })).toBeEnabled(), { timeout: 5000 });
  }, 30000);

  it("ledger filters actually filter rows", () => {
    const receipts = [
      makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 200, query: "tx-one" }),
      makeReceipt({ intent: "GRID_POWER_PRICE_GENERAL", status: 422, query: "grid-one" }),
    ];
    render(<ReceiptsLedger receipts={receipts} onInspect={() => undefined} showToast={() => undefined} />);
    expect(screen.getByText("tx-one")).toBeTruthy();
    expect(screen.getByText("grid-one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "422 Only" }));
    expect(screen.queryByText("tx-one")).toBeNull();
    expect(screen.getByText("grid-one")).toBeTruthy();
  });

  it("ledger pagination renders at most 50 rows per page", () => {
    const receipts = Array.from({ length: 60 }, (_, i) =>
      makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 200, query: `tx-${i}` }),
    );
    render(<ReceiptsLedger receipts={receipts} onInspect={() => undefined} showToast={() => undefined} />);
    expect(screen.getAllByText("Inspect →")).toHaveLength(50);
    expect(screen.getByText(/Page 1 of 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getAllByText("Inspect →")).toHaveLength(10);
    expect(screen.getByText(/Page 2 of 2/)).toBeTruthy();
  });

  it("the session ledger caps at the latest 200 receipts", () => {
    // Simulate the Dashboard's onRecord path: arrivals oldest-first,
    // newest prepended, capped at LEDGER_CAP.
    let ledger: LiveReceipt[] = [];
    for (let i = 0; i < 250; i++) {
      ledger = appendToLedger(
        ledger,
        makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 200, query: `tx-${i}` }),
      );
    }
    expect(LEDGER_CAP).toBe(200);
    expect(ledger).toHaveLength(200);
    expect(ledger[0].query).toBe("tx-249");
    expect(ledger[199].query).toBe("tx-50");
  });

  it("the Auth drawer collects no credentials (no BYO key inputs)", () => {
    render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: "Sponsored" }));
    expect(screen.getByRole("dialog", { name: "Auth & Payment Mode" })).toBeTruthy();
    expect(screen.queryByText(/BYO Key/)).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByLabelText(/Anjoman API Key/)).toBeNull();
    expect(screen.queryByLabelText(/wallet address/i)).toBeNull();
  });

  it("drawers are mutually exclusive, focus on open, and inert when closed", async () => {
    render(<Dashboard />);
    // Open the receipt drawer via a desk run row.
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText(/COMPLETE · APPENDED TO LEDGER/, {}, { timeout: 15000 })).toBeTruthy();
    fireEvent.click(screen.getByText("ONCHAIN_TX_LOOKUP"));
    const receiptAside = screen.getByRole("dialog", { name: "Receipt Inspector" });
    expect(receiptAside.getAttribute("inert")).toBeNull();
    expect(document.activeElement).toBe(receiptAside);
    // Opening the auth drawer closes the receipt drawer.
    fireEvent.click(screen.getByRole("button", { name: "Sponsored" }));
    expect(screen.getByRole("dialog", { name: "Auth & Payment Mode" }).getAttribute("inert")).toBeNull();
    expect(receiptAside.getAttribute("inert")).not.toBeNull();
  }, 30000);

  it("a non-https audit_url renders as plain text, never as a link", () => {
    const base = makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 200 });
    const evil = {
      ...base,
      receipt: { ...RECEIPT, audit_url: "javascript:alert(1)" },
    };
    const { rerender } = render(<ReceiptDrawer receipt={evil} onClose={() => undefined} showToast={() => undefined} />);
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeTruthy();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    const dataUrl = {
      ...base,
      receipt: { ...RECEIPT, audit_url: "data:text/html,<script>alert(1)</script>" },
    };
    rerender(<ReceiptDrawer receipt={dataUrl} onClose={() => undefined} showToast={() => undefined} />);
    expect(document.querySelector('a[href^="data:"]')).toBeNull();
    // A real https audit URL still renders as a link.
    rerender(<ReceiptDrawer receipt={base} onClose={() => undefined} showToast={() => undefined} />);
    const link = document.querySelector('a[href="https://verireceipt.onrender.com/receipts/rcpt_TEST00000000000000000001"]');
    expect(link).not.toBeNull();
  });

  it("the miner.yaml docs tab is byte-identical to the repo-root miner.yaml", () => {
    // Vitest runs from frontend/, so the repo root is one level up.
    const minerYaml = readFileSync(resolve(process.cwd(), "..", "miner.yaml"), "utf8");
    expect(DOC_SNIPPETS.yaml).toBe(minerYaml);
  });

  it("every runnable benchmark case calls a supported chain", () => {
    const supported = new Set(["ethereum", "base", "arbitrum", "optimism", "polygon", "sepolia"]);
    for (const c of BENCH_CASES) {
      if (!c.runnable) continue;
      const probeText = c.probe();
      const m = /"chain":"([^"]+)"/.exec(probeText);
      if (m) expect(supported.has(m[1])).toBe(true);
    }
  });
});
