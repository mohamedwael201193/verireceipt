import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Desk, { deliveryEpochWindowMs } from "./Desk";
import { RELATED_PARTY_DISCLOSURE } from "../lib/desk";

// Fixtures use the REAL backend shapes (backend/src/desk/routes.ts +
// ledger.ts). Anything in the old invented shape (lowercase mission,
// nested inputs, spend_usdc, receipts[], latency_ms, payer_balance_usdc,
// page_size) must FAIL the parsers — see the rejection test below.

const STATS_OK = {
  payer_address: "0x1234567890abcdef1234567890abcdef12345678",
  diamond: "0x72a70e949362670Bf8bceAd24eFC5b8f950aa08b",
  network: "Ethereum Sepolia",
  chain: "Ethereum Sepolia (testnet)",
  escrow: { available: 2500000 },
  runway_checks: 250,
  runway_label: "Funded for ~250 live checks",
  spend: {
    total_calls: 12,
    total_cost_uusdc: 120000,
    total_cost_usd: 0.12,
    m13_calls: 10,
    m12_calls: 2,
    verified_calls: 3,
    distinct_miners: 4,
    distinct_scenarios: 2,
  },
  spend_today: { day: "2026-11-20", calls: 5, cost_uusdc: 50000, cost_usd: 0.05 },
  caps: { free_checks_per_ip_per_day: 5, daily_global_cap_usd: 2, cost_per_check_usd: 0.01 },
  related_party_disclosure: RELATED_PARTY_DISCLOSURE,
};

function isoNowMinus(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function runOk(fetchedAt: string = new Date().toISOString()) {
  return {
    run_id: "desk_run_1",
    mission: "M13",
    // Verdict-free scenario id (J1-3): the id is the ledger label, so it
    // must never embed a verdict — this fixture pairs the id with an
    // APPROVE verdict to prove the label does not decide the outcome.
    scenario_id: "m13-reverted-counterparty-tx",
    verdict: "APPROVE",
    checks: [
      {
        id: "tx_status",
        name: "Counterparty transaction status",
        status: "pass",
        reason: "Counterparty transaction is confirmed on chain.",
        detail: "block 26454869",
      },
      {
        id: "sanctions",
        name: "Sanctions screening (issuer)",
        status: "skipped",
        reason: "No sanctions-screening evidence was bought in this run.",
      },
    ],
    why: [
      "PASS — Counterparty transaction status: Counterparty transaction is confirmed on chain.",
      "SKIPPED — Sanctions screening (issuer): No sanctions-screening evidence was bought in this run.",
    ],
    calls: [
      {
        intent: "ONCHAIN_TX_LOOKUP_GENERAL",
        params: {
          tx_hash: "0x1b9e2b48eb3510ee1a8aae2fc402139784f32d43b76d5853387cacb484a9a9d3",
          chain: "ethereum",
        },
        miner_id: "774921",
        miner_name: "verireceipt",
        signal_hash: "abc123hash",
        receipt_hash: "rcpt_hash_1",
        cost_uusdc: 10000,
        rail: "escrow",
        fetched_at: fetchedAt,
        signal_url: "https://devnode.telegraphprotocol.com/engine/v1/signal/abc123hash",
      },
      {
        intent: "TVL_LOOKUP_GENERAL",
        params: { protocol: "aave-v3" },
        miner_id: null,
        miner_name: null,
        signal_hash: null,
        receipt_hash: null,
        cost_uusdc: 0,
        rail: "escrow",
        fetched_at: fetchedAt,
        signal_url: null,
      },
    ],
    total_cost_uusdc: 10000,
    total_cost_usd: 0.01,
    related_party: true,
    disclosure: RELATED_PARTY_DISCLOSURE,
  };
}

function runM12Ok() {
  return {
    run_id: "desk_run_m12",
    mission: "M12",
    scenario_id: "m12-grid-high-breakeven",
    verdict: "MINE",
    checks: [
      {
        id: "interval_finished",
        name: "Settlement interval finished",
        status: "pass",
        reason: "Settlement interval is finished.",
      },
      {
        id: "dispatch",
        name: "Dispatch economics vs break-even",
        status: "pass",
        reason: "Price $25.00 / MWh is at or below $475.00 — mining clears its power cost.",
      },
    ],
    why: ["PASS — Dispatch economics vs break-even: Price $25.00 / MWh is at or below $475.00."],
    calls: [
      {
        intent: "GRID_POWER_PRICE_GENERAL",
        params: { node_or_zone: "TH_NP15_GEN-APND" },
        miner_id: "774921",
        miner_name: "verireceipt",
        signal_hash: "gridhash1",
        receipt_hash: "rcpt_hash_g1",
        cost_uusdc: 10000,
        rail: "escrow",
        fetched_at: new Date().toISOString(),
        signal_url: "https://devnode.telegraphprotocol.com/engine/v1/signal/gridhash1",
      },
      {
        intent: "MINING_HASHPRICE_VERIFY_GENERAL",
        params: {},
        miner_id: "774921",
        miner_name: "verireceipt",
        signal_hash: "hashhash1",
        receipt_hash: "rcpt_hash_h1",
        cost_uusdc: 10000,
        rail: "escrow",
        fetched_at: new Date().toISOString(),
        signal_url: "https://devnode.telegraphprotocol.com/engine/v1/signal/hashhash1",
      },
    ],
    total_cost_uusdc: 20000,
    total_cost_usd: 0.02,
    related_party: true,
    disclosure: RELATED_PARTY_DISCLOSURE,
  };
}

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    run_id: "desk_run_1",
    mission: "M13",
    scenario_id: "m13-reverted-counterparty-tx",
    intent: "ONCHAIN_TX_LOOKUP_GENERAL",
    miner_id: "774921",
    miner_name: "verireceipt",
    signal_hash: "abc123hash",
    signal_url: "https://devnode.telegraphprotocol.com/engine/v1/signal/abc123hash",
    receipt_hash: "rcpt_hash_1",
    cost_uusdc: 10000,
    cost_usd: 0.01,
    rail: "escrow",
    verdict: "APPROVE",
    related_party: true,
    fetched_at: new Date().toISOString(),
    verification_status: "pending",
    ...overrides,
  };
}

