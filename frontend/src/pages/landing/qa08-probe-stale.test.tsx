// QA-08 (external live-site QA, 2026-11-21): after a successful run, an
// invalid-JSON submission showed the form error while the previous green
// 200 + receipt stayed on screen. Now an invalid submission clears the
// displayed result, an edited-but-not-run payload is flagged, and an
// unsupported parameter (e.g. route "amount") is a form error with zero
// fetches instead of being silently dropped.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Probe } from "./Probe";
import { PRESETS } from "./data";

const TX_BODY = {
  tx_hash: PRESETS.tx.tx_hash,
  status: "confirmed",
  block_number: 26454869,
  source: "archive-rpc-quorum",
  receipt: {
    receipt_id: "rcpt-qa08",
    upstream_url: "https://example.com/upstream",
    raw_response_sha256: "a".repeat(64),
    fetched_at: "2026-11-21T00:00:00Z",
    quorum_votes: "2-of-3",
  },
};

function stubOk() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(TX_BODY), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const out = () => document.getElementById("pr-out");
const runBtn = () => screen.getByRole("button", { name: "Run live probe →" });
const payloadBox = () => screen.getByLabelText("Payload JSON") as HTMLInputElement;

describe("QA-08 Probe never shows a stale 200 next to a new error", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("invalid JSON after a 200 clears the result and shows only the form error", async () => {
    stubOk();
    render(<Probe />);
    fireEvent.click(runBtn());
    await waitFor(() => expect(out()?.textContent).toContain("200 OK"));
    expect(out()?.textContent).toContain("rcpt-qa08");

    fireEvent.change(payloadBox(), { target: { value: "{bad" } });
    fireEvent.click(runBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(/not valid JSON.*Nothing was sent/);
    expect(out()).toBeNull();
    expect(screen.queryByText(/rcpt-qa08/)).toBeNull();
  });

  it("a non-object payload after a 200 also clears the result", async () => {
    stubOk();
    render(<Probe />);
    fireEvent.click(runBtn());
    await waitFor(() => expect(out()).not.toBeNull());
    fireEvent.change(payloadBox(), { target: { value: "[1,2]" } });
    fireEvent.click(runBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(/JSON object/);
    expect(out()).toBeNull();
  });

  it("an edited-but-not-run payload is flagged as the previous run", async () => {
    stubOk();
    render(<Probe />);
    fireEvent.click(runBtn());
    await waitFor(() => expect(out()).not.toBeNull());
    expect(screen.queryByText(/inputs edited since/)).toBeNull();
    const original = payloadBox().value;
    fireEvent.change(payloadBox(), { target: { value: JSON.stringify({ tx_hash: "0x" + "b".repeat(64) }) } });
    expect(screen.getByText(/previous run .*inputs edited since — run again/)).toBeTruthy();
    fireEvent.change(payloadBox(), { target: { value: original } });
    expect(screen.queryByText(/inputs edited since/)).toBeNull();
  });

  it("an unsupported parameter is a form error with zero fetches (route amount)", async () => {
    const fetchMock = stubOk();
    render(<Probe />);
    fireEvent.change(screen.getByLabelText(/intent/), { target: { value: "route" } });
    fireEvent.change(payloadBox(), { target: { value: JSON.stringify({ pair: "ETH/USDC", amount: "1000" }) } });
    fireEvent.click(runBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Parameter "amount" not accepted by this endpoint \(it takes: pair\)/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out()).toBeNull();
  });
});
