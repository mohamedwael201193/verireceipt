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
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "../Dashboard";
import ReceiptDrawer from "./ReceiptDrawer";
import ReceiptsLedger from "./ReceiptsLedger";
import { BENCH_CASES } from "./benchmarks";
import { DOC_SNIPPETS } from "./docs";
import { DESK_PRESETS } from "./presets";
import type { DeskCheckResult, DeskEvaluation } from "./presets";
import type { LiveReceipt, Receipt } from "./types";
import { appendToLedger, highlightJson, isVerified, LEDGER_CAP, toLiveReceipt } from "./utils";

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
  // Real Response (not a hand-rolled stub): the data-layer lib reads
  // res.text() AND res.headers (Retry-After fallback in lib/api.ts) on
  // every non-ok response, and a real fetch Response always has headers.
  // A stub without `headers` throws inside the lib and surfaces as a
  // NETWORK_ERROR with status 0 (round-2 B1: R03/F02 failed this way).
  return Promise.resolve(
    new Response(text, { status, headers: { "Content-Type": "application/json" } }),
  );
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

describe("J2 R3 — HTTP-200 refusals are never displayed as verified", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", (url: string) => mockFetch(url));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** HTTP 200 with a >1 MiB body for every endpoint: the lib refuses
   * every call as INVALID_RESPONSE (status 200, no receipt) — J2's
   * exact B6 reproduction. */
  function oversize200Fetch(_url: string) {
    const big = JSON.stringify({ receipt: RECEIPT, answer: "mock", padding: "x".repeat(1_100_000) });
    return Promise.resolve(
      new Response(big, { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }

  /** A fetch that hangs on the drawer upstream URL only (M-2). */
  function hangingUpstreamFetch(url: string, init?: { signal?: AbortSignal }) {
    if (String(url).includes("example.com/upstream")) return hangingFetch(url, init);
    return mockFetch(url);
  }

  /** Green badges whose text is exactly "200" — the dishonest shape. */
  function green200Badges(container: HTMLElement): Element[] {
    return [...container.querySelectorAll(".badge.b-ok")].filter((b) => b.textContent === "200");
  }

  /** Click the Ping button on the /health endpoint row (J1 R3 M-c):
   * an index-based pingButtons[5] silently pings the wrong row if
   * endpointDefs() is ever reordered. */
  function pingHealthRow() {
    const row = screen.getByText("/health").closest("tr");
    if (!row) throw new Error("no /health row in the endpoint table");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Ping" }));
  }

  it("B-J2-1 repro: 200 + >1 MiB body, m13-defi preset — all 8 display sites stay honest", async () => {
    vi.stubGlobal("fetch", (url: string) => oversize200Fetch(url));
    const { container } = render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText(/COMPLETE · APPENDED TO LEDGER/, {}, { timeout: 15000 })).toBeTruthy();
    // Verdict logic (presets.ts, untouched) reads the probe error body:
    // all four refusals score 0.
    expect(screen.getByText(/Score 0 \/ 100/)).toBeTruthy();
    // (J2 R4 B1c) why-cards never render success text for a refused
    // call: Archive Quorum must NOT claim "status ? · block ?".
    const quorumCard = screen.getByText("Archive Quorum").closest(".panel");
    expect(quorumCard?.textContent).not.toContain("status ? · block ?");
    expect(quorumCard?.textContent).toContain("call failed: HTTP 200");
    expect(quorumCard?.textContent).toContain("GATE");
    // The other three cards fall back to their honest "no live …" text.
    expect(screen.getByText("TVL (live)").closest(".panel")?.textContent).toContain("no live TVL returned");
    expect(screen.getByText("SEC Compliance").closest(".panel")?.textContent).toContain("no live filings returned");
    expect(screen.getByText("Route Execution").closest(".panel")?.textContent).toContain("no live route returned");
    // All four why-cards are GATE, none PASS.
    expect(screen.getAllByText("GATE")).toHaveLength(4);
    expect(screen.queryByText("PASS")).toBeNull();
    // (2) Mission Desk run table: no green 200 badges on refused rows,
    // while the Proofs cell honestly says "no receipt · 200 refusal".
    expect(green200Badges(container)).toHaveLength(0);
    expect(screen.getAllByText(/no receipt · 200 refusal/)).toHaveLength(4);
    // (7) Drawer: a refused row opens with a warn "200 · refused"
    // header badge, never green "200 OK".
    fireEvent.click(screen.getByText("ONCHAIN_TX_LOOKUP"));
    const dialog = screen.getByRole("dialog", { name: "Receipt Inspector" });
    const headBadge = dialog.querySelector(".drawer-head .badge");
    expect(headBadge?.textContent).toBe("200 · refused");
    expect(headBadge?.classList.contains("b-warn")).toBe(true);
    expect(headBadge?.classList.contains("b-ok")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close Inspector" }));
    // (1) + (3) Receipts Ledger: KPI reads 0, no green 200 row badges.
    const receiptsTab = screen.getAllByRole("button", { name: "02 Receipts" })[0];
    fireEvent.click(receiptsTab);
    const kpiCell = screen.getByText("200 OK Verified").closest(".kpi-cell");
    expect(kpiCell?.querySelector(".kpi-val")?.textContent).toBe("0");
    expect(green200Badges(container)).toHaveLength(0);
    // (M-5) the refusal reason is visible on the row itself.
    expect(screen.getAllByText(/INVALID_RESPONSE/).length).toBeGreaterThanOrEqual(4);
    // (4) telemetry: the desk run probes no /health, so it must read
    // "not probed yet" — never "/health: ok".
    expect(screen.queryByText(/\/health: ok/)).toBeNull();
    // Status view: ping /health (refused 200) → (4) telemetry still not
    // ok, (5) Endpoints Answered 0/5, (6) no "Last grid receipt".
    const statusTab = screen.getAllByRole("button", { name: "04 Status & Docs" })[0];
    fireEvent.click(statusTab);
    pingHealthRow();
    expect(await screen.findByText(/\/health: HTTP 200 — refused \(body not ok\)/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/\/health: ok/)).toBeNull();
    // (J1 R3 B-1b) the /health row never renders UP for a refused ping.
    const healthRow = screen.getByText("/health").closest("tr");
    const rowBadge = healthRow?.querySelector(".badge");
    expect(rowBadge?.textContent).not.toBe("UP");
    expect(rowBadge?.classList.contains("b-ok")).toBe(false);
    const answeredCard = screen.getByText("Endpoints Answered (this session)").closest(".card");
    expect(answeredCard?.textContent).toContain("0 / 5");
    expect(screen.getByText("No grid probe yet")).toBeTruthy();
    expect(screen.queryByText(/Last grid receipt/)).toBeNull();
    // (8) Benchmarks: the suite scores 0/12 and F01 FAILs with http 200
    // wearing no green badge.
    const benchTab = screen.getAllByRole("button", { name: "03 Benchmarks" })[0];
    fireEvent.click(benchTab);
    fireEvent.click(screen.getByRole("button", { name: /Run 24-Case Adversarial Suite/ }));
    expect(await screen.findByText("0 / 12", {}, { timeout: 60000 })).toBeTruthy();
    const f01Row = screen.getByText("F01").closest("tr");
    const f01Http = [...(f01Row?.querySelectorAll(".badge") ?? [])].find((b) => b.textContent === "200");
    expect(f01Http).toBeTruthy();
    expect(f01Http?.classList.contains("b-ok")).toBe(false);
  }, 120000);

  it("B2 repro: m13-sec + m12 refusal paths never render 'undefined' why-card text", async () => {
    vi.stubGlobal("fetch", (url: string) => oversize200Fetch(url));
    render(<Dashboard />);
    // --- m13-sec: SEC 10-K Compliance Audit (filings + route refused).
    fireEvent.click(screen.getByRole("button", { name: /SEC 10-K Compliance Audit/ }));
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText(/COMPLETE · APPENDED TO LEDGER/, {}, { timeout: 15000 })).toBeTruthy();
    expect(screen.getByText(/Score 0 \/ 100/)).toBeTruthy();
    // (J2 R5 B2) The filings refusal body {error, message} is truthy,
    // so the old `filingsBody ? ...` rendered "undefined filings for
    // undefined" — the card must fall back to the honest text.
    const edgarCard = screen.getByText("Official EDGAR").closest(".panel");
    expect(edgarCard?.textContent).toContain("no live filings returned");
    expect(edgarCard?.textContent).not.toContain("undefined");
    expect(screen.getByText("URL Provenance").closest(".panel")?.textContent).toContain("no archive URLs returned");
    expect(screen.getByText("Route Execution").closest(".panel")?.textContent).toContain("no live route returned");
    // No "undefined" anywhere in the why-cards; all three GATE, none PASS.
    const whySection = screen.getByText("// why · deterministic policy evaluation").closest(".card");
    expect(whySection?.textContent).not.toContain("undefined");
    expect(screen.getAllByText("GATE")).toHaveLength(3);
    expect(screen.queryByText("PASS")).toBeNull();
    // The run table honestly records two refused rows.
    expect(screen.getAllByText(/no receipt · 200 refusal/)).toHaveLength(2);
    // --- m12: Grid LMP Dispatch Check (grid + route refused).
    fireEvent.click(screen.getByRole("button", { name: /Mission 12 · Mining/ }));
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText(/COMPLETE · APPENDED TO LEDGER/, {}, { timeout: 15000 })).toBeTruthy();
    expect(screen.getByText(/Score 0 \/ 100/)).toBeTruthy();
    // (J2 R5 B2) The grid refusal body rendered "— / MWh ·  ·
    // undefined" — the card must fall back to the honest text.
    const lmpCard = screen.getByText("LMP (live)").closest(".panel");
    expect(lmpCard?.textContent).toContain("no live LMP returned");
    expect(lmpCard?.textContent).not.toContain("undefined");
    // (J2 R5) Curtailment Threshold is disclosure, not a check: N/A,
    // never PASS or GATE.
    const curtailCard = screen.getByText("Curtailment Threshold").closest(".panel");
    expect(curtailCard?.textContent).toContain("N/A");
    expect(curtailCard?.textContent).toContain("No threshold configured");
    expect(curtailCard?.textContent).not.toContain("undefined");
    expect(screen.getByText("ETH Hedge Check").closest(".panel")?.textContent).toContain("no live route returned");
    const whySection2 = screen.getByText("// why · deterministic policy evaluation").closest(".card");
    expect(whySection2?.textContent).not.toContain("undefined");
    expect(screen.getAllByText("GATE")).toHaveLength(2);
    expect(screen.queryByText("PASS")).toBeNull();
    expect(screen.getAllByText(/no receipt · 200 refusal/)).toHaveLength(2);
  }, 120000);

  it("B1a/B1b: m13-reverted with 200-refusals never renders success why-card text", async () => {
    vi.stubGlobal("fetch", (url: string) => oversize200Fetch(url));
    render(<Dashboard />);
    // Select the Reverted Counterparty Trap preset (m13-reverted).
    fireEvent.click(screen.getByRole("button", { name: /Reverted Counterparty Trap/ }));
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText(/COMPLETE · APPENDED TO LEDGER/, {}, { timeout: 15000 })).toBeTruthy();
    expect(screen.getByText(/Score 0 \/ 100/)).toBeTruthy();
    // (B1a) Receipt Status must NOT claim an archive-quorum
    // confirmation that never happened.
    const receiptCard = screen.getByText("Receipt Status").closest(".panel");
    expect(receiptCard?.textContent).not.toContain("archive quorum confirms");
    expect(receiptCard?.textContent).toContain("call failed: HTTP 200");
    expect(receiptCard?.textContent).toContain("GATE");
    // (B1b) TVL Guard must NOT claim a live TVL that was never returned.
    const tvlCard = screen.getByText("TVL Guard").closest(".panel");
    expect(tvlCard?.textContent).not.toContain("live TVL");
    expect(tvlCard?.textContent).toContain("clean refusal HTTP 200");
    expect(tvlCard?.textContent).toContain("GATE");
    // Signing Policy stays GATE too: no reverted tx was observed.
    expect(screen.getByText("Signing Policy").closest(".panel")?.textContent).toContain("GATE");
    expect(screen.getAllByText("GATE")).toHaveLength(3);
    expect(screen.queryByText("PASS")).toBeNull();
    // The run table honestly records two refused rows, no green 200s.
    expect(screen.getAllByText(/no receipt · 200 refusal/)).toHaveLength(2);
  }, 120000);

  it("positive control: a genuine 200 WITH a receipt still shows verified/OK everywhere", async () => {
    const { container } = render(<Dashboard />);
    fireEvent.click(screen.getByRole("button", { name: /Run Live Checks/ }));
    expect(await screen.findByText(/COMPLETE · APPENDED TO LEDGER/, {}, { timeout: 15000 })).toBeTruthy();
    expect(screen.getByText(/Score 100 \/ 100/)).toBeTruthy();
    // Desk run table: 4 green 200 badges.
    expect(green200Badges(container)).toHaveLength(4);
    // Drawer header: green "200 OK".
    fireEvent.click(screen.getByText("ONCHAIN_TX_LOOKUP"));
    const dialog = screen.getByRole("dialog", { name: "Receipt Inspector" });
    const headBadge = dialog.querySelector(".drawer-head .badge");
    expect(headBadge?.textContent).toBe("200 OK");
    expect(headBadge?.classList.contains("b-ok")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Inspector" }));
    // Ledger KPI reads 4.
    fireEvent.click(screen.getAllByRole("button", { name: "02 Receipts" })[0]);
    const kpiCell = screen.getByText("200 OK Verified").closest(".kpi-cell");
    expect(kpiCell?.querySelector(".kpi-val")?.textContent).toBe("4");
    // Status: ping /health → telemetry reads "/health: ok"; 4/5 answered
    // (desk ran tx/tvl/filings/route; grid never probed).
    fireEvent.click(screen.getAllByRole("button", { name: "04 Status & Docs" })[0]);
    pingHealthRow();
    expect(await screen.findByText(/\/health: ok/, {}, { timeout: 5000 })).toBeTruthy();
    // (J1 R3 B-1b/B-1c) the /health row badge is UP, never "refused",
    // for a healthy ping, and the health card reads "/health ok".
    const healthRow = screen.getByText("/health").closest("tr");
    const rowBadge = healthRow?.querySelector(".badge");
    expect(rowBadge?.textContent).toBe("UP");
    expect(rowBadge?.classList.contains("b-ok")).toBe(true);
    expect(screen.getByText(/\/health ok · uptime 123s/)).toBeTruthy();
    const answeredCard = screen.getByText("Endpoints Answered (this session)").closest(".card");
    expect(answeredCard?.textContent).toContain("4 / 5");
    // Benchmarks: a PASS with http 200 keeps its green badge (T11).
    fireEvent.click(screen.getAllByRole("button", { name: "03 Benchmarks" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /Run 24-Case Adversarial Suite/ }));
    expect(await screen.findByText("12 / 12", {}, { timeout: 20000 })).toBeTruthy();
    const t11Row = screen.getByText("T11").closest("tr");
    const t11Http = [...(t11Row?.querySelectorAll(".badge") ?? [])].find((b) => b.textContent === "200");
    expect(t11Http?.classList.contains("b-ok")).toBe(true);
  }, 60000);

  it("isVerified requires 200 AND a receipt", () => {
    expect(isVerified({ status: 200, receipt: RECEIPT as unknown as Receipt })).toBe(true);
    expect(isVerified({ status: 200, receipt: null })).toBe(false);
    expect(isVerified({ status: 422, receipt: null })).toBe(false);
    expect(isVerified({ status: 0, receipt: null })).toBe(false);
  });

  it("a hung upstream recompute can be cancelled and the drawer stays usable (M-2)", async () => {
    vi.stubGlobal("fetch", hangingUpstreamFetch);
    const receipt = makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 200 });
    render(<ReceiptDrawer receipt={receipt} onClose={() => undefined} showToast={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Recompute SHA-256 in Browser/ }));
    expect(await screen.findByText("Fetching upstream…", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Recompute SHA-256 in Browser/ })).toBeEnabled(), { timeout: 5000 });
    expect(screen.queryByText("Fetching upstream…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  }, 30000);

  it("a hung upstream recompute times out after 45s instead of hanging forever (M-2)", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", hangingUpstreamFetch);
      const receipt = makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 200 });
      render(<ReceiptDrawer receipt={receipt} onClose={() => undefined} showToast={() => undefined} />);
      fireEvent.click(screen.getByRole("button", { name: /Recompute SHA-256 in Browser/ }));
      expect(screen.getByText("Fetching upstream…")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      expect(screen.getByText(/timed out after 45s/)).toBeTruthy();
      expect(screen.getByRole("button", { name: /Recompute SHA-256 in Browser/ })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  }, 30000);

  it("highlightJson never throws on undefined/null/non-string input (M-3)", () => {
    expect(highlightJson(undefined)).toBe("");
    expect(highlightJson(null)).toBe("");
    expect(highlightJson(() => 1)).toBe("");
    expect(highlightJson(Symbol("x"))).toBe("");
    // JSON.stringify THROWS on BigInt and circular input (J2 R4 M3).
    expect(highlightJson(BigInt(1))).toBe("");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(highlightJson(circular)).toBe("");
    expect(highlightJson({ a: 1 })).toContain("a");
    expect(highlightJson("plain")).toContain("plain");
  });

  it("ledger rows surface the refusal reason (M-5)", () => {
    const refused = toLiveReceipt("ONCHAIN_TX_LOOKUP_GENERAL", "tx-one", "https://example.com", {
      ok: false,
      body: { error: "INVALID_RESPONSE", message: "Response body exceeds the 1048576 byte limit" },
      latencyMs: 12,
      status: 200,
      errorCode: "INVALID_RESPONSE",
      errorMessage: "Response body exceeds the 1048576 byte limit",
    });
    render(<ReceiptsLedger receipts={[refused]} onInspect={() => undefined} showToast={() => undefined} />);
    expect(screen.getByText(/INVALID_RESPONSE/)).toBeTruthy();
    expect(screen.getByText(/Response body exceeds the 1048576 byte limit/)).toBeTruthy();
    // The refused 200 is not a verified row: no green badge, KPI 0.
    expect(document.querySelectorAll(".badge.b-ok")).toHaveLength(0);
    const kpiCell = screen.getByText("200 OK Verified").closest(".kpi-cell");
    expect(kpiCell?.querySelector(".kpi-val")?.textContent).toBe("0");
  });

  it("ledger Refusals KPI counts every non-verified row (M4)", () => {
    const verified = makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 200, query: "tx-ok" });
    const refused422 = makeReceipt({ intent: "GRID_POWER_PRICE_GENERAL", status: 422, query: "grid-422" });
    const refused200 = toLiveReceipt("ONCHAIN_TX_LOOKUP_GENERAL", "tx-200", "https://example.com", {
      ok: false,
      body: { error: "INVALID_RESPONSE", message: "Response body exceeds the 1048576 byte limit" },
      latencyMs: 12,
      status: 200,
      errorCode: "INVALID_RESPONSE",
      errorMessage: "Response body exceeds the 1048576 byte limit",
    });
    // (J2 R5 M4) The label used to promise only 400/422/200-no-receipt
    // while 5xx, other 4xx and timeouts had no KPI: every non-verified
    // row is now a refusal, and the label says exactly that.
    const refused500 = makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 500, query: "tx-500" });
    const refused404 = makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 404, query: "tx-404" });
    const timedOut = makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 0, query: "tx-timeout" });
    render(<ReceiptsLedger receipts={[verified, refused422, refused200, refused500, refused404, timedOut]} onInspect={() => undefined} showToast={() => undefined} />);
    // 422 + 200-refusal + 500 + 404 + timeout = 5; the verified 200 is never a refusal.
    const kpiCell = screen.getByText("Refusals").closest(".kpi-cell");
    expect(kpiCell?.querySelector(".kpi-val")?.textContent).toBe("5");
    const okCell = screen.getByText("200 OK Verified").closest(".kpi-cell");
    expect(okCell?.querySelector(".kpi-val")?.textContent).toBe("1");
  });
});