const LEDGER_EMPTY = { runs: [], page: 1, limit: 20, total: 0 };
const LEDGER_WITH_RUN = { runs: [ledgerRow()], page: 1, limit: 20, total: 1 };

// The OLD invented shape (pre-fix desk.ts): lowercase mission, nested
// inputs, spend_usdc, receipts[], per-call miner/cost_usdc/latency_ms/
// status. The real backend never returns this — the parsers must reject it.
const RUN_OLD_SHAPE = {
  verdict: "APPROVE",
  why: ["Counterparty tx confirmed on-chain (archive quorum 2-of-3)."],
  calls: [
    {
      intent: "ONCHAIN_TX_LOOKUP_GENERAL",
      miner: "verireceipt",
      signal_hash: "abc123hash",
      cost_usdc: 0.01,
      latency_ms: 142,
      status: "200 OK",
    },
  ],
  receipts: [{ signal_hash: "abc123hash", receipt_id: "rcpt_01" }],
  spend_usdc: 0.01,
};

function makeRes(body: unknown, ok = true, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
    json: async () => body,
  };
}

type FetchStub = ReturnType<typeof vi.fn>;

function stubFetch(overrides: {
  stats?: unknown;
  statsOk?: boolean;
  statsStatus?: number;
  run?: unknown;
  runOk?: boolean;
  runStatus?: number;
  ledger?: unknown;
  ledgerOk?: boolean;
} = {}): FetchStub {
  const calls: string[] = [];
  const stub = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("/api/desk/stats")) {
      return makeRes(overrides.stats ?? STATS_OK, overrides.statsOk ?? true, overrides.statsStatus ?? 200);
    }
    if (url.startsWith("/api/desk/run")) {
      return makeRes(overrides.run ?? runOk(), overrides.runOk ?? true, overrides.runStatus ?? 200);
    }
    if (url.startsWith("/api/desk/ledger")) {
      return makeRes(overrides.ledger ?? LEDGER_EMPTY, overrides.ledgerOk ?? true, 200);
    }
    if (url === "/api/health") {
      return makeRes({ status: "ok", service: "verireceipt", uptime_s: 1 });
    }
    return makeRes({ error: "not found" }, false, 404);
  });
  (stub as unknown as { calls: string[] }).calls = calls;
  vi.stubGlobal("fetch", stub);
  return stub;
}

