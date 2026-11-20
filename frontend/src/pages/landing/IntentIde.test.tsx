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
  tx_hash: "0x8c3f442fc6d640a6ff3ea0b12be64f1d4609ea94edd2966f42c01cd9bdcf04b5",
  status: "confirmed",
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  block_number: 15725067,
  value_eth: "0.01",
  source: "archive-rpc-quorum",
  receipt: { ...RECEIPT, quorum_votes: "2-of-3" },
};

const SEC_BODY = {
  entity: "AAPL",
  filing_count: 3,
  filings: [
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
  const fetchMock = vi.fn(async (url: string) => {
    const body = String(url).includes("/v1/filings") ? SEC_BODY : TX_BODY;
    return { ok: true, status: 200, json: async () => body };
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

  it("fires exactly one fetch on mount, per mode switch, per re-run, and per tab switch", async () => {
    const fetchMock = mockFetch();
    render(<IntentIde />);

    // Mount: one call for the default (tx) tab.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Mode switch to the 422 trap: exactly one more call, to the trap params.
    fireEvent.click(screen.getByRole("button", { name: "Test 422 trap" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain("tx_hash=0x0000000000000000000000000000000000000000000000000000000000000000");

    // Mode switch back to 200 OK: exactly one more call.
    fireEvent.click(screen.getByRole("button", { name: "Run 200 OK" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // Re-run in the same mode: still exactly one call (not zero, not two).
    fireEvent.click(screen.getByRole("button", { name: "Run 200 OK" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    // Tab switch: exactly one call for the new tab. (The accessible name
    // has a space — "sec-filing .ts" — because the extension is a
    // separate span; match on the file part.)
    fireEvent.click(screen.getByRole("tab", { name: /sec-filing/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(String(fetchMock.mock.calls[4][0])).toContain("/v1/filings");
  });

  it("ignores a stale response that resolves after a newer run", async () => {
    // Tabs are not disabled while loading, so two runs CAN overlap here:
    // switching tabs mid-flight must not let the stale response overwrite
    // the newest run. (The Probe's identical guard is defense-in-depth
    // behind its disabled chips, which React will not deliver clicks to.)
    const pending: { resolve: (body: unknown) => void }[] = [];
    const fetchMock = vi.fn((url: string) => {
      let resolve!: (body: unknown) => void;
      const promise = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((r) => {
        resolve = (body: unknown) => r({ ok: true, status: 200, json: async () => body });
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

    // Newest run (sec) resolves first…
    pending[1].resolve(SEC_BODY);
    await waitFor(() => expect(screen.getByText(/AAPL — 3 filings/)).toBeInTheDocument());
    // …then the stale tx run resolves late: it must not overwrite.
    pending[0].resolve(TX_BODY);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/AAPL — 3 filings/)).toBeInTheDocument();
    expect(screen.queryByText(/confirmed · block 15725067/)).toBeNull();
  });
});
