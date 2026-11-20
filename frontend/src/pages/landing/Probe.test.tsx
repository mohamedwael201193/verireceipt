// M2 regression tests: probe chips must not start concurrent runs, and a
// stale response must never overwrite the newest run's receipt (the
// VerifyBadge URL is built from the newest run's params, so a mismatch
// would show a receipt for a different request than the one displayed).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Probe } from "./Probe";

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

const TVL_BODY = {
  protocol_or_chain: "aave-v3",
  tvl_usd: 12345678901,
  chain_tvl_usd: 1234567890,
  as_of: "2026-11-20T00:00:00Z",
  // Distinct receipt id so tests can tell the TVL run's receipt apart
  // from the TX run's.
  receipt: { ...RECEIPT, receipt_id: "rcpt-test-tvl" },
};

const CHIP_LABELS = [
  "TX: Block 15725067",
  "SEC: AAPL 10-K",
  "TVL: aave-v3",
  "Route: 1 ETH → USDC",
  "Grid: CAISO NP15",
  "422 Trap: Future Grid",
];

interface DeferredResponse {
  promise: Promise<Response>;
  resolve: (body: unknown) => void;
}

function deferredResponse(): DeferredResponse {
  let resolve!: (body: unknown) => void;
  // Real Response: lib/api.ts reads the body via res.text() — a
  // hand-rolled {ok, status, json} mock has no text() and fails with
  // INVALID_RESPONSE (see IntentIde.test.tsx).
  const promise = new Promise<Response>((r) => {
    resolve = (body: unknown) =>
      r(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
  });
  return { promise, resolve };
}

/** Mock fetch with one controllable deferred response per call. */
function mockFetch() {
  const pending: DeferredResponse[] = [];
  const fetchMock = vi.fn((url: string) => {
    const d = deferredResponse();
    pending.push(d);
    void url;
    return d.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, pending };
}

function chips(): HTMLButtonElement[] {
  return CHIP_LABELS.map((label) => screen.getByRole("button", { name: label }) as HTMLButtonElement);
}

describe("Probe — chip race guard (M2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("disables all preset chips while a run is loading, re-enables after", async () => {
    const { fetchMock, pending } = mockFetch();
    const { container } = render(<Probe />);

    fireEvent.click(screen.getByRole("button", { name: "TVL: aave-v3" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(chips().every((c) => c.disabled)).toBe(true);

    pending[0].resolve(TVL_BODY);
    await waitFor(() => expect(chips().every((c) => !c.disabled)).toBe(true));
    expect(container.querySelector("#pr-out")?.textContent).toContain("aave-v3");
  });

  it("always shows the latest completed run's receipt (no mismatch)", async () => {
    // The request-id guard is defense-in-depth: with the chips disabled
    // while loading (test above), two runs cannot overlap through the UI
    // — React does not deliver clicks to a disabled button even when the
    // click is dispatched directly. What the UI must guarantee is that
    // the displayed receipt always belongs to the latest completed run,
    // never to an earlier one (the VerifyBadge URL is built from the
    // latest run's params). The guard itself is proven by the IDE test
    // ("ignores a stale response…"), where tab switches CAN overlap runs.
    const { fetchMock, pending } = mockFetch();
    const { container } = render(<Probe />);

    fireEvent.click(screen.getByRole("button", { name: "TX: Block 15725067" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    pending[0].resolve(TX_BODY);
    await waitFor(() =>
      expect(container.querySelector("#pr-out")?.textContent).toContain(
        "0x8c3f442fc6d640a6ff3ea0b12be64f1d4609ea94edd2966f42c01cd9bdcf04b5",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "TVL: aave-v3" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    pending[1].resolve(TVL_BODY);
    await waitFor(() =>
      expect(container.querySelector("#pr-out")?.textContent).toContain("aave-v3"),
    );
    const out = container.querySelector("#pr-out")?.textContent ?? "";
    expect(out).toContain("rcpt-test-tvl");
    expect(out).not.toContain("0x8c3f442fc6d640a6ff3ea0b12be64f1d4609ea94edd2966f42c01cd9bdcf04b5");
    expect(out).not.toContain("rcpt-test-1");
  });
});