describe("J2 R6 — latent minors (verified receipt, missing field)", () => {
  /** Pure evaluate() helpers: build a DeskCheckResult straight from a
   * toLiveReceipt outcome — no fetch, no render — so a verified receipt
   * lacking one field exercises exactly the latent branch. */
  function presetById(id: string) {
    const preset = DESK_PRESETS.find((p) => p.id === id);
    if (!preset) throw new Error(`no desk preset ${id}`);
    return preset;
  }

  function deskResult(presetId: string, checkIndex: number, receipt: LiveReceipt): DeskCheckResult {
    const preset = presetById(presetId);
    return { check: preset.buildChecks(preset.inputs)[checkIndex], receipt };
  }

  function verifiedLiveReceipt(intent: string, body: unknown): LiveReceipt {
    return toLiveReceipt(intent, "q", "https://example.com", {
      ok: true,
      body,
      receipt: RECEIPT as unknown as Receipt,
      latencyMs: 1,
    });
  }

  function refusedLiveReceipt(intent: string, status: number, body: unknown): LiveReceipt {
    return toLiveReceipt(intent, "q", "https://example.com", {
      ok: false,
      body,
      latencyMs: 1,
      status,
      errorCode: "UNKNOWN_ENTITY",
      errorMessage: "refused",
    });
  }

  function whyCard(ev: DeskEvaluation, k: string) {
    const card = ev.why.find((c) => c.k === k);
    if (!card) throw new Error(`no why-card ${k}`);
    return card;
  }

  it("M1: m12 headline never renders 'undefined' when node_or_zone is absent", () => {
    const preset = presetById("m12-curtail");
    const grid = deskResult("m12-curtail", 0, verifiedLiveReceipt("GRID_POWER_PRICE_GENERAL", { lmp_usd_per_mwh: 42 }));
    const route = deskResult("m12-curtail", 1, verifiedLiveReceipt("OPTIMAL_EXECUTION_ROUTE_GENERAL", { amount_out: 1700000000 }));
    const ev = preset.evaluate([grid, route]);
    // The price is genuinely verified (receipt + finite LMP), so the
    // verdict stays APPROVE — only the zone clause is omitted.
    expect(ev.verdict).toBe("APPROVE");
    expect(ev.score).toBe(100);
    expect(ev.headline).toBe("Wholesale LMP $42.00 / MWh verified live.");
    expect(ev.headline).not.toContain("undefined");
    // Positive control: a typed zone restores the "at …" clause.
    const gridZoned = deskResult(
      "m12-curtail",
      0,
      verifiedLiveReceipt("GRID_POWER_PRICE_GENERAL", { lmp_usd_per_mwh: 42, node_or_zone: "TH_NP15_GEN-APND", market: "CAISO" }),
    );
    expect(preset.evaluate([gridZoned, route]).headline).toBe("Wholesale LMP $42.00 / MWh verified live at TH_NP15_GEN-APND.");
  });

  it("M2: m12 LMP card never renders '[object Object]' for a non-string market", () => {
    const preset = presetById("m12-curtail");
    const route = deskResult("m12-curtail", 1, verifiedLiveReceipt("OPTIMAL_EXECUTION_ROUTE_GENERAL", { amount_out: 1700000000 }));
    const gridObj = deskResult(
      "m12-curtail",
      0,
      verifiedLiveReceipt("GRID_POWER_PRICE_GENERAL", { lmp_usd_per_mwh: 42, node_or_zone: "TH_NP15_GEN-APND", market: {} }),
    );
    const lmpObj = whyCard(preset.evaluate([gridObj, route]), "LMP (live)");
    expect(lmpObj.v).toBe("$42.00 / MWh · TH_NP15_GEN-APND");
    expect(lmpObj.v).not.toContain("[object Object]");
    // Empty-string market omits the segment the same clean way.
    const gridEmpty = deskResult(
      "m12-curtail",
      0,
      verifiedLiveReceipt("GRID_POWER_PRICE_GENERAL", { lmp_usd_per_mwh: 42, node_or_zone: "TH_NP15_GEN-APND", market: "" }),
    );
    expect(whyCard(preset.evaluate([gridEmpty, route]), "LMP (live)").v).toBe("$42.00 / MWh · TH_NP15_GEN-APND");
    // Positive control: a string market still renders its segment.
    const gridStr = deskResult(
      "m12-curtail",
      0,
      verifiedLiveReceipt("GRID_POWER_PRICE_GENERAL", { lmp_usd_per_mwh: 42, node_or_zone: "TH_NP15_GEN-APND", market: "CAISO" }),
    );
    expect(whyCard(preset.evaluate([gridStr, route]), "LMP (live)").v).toBe("$42.00 / MWh · CAISO · TH_NP15_GEN-APND");
  });

  it("M3: m13-reverted TVL Guard shows the honest fallback when tvl_usd is absent", () => {
    const preset = presetById("m13-reverted");
    const tx = deskResult("m13-reverted", 0, verifiedLiveReceipt("ONCHAIN_TX_LOOKUP_GENERAL", { status: "reverted", block_number: 1 }));
    const tvl = deskResult("m13-reverted", 1, verifiedLiveReceipt("TVL_LOOKUP_GENERAL", { protocol_or_chain: "micro-vault-v1" }));
    const ev = preset.evaluate([tx, tvl]);
    expect(ev.verdict).toBe("REJECT");
    const guard = whyCard(ev, "TVL Guard");
    expect(guard.v).toBe("no live TVL returned");
    expect(guard.v).not.toMatch(/^live TVL/);
    expect(guard.ok).toBe(false);
    // Positive control: a numeric tvl_usd still renders live TVL.
    const tvlLive = deskResult("m13-reverted", 1, verifiedLiveReceipt("TVL_LOOKUP_GENERAL", { protocol_or_chain: "micro-vault-v1", tvl_usd: 100 }));
    expect(whyCard(preset.evaluate([tx, tvlLive]), "TVL Guard").v).toBe("live TVL $100");
  });

  it("M4: m13-sec URL Provenance ok is false without a verified receipt", () => {
    const preset = presetById("m13-sec");
    const route = deskResult("m13-sec", 1, verifiedLiveReceipt("OPTIMAL_EXECUTION_ROUTE_GENERAL", { amount_out: 1700000000 }));
    // Refused filings whose body still carries urls: the old ungated
    // `ok` read true on exactly this shape.
    const filingsRefused = deskResult(
      "m13-sec",
      0,
      refusedLiveReceipt("REGULATORY_FILING_MONITOR_GENERAL", 422, {
        urls: ["https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm"],
      }),
    );
    const ev = preset.evaluate([filingsRefused, route]);
    const prov = whyCard(ev, "URL Provenance");
    expect(prov.ok).toBe(false);
    expect(prov.v).toBe("no archive URLs returned");
    // Positive control: a verified receipt with urls still passes.
    const filingsOk = deskResult(
      "m13-sec",
      0,
      verifiedLiveReceipt("REGULATORY_FILING_MONITOR_GENERAL", {
        entity: "AAPL",
        filing_count: 1,
        urls: ["https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm"],
      }),
    );
    const evOk = preset.evaluate([filingsOk, route]);
    expect(whyCard(evOk, "URL Provenance").ok).toBe(true);
    expect(whyCard(evOk, "URL Provenance").v).toBe("1 archive URL(s) on sec.gov");
  });

  it("M5: ledger 503 KPI is error-toned and labelled a subset of Refusals", () => {
    const verified = makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 200, query: "tx-ok" });
    const err503 = makeReceipt({ intent: "ONCHAIN_TX_LOOKUP_GENERAL", status: 503, query: "tx-503" });
    const refused422 = makeReceipt({ intent: "GRID_POWER_PRICE_GENERAL", status: 422, query: "grid-422" });
    render(<ReceiptsLedger receipts={[verified, err503, refused422]} onInspect={() => undefined} showToast={() => undefined} />);
    // The 503 row counts in BOTH KPIs: it is a refusal and a 503.
    const cell503 = screen.getByText("HTTP 503 Errors").closest(".kpi-cell");
    expect(cell503?.querySelector(".kpi-val")?.textContent).toBe("1");
    expect(cell503?.querySelector(".kpi-val")?.getAttribute("style")).toContain("var(--err)");
    expect(cell503?.querySelector(".kpi-val")?.getAttribute("style")).not.toContain("var(--ok)");
    expect(cell503?.textContent).toContain("subset of Refusals");
    const refusals = screen.getByText("Refusals").closest(".kpi-cell");
    expect(refusals?.querySelector(".kpi-val")?.textContent).toBe("2");
  });
});
