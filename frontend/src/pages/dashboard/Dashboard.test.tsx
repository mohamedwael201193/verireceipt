// Smoke test for the Dashboard & Proof Hub page.
//
// The page must render its four views with live (mocked) data and must NOT
// render any of the mock file's canned numbers. Network is fully mocked at
// the fetch level; the data-layer lib's real getHealth/getTx/... run against
// the mock.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "../Dashboard";
import ReceiptsLedger from "./ReceiptsLedger";

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

function mockFetch(url: string) {
  const u = String(url);
  let status = 200;
  let body: unknown = {};
  if (u.includes("/health")) {
    body = { status: "ok", service: "verireceipt", uptime_s: 123, upstreams: {} };
  } else if (u.includes("/v1/tx")) {
    body = envelope({ tx_hash: "0x1b9e", status: "confirmed", from: "0x1", to: "0x2", block_number: 1, value_eth: 0 });
  } else if (u.includes("/v1/filings")) {
    body = envelope({ entity: "AAPL", filing_count: 1, filings: [], urls: [] });
  } else if (u.includes("/v1/tvl")) {
    body = envelope({ protocol_or_chain: "aave-v3", tvl_usd: 100, chain_tvl_usd: 90, as_of: "2026-11-20T07:00:00.000Z" });
  } else if (u.includes("/v1/route")) {
    body = envelope({ amount_out: 1700000000 });
  } else if (u.includes("/v1/grid-price")) {
    body = envelope({ lmp_usd_per_mwh: 42, node_or_zone: "TH_NP15_GEN-APND", market: "CAISO", interval_start: "2026-11-20T05:00:00.000Z", currency: "USD" });
  } else if (u.includes("mcp")) {
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

describe("Dashboard page", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", (url: string) => mockFetch(url));
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
    // Verified bond is shown instead.
    expect(screen.getByText(/Bond \$1\.40 Test USDC/)).toBeTruthy();
    // Live probes populate the session ledger (auto-probed health rows).
    expect(await screen.findByText(/Session receipts:/)).toBeTruthy();
  });

  it("shows the honest empty ledger state when no calls have been made", () => {
    render(<ReceiptsLedger receipts={[]} onInspect={() => undefined} showToast={() => undefined} />);
    expect(screen.getByText(/No receipts yet in this session/)).toBeTruthy();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.getByText(/Export ledger\.jsonl/)).toBeDisabled();
  });
});