function renderDesk() {
  return render(
    <MemoryRouter initialEntries={["/desk"]}>
      <Desk />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute("data-theme", "dark");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Desk workbench", () => {
  it("renders all five one-click presets with neutral titles — no verdict in any label", async () => {
    stubFetch();
    renderDesk();
    expect(await screen.findByRole("heading", { name: /VeriReceipt Desk\./ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Institutional DeFi allocation/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thin-TVL protocol allocation/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Counterparty transaction check/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Grid dispatch — low break-even/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Grid dispatch — high break-even/ })).toBeInTheDocument();
    // No preset button may promise an outcome before any run.
    for (const btn of screen.getAllByRole("button")) {
      const label = btn.textContent ?? "";
      if (/M13|M12/.test(label)) {
        expect(label).not.toMatch(/— Approve|— Reject|— Hold|— Curtail case|— Mine case/);
      }
    }
  });

  it("shows the live runway ticker from GET /api/desk/stats — and no invented numbers", async () => {
    stubFetch();
    renderDesk();
    expect(await screen.findByText("Funded for ~250 live checks")).toBeInTheDocument();
    expect(screen.getByText(/payer 0x1234…5678/)).toBeInTheDocument();
    expect(screen.getByText(/spent today \$0\.05 · cap \$2\.00\/day/)).toBeInTheDocument();
    // The design drafts' fabricated figures must never appear.
    expect(screen.queryByText(/184 checks/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$18\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/450×/)).not.toBeInTheDocument();
  });

  it("stats failure is an error state, not a fabricated runway", async () => {
    stubFetch({ stats: { error: "down" }, statsOk: false, statsStatus: 503 });
    renderDesk();
    expect(await screen.findByText(/Runway unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Funded for/)).not.toBeInTheDocument();
  });

  it("clicking a preset then Run calls POST /api/desk/run with the real flat shape and renders the verdict + why + checks", async () => {
    const fetchStub = stubFetch();
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Counterparty transaction check/ }));
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await waitFor(() => {
      const post = (fetchStub.mock.calls as unknown[][]).find(
        ([url, init]) => url === "/api/desk/run" && (init as RequestInit).method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse((post![1] as RequestInit).body as string) as Record<string, unknown>;
      // Real backend contract: UPPERCASE mission, FLAT fields, no nesting.
      expect(body["mission"]).toBe("M13");
      expect(body["scenario_id"]).toBe("m13-reverted-counterparty-tx");
      expect(body["protocol"]).toBe("aave-v3");
      expect(body["chain"]).toBe("ethereum");
      expect(body["issuer_entity"]).toBe("AAPL");
      expect(body["period"]).toBe("last 12 months");
      expect(body["trade_pair"]).toBe("ETH/USDC");
      expect(body["tx_hash"]).toMatch(/^0x1a146789/);
      expect(body["preset_id"]).toBeUndefined();
      expect(body["inputs"]).toBeUndefined();
    });
    expect(await screen.findByText("APPROVE")).toBeInTheDocument();
    // The reason renders twice: once in the structured checks list, once
    // in the backend's why lines — both must be present.
    expect(screen.getAllByText(/Counterparty transaction is confirmed on chain/)).toHaveLength(2);
    // Fail-closed, visibly: the skipped check + its reason render in the Why box.
    expect(screen.getAllByText(/No sanctions-screening evidence was bought in this run/)).toHaveLength(2);
    expect(screen.getByText(/\$0\.01 Test USDC spent/)).toBeInTheDocument();
    // The stream is labelled a replay, stamped with real fetched_at — never a live stream.
    expect(screen.getByText(/settled-run summary · replayed/)).toBeInTheDocument();
    expect(screen.queryByText(/live execution stream/)).not.toBeInTheDocument();
  });

  it("M12 run posts the flat M12 fields with a numeric break-even", async () => {
    const fetchStub = stubFetch({ run: runM12Ok() });
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Grid dispatch — high break-even/ }));
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await waitFor(() => {
      const post = (fetchStub.mock.calls as unknown[][]).find(
        ([url, init]) => url === "/api/desk/run" && (init as RequestInit).method === "POST",
      );
      expect(post).toBeDefined();
      const body = JSON.parse((post![1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body["mission"]).toBe("M12");
      expect(body["scenario_id"]).toBe("m12-grid-high-breakeven");
      expect(body["node_or_zone"]).toBe("TH_NP15_GEN-APND");
      expect(typeof body["interval_start"]).toBe("string");
      expect(body["breakeven_usd_per_mwh"]).toBe(500);
      expect(body["inputs"]).toBeUndefined();
    });
    expect(await screen.findByText("MINE")).toBeInTheDocument();
  });

  it("run success is only 'APPENDED TO LEDGER' once the reloaded ledger contains the run_id", async () => {
    stubFetch({ ledger: LEDGER_WITH_RUN });
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    expect(await screen.findByText("COMPLETE · APPENDED TO LEDGER")).toBeInTheDocument();
  });

  it("run success without the run_id in the reloaded ledger says so instead of claiming completion", async () => {
    stubFetch();
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    expect(await screen.findByText("COMPLETE · RUN NOT VISIBLE IN LEDGER YET")).toBeInTheDocument();
  });

  it("shows the empty ledger state before any run exists", async () => {
    stubFetch();
    renderDesk();
    expect(await screen.findByText("No desk runs yet — run a preset above.")).toBeInTheDocument();
  });

  it("run failure is an error banner, records no verdict, and says so only after the ledger proves unchanged", async () => {
    stubFetch({ run: { error: "escrow empty" }, runOk: false, runStatus: 503 });
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/escrow empty/);
    expect(screen.queryByText("APPROVE")).not.toBeInTheDocument();
    expect(await screen.findByText("FAILED — NO RUN RECORDED")).toBeInTheDocument();
  });

  it("rejects the old invented response shape instead of rendering it", async () => {
    stubFetch({ run: RUN_OLD_SHAPE });
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Invalid response from server/);
    expect(screen.queryByText("APPROVE")).not.toBeInTheDocument();
  });

  it("receipt drawer links the devnode signal URL — never explorer — with the delivery-epoch window, fail-closed checks incl. detail, and UNAVAILABLE re-hash", async () => {
    stubFetch();
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await screen.findByText("APPROVE");
    fireEvent.click(screen.getByText("ONCHAIN_TX_LOOKUP"));
    const link = await screen.findByRole("link", {
      name: /devnode\.telegraphprotocol\.com\/engine\/v1\/signal\/abc123hash/,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://devnode.telegraphprotocol.com/engine/v1/signal/abc123hash",
    );
    // No epoch badge for the SIGNAL: a signal carries no epoch, and the
    // old hourly model is gone entirely — no "hourly" text anywhere.
    expect(document.body.innerHTML).not.toContain("hourly");
    expect(document.body.innerHTML).not.toContain("Pending hourly epoch");
    // The call carries a receipt_hash, so the DELIVERY epoch window is
    // shown instead: fetched_at is now, inside its own 3h window, so
    // the window is still pending.
    expect(screen.getByText("Delivery epoch pending")).toBeInTheDocument();
    expect(screen.getByText(/3-hour delivery window containing this call/)).toBeInTheDocument();
    expect(screen.getByText(/settlement can lag an epoch/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("explorer.telegraphprotocol.com");
    // No live-proof assertion anywhere in the drawer.
    expect(document.body.innerHTML).not.toContain("The signal proof is live now");
    // Verification is stored-bytes re-hash only and the endpoint is not shipped:
    // UNAVAILABLE, never a fake MATCH or MISMATCH — and the copy now
    // scopes that to the re-hash and names the signal-verification path.
    expect(screen.getByText(/UNAVAILABLE — RE-HASH UNPROVEN/)).toBeInTheDocument();
    expect(screen.getByText(/GET \/api\/desk\/verify/)).toBeInTheDocument();
    expect(screen.getByText(/verify_receipt/)).toBeInTheDocument();
    expect(screen.queryByText(/BIT-EXACT MATCH/)).not.toBeInTheDocument();
    expect(screen.queryByText(/DIGEST MISMATCH/)).not.toBeInTheDocument();
    // Fail-closed, visibly: the run's checks render in the drawer too,
    // WITH detail (the tx_status check's "block N" evidence).
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/No sanctions-screening evidence was bought in this run/)).toBeInTheDocument();
    expect(within(dialog).getByText("SKIPPED")).toBeInTheDocument();
    expect(within(dialog).getByText(/\(block 26454869\)/)).toBeInTheDocument();
  });

  it("drawer shows the delivery window as closed once the fetched_at 3h window has passed", async () => {
    stubFetch({ run: runOk(isoNowMinus(4)) });
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await screen.findByText("APPROVE");
    fireEvent.click(screen.getByText("ONCHAIN_TX_LOOKUP"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Delivery epoch pending")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Delivery window closed")).toBeInTheDocument();
    expect(within(dialog).queryByText("Pending hourly epoch")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/UNAVAILABLE — RE-HASH UNPROVEN/)).toBeInTheDocument();
  });

  it("a call with no signal_hash shows the unbilled-refusal note and no signal link — and no delivery-epoch block, since it carries no receipt_hash either", async () => {
    stubFetch();
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await screen.findByText("APPROVE");
    fireEvent.click(screen.getByText("TVL_LOOKUP"));
    expect(await screen.findByText(/No signal_hash — unbilled refusal/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /devnode\.telegraphprotocol\.com/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Delivery epoch/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delivery window/)).not.toBeInTheDocument();
  });

  it("shows the related-party disclosure verbatim (blueprint §7.3)", async () => {
    stubFetch();
    renderDesk();
    expect(await screen.findByText(RELATED_PARTY_DISCLOSURE)).toBeInTheDocument();
  });

  it("ledger pagination reads the next page from GET /api/desk/ledger with ?limit=", async () => {
    const fetchStub = stubFetch({
      ledger: {
        runs: [ledgerRow()],
        page: 1,
        limit: 20,
        total: 25,
      },
    });
    renderDesk();
    expect(await screen.findByText(/Page 1 of 2 · 25 calls/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next →/ }));
    await waitFor(() => {
      expect(
        (fetchStub.mock.calls as unknown[][]).some(([url]) =>
          typeof url === "string" && url.includes("/api/desk/ledger?page=2&limit=20"),
        ),
      ).toBe(true);
    });
    // No ?page_size= anywhere in the requests the page makes.
    expect(
      (fetchStub.mock.calls as unknown[][]).every(
        ([url]) => typeof url !== "string" || !url.includes("page_size"),
      ),
    ).toBe(true);
  });

  it("delivery epoch window is the real 3h :05:41 grid — the old hourly math is gone", () => {
    // J2's cases, anchor 2026-11-20T04:05:41Z (epoch 22). The old hourly
    // model said a 05:30Z fetch closed at 06:00Z (65.7 min early) and a
    // 07:05Z fetch was "Pending" 54.3 min after the real close; the real
    // windows below close at the :05:41 boundary, never the hour.
    expect(deliveryEpochWindowMs("2026-11-20T05:30:00Z")).toEqual({
      startMs: Date.parse("2026-11-20T04:05:41Z"),
      closesAtMs: Date.parse("2026-11-20T07:05:41Z"),
    });
    expect(deliveryEpochWindowMs("2026-11-20T07:06:00Z")?.closesAtMs).toBe(
      Date.parse("2026-11-20T10:05:41Z"),
    );
    expect(deliveryEpochWindowMs("2026-11-20T04:10:00Z")?.closesAtMs).toBe(
      Date.parse("2026-11-20T07:05:41Z"),
    );
    expect(deliveryEpochWindowMs("2026-11-20T07:05:00Z")?.closesAtMs).toBe(
      Date.parse("2026-11-20T07:05:41Z"),
    );
    expect(deliveryEpochWindowMs("2026-11-20T10:05:00Z")?.closesAtMs).toBe(
      Date.parse("2026-11-20T10:05:41Z"),
    );
    expect(deliveryEpochWindowMs("not-a-date")).toBeNull();
  });

  it("switching preset clears the inspected receipt — no stale drawer from the previous run", async () => {
    stubFetch();
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await screen.findByText("APPROVE");
    fireEvent.click(screen.getByText("ONCHAIN_TX_LOOKUP"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("No receipt selected.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Grid dispatch — high break-even/ }));
    // The drawer shell stays mounted; the closed state is the empty body.
    expect(await screen.findByText("No receipt selected.")).toBeInTheDocument();
  });

  it("running again clears the inspected receipt — a failed re-run shows no stale receipt", async () => {
    stubFetch();
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await screen.findByText("APPROVE");
    fireEvent.click(screen.getByText("ONCHAIN_TX_LOOKUP"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("No receipt selected.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    // The drawer shell stays mounted; the closed state is the empty body.
    expect(await screen.findByText("No receipt selected.")).toBeInTheDocument();
  });

  it("double-click during the pre-run ledger snapshot posts POST /api/desk/run exactly once", async () => {
    // F1 (round 3): executeRun awaited the page-1 ledger snapshot BEFORE
    // setRunning(true), so both guards were dead while it was pending and
    // an ordinary double-click POSTed twice — spending escrow twice for
    // one user intent. The run must be claimed (ref + running state)
    // BEFORE the snapshot await, so the second click is a no-op.
    let releaseSnapshot!: () => void;
    const snapshotHeld = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let page1Loads = 0;
    const fetchStub = vi.fn(async (url: string) => {
      if (url.startsWith("/api/desk/stats")) return makeRes(STATS_OK);
      if (url.startsWith("/api/desk/run")) return makeRes(runOk());
      if (url.startsWith("/api/desk/ledger")) {
        const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
        if (page === 1) {
          page1Loads += 1;
          // Every page-1 load after the mount load is a snapshot/reload:
          // hold it until the test releases, so the Run click below is
          // still inside the snapshot await when the second click lands.
          if (page1Loads > 1) await snapshotHeld;
        }
        return makeRes({
          runs: [ledgerRow({ id: page === 1 ? 7 : 3, run_id: page === 1 ? "desk_run_1" : "desk_run_old" })],
          page,
          limit: 20,
          total: 25,
        });
      }
      return makeRes({ error: "not found" }, false, 404);
    });
    vi.stubGlobal("fetch", fetchStub);
    renderDesk();
    expect(await screen.findByText(/Page 1 of 2 · 25 calls/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next →/ }));
    await waitFor(() => {
      expect(
        (fetchStub.mock.calls as unknown[][]).some(([url]) =>
          typeof url === "string" && url.includes("/api/desk/ledger?page=2&limit=20"),
        ),
      ).toBe(true);
    });
    await screen.findByText(/Page 2 of 2 · 25 calls/);
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    // The snapshot await is now pending (ledger was on page 2, so the
    // snapshot path fired). Record whether the Run button is already
    // disabled DURING the await — on the unfixed code it is not.
    await waitFor(() => expect(page1Loads).toBeGreaterThan(1));
    const runButtonDuringSnapshot = screen.queryByRole("button", {
      name: /Running ranked checks/,
    });
    const disabledDuringSnapshot =
      runButtonDuringSnapshot !== null && runButtonDuringSnapshot.hasAttribute("disabled");
    // Second click, 50 ms-style, while the snapshot is still pending.
    fireEvent.click(
      screen.getByRole("button", { name: /Run Live Escrow Check|Running ranked checks/ }),
    );
    releaseSnapshot();
    // The verdict text is ambiguous here (the reloaded ledger also
    // renders an APPROVE badge for its row), so wait on the unique
    // stream state instead: it only appears once the run settles AND
    // the reloaded ledger contains the run_id.
    expect(await screen.findByText("COMPLETE · APPENDED TO LEDGER")).toBeInTheDocument();
    const runPosts = (fetchStub.mock.calls as unknown[][]).filter(
      ([url, init]) => url === "/api/desk/run" && (init as RequestInit).method === "POST",
    );
    expect(runPosts).toHaveLength(1);
    expect(disabledDuringSnapshot).toBe(true);
  });

  it("preset switch during the pre-run ledger snapshot is blocked — the run posts the clicked preset's inputs", async () => {
    // F1 (round 3), second half: the same dead-guard window let a preset
    // switch land mid-snapshot, so the run posted the OLD preset's inputs
    // while the UI showed the NEW preset selected. The switch must be
    // blocked until the run settles.
    let releaseSnapshot!: () => void;
    const snapshotHeld = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let page1Loads = 0;
    const fetchStub = vi.fn(async (url: string) => {
      if (url.startsWith("/api/desk/stats")) return makeRes(STATS_OK);
      if (url.startsWith("/api/desk/run")) return makeRes(runOk());
      if (url.startsWith("/api/desk/ledger")) {
        const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
        if (page === 1) {
          page1Loads += 1;
          if (page1Loads > 1) await snapshotHeld;
        }
        return makeRes({
          runs: [ledgerRow({ id: page === 1 ? 7 : 3, run_id: page === 1 ? "desk_run_1" : "desk_run_old" })],
          page,
          limit: 20,
          total: 25,
        });
      }
      return makeRes({ error: "not found" }, false, 404);
    });
    vi.stubGlobal("fetch", fetchStub);
    renderDesk();
    expect(await screen.findByText(/Page 1 of 2 · 25 calls/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next →/ }));
    await waitFor(() => {
      expect(
        (fetchStub.mock.calls as unknown[][]).some(([url]) =>
          typeof url === "string" && url.includes("/api/desk/ledger?page=2&limit=20"),
        ),
      ).toBe(true);
    });
    await screen.findByText(/Page 2 of 2 · 25 calls/);
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await waitFor(() => expect(page1Loads).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: /Grid dispatch — high break-even/ }));
    // The switch must not have landed: the M12 preset is not active.
    expect(
      screen.getByRole("button", { name: /Grid dispatch — high break-even/ }).className,
    ).not.toContain("active");
    releaseSnapshot();
    // Unique stream state, not the verdict text (the reloaded ledger
    // also renders an APPROVE badge for its row).
    expect(await screen.findByText("COMPLETE · APPENDED TO LEDGER")).toBeInTheDocument();
    const runPosts = (fetchStub.mock.calls as unknown[][]).filter(
      ([url, init]) => url === "/api/desk/run" && (init as RequestInit).method === "POST",
    );
    expect(runPosts).toHaveLength(1);
    const body = JSON.parse((runPosts[0]![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body["scenario_id"]).toBe("m13-institutional-defi");
  });

  it("cancel during ledger confirmation does NOT claim the run was aborted — verdict and spend stand", async () => {
    // J2 round 4, finding 2: held the post-settle ledger-confirm load,
    // clicked Cancel during "COMPLETE · CONFIRMING LEDGER…", and the
    // unfixed UI reported "CANCELLED — RUN ABORTED" beside a live
    // APPROVE verdict and spent escrow. The run was not aborted — only
    // the confirmation read was. The final state must say the
    // confirmation was interrupted while the verdict and spend stand.
    let releaseConfirm!: () => void;
    const confirmHeld = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    let page1Loads = 0;
    const fetchStub = vi.fn(async (url: string) => {
      if (url.startsWith("/api/desk/stats")) return makeRes(STATS_OK);
      if (url.startsWith("/api/desk/run")) return makeRes(runOk());
      if (url.startsWith("/api/desk/ledger")) {
        const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
        if (page === 1) {
          page1Loads += 1;
          // Mount load resolves at once; the post-settle confirmation
          // load is held so Cancel lands during CONFIRMING LEDGER…
          if (page1Loads > 1) await confirmHeld;
        }
        return makeRes(LEDGER_WITH_RUN);
      }
      return makeRes({ error: "not found" }, false, 404);
    });
    vi.stubGlobal("fetch", fetchStub);
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    expect(await screen.findByText("COMPLETE · CONFIRMING LEDGER…")).toBeInTheDocument();
    await waitFor(() => expect(page1Loads).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: /Cancel run/ }));
    releaseConfirm();
    expect(await screen.findByText(/LEDGER CONFIRMATION INTERRUPTED/)).toBeInTheDocument();
    expect(screen.queryByText("CANCELLED — RUN ABORTED")).not.toBeInTheDocument();
    // Verdict and spend are untouched by the interrupted confirmation.
    // The bare verdict text is ambiguous (the reloaded ledger also
    // renders an APPROVE badge for its row — see the note above the
    // double-click test), so scope the verdict assertion to the banner.
    expect(
      within(document.querySelector(".verdict-banner") as HTMLElement).getByText("APPROVE"),
    ).toBeInTheDocument();
    expect(screen.getByText(/\$0\.01 Test USDC spent/)).toBeInTheDocument();
    const runPosts = (fetchStub.mock.calls as unknown[][]).filter(
      ([url, init]) => url === "/api/desk/run" && (init as RequestInit).method === "POST",
    );
    expect(runPosts).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Run Live Escrow Check/ })).toBeEnabled();
  });

  it("cancel during post-failure ledger confirmation does NOT claim the run was aborted — the failure stands", async () => {
    // Round 6, F1 (J1-1 / J2-3): the run FAILED at the backend on its own
    // ("escrow empty"), and Cancel landed during the post-failure ledger
    // confirmation ("FAILED · CONFIRMING LEDGER…"). The unfixed UI
    // reported "CANCELLED — RUN ABORTED" beside the error banner — false:
    // the run was not aborted, only the confirmation READ was
    // interrupted. The final state must say the failure stands, with the
    // backend failure still shown beside it.
    let releaseConfirm!: () => void;
    const confirmHeld = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    let page1Loads = 0;
    const fetchStub = vi.fn(async (url: string) => {
      if (url.startsWith("/api/desk/stats")) return makeRes(STATS_OK);
      if (url.startsWith("/api/desk/run")) return makeRes({ error: "escrow empty" }, false, 503);
      if (url.startsWith("/api/desk/ledger")) {
        const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
        if (page === 1) {
          page1Loads += 1;
          // Mount load resolves at once; the post-failure confirmation
          // load is held so Cancel lands during FAILED · CONFIRMING LEDGER…
          if (page1Loads > 1) await confirmHeld;
        }
        return makeRes(LEDGER_WITH_RUN);
      }
      return makeRes({ error: "not found" }, false, 404);
    });
    vi.stubGlobal("fetch", fetchStub);
    renderDesk();
    await screen.findByText("Funded for ~250 live checks");
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    expect(await screen.findByText("FAILED · CONFIRMING LEDGER…")).toBeInTheDocument();
    await waitFor(() => expect(page1Loads).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: /Cancel run/ }));
    releaseConfirm();
    expect(
      await screen.findByText("FAILED · LEDGER CONFIRMATION INTERRUPTED — FAILURE STANDS"),
    ).toBeInTheDocument();
    expect(screen.queryByText("CANCELLED — RUN ABORTED")).not.toBeInTheDocument();
    // The backend failure is still shown — the cancel did not erase it.
    expect(await screen.findByRole("alert")).toHaveTextContent(/escrow empty/);
    // No verdict was ever rendered for the failed run. The ledger table
    // also renders an APPROVE badge for its row, so scope this to the
    // verdict banner (same ambiguity as the settled-cancel test above).
    expect(
      within(document.querySelector(".verdict-banner") as HTMLElement).queryByText("APPROVE"),
    ).not.toBeInTheDocument();
    const runPosts = (fetchStub.mock.calls as unknown[][]).filter(
      ([url, init]) => url === "/api/desk/run" && (init as RequestInit).method === "POST",
    );
    expect(runPosts).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Run Live Escrow Check/ })).toBeEnabled();
  });

  it("cancel mid-snapshot posts nothing, re-enables Run, and a fresh Run posts exactly once", async () => {
    // Pre-settle cancel (J2-verified working, round 3): the run never
    // reached the backend, so "CANCELLED — RUN ABORTED" is honest here
    // and the next Run must work.
    let releaseSnapshot!: () => void;
    const snapshotHeld = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let page1Loads = 0;
    const fetchStub = vi.fn(async (url: string) => {
      if (url.startsWith("/api/desk/stats")) return makeRes(STATS_OK);
      if (url.startsWith("/api/desk/run")) return makeRes(runOk());
      if (url.startsWith("/api/desk/ledger")) {
        const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
        if (page === 1) {
          page1Loads += 1;
          if (page1Loads > 1) await snapshotHeld;
        }
        return makeRes({
          runs: [ledgerRow({ id: page === 1 ? 7 : 3, run_id: page === 1 ? "desk_run_1" : "desk_run_old" })],
          page,
          limit: 20,
          total: 25,
        });
      }
      return makeRes({ error: "not found" }, false, 404);
    });
    vi.stubGlobal("fetch", fetchStub);
    renderDesk();
    expect(await screen.findByText(/Page 1 of 2 · 25 calls/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next →/ }));
    await screen.findByText(/Page 2 of 2 · 25 calls/);
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await waitFor(() => expect(page1Loads).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: /Cancel run/ }));
    releaseSnapshot();
    expect(await screen.findByText("CANCELLED — RUN ABORTED")).toBeInTheDocument();
    const runPosts = (fetchStub.mock.calls as unknown[][]).filter(
      ([url, init]) => url === "/api/desk/run" && (init as RequestInit).method === "POST",
    );
    expect(runPosts).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Run Live Escrow Check/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    expect(await screen.findByText("COMPLETE · APPENDED TO LEDGER")).toBeInTheDocument();
    const runPostsAfter = (fetchStub.mock.calls as unknown[][]).filter(
      ([url, init]) => url === "/api/desk/run" && (init as RequestInit).method === "POST",
    );
    expect(runPostsAfter).toHaveLength(1);
  });

  it("unmount mid-snapshot posts nothing", async () => {
    let releaseSnapshot!: () => void;
    const snapshotHeld = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let page1Loads = 0;
    const fetchStub = vi.fn(async (url: string) => {
      if (url.startsWith("/api/desk/stats")) return makeRes(STATS_OK);
      if (url.startsWith("/api/desk/run")) return makeRes(runOk());
      if (url.startsWith("/api/desk/ledger")) {
        const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
        if (page === 1) {
          page1Loads += 1;
          if (page1Loads > 1) await snapshotHeld;
        }
        return makeRes({
          runs: [ledgerRow({ id: page === 1 ? 7 : 3, run_id: page === 1 ? "desk_run_1" : "desk_run_old" })],
          page,
          limit: 20,
          total: 25,
        });
      }
      return makeRes({ error: "not found" }, false, 404);
    });
    vi.stubGlobal("fetch", fetchStub);
    const { unmount } = renderDesk();
    expect(await screen.findByText(/Page 1 of 2 · 25 calls/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next →/ }));
    await screen.findByText(/Page 2 of 2 · 25 calls/);
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    await waitFor(() => expect(page1Loads).toBeGreaterThan(1));
    unmount();
    releaseSnapshot();
    await new Promise((r) => setTimeout(r, 100));
    const runPosts = (fetchStub.mock.calls as unknown[][]).filter(
      ([url, init]) => url === "/api/desk/run" && (init as RequestInit).method === "POST",
    );
    expect(runPosts).toHaveLength(0);
  });

  it("failure proof still works after paging to page 2 — the snapshot is page 1", async () => {
    // Ledger pages carry DIFFERENT newest ids, so a snapshot taken from
    // the open page would never match the page-1 reload. The run must
    // still prove "FAILED — NO RUN RECORDED" from page 1.
    const fetchStub = vi.fn(async (url: string) => {
      if (url.startsWith("/api/desk/stats")) return makeRes(STATS_OK);
      if (url.startsWith("/api/desk/run")) return makeRes({ error: "escrow empty" }, false, 503);
      if (url.startsWith("/api/desk/ledger")) {
        const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
        return makeRes({
          runs: [ledgerRow({ id: page === 1 ? 7 : 3, run_id: page === 1 ? "desk_run_1" : "desk_run_old" })],
          page,
          limit: 20,
          total: 25,
        });
      }
      return makeRes({ error: "not found" }, false, 404);
    });
    vi.stubGlobal("fetch", fetchStub);
    renderDesk();
    expect(await screen.findByText(/Page 1 of 2 · 25 calls/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next →/ }));
    await waitFor(() => {
      expect(
        (fetchStub.mock.calls as unknown[][]).some(([url]) =>
          typeof url === "string" && url.includes("/api/desk/ledger?page=2&limit=20"),
        ),
      ).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: /Run Live Escrow Check/ }));
    expect(await screen.findByText("FAILED — NO RUN RECORDED")).toBeInTheDocument();
  });
});
