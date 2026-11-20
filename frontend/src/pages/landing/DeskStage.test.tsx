// J2 B1 regression tests: desk items 03/04 must NEVER render a VERIFIED
// verdict. No SHA-256 recompute happens anywhere in the desk — the grid
// call merely returning data is a live response with a receipt, not a
// verification (the same principle d004f91 applied to item 01). The
// verdict label is RECEIPTED and the section heading reads "receipted
// in the open." — assert both, plus that no VERIFIED label appears.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeskStage } from "./DeskStage";

const RECEIPT = {
  receipt_id: "rcpt-test-grid",
  upstream_url: "https://example.com/upstream",
  raw_response_sha256: "c".repeat(64),
  fetched_at: "2026-11-20T00:00:00Z",
};

const GRID_BODY = {
  lmp_usd_per_mwh: 32.5,
  node_or_zone: "TH_NP15_GEN-APND",
  market: "CAISO",
  interval_start: "2026-11-20T05:00:00Z",
  currency: "USD",
  receipt: RECEIPT,
};

const GRID_NYISO_BODY = {
  ...GRID_BODY,
  node_or_zone: "ZONE_J",
  market: "NYISO",
};

function mockGridFetch(body: unknown) {
  // Real Response: lib/api.ts reads the body via res.text().
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function runItem(title: RegExp, body: unknown) {
  mockGridFetch(body);
  render(<DeskStage />);
  fireEvent.click(screen.getByRole("button", { name: title }));
  fireEvent.click(screen.getByRole("button", { name: /Run .* live checks/ }));
  await waitFor(() => expect(screen.getByText("RECEIPTED")).toBeInTheDocument(), {
    timeout: 15000,
  });
}

describe("DeskStage — no VERIFIED verdict for grid items (J2 B1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("item 03 (CAISO NP15): a 200 grid response renders RECEIPTED, never VERIFIED", async () => {
    await runItem(/CAISO NP15/, GRID_BODY);
    expect(screen.queryByText("VERIFIED")).toBeNull();
    expect(screen.getByText(/receipted in the open\./)).toBeInTheDocument();
    expect(screen.queryByText(/verified in the open\./)).toBeNull();
    expect(screen.getByText(/live response with receipt, no threshold applied/)).toBeInTheDocument();
  });

  it("item 04 (NYISO Zone J): a 200 grid response renders RECEIPTED, never VERIFIED", async () => {
    await runItem(/NYISO Zone J/, GRID_NYISO_BODY);
    expect(screen.queryByText("VERIFIED")).toBeNull();
    expect(screen.getByText(/receipted in the open\./)).toBeInTheDocument();
  });
});
