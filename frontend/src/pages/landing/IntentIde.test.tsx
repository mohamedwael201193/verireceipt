// M1 regression test: a mode switch in the IDE must trigger EXACTLY ONE
// live call. The old code called runIntent directly from the mode-button
// onClick AND let setIs422 re-fire the effect — two fetches per switch.
// The fix routes every switch through state only (runNonce), with the
// effect as the single dispatch path.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntentIde } from "./IntentIde";

const RECEIPT = {
  receipt_id: "rcpt-test-1",
  upstream_url: "https://example.com/upstream",
  raw_response_sha256: "a".repeat(64),
  fetched_at: "2026-11-20T00:00:00Z",
};

const TX_BODY = {
  tx_hash: "0xafdbc83c485355d90f79fd660bcd12713402aa78922d966657d1005f59e92902",
  status: "confirmed",
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  block_number: 26454869,
  value_eth: "0.01",
  source: "archive-rpc-quorum",
  receipt: { ...RECEIPT, quorum_votes: "2-of-3" },
};

const SEC_BODY = {
  entity: "AAPL",
  filing_count: 3,
  filings: ["Form 10-K filed 2024-11-01"],
  filings_detail: [
    {
      form: "10-K",
      accession: "0000320193-24-000123",
      filing_date: "2024-11-01",
      url: "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
    },
  ],
  urls: ["https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm"],
  receipt: RECEIPT,
};

