// QA-01 (external live-site QA, 2026-11-21): Dashboard receipts must reach
// the shared /receipts ledger and must survive leaving the page and a
// reload; a Clear must not be undone; the run toast must only claim
// receipts that were really saved.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "../Dashboard";
import { DASHBOARD_ROWS_KEY, isValidLiveReceiptRow, readDashboardRows, writeDashboardRows } from "./dashboardRows";
import { bumpLedgerGeneration, readSessionReceipts, SESSION_RECEIPTS_GEN_KEY } from "../../lib/sessionReceipts";
import { toLiveReceipt } from "./utils";

const RECEIPT = {
  receipt_id: "rcpt_QA01000000000000000001",
  intent: "TVL_LOOKUP_GENERAL",
  upstream_url: "https://api.llama.fi/protocol/aave-v3",
  raw_response_sha256: "b".repeat(64),
  quorum_votes: "1/1 primary source",
  fetched_at: "2026-11-21T16:00:00.000Z",
  audit_url: "https://verireceipt.onrender.com/receipts/rcpt_QA01000000000000000001",
};

const ENV = (extra: Record<string, unknown>) => ({
  ...extra,
  answer: "mock answer",
  verdict: "verified",
  confidence: 1,
  source: "mock",
  checked_at: "2026-11-21T16:00:00.000Z",
  receipt: RECEIPT,
});

/** Minimal live-shaped mock: 200 envelopes for the four allocation
 *  checks; the miner's real 400 for a malformed tx hash is produced by
 *  the lib before any request. */
function mockFetch(url: string) {
  const u = new URL(String(url), "http://localhost");
  const p = u.searchParams;
  let body: unknown = { status: "ok" };
  if (u.pathname.endsWith("/v1/tx") && (p.get("tx_hash") ?? "").length !== 66) {
    const err = { error: "invalid_tx_hash", code: "INVALID_TX_HASH", message: "tx_hash must be 0x + 64 hex" };
    return Promise.resolve(new Response(JSON.stringify(err), { status: 400, headers: { "Content-Type": "application/json" } }));
  }
  if (u.pathname.endsWith("/v1/tx")) body = ENV({ tx_hash: p.get("tx_hash"), status: "confirmed", block_number: 1, value_eth: 0 });
  else if (u.pathname.endsWith("/v1/filings")) body = ENV({ entity: p.get("entity"), filing_count: 1, filings: [], urls: [] });
  else if (u.pathname.endsWith("/v1/tvl")) body = ENV({ protocol_or_chain: "aave-v3", tvl_usd: 100 });
  else if (u.pathname.endsWith("/v1/route")) body = ENV({ amount_out: 1700000000 });
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

function tvlRow() {
  return toLiveReceipt("TVL_LOOKUP_GENERAL", "protocol=aave-v3", "https://verireceipt.onrender.com/v1/tvl?protocol=aave-v3", {
    ok: true,
    body: { tvl_usd: 1, receipt: RECEIPT },
    receipt: RECEIPT,
    latencyMs: 12,
    ledgerGenAtStart: 0,
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", (url: string) => mockFetch(url));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function runDefaultDesk() {
  fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
  expect(await screen.findByText(/^COMPLETE · RECEIPTS SAVED TO LEDGER$/, {}, { timeout: 15000 })).toBeTruthy();
}

describe("QA-01 dashboard receipts persistence", () => {
  it("an allocation run writes its 4 receipts to the shared ledger once", async () => {
    render(<Dashboard />);
    await runDefaultDesk();
    const shared = readSessionReceipts();
    expect(shared.entries).toHaveLength(4);
    expect(new Set(shared.entries.map((e) => e.endpoint))).toEqual(new Set(["tx", "tvl", "filings", "route"]));
    // Unique per-call keys: no duplicate rows for one call.
    expect(new Set(shared.entries.map((e) => e.key)).size).toBe(4);
  }, 30000);

  it("rows survive unmount/remount (navigate away and back) and a reload", async () => {
    const first = render(<Dashboard />);
    await runDefaultDesk();
    const before = readDashboardRows().map((r) => r.key);
    expect(before).toHaveLength(4);
    first.unmount();
    // Same tab, fresh mount (route change or reload): same rows.
    render(<Dashboard />);
    expect(screen.getByText(/Receipts \(this tab\):/).textContent).toContain("4");
    expect(readDashboardRows().map((r) => r.key)).toEqual(before);
    // The shared ledger still holds exactly the same 4 calls.
    expect(readSessionReceipts().entries).toHaveLength(4);
  }, 30000);

  it("the run toast states what was saved and never counts a refusal as a receipt", async () => {
    render(<Dashboard />);
    // Select the refusal probe (malformed tx hash -> 400, no receipt).
    fireEvent.click(screen.getByText(/Refusal Probe/));
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText(/^COMPLETE$/, {}, { timeout: 15000 })).toBeTruthy();
    const toast = document.getElementById("toast");
    expect(toast?.textContent).toContain("0 receipt(s) saved");
    expect(toast?.textContent).toContain("1 refusal(s) without a receipt");
    expect(readSessionReceipts().entries).toHaveLength(0);
  }, 30000);

  it("a Clear (generation bump) is not undone by restored rows", async () => {
    const first = render(<Dashboard />);
    await runDefaultDesk();
    first.unmount();
    bumpLedgerGeneration();
    render(<Dashboard />);
    expect(readDashboardRows()).toHaveLength(0);
    expect(screen.getByText(/Receipts \(this tab\):/).textContent).toContain("0");
  }, 30000);

  it("a Clear in another tab empties the mounted dashboard", async () => {
    render(<Dashboard />);
    await runDefaultDesk();
    await act(async () => {
      bumpLedgerGeneration();
      window.dispatchEvent(new StorageEvent("storage", { key: SESSION_RECEIPTS_GEN_KEY, newValue: "1" }));
    });
    expect(screen.getByText(/Receipts \(this tab\):/).textContent).toContain("0");
  }, 30000);
});

describe("dashboardRows store", () => {
  it("round-trips valid rows and drops malformed ones", () => {
    const row = tvlRow();
    expect(isValidLiveReceiptRow(row)).toBe(true);
    expect(writeDashboardRows([row])).toBe(1);
    expect(readDashboardRows()).toHaveLength(1);
    sessionStorage.setItem(DASHBOARD_ROWS_KEY, JSON.stringify({ v: 1, gen: 0, rows: [row, { key: "x" }, null] }));
    expect(readDashboardRows()).toHaveLength(1);
  });

  it("corrupt or foreign storage restores nothing (never throws)", () => {
    sessionStorage.setItem(DASHBOARD_ROWS_KEY, "{not json");
    expect(readDashboardRows()).toEqual([]);
    sessionStorage.setItem(DASHBOARD_ROWS_KEY, JSON.stringify([tvlRow()]));
    expect(readDashboardRows()).toEqual([]);
  });

  it("a quota error drops the oldest rows instead of failing silently", () => {
    const rows = Array.from({ length: 8 }, () => tvlRow());
    const real = Storage.prototype.setItem;
    let calls = 0;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      calls += 1;
      if (k === DASHBOARD_ROWS_KEY && JSON.parse(v).rows.length > 2) throw new DOMException("full", "QuotaExceededError");
      return real.call(this, k, v);
    });
    expect(writeDashboardRows(rows)).toBe(2);
    expect(calls).toBeGreaterThan(1);
    spy.mockRestore();
    // Newest rows kept (index 0 is newest).
    expect(readDashboardRows().map((r) => r.key)).toEqual(rows.slice(0, 2).map((r) => r.key));
  });
});
