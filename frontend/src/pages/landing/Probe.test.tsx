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

  it("disables inputs while loading and Copy curl uses the displayed run's params (J2 minor 6)", async () => {
    const writeMock = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeMock },
      configurable: true,
    });
    try {
      const { fetchMock, pending } = mockFetch();
      render(<Probe />);

      fireEvent.click(screen.getByRole("button", { name: "TVL: aave-v3" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      // The chips and Run button were already disabled mid-run; the
      // select, payload input, and mode buttons stayed live, so a user
      // could edit the payload mid-flight and copy a mismatched curl.
      expect(screen.getByRole("combobox")).toBeDisabled();
      expect(screen.getByLabelText("Payload JSON")).toBeDisabled();
      expect(screen.getByRole("button", { name: "200 OK" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "422 Refusal" })).toBeDisabled();

      // Copy curl mid-flight copies the RUNNING params.
      fireEvent.click(screen.getByRole("button", { name: "Copy curl" }));
      await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1));
      expect(writeMock.mock.calls[0][0]).toContain("protocol=aave-v3");

      pending[0].resolve(TVL_BODY);
      await waitFor(() => expect(screen.getByRole("combobox")).not.toBeDisabled());

      // After the run, editing the payload box must NOT change what Copy
      // curl copies: it still reflects the displayed run's params.
      fireEvent.change(screen.getByLabelText("Payload JSON"), {
        target: { value: JSON.stringify({ protocol: "not-a-real-protocol-xyz" }) },
      });
      fireEvent.click(screen.getByRole("button", { name: "Copy curl" }));
      await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(2));
      expect(writeMock.mock.calls[1][0]).toContain("protocol=aave-v3");
      expect(writeMock.mock.calls[1][0]).not.toContain("not-a-real-protocol-xyz");
    } finally {
      // jsdom has no clipboard; remove the stub so other tests see the
      // stock navigator again.
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });
});

describe("Probe — programmatic retarget mid-run is a no-op (J2 R2 M2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("a dispatched change reaches the handler when idle (control for the repro)", () => {
    mockFetch();
    render(<Probe />);

    // Same dispatch mechanism as the repro below, but while idle: the
    // handler MUST run — this proves the mid-run test below is not
    // passing vacuously because the dispatch never reaches React.
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    setter.call(select, "sec");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(screen.getByLabelText("Payload JSON")).toHaveValue(
      JSON.stringify({ entity: "AAPL", period: "last 6 months" }),
    );
  });

  it("a dispatched change on the disabled select mid-run does not retarget the run", async () => {
    const { fetchMock, pending } = mockFetch();
    const { container } = render(<Probe />);

    // Start a TVL chip run.
    fireEvent.click(screen.getByRole("button", { name: "TVL: aave-v3" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("combobox")).toBeDisabled();

    // J2's exact repro: native setter + dispatchEvent on the disabled
    // select. The old code moved intent tx -> sec mid-run, so after the
    // TVL run resolved the VerifyBadge URL was built from the sec intent
    // with the TVL run's params (/v1/filings?protocol=aave-v3).
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    setter.call(select, "sec");
    select.dispatchEvent(new Event("change", { bubbles: true }));

    // No second run started, intent did not move: the payload box still
    // holds the TVL preset (the handler would have swapped in the sec
    // preset). The select's own DOM value is not asserted — React only
    // restores a controlled value on re-render, and the guard correctly
    // causes no re-render.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Payload JSON")).toHaveValue(
      JSON.stringify({ protocol: "aave-v3" }),
    );

    pending[0].resolve(TVL_BODY);
    await waitFor(() =>
      expect(container.querySelector("#pr-out")?.textContent).toContain("aave-v3"),
    );

    // The VerifyBadge URL is the TVL run's, not the filings URL.
    fireEvent.click(screen.getByRole("button", { name: "Compute envelope digest" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toBe("/api/v1/tvl?protocol=aave-v3");
  });

  it("a dispatched mode change mid-run does not retarget the run", async () => {
    const { fetchMock, pending } = mockFetch();
    render(<Probe />);

    // Control: the same dispatched click DOES toggle the mode while idle,
    // so the mid-run assertion below is not vacuous. A plain Event("click")
    // does not reach React's onClick (button is undefined, not 0); a real
    // user click is a MouseEvent, so dispatch that.
    const modeButton = screen.getByRole("button", { name: "422 Refusal" });
    modeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(modeButton).toHaveAttribute("aria-pressed", "true");

    // The TVL chip resets the mode to 200 OK and starts a run.
    fireEvent.click(screen.getByRole("button", { name: "TVL: aave-v3" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(modeButton).toHaveAttribute("aria-pressed", "false");

    // Same dispatch mid-run: the guard must block it.
    modeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(modeButton).toHaveAttribute("aria-pressed", "false");

    pending[0].resolve(TVL_BODY);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "422 Refusal" })).not.toBeDisabled(),
    );
  });
});

describe("Probe — oversize param is a form error, zero fetches (J2 R2 M6)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("600-char protocol renders a form error and sends no fetch", async () => {
    const { fetchMock } = mockFetch();
    render(<Probe />);

    fireEvent.change(screen.getByLabelText("Payload JSON"), {
      target: { value: JSON.stringify({ protocol: "x".repeat(600) }) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run live probe →" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/exceeds 512 characters/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/INVALID_PARAM/)).toBeNull();
  });

  it("malformed JSON still renders a form error with zero fetches", async () => {
    const { fetchMock } = mockFetch();
    render(<Probe />);

    fireEvent.change(screen.getByLabelText("Payload JSON"), {
      target: { value: "{not json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run live probe →" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not valid JSON/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