function mockFetch() {
  // Real Response objects (as datalayer api.test.ts does): lib/api.ts
  // reads the body via res.text(), so a hand-rolled {ok, status, json}
  // mock has no text() — text() throws, the client swallows it to
  // body = null, and assertValidBody throws INVALID_RESPONSE.
  const fetchMock = vi.fn(async (url: string) => {
    const body = String(url).includes("/v1/filings") ? SEC_BODY : TX_BODY;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("IntentIde — one live call per switch (M1)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // M4: generous waits — the 1 s waitFor defaults flaked twice under
  // CPU load (slow chunk transform), so each wait gets 15 s and the
  // test itself 60 s. No production-code change.
  // J2 minor 1: the mode buttons are disabled while a run is loading,
  // so clicking one mid-flight is a no-op and the next count assertion
  // stalls (the old test only waited for the fetch count, not for the
  // run to settle). Wait for the buttons to re-enable before every
  // click, so each click lands on exactly one fresh run.
  async function waitSettled() {
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Test 422 trap" })).not.toBeDisabled(),
      { timeout: 15000 },
    );
  }

  it("fires exactly one fetch on mount, per mode switch, per re-run, and per tab switch", async () => {
    const fetchMock = mockFetch();
    render(<IntentIde />);

    // Mount: one call for the default (tx) tab.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 15000 });
    await waitSettled();

    // Mode switch to the 422 trap: exactly one more call, to the trap params.
    fireEvent.click(screen.getByRole("button", { name: "Test 422 trap" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 15000 });
    expect(String(fetchMock.mock.calls[1][0])).toContain("tx_hash=0x0000000000000000000000000000000000000000000000000000000000000000");
    await waitSettled();

    // Mode switch back to 200 OK: exactly one more call.
    fireEvent.click(screen.getByRole("button", { name: "Run 200 OK" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 15000 });
    await waitSettled();

    // Re-run in the same mode: still exactly one call (not zero, not two).
    fireEvent.click(screen.getByRole("button", { name: "Run 200 OK" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4), { timeout: 15000 });
    await waitSettled();

    // Tab switch: exactly one call for the new tab. (The accessible name
    // has a space — "sec-filing .ts" — because the extension is a
    // separate span; match on the file part.)
    fireEvent.click(screen.getByRole("tab", { name: /sec-filing/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5), { timeout: 15000 });
    expect(String(fetchMock.mock.calls[4][0])).toContain("/v1/filings");
  }, 60000);

  it("ignores a stale response that resolves after a newer run", async () => {
    // Tabs are not disabled while loading, so two runs CAN overlap here:
    // switching tabs mid-flight must not let the stale response overwrite
    // the newest run. (The Probe's identical guard is defense-in-depth
    // behind its disabled chips, which React will not deliver clicks to.)
    const pending: { resolve: (body: unknown) => void }[] = [];
    const fetchMock = vi.fn((url: string) => {
      let resolve!: (body: unknown) => void;
      // Real Response: lib/api.ts reads the body via res.text().
      const promise = new Promise<Response>((r) => {
        resolve = (body: unknown) =>
          r(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
      });
      pending.push({ resolve });
      void url;
      return promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<IntentIde />);

    // Mount starts the tx run; switch tabs while it is still in flight.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: /sec-filing/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Newest run (sec) resolves first… (the visual carries the
    // window: "AAPL — 3 filings · last 12 months", not a bare count —
    // filings J2 R3 M3).
    pending[1].resolve(SEC_BODY);
    await waitFor(() => expect(screen.getByText(/AAPL — 3 filings · last 12 months/)).toBeInTheDocument());
    // …then the stale tx run resolves late: it must not overwrite.
    pending[0].resolve(TX_BODY);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/AAPL — 3 filings · last 12 months/)).toBeInTheDocument();
    expect(screen.queryByText(/confirmed · block 26454869/)).toBeNull();
  });

  it("IDE visuals never claim verification (J2 B1)", async () => {
    // Per-intent bodies: the tx body here carries NO quorum_votes, so
    // the TxVisual fallback renders ("receipted", not "verified").
    const TVL_BODY = {
      protocol_or_chain: "aave-v3",
      tvl_usd: 12345678901,
      chain_tvl_usd: 1234567890,
      as_of: "2026-11-20T00:00:00Z",
      receipt: RECEIPT,
    };
    const GRID_BODY = {
      lmp_usd_per_mwh: 32.5,
      node_or_zone: "TH_NP15_GEN-APND",
      market: "CAISO",
      interval_start: "2026-11-20T05:00:00Z",
      currency: "USD",
      receipt: RECEIPT,
    };
    const TX_NO_QUORUM = { ...TX_BODY, receipt: RECEIPT };
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      const body = u.includes("/v1/filings")
        ? SEC_BODY
        : u.includes("/v1/tvl")
          ? TVL_BODY
          : u.includes("/v1/grid-price")
            ? GRID_BODY
            : TX_NO_QUORUM;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<IntentIde />);

    // Tx visual: quorum fallback is "receipted", never "verified".
    await waitFor(() => expect(screen.getByText(/receipted · #26454869/)).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.queryByText("verified")).toBeNull();

    // TVL visual: docked portal is "receipted".
    fireEvent.click(screen.getByRole("tab", { name: /tvl-oracle/ }));
    await waitFor(() => expect(screen.getByText("docked · receipted portal")).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.queryByText("verified")).toBeNull();
    expect(screen.queryByText("docked · verified portal")).toBeNull();

    // Grid visual: "live grid response".
    fireEvent.click(screen.getByRole("tab", { name: /grid-lmp/ }));
    await waitFor(() => expect(screen.getByText("live grid response")).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.queryByText("verified")).toBeNull();
  });
});

describe("IntentIde — 'Unbilled refusal' line is 422-only (J2 R2 M4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function mockErrorFetch(status: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  }

  it("a 500 error does NOT render the 'Unbilled refusal' line", async () => {
    mockErrorFetch(500, { error: "upstream boom" });
    render(<IntentIde />);
    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.queryByText(/Unbilled refusal/)).toBeNull();
  });

  it("a network failure does NOT render the 'Unbilled refusal' line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    render(<IntentIde />);
    await waitFor(() => expect(screen.getByText(/Request failed/)).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.queryByText(/Unbilled refusal/)).toBeNull();
  });

  it("a 422 error DOES render the 'Unbilled refusal' line", async () => {
    mockErrorFetch(422, { error: "interval_in_future" });
    render(<IntentIde />);
    await waitFor(() => expect(screen.getByText(/HTTP 422/)).toBeInTheDocument(), {
      timeout: 15000,
    });
    expect(screen.getByText(/Unbilled refusal/)).toBeInTheDocument();
  });
});
